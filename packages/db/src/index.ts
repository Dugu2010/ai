import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import type { User, Project, Conversation, ChatMessage, UserSettings } from "@dai/types";

const connectionString = process.env.DATABASE_URL;
if (!connectionString && process.env.NODE_ENV !== "test") {
  console.warn("[@dai/db] DATABASE_URL is not set;");
}

export const pool = new Pool({ connectionString, max: 20 });

export interface DbError extends Error {
  code?: string;
}

export async function query<T = any>(
  text: string,
  params: unknown[] = []
): Promise<{ rows: T[] }> {
  try {
    const res = await pool.query(text, params as any);
    return { rows: res.rows as T[] };
  } catch (e: any) {
    const err: DbError = new Error(e.message ?? "DB error");
    err.code = e.code;
    throw err;
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function createUser(
  email: string,
  name: string | null,
  passwordHash: string
): Promise<User> {
  const res = await query<{
    id: string;
    email: string;
    name: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, created_at, updated_at`,
    [email, name ?? null, passwordHash]
  );
  return {
    id: res.rows[0]!.id,
    email: res.rows[0]!.email,
    name: res.rows[0]!.name,
    createdAt: res.rows[0]!.created_at,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const res = await query<{
    id: string;
    email: string;
    name: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, email, name, created_at, updated_at FROM users WHERE email = $1`,
    [email]
  );
  if (!res.rows[0]) return null;
  return {
    id: res.rows[0]!.id,
    email: res.rows[0]!.email,
    name: res.rows[0]!.name,
    createdAt: res.rows[0]!.created_at,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function getUserByEmailWithPassword(email: string): Promise<{
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
} | null> {
  const res = await query<{
    id: string;
    email: string;
    name: string | null;
    password_hash: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, email, name, password_hash, created_at, updated_at FROM users WHERE email = $1`,
    [email]
  );
  if (!res.rows[0]) return null;
  return res.rows[0];
}

export async function getUserById(id: string): Promise<User | null> {
  const res = await query<{
    id: string;
    email: string;
    name: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, email, name, created_at, updated_at FROM users WHERE id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  return {
    id: res.rows[0]!.id,
    email: res.rows[0]!.email,
    name: res.rows[0]!.name,
    createdAt: res.rows[0]!.created_at,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function updateUser(
  id: string,
  updates: { name?: string }
): Promise<User | null> {
  const set: string[] = [];
  const vals: unknown[] = [];
  if (updates.name !== undefined) {
    vals.push(updates.name);
    set.push(`name = $${vals.length}`);
  }
  if (set.length === 0) return null;
  vals.push(id);
  const res = await query<{
    id: string;
    email: string;
    name: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `UPDATE users SET ${set.join(", ")} WHERE id = $${vals.length} RETURNING id, email, name, created_at, updated_at`,
    vals
  );
  if (!res.rows[0]) return null;
  return {
    id: res.rows[0]!.id,
    email: res.rows[0]!.email,
    name: res.rows[0]!.name,
    createdAt: res.rows[0]!.created_at,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function createProject(
  userId: string,
  { slug, name, description }: { slug: string; name: string; description?: string }
): Promise<Project> {
  const res = await query(
    `INSERT INTO projects (user_id, slug, name, description) VALUES ($1, $2, $3, $4) RETURNING id, slug, name, description, user_id, sandbox_id, sandbox_slug, vm_id, vm_slug, status, preview_domain, preview_port, preview_url, dev_server_running, last_error, created_at, updated_at, last_accessed_at, is_hibernated, bootup_type, is_up_to_date`,
    [userId, slug, name, description ?? null]
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    userId: row.user_id,
    sandboxId: row.sandbox_id ?? null,
    sandboxSlug: row.sandbox_slug ?? null,
    vmId: row.vm_id ?? null,
    vmSlug: row.vm_slug ?? null,
    status: row.status as any,
    previewDomain: row.preview_domain ?? null,
    previewPort: row.preview_port ?? null,
    previewUrl: row.preview_url ?? null,
    devServerRunning: row.dev_server_running,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? null,
    isHibernated: row.is_hibernated ?? false,
    bootupType: row.bootup_type as Project["bootupType"],
    isUpToDate: row.is_up_to_date ?? null,
  };
}

export async function getProject(id: string): Promise<Project | null> {
  const res = await query(
    `SELECT id, slug, name, description, user_id, sandbox_id, sandbox_slug, vm_id, vm_slug, status, preview_domain, preview_port, preview_url, dev_server_running, last_error, created_at, updated_at, last_accessed_at, is_hibernated, bootup_type, is_up_to_date FROM projects WHERE id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0]!;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    userId: row.user_id,
    sandboxId: row.sandbox_id ?? null,
    sandboxSlug: row.sandbox_slug ?? null,
    vmId: row.vm_id ?? null,
    vmSlug: row.vm_slug ?? null,
    status: row.status as any,
    previewDomain: row.preview_domain ?? null,
    previewPort: row.preview_port ?? null,
    previewUrl: row.preview_url ?? null,
    devServerRunning: row.dev_server_running,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? null,
    isHibernated: row.is_hibernated ?? false,
    bootupType: row.bootup_type as Project["bootupType"],
    isUpToDate: row.is_up_to_date ?? null,
  };
}

export async function getProjectByUser(id: string, userId: string): Promise<Project | null> {
  const res = await query(
    `SELECT id, slug, name, description, user_id, sandbox_id, sandbox_slug, vm_id, vm_slug, status, preview_domain, preview_port, preview_url, dev_server_running, last_error, created_at, updated_at, last_accessed_at, is_hibernated, bootup_type, is_up_to_date FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0]!;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    userId: row.user_id,
    sandboxId: row.sandbox_id ?? null,
    sandboxSlug: row.sandbox_slug ?? null,
    vmId: row.vm_id ?? null,
    vmSlug: row.vm_slug ?? null,
    status: row.status as any,
    previewDomain: row.preview_domain ?? null,
    previewPort: row.preview_port ?? null,
    previewUrl: row.preview_url ?? null,
    devServerRunning: row.dev_server_running,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? null,
    isHibernated: row.is_hibernated ?? false,
    bootupType: row.bootup_type as Project["bootupType"],
    isUpToDate: row.is_up_to_date ?? null,
  };
}

export async function listProjects(userId: string): Promise<Project[]> {
  const res = await query(
    `SELECT id, slug, name, description, user_id, sandbox_id, sandbox_slug, vm_id, vm_slug, status, preview_domain, preview_port, preview_url, dev_server_running, last_error, created_at, updated_at, last_accessed_at, is_hibernated, bootup_type, is_up_to_date FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows.map((row: any) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    userId: row.user_id,
    sandboxId: row.sandbox_id ?? null,
    sandboxSlug: row.sandbox_slug ?? null,
    vmId: row.vm_id ?? null,
    vmSlug: row.vm_slug ?? null,
    status: row.status as any,
    previewDomain: row.preview_domain ?? null,
    previewPort: row.preview_port ?? null,
    previewUrl: row.preview_url ?? null,
    devServerRunning: row.dev_server_running,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? null,
    isHibernated: row.is_hibernated ?? false,
    bootupType: row.bootup_type as "CLEAN" | "RESUME" | "RUNNING" | "FORK" | null,
    isUpToDate: row.is_up_to_date ?? null,
  }));
}

export interface SandboxQueueJob {
  id: string;
  userId: string;
  projectId: string;
  action: "create" | "resume";
  payload: Record<string, unknown>;
  status: "queued" | "processing" | "completed" | "failed";
  position: number | null;
  attempts: number;
  error: string | null;
  createdAt: string;
}

export async function countActiveSandboxes(userId?: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
     FROM projects
     WHERE sandbox_id IS NOT NULL
       AND is_hibernated = false
       AND status IN ('ready', 'provisioning')` + (userId ? ` AND user_id = $1` : ""),
    userId ? [userId] : []
  );
  return Number(res.rows[0]?.count ?? 0);
}

export async function enqueueSandboxJob(
  userId: string,
  projectId: string,
  action: "create" | "resume",
  payload: Record<string, unknown> = {}
): Promise<SandboxQueueJob> {
  const res = await query<{
    id: string;
    user_id: string;
    project_id: string;
    action: string;
    payload: Record<string, unknown>;
    status: string;
    position: number | null;
    attempts: number;
    error: string | null;
    created_at: string;
  }>(
    `WITH inserted AS (
       INSERT INTO sandbox_queue (user_id, project_id, action, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *
     ),
     positions AS (
       SELECT id, COUNT(*) OVER (ORDER BY created_at, id)::bigint AS position
       FROM sandbox_queue
       WHERE status = 'queued'
     )
     SELECT i.*, p.position
     FROM inserted i
     LEFT JOIN positions p ON p.id = i.id`,
    [userId, projectId, action, JSON.stringify(payload)]
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    action: row.action as "create" | "resume",
    payload: row.payload,
    status: row.status as SandboxQueueJob["status"],
    position: row.position,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
  };
}

export async function claimNextSandboxJob(): Promise<SandboxQueueJob | null> {
  const res = await query<{
    id: string;
    user_id: string;
    project_id: string;
    action: string;
    payload: Record<string, unknown>;
    status: string;
    position: number | null;
    attempts: number;
    error: string | null;
    created_at: string;
  }>(
    `WITH next_job AS (
       SELECT id
       FROM sandbox_queue
       WHERE status = 'queued'
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ),
     claimed AS (
       UPDATE sandbox_queue
       SET status = 'processing',
           claimed_at = now(),
           attempts = attempts + 1,
           error = NULL,
           updated_at = now()
       WHERE id = (SELECT id FROM next_job)
       RETURNING *
     )
     SELECT * FROM claimed`,
    []
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    action: row.action as "create" | "resume",
    payload: row.payload,
    status: row.status as SandboxQueueJob["status"],
    position: row.position,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
  };
}

export async function completeSandboxJob(jobId: string): Promise<void> {
  await query(
    `UPDATE sandbox_queue
     SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
}

export async function failSandboxJob(jobId: string, error: string): Promise<void> {
  await query(
    `UPDATE sandbox_queue
     SET status = 'failed', error = $2, updated_at = now()
     WHERE id = $1`,
    [jobId, error]
  );
}

/**
 * Requeue sandbox_queue jobs stuck in 'processing' (worker died mid-job, e.g. Render restart).
 * Returns how many jobs were requeued.
 */
export async function requeueStaleSandboxJobs(staleMinutes = 5): Promise<number> {
  const res = await query<{ count: string }>(
    `WITH requeued AS (
       UPDATE sandbox_queue
       SET status = 'queued', claimed_at = NULL, updated_at = now()
       WHERE status = 'processing' AND claimed_at < now() - ($1 || ' minutes')::interval
       RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM requeued`,
    [String(staleMinutes)]
  );
  return Number(res.rows[0]?.count ?? 0);
}

export async function updateProjectRuntimeState(
  projectId: string,
  updates: {
    isHibernated?: boolean;
    bootupType?: Project["bootupType"];
    isUpToDate?: boolean | null;
    lastAccessedAt?: string | null;
  }
): Promise<void> {
  await updateProject(projectId, updates);
}


export async function updateProject(
  id: string,
  updates: {
    slug?: string;
    name?: string;
    description?: string | null;
    status?: string;
    previewDomain?: string | null;
    previewPort?: number | null;
    previewUrl?: string | null;
    devServerRunning?: boolean;
    lastError?: string | null;
    sandboxId?: string | null;
    sandboxSlug?: string | null;
    vmId?: string | null;
    vmSlug?: string | null;
    lastAccessedAt?: string | null;
    isHibernated?: boolean;
    bootupType?: Project["bootupType"];
    isUpToDate?: boolean | null;
  }
): Promise<Project | null> {
  const set: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    set.push(`${col} = $${vals.length}`);
  };
  if (updates.slug !== undefined) add("slug", updates.slug);
  if (updates.name !== undefined) add("name", updates.name);
  if (updates.description !== undefined) add("description", updates.description);
  if (updates.status !== undefined) add("status", updates.status);
  if (updates.previewDomain !== undefined) add("preview_domain", updates.previewDomain);
  if (updates.previewPort !== undefined) add("preview_port", updates.previewPort);
  if (updates.previewUrl !== undefined) add("preview_url", updates.previewUrl);
  if (updates.devServerRunning !== undefined) add("dev_server_running", updates.devServerRunning);
  if (updates.lastError !== undefined) add("last_error", updates.lastError);
  if (updates.sandboxId !== undefined) add("sandbox_id", updates.sandboxId);
  if (updates.sandboxSlug !== undefined) add("sandbox_slug", updates.sandboxSlug);
  if (updates.vmId !== undefined) add("vm_id", updates.vmId);
  if (updates.vmSlug !== undefined) add("vm_slug", updates.vmSlug);
  if (updates.lastAccessedAt !== undefined) add("last_accessed_at", updates.lastAccessedAt);
  if (updates.isHibernated !== undefined) add("is_hibernated", updates.isHibernated);
  if (updates.bootupType !== undefined) add("bootup_type", updates.bootupType);
  if (updates.isUpToDate !== undefined) add("is_up_to_date", updates.isUpToDate);
  if (set.length === 0) return null;
  vals.push(id);
  const res = await query(
    `UPDATE projects SET ${set.join(", ")} WHERE id = $${vals.length} RETURNING id, slug, name, description, user_id, sandbox_id, sandbox_slug, vm_id, vm_slug, status, preview_domain, preview_port, preview_url, dev_server_running, last_error, created_at, updated_at, last_accessed_at, is_hibernated, bootup_type, is_up_to_date`,
    vals
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0]!;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    userId: row.user_id,
    sandboxId: row.sandbox_id ?? null,
    sandboxSlug: row.sandbox_slug ?? null,
    vmId: row.vm_id ?? null,
    vmSlug: row.vm_slug ?? null,
    status: row.status as any,
    previewDomain: row.preview_domain ?? null,
    previewPort: row.preview_port ?? null,
    previewUrl: row.preview_url ?? null,
    devServerRunning: row.dev_server_running,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? null,
    isHibernated: row.is_hibernated ?? false,
    bootupType: row.bootup_type as Project["bootupType"],
    isUpToDate: row.is_up_to_date ?? null,
  };
}

export async function deleteProject(id: string): Promise<void> {
  await query(`DELETE FROM projects WHERE id = $1`, [id]);
}

export async function createConversation(
  projectId: string,
  { title, model }: { title: string; model: string }
): Promise<Conversation> {
  const res = await query<{
    id: string;
    project_id: string;
    title: string;
    model: string;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO conversations (project_id, title, model) VALUES ($1, $2, $3) RETURNING id, project_id, title, model, created_at, updated_at`,
    [projectId, title, model]
  );
  return {
    id: res.rows[0]!.id,
    projectId: res.rows[0]!.project_id,
    title: res.rows[0]!.title,
    model: res.rows[0]!.model,
    createdAt: res.rows[0]!.created_at,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function getActiveConversation(projectId: string): Promise<Conversation | null> {
  const res = await query<{
    id: string;
    project_id: string;
    title: string;
    model: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, project_id, title, model, created_at, updated_at FROM conversations WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [projectId]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0]!;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function addMessage(
  conversationId: string,
  {
    role,
    content,
    projectId,
    toolName,
    toolArgs,
    toolResult,
    usage,
  }: {
    role: string;
    content: string | null;
    projectId?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: { success: boolean; result: string };
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  }
): Promise<ChatMessage> {
  const res = await query<{
    id: string;
    conversation_id: string;
    role: string;
    content: string | null;
    tool_name: string | null;
    tool_args: any;
    tool_result: any;
    message_name: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    created_at: string;
  }>(
    `INSERT INTO messages (conversation_id, project_id, role, content, tool_name, tool_args, tool_result, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, conversation_id, role, content, tool_name, tool_args, tool_result, message_name, prompt_tokens, completion_tokens, total_tokens, created_at`,
    [
      conversationId,
      projectId ?? null,
      role,
      content ?? null,
      toolName ?? null,
      toolArgs ? JSON.stringify(toolArgs) : null,
      toolResult ? JSON.stringify(toolResult) : null,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.totalTokens ?? null,
    ]
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content ?? null,
    toolName: row.tool_name ?? undefined,
    toolArgs: row.tool_args ?? undefined,
    toolResult: row.tool_result ?? undefined,
    name: row.message_name ?? null,
    usage: row.prompt_tokens !== null || row.completion_tokens !== null || row.total_tokens !== null
      ? { promptTokens: row.prompt_tokens ?? 0, completionTokens: row.completion_tokens ?? 0, totalTokens: row.total_tokens ?? 0 }
      : null,
    createdAt: row.created_at,
  };
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const res = await query<{
    id: string;
    conversation_id: string;
    role: string;
    content: string | null;
    tool_name: string | null;
    tool_args: any;
    tool_result: any;
    message_name: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    created_at: string;
  }>(
    `SELECT id, conversation_id, role, content, tool_name, tool_args, tool_result, message_name, prompt_tokens, completion_tokens, total_tokens, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );
  return res.rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content ?? null,
    toolName: row.tool_name ?? undefined,
    toolArgs: row.tool_args ?? undefined,
    toolResult: row.tool_result ?? undefined,
    name: row.message_name ?? null,
    usage: row.prompt_tokens !== null || row.completion_tokens !== null || row.total_tokens !== null
      ? { promptTokens: row.prompt_tokens ?? 0, completionTokens: row.completion_tokens ?? 0, totalTokens: row.total_tokens ?? 0 }
      : null,
    createdAt: row.created_at,
  }));
}

