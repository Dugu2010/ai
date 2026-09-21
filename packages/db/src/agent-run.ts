/**
 * Persistence for agent runs, the activity timeline and undo checkpoints.
 *
 * These live in PostgreSQL on purpose: reading a run's history, rendering its
 * timeline, showing a diff and undoing work must all be possible without paying
 * for a Modal Sandbox, because on this provider any workspace byte access costs
 * compute.
 */

import { query } from "./client.js";

/* ------------------------------- agent runs ------------------------------- */

export interface AgentRun {
  id: string;
  projectId: string;
  conversationId: string | null;
  userId: string;
  prompt: string;
  state: string;
  outcome: string | null;
  stopReason: string | null;
  iterations: number;
  toolCalls: number;
  execCalls: number;
  runtimeActivations: number;
  runtimeMs: number;
  filesChanged: number;
  sandboxId: string | null;
  budget: Record<string, unknown>;
  summary: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  user_id: string;
  prompt: string;
  state: string;
  outcome: string | null;
  stop_reason: string | null;
  iterations: number;
  tool_calls: number;
  exec_calls: number;
  runtime_activations: number;
  runtime_ms: string | number;
  files_changed: number;
  sandbox_id: string | null;
  budget_json: Record<string, unknown>;
  summary: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function mapRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id ?? null,
    userId: row.user_id,
    prompt: row.prompt,
    state: row.state,
    outcome: row.outcome ?? null,
    stopReason: row.stop_reason ?? null,
    iterations: row.iterations ?? 0,
    toolCalls: row.tool_calls ?? 0,
    execCalls: row.exec_calls ?? 0,
    runtimeActivations: row.runtime_activations ?? 0,
    runtimeMs: Number(row.runtime_ms ?? 0),
    filesChanged: row.files_changed ?? 0,
    sandboxId: row.sandbox_id ?? null,
    budget: row.budget_json ?? {},
    summary: row.summary ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null,
  };
}

export async function createAgentRun(input: {
  projectId: string;
  conversationId: string | null;
  userId: string;
  prompt: string;
  budget: Record<string, unknown>;
  sandboxId: string | null;
}): Promise<AgentRun> {
  const res = await query<RunRow>(
    `INSERT INTO agent_runs (project_id, conversation_id, user_id, prompt, state, budget_json, sandbox_id)
     VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6)
     RETURNING *`,
    [
      input.projectId,
      input.conversationId,
      input.userId,
      input.prompt,
      JSON.stringify(input.budget),
      input.sandboxId,
    ]
  );
  return mapRun(res.rows[0]!);
}

export async function updateAgentRun(
  id: string,
  patch: Partial<{
    state: string;
    outcome: string;
    stopReason: string;
    iterations: number;
    toolCalls: number;
    execCalls: number;
    runtimeActivations: number;
    runtimeMs: number;
    filesChanged: number;
    sandboxId: string;
    budget: Record<string, unknown>;
    summary: string;
    lastError: string;
    finishedAt: string;
  }>
): Promise<void> {
  const columns: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    columns.push(`${column} = $${values.length}`);
  };
  const map: Record<string, string> = {
    state: "state",
    outcome: "outcome",
    stopReason: "stop_reason",
    iterations: "iterations",
    toolCalls: "tool_calls",
    execCalls: "exec_calls",
    runtimeActivations: "runtime_activations",
    runtimeMs: "runtime_ms",
    filesChanged: "files_changed",
    sandboxId: "sandbox_id",
    summary: "summary",
    lastError: "last_error",
    finishedAt: "finished_at",
  };
  for (const [key, column] of Object.entries(map)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) add(column, value);
  }
  if (patch.budget !== undefined) add("budget_json", JSON.stringify(patch.budget));
  if (columns.length === 0) return;
  values.push(id);
  await query(`UPDATE agent_runs SET ${columns.join(", ")}, updated_at = now() WHERE id = $${values.length}`, values);
}

export async function getAgentRun(id: string): Promise<AgentRun | null> {
  const res = await query<RunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [id]);
  return res.rows[0] ? mapRun(res.rows[0]) : null;
}

