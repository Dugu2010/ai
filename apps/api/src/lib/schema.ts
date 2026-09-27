import { pool } from "@dai/db";

/**
 * Ensures all tables exist. Runs once at startup so a fresh Render Postgres
 * works immediately without a manual migration step.
 */
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      sandbox_id TEXT,
      sandbox_slug TEXT,
      vm_id TEXT,
      vm_slug TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      preview_domain TEXT,
      preview_port INTEGER,
      preview_url TEXT,
      dev_server_running BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_accessed_at TIMESTAMPTZ,
      is_hibernated BOOLEAN NOT NULL DEFAULT false,
      bootup_type TEXT,
      is_up_to_date BOOLEAN,
      UNIQUE (user_id, slug)
    );

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_id TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_slug TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_hibernated BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS bootup_type TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_up_to_date BOOLEAN;

    -- Runtime provider columns. sandbox_id is reused to hold the live provider
    -- handle; for Vercel that is the deterministic sandbox *name*, which is what
    -- resume is keyed on, and for Modal it held the opaque sandbox id.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_provider TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_volume_subpath TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS legacy_sandbox_id TEXT;
    -- Vercel specifics: the project's own drive, its R2 archive prefix, whether
    -- the archive may be stale, and the escalation state for sizing.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_drive_name TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_archive_key TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_escalations INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_resource_tier INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_escalated_at TIMESTAMPTZ;
    -- Migration outcome per project: modal_workspace_ready | modal_files_imported |
    -- modal_awaiting_import | modal_import_failed. Written by scripts/migrate-runtime.ts.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_migration_status TEXT;
    -- Storage accounting. Modal has no per-project quota, so DAI measures the
    -- project's subPath and enforces MAX_PROJECT_WORKSPACE_BYTES itself.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_bytes BIGINT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_measured_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_projects_runtime_provider ON projects(runtime_provider);

    CREATE TABLE IF NOT EXISTS sandbox_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued',
      position BIGINT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_sandbox_queue_status ON sandbox_queue(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_queue_project ON sandbox_queue(project_id);

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      project_id UUID,
      role TEXT NOT NULL,          -- user | assistant | tool
      content TEXT,
      tool_name TEXT,
      tool_args JSONB,
      tool_result JSONB,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Migration for existing databases created before these columns existed.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_id UUID;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_args JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_result JSONB;

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      -- Empty means "follow the API's NIM_MODEL env var". A concrete default
      -- here would silently outrank the env config for every new account.
      nim_model TEXT NOT NULL DEFAULT '',
      nim_base_url TEXT NOT NULL DEFAULT 'https://integrate.api.nvidia.com/v1',
      nim_api_key_enc TEXT,
      idle_timeout_seconds INTEGER NOT NULL DEFAULT 30,
      UNIQUE (user_id)
    );

    ALTER TABLE user_settings ALTER COLUMN nim_model SET DEFAULT '';

    -- ---------------------------------------------------------------------
    -- Agent runs: one row per user task. Holds the state machine position and
    -- the runtime budget actually consumed, so cost is auditable afterwards.
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS agent_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      outcome TEXT,                    -- completed | failed | paused | budget_exhausted
      stop_reason TEXT,
      iterations INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      exec_calls INTEGER NOT NULL DEFAULT 0,
      runtime_activations INTEGER NOT NULL DEFAULT 0,
      runtime_ms BIGINT NOT NULL DEFAULT 0,
      files_changed INTEGER NOT NULL DEFAULT 0,
      sandbox_id TEXT,
      budget_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      summary TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );

    -- ---------------------------------------------------------------------
    -- Activity timeline. Deliberately high level: titles describe observable
    -- actions and results, never model reasoning.
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS activity_events (
      id BIGSERIAL PRIMARY KEY,
      run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      state TEXT,
      title TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id, seq)
    );

    -- ---------------------------------------------------------------------
    -- Undo / rollback. A checkpoint records the exact pre- and post-image of
    -- every file an agent run is about to change, so restore is a compare and
    -- swap rather than a blind overwrite.
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS checkpoints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'applied',   -- applied | undone | partial
      reversible BOOLEAN NOT NULL DEFAULT true,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS checkpoint_files (
      id BIGSERIAL PRIMARY KEY,
      checkpoint_id UUID NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      change_kind TEXT NOT NULL,                -- create | modify | delete | rename
      -- Either inline (legacy and the default when no object store is wired) or
      -- a key naming the object that holds the same bytes.
      content_before TEXT,
      content_after TEXT,
      content_before_key TEXT,
      content_after_key TEXT,
      existed_before BOOLEAN NOT NULL,
      size_before BIGINT NOT NULL DEFAULT 0,
      size_after BIGINT NOT NULL DEFAULT 0,
      reversible BOOLEAN NOT NULL DEFAULT true,
      skip_reason TEXT
    );

    -- Databases created before the key columns existed. These ALTERs must come
    -- after the CREATE above: a fresh schema runs this script top to bottom, and
    -- an ALTER naming a table that has not been created yet aborts the whole
    -- startup transaction.
    ALTER TABLE checkpoint_files ADD COLUMN IF NOT EXISTS content_before_key TEXT;
    ALTER TABLE checkpoint_files ADD COLUMN IF NOT EXISTS content_after_key TEXT;

    -- Redo stack: which checkpoints a user has undone, so redo can re-apply.
    ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;

    -- ---------------------------------------------------------------------
    -- Compute ledger. One row per provider session.
    --
    -- The monthly allowance is enforced from these rows rather than from a
    -- dashboard: on the free tier, exceeding a quota does not produce a bill, it
    -- pauses sandbox creation for 30 days, so the app has to know its own spend
    -- before it boots the machine that would overspend it.
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS runtime_usage (
      id BIGSERIAL PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
      sandbox_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'agent',      -- agent | preview | maintenance
      vcpus INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stopped_at TIMESTAMPTZ,
      active_cpu_ms BIGINT NOT NULL DEFAULT 0,
      provisioned_ms BIGINT NOT NULL DEFAULT 0,
      egress_bytes BIGINT NOT NULL DEFAULT 0,
      -- Set when a session was never reported closed, so a crash cannot leave
      -- the month's total permanently understated.
      reconciled BOOLEAN NOT NULL DEFAULT false
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_usage_created ON runtime_usage(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_usage_open ON runtime_usage(stopped_at) WHERE stopped_at IS NULL;

    -- The same period aggregated, because every boot has to read it and scanning
    -- the ledger each time would grow with the month.
    CREATE TABLE IF NOT EXISTS runtime_quota_state (
      month TEXT PRIMARY KEY,                    -- 'YYYY-MM', UTC
      active_cpu_ms BIGINT NOT NULL DEFAULT 0,
      provisioned_gb_ms BIGINT NOT NULL DEFAULT 0,
      creations INTEGER NOT NULL DEFAULT 0,
      egress_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_run ON activity_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_checkpoint_files_ckpt ON checkpoint_files(checkpoint_id);
  `);

  // One-time retirement of pre-Modal runtime identifiers.
  //
  // A CodeSandbox sandbox id is not a Modal sandbox id. Leaving it in
  // `sandbox_id` would make every acquire() attempt a reattach against an id
  // Modal has never heard of, so it is moved to legacy_sandbox_id, the live
  // pointer is cleared, and the project is marked for Modal provisioning.
  // Existing rows keep all their metadata; source files that could be exported
  // from the previous provider are copied by scripts/migrate-runtime.ts.
  const retired = await pool.query(
    `UPDATE projects
        SET legacy_sandbox_id = sandbox_id,
            sandbox_id = NULL,
            runtime_provider = 'codesandbox_retired',
            status = 'provisioning'
      WHERE sandbox_id IS NOT NULL
        AND runtime_provider IS NULL
      RETURNING id`
  );
  if (retired.rowCount) {
    console.log(`[db] retired ${retired.rowCount} legacy CodeSandbox runtime identifier(s)`);
  }

  // Retirement of Modal runtime identifiers, for a deployment switching to
  // Vercel. A Modal sandbox id is meaningless to `Sandbox.get`, which is keyed by
  // name, so leaving it in `sandbox_id` would make every acquire attempt a resume
  // against an id that has never existed.
  //
  // Gated on the provider actually being Vercel: running this against a deployment
  // still using Modal would clear the live handles and orphan every running
  // sandbox. Bytes are not touched here — scripts/migrate-runtime-v2.ts copies the
  // Volume contents to the mirror first, and this UPDATE follows that.
  if ((process.env.RUNTIME_PROVIDER ?? "modal").trim().toLowerCase() === "vercel") {
    const moved = await pool.query(
      `UPDATE projects
          SET legacy_sandbox_id = COALESCE(legacy_sandbox_id, sandbox_id),
              sandbox_id = NULL,
              runtime_provider = 'vercel',
              runtime_volume_subpath = 'projects/' || id,
              status = 'provisioning'
        WHERE runtime_provider = 'modal'
        RETURNING id`
    );
    if (moved.rowCount) {
      console.log(`[db] retired ${moved.rowCount} Modal runtime identifier(s); awaiting workspace import`);
    }
  }
  console.log("[db] schema ensured");
}
