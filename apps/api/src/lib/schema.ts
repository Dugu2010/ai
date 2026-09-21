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

    -- Runtime provider columns. sandbox_id is reused to hold the live Modal
    -- Sandbox id; the CodeSandbox identifier is retired into
    -- legacy_sandbox_id rather than dropped, so nothing is silently lost.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_provider TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_volume_subpath TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS legacy_sandbox_id TEXT;
    -- Migration outcome per project: modal_workspace_ready | modal_files_imported |
    -- modal_awaiting_import | modal_import_failed. Written by scripts/migrate-runtime.ts.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_migration_status TEXT;

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
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_args JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_result JSONB;

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      nim_model TEXT NOT NULL DEFAULT 'meta/llama-3.1-405b-instruct',
      nim_base_url TEXT NOT NULL DEFAULT 'https://integrate.api.nvidia.com/v1',
      nim_api_key_enc TEXT,
      idle_timeout_seconds INTEGER NOT NULL DEFAULT 30,
      UNIQUE (user_id)
    );

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
      content_before TEXT,
      content_after TEXT,
      existed_before BOOLEAN NOT NULL,
      size_before BIGINT NOT NULL DEFAULT 0,
      size_after BIGINT NOT NULL DEFAULT 0,
      reversible BOOLEAN NOT NULL DEFAULT true,
      skip_reason TEXT
    );

    -- Redo stack: which checkpoints a user has undone, so redo can re-apply.
    ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;

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
  console.log("[db] schema ensured");
}