/** Runs the user may act on: the latest first, capped. */
export async function listAgentRuns(projectId: string, limit = 20): Promise<AgentRun[]> {
  const res = await query<RunRow>(
    `SELECT * FROM agent_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, Math.min(Math.max(limit, 1), 100)]
  );
  return res.rows.map(mapRun);
}

/* ------------------------------ activity events --------------------------- */

export interface ActivityEventRow {
  seq: number;
  event_type: string;
  state: string | null;
  title: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function insertActivityEvent(
  runId: string,
  projectId: string,
  event: { seq: number; type: string; state: string | null; title: string; detail: Record<string, unknown> }
): Promise<void> {
  await query(
    `INSERT INTO activity_events (run_id, project_id, seq, event_type, state, title, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (run_id, seq) DO NOTHING`,
    [runId, projectId, event.seq, event.type, event.state, event.title, JSON.stringify(event.detail ?? {})]
  );
}

/** Highest stored sequence number for a run, so a later writer can continue it. */
export async function maxActivitySeq(runId: string): Promise<number> {
  const res = await query<{ max_seq: string | number | null }>(
    `SELECT MAX(seq) AS max_seq FROM activity_events WHERE run_id = $1`,
    [runId]
  );
  return Number(res.rows[0]?.max_seq ?? 0) || 0;
}

export async function listActivityEvents(runId: string): Promise<ActivityEventRow[]> {
  const res = await query<ActivityEventRow>(
    `SELECT seq, event_type, state, title, detail, created_at FROM activity_events WHERE run_id = $1 ORDER BY seq ASC`,
    [runId]
  );
  return res.rows;
}

/* -------------------------------- checkpoints ----------------------------- */

export interface CheckpointFileRecord {
  path: string;
  changeKind: "create" | "modify" | "delete" | "rename";
  contentBefore: string | null;
  contentAfter: string | null;
  existedBefore: boolean;
  sizeBefore: number;
  sizeAfter: number;
  reversible: boolean;
  skipReason: string | null;
}

export interface CheckpointRecord {
  id: string;
  projectId: string;
  runId: string | null;
  label: string;
  status: string;
  reversible: boolean;
  note: string | null;
  createdAt: string;
  undoneAt: string | null;
  files: CheckpointFileRecord[];
}

interface CheckpointRow {
  id: string;
  project_id: string;
  run_id: string | null;
  label: string;
  status: string;
  reversible: boolean;
  note: string | null;
  created_at: string;
  undone_at: string | null;
}

interface CheckpointFileRow {
  path: string;
  change_kind: string;
  content_before: string | null;
  content_after: string | null;
  existed_before: boolean;
  size_before: string | number;
  size_after: string | number;
  reversible: boolean;
  skip_reason: string | null;
}

function mapFile(row: CheckpointFileRow): CheckpointFileRecord {
  return {
    path: row.path,
    changeKind: row.change_kind as CheckpointFileRecord["changeKind"],
    contentBefore: row.content_before ?? null,
    contentAfter: row.content_after ?? null,
    existedBefore: row.existed_before,
    sizeBefore: Number(row.size_before ?? 0),
    sizeAfter: Number(row.size_after ?? 0),
    reversible: row.reversible,
    skipReason: row.skip_reason ?? null,
  };
}

export async function createCheckpoint(input: {
  projectId: string;
  runId: string | null;
  label: string;
  reversible: boolean;
  note?: string | null;
  files: CheckpointFileRecord[];
}): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO checkpoints (project_id, run_id, label, reversible, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.projectId, input.runId, input.label, input.reversible, input.note ?? null]
  );
  const checkpointId = res.rows[0]!.id;
  for (const file of input.files) {
    await query(
      `INSERT INTO checkpoint_files
         (checkpoint_id, path, change_kind, content_before, content_after,
          existed_before, size_before, size_after, reversible, skip_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        checkpointId,
        file.path,
        file.changeKind,
        file.contentBefore,
        file.contentAfter,
        file.existedBefore,
        file.sizeBefore,
        file.sizeAfter,
        file.reversible,
        file.skipReason,
      ]
    );
  }
  return checkpointId;
}

