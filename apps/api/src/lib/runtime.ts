/**
 * DAI's runtime service: binds the provider-neutral Modal runtime to the
 * project rows in PostgreSQL.
 *
 * PostgreSQL is the authoritative project-to-Sandbox mapping. Modal's own
 * name lookup only resolves while a Sandbox is running, and tag listing is a
 * recovery aid, so neither is trusted as the source of truth.
 */

import {
  ModalProvider,
  ModalRuntimeService,
  RuntimeOperationError,
  configFromEnv,
  volumeSubPath,
  type ModalRuntimeConfig,
  type Workspace,
} from "@dai/modal";
import { getProject, pool, updateProject } from "@dai/db";

let service: ModalRuntimeService | null = null;
let cachedConfig: ModalRuntimeConfig | null = null;

/**
 * Runtime tuning is pure configuration and must resolve without credentials,
 * so routes can read it at import time. Building the actual client is separate
 * and lazy — see runtimeService().
 */
export function runtimeConfig(): ModalRuntimeConfig {
  if (!cachedConfig) cachedConfig = configFromEnv();
  return cachedConfig;
}

export function runtimeDefaultPort(): number {
  return runtimeConfig().previewPorts[0] ?? 3_000;
}

/** Credentials never leave Render: the SDK reads MODAL_TOKEN_ID/MODAL_TOKEN_SECRET. */
export function isRuntimeConfigured(): boolean {
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}

function runtimeService(): ModalRuntimeService {
  if (service) return service;
  if (!isRuntimeConfigured()) {
    throw new RuntimeOperationError(
      "No execution runtime is configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the backend.",
      "unavailable"
    );
  }
  service = new ModalRuntimeService({ provider: new ModalProvider({ config: runtimeConfig() }) });
  return service;
}

/**
 * Serialize runtime acquisition per project so two simultaneous requests cannot
 * each create a Sandbox and end up with two writers on one workspace.
 */
async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // pg_advisory_xact_lock only persists for a transaction, so the lock and
    // the work it protects must share one explicit transaction.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dai-runtime:${projectId}`]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface AcquiredWorkspace {
  workspace: Workspace;
  /** True when the Sandbox already existed and was reattached. */
  reattached: boolean;
}

/**
 * Get a usable Sandbox for a project, creating one only when the stored handle
 * is absent or has finished. Called once per agent run, never per command.
 */
export async function acquireWorkspace(projectId: string): Promise<AcquiredWorkspace> {
  const service = runtimeService();
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project) {
      throw new RuntimeOperationError(`Project ${projectId} no longer exists`, "not_found");
    }

    // Only trust a stored handle from the current provider; a retired
    // CodeSandbox id would be meaningless to Modal.
    const priorSandboxId = project.runtimeProvider === "modal" ? project.sandboxId : null;
    const workspace = await service.acquire({ projectId, existingSandboxId: priorSandboxId });
    const reattached = priorSandboxId !== null && workspace.sandboxId === priorSandboxId;

    await updateProject(projectId, {
      sandboxId: workspace.sandboxId,
      runtimeProvider: "modal",
      runtimeVolumeSubPath: volumeSubPath(projectId),
      bootupType: reattached ? "RESUME" : "CLEAN",
      isHibernated: false,
      isUpToDate: true,
      status: "ready",
      lastAccessedAt: new Date().toISOString(),
      lastError: null,
    });

    return { workspace, reattached };
  });
}


export async function releaseWorkspace(workspace: Workspace): Promise<void> {
  workspace.close();
}

/** Terminate live compute for a project. The Volume and its files are untouched. */
export async function terminateRuntime(projectId: string): Promise<void> {
  const service = runtimeService();
  await service.destroy(projectId);
  await updateProject(projectId, {
    sandboxId: null,
    isHibernated: true,
    devServerRunning: false,
    bootupType: null,
  });
}

/** Read-only liveness, never creating or waking anything. */
export async function runtimeState(projectId: string): Promise<"running" | "stopped" | "provisioning" | "unreachable"> {
  if (!isRuntimeConfigured()) return "unreachable";
  const project = await getProject(projectId);
  if (!project) return "provisioning";
  if (!project.sandboxId || project.runtimeProvider !== "modal") return "provisioning";
  return runtimeService().status(projectId, project.sandboxId);
}

/** Server-side workspace copy inside the shared Volume. Used by fork. */
export async function duplicateProjectWorkspace(
  sourceProjectId: string,
  targetProjectId: string
): Promise<void> {
  await runtimeService().duplicateWorkspace(sourceProjectId, targetProjectId);
}

/**
 * Refuse a run that has already outgrown its storage allowance.
 *
 * The check reads only Postgres, so enforcing the quota never costs compute.
 * The measurement it guards comes from a `du` run on a Sandbox that was already
 * attached for other reasons.
 */
export async function assertWithinStorageQuota(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) {
    throw new RuntimeOperationError(`Project ${projectId} no longer exists`, "not_found");
  }
  const limit = runtimeConfig().maxProjectWorkspaceBytes;
  const used = project.workspaceBytes;
  if (used !== null && used >= limit) {
    throw new RuntimeOperationError(
      `This project's workspace is at its storage limit (${formatBytes(used)} of ${formatBytes(limit)}). ` +
        "Delete files or remove the project before running more work.",
      "too_large"
    );
  }
}

/** Store a usage measurement taken on the Sandbox this run already holds. */
export async function recordWorkspaceUsage(
  workspace: Workspace,
  projectId: string
): Promise<number | null> {
  const bytes = await workspace.workspaceUsageBytes();
  if (bytes === null) return null;
  await updateProject(projectId, {
    workspaceBytes: bytes,
    workspaceMeasuredAt: new Date().toISOString(),
  });
  return bytes;
}

export function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Permanently discard a project's durable workspace. Destructive. */
export async function purgeRuntimeWorkspace(projectId: string): Promise<void> {
  if (!isRuntimeConfigured()) return;
  const service = runtimeService();
  await service.destroy(projectId);
  await service.purgeWorkspace(projectId);
}

export { RuntimeOperationError };