export async function getUserSettings(userId: string): Promise<UserSettings | null> {
  const res = await query<{
    user_id: string;
    nim_model: string;
    nim_base_url: string;
    nim_api_key_enc: string | null;
    idle_timeout_seconds: number;
  }>(
    `SELECT user_id, nim_model, nim_base_url, nim_api_key_enc, idle_timeout_seconds FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0]!;
  return {
    id: row.user_id,
    userId: row.user_id,
    nimModel: row.nim_model,
    nimBaseURL: row.nim_base_url,
    nimApiKeyEnc: row.nim_api_key_enc,
    idleTimeoutSeconds: row.idle_timeout_seconds,
  };
}

export async function upsertUserSettings(
  userId: string,
  updates: {
    nimModel?: string;
    nimBaseURL?: string;
    nimApiKeyEnc?: string | null;
    idleTimeoutSeconds?: number;
  }
): Promise<UserSettings> {
  await query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  const set: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    set.push(`${col} = $${vals.length}`);
  };
  if (updates.nimModel !== undefined) add("nim_model", updates.nimModel);
  if (updates.nimBaseURL !== undefined) add("nim_base_url", updates.nimBaseURL);
  if (updates.nimApiKeyEnc !== undefined) add("nim_api_key_enc", updates.nimApiKeyEnc);
  if (updates.idleTimeoutSeconds !== undefined) add("idle_timeout_seconds", updates.idleTimeoutSeconds);
  if (set.length > 0) {
    vals.push(userId);
    await query(`UPDATE user_settings SET ${set.join(", ")} WHERE user_id = $${vals.length}`, vals);
  }
  const res = await query<{
    user_id: string;
    nim_model: string;
    nim_base_url: string;
    nim_api_key_enc: string | null;
    idle_timeout_seconds: number;
  }>(
    `SELECT user_id, nim_model, nim_base_url, nim_api_key_enc, idle_timeout_seconds FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  const row = res.rows[0]!;
  return {
    id: row.user_id,
    userId: row.user_id,
    nimModel: row.nim_model,
    nimBaseURL: row.nim_base_url,
    nimApiKeyEnc: row.nim_api_key_enc,
    idleTimeoutSeconds: row.idle_timeout_seconds,
  };
}