async function loadFiles(checkpointId: string): Promise<CheckpointFileRecord[]> {
  const res = await query<CheckpointFileRow>(
    `SELECT path, change_kind, content_before, content_after, existed_before,
            size_before, size_after, reversible, skip_reason
       FROM checkpoint_files WHERE checkpoint_id = $1 ORDER BY id ASC`,
    [checkpointId]
  );
  return res.rows.map(mapFile);
}

/**
 * Scoped by project id as well as checkpoint id, so a guessed identifier from
 * another tenant cannot resolve to a restorable set of paths.
 */
export async function getCheckpoint(
  checkpointId: string,
  projectId: string
): Promise<CheckpointRecord | null> {
  const res = await query<CheckpointRow>(
    `SELECT id, project_id, run_id, label, status, reversible, note, created_at, undone_at
       FROM checkpoints WHERE id = $1 AND project_id = $2`,
    [checkpointId, projectId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    label: row.label,
    status: row.status,
    reversible: row.reversible,
    note: row.note ?? null,
    createdAt: row.created_at,
    undoneAt: row.undone_at ?? null,
    files: await loadFiles(row.id),
  };
}

export async function listCheckpoints(
  projectId: string,
  limit = 25
): Promise<Array<Omit<CheckpointRecord, "files"> & { fileCount: number }>> {
  const res = await query<CheckpointRow & { file_count: number }>(
    `SELECT c.id, c.project_id, c.run_id, c.label, c.status, c.reversible, c.note,
            c.created_at, c.undone_at,
            (SELECT COUNT(*)::int FROM checkpoint_files f WHERE f.checkpoint_id = c.id) AS file_count
       FROM checkpoints c
      WHERE c.project_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [projectId, Math.min(Math.max(limit, 1), 100)]
  );
  return res.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    label: row.label,
    status: row.status,
    reversible: row.reversible,
    note: row.note ?? null,
    createdAt: row.created_at,
    undoneAt: row.undone_at ?? null,
    fileCount: row.file_count,
  }));
}

export async function setCheckpointStatus(
  checkpointId: string,
  projectId: string,
  status: "applied" | "undone" | "partial",
  note: string | null
): Promise<void> {
  await query(
    `UPDATE checkpoints
        SET status = $3,
            note = COALESCE($4, note),
            undone_at = CASE WHEN $3 = 'undone' THEN now() ELSE undone_at END
      WHERE id = $1 AND project_id = $2`,
    [checkpointId, projectId, status, note]
  );
}

/** Most recent checkpoint still awaiting undo. */
export async function findLatestAppliedCheckpoint(
  projectId: string
): Promise<CheckpointRecord | null> {
  const res = await query<CheckpointRow>(
    `SELECT id, project_id, run_id, label, status, reversible, note, created_at, undone_at
       FROM checkpoints
      WHERE project_id = $1 AND status = 'applied'
      ORDER BY created_at DESC
      LIMIT 1`,
    [projectId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return getCheckpoint(row.id, projectId);
}

/** Next undone checkpoint, for redo. */
export async function findNextUndoneCheckpoint(
  projectId: string
): Promise<CheckpointRecord | null> {
  const res = await query<CheckpointRow>(
    `SELECT id, project_id, run_id, label, status, reversible, note, created_at, undone_at
       FROM checkpoints
      WHERE project_id = $1 AND status = 'undone'
      ORDER BY undone_at ASC NULLS LAST
      LIMIT 1`,
    [projectId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return getCheckpoint(row.id, projectId);
}

export async function deleteCheckpointsForProject(projectId: string): Promise<void> {
  // Rows cascade from checkpoints -> checkpoint_files, and from projects ->
  // checkpoints, so this is a guard for callers that purge before deleting the
  // project itself.
  await query(`DELETE FROM checkpoints WHERE project_id = $1`, [projectId]);
}
