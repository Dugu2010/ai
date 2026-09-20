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

    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  `);
  console.log("[db] schema ensured");
}
