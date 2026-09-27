/**
 * DAI's runtime service: binds a provider-neutral runtime to the project rows in
 * PostgreSQL, and keeps the monthly compute ledger honest.
 *
 * PostgreSQL is the authoritative project-to-Sandbox mapping. A provider's own
 * name lookup only resolves while a machine is running, so it is never trusted as
 * the source of truth.
 *
 * Which provider is live is configuration, not code: `RUNTIME_PROVIDER` selects
 * it. The default stays `modal` until the data migration has run, because rows
 * holding a Modal sandbox id cannot be resumed by Vercel and vice versa.
 */

import {
  ModalProvider,
  ModalRuntimeService,
  configFromEnv as modalConfigFromEnv,
  volumeSubPath,
  type ModalRuntimeConfig,
} from "@dai/modal";
import {
  CheckpointBlobs,
  S3ObjectStore,
  VercelRuntimeService,
  WorkspaceMirror,
  configFromEnv as vercelConfigFromEnv,
  isMirrorConfigured,
  type MonthlyBudget,
  type VercelRuntimeConfig,
  type VercelWorkspace,
} from "@dai/vercel";
import { RuntimeOperationError, type RuntimeService, type Workspace } from "@dai/runtime";
import {
  getProject,
  getProjectByUser,
  pool,
  setCheckpointImageStore,
  startUsageSession,
  updateProject,
} from "@dai/db";
import type { Project } from "@dai/types";

export type ProviderKind = "modal" | "vercel";

export function runtimeProvider(): ProviderKind {
  return (process.env.RUNTIME_PROVIDER ?? "vercel").trim().toLowerCase() === "modal" ? "modal" : "vercel";
}

/** The tuning both providers expose, so routes do not branch on which is live. */
export interface RuntimeTuning {
  previewPorts: number[];
  workspacePath: string;
  maxProjectWorkspaceBytes: number;
}

let service: RuntimeService | null = null;
let cachedModalConfig: ModalRuntimeConfig | null = null;
let cachedVercelConfig: VercelRuntimeConfig | null = null;

function modalConfig(): ModalRuntimeConfig {
  if (!cachedModalConfig) cachedModalConfig = modalConfigFromEnv();
  return cachedModalConfig;
}

function vercelConfig(): VercelRuntimeConfig {
  if (!cachedVercelConfig) cachedVercelConfig = vercelConfigFromEnv();
  return cachedVercelConfig;
}

/**
 * Runtime tuning is pure configuration and must resolve without credentials,
 * so routes can read it at import time. Building the actual client is separate
 * and lazy — see runtimeService().
 */
export function runtimeConfig(): RuntimeTuning {
  if (runtimeProvider() === "vercel") {
    const config = vercelConfig();
    return {
      previewPorts: config.previewPorts,
      workspacePath: config.workspacePath,
      maxProjectWorkspaceBytes: config.maxProjectWorkspaceBytes,
    };
  }
  const config = modalConfig();
  return {
    previewPorts: config.previewPorts,
    workspacePath: config.workspacePath,
    maxProjectWorkspaceBytes: config.maxProjectWorkspaceBytes,
  };
}

/**
 * The monthly budget, or null when Vercel is not the live provider.
 *
 * Callers must treat null as "no budget to report" rather than "nothing spent":
 * on Modal there is no allowance to approach, and reporting one would be a
 * number invented for the user.
 */
export function runtimeBudgetConfig(): { budget: MonthlyBudget } | null {
  return runtimeProvider() === "vercel" ? { budget: vercelConfig().budget } : null;
}

export function runtimeDefaultPort(): number {
  return runtimeConfig().previewPorts[0] ?? 3_000;
}

/** Credentials never leave Render: each provider reads its own from the environment. */
export function isRuntimeConfigured(): boolean {
  if (runtimeProvider() === "vercel") {
    return Boolean(process.env.VERCEL_TOKEN || (process.env.VERCEL_OIDC_TOKEN && process.env.VERCEL_PROJECT_ID));
  }
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}

/**
 * Point checkpoint file images at object storage, if it is configured.
 *
 * Independent of the execution provider on purpose: image bytes are large,
 * immutable and read rarely, so they belong in R2 whether the sandboxes are
 * Modal's or Vercel's. Called once at boot; with no R2 credentials nothing is
 * wired and checkpoints keep storing images inline in Postgres.
 */
export function configureCheckpointImages(): boolean {
  const config = vercelConfig();
  if (!isMirrorConfigured(config)) return false;
  const store = S3ObjectStore.forR2({
    accountId: config.r2.accountId,
    bucket: config.r2.bucket,
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  });
  setCheckpointImageStore(new CheckpointBlobs({ store, rootPrefix: config.r2.rootPrefix }));
  return true;
}

/** A configured R2 mirror, or null. Cold reads depend on this being present. */
let cachedMirror: WorkspaceMirror | null | undefined;
export function workspaceMirror(): WorkspaceMirror | null {
  if (cachedMirror !== undefined) return cachedMirror;
  const config = vercelConfig();
  cachedMirror = isMirrorConfigured(config)
    ? new WorkspaceMirror({
        store: S3ObjectStore.forR2({
          accountId: config.r2.accountId,
          bucket: config.r2.bucket,
          accessKeyId: config.r2.accessKeyId,
          secretAccessKey: config.r2.secretAccessKey,
        }),
        rootPrefix: config.r2.rootPrefix,
        workspaceRoot: config.workspacePath,
      })
    : null;
  return cachedMirror;
}

/**
 * A project whose files can be answered from object storage, with no compute.
 *
 * Three conditions must all hold, and each one is a different way this could
 * otherwise be wrong: the caller must own the project; no machine may already be
 * live, because then the live tree is the source of truth and a mirror is by
 * definition a moment behind it; and the mirror must be clean, since a command
 * may have written files nobody reported to it.
 *
 * Returning null is always safe — the caller falls back to attaching compute and
 * pays for it. Returning a project when the tree is stale is not.
 */
export async function coldMirrorProject(
  projectId: string,
  userId: string
): Promise<{ project: Project } | null> {
  if (runtimeProvider() !== "vercel") return null;
  const mirror = workspaceMirror();
  if (!mirror) return null;
  const project = await getProjectByUser(projectId, userId);
  if (!project) return null;
  if ((await runtimeState(project.id)) === "running") return null;
  if (!(await mirror.isReadable(project.id))) return null;
  return { project };
}

function runtimeService(): RuntimeService {
  if (service) return service;
  if (!isRuntimeConfigured()) {
    const provider = runtimeProvider();
    throw new RuntimeOperationError(
      provider === "vercel"
        ? "No execution runtime is configured. Set VERCEL_TOKEN (and R2 credentials for the workspace mirror) on the backend."
        : "No execution runtime is configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the backend.",
      "unavailable"
    );
  }
  if (runtimeProvider() === "vercel") {
    const config = vercelConfig();
    const mirror = workspaceMirror();
    service = new VercelRuntimeService({ config, ...(mirror ? { mirror } : {}) });
  } else {
    service = new ModalRuntimeService({ provider: new ModalProvider({ config: modalConfig() }) });
  }
  return service;
}

/** A live Vercel handle exposes usage; a Modal one does not and needs no ledger. */
function asVercelWorkspace(workspace: Workspace): VercelWorkspace | null {
  return runtimeProvider() === "vercel" ? (workspace as VercelWorkspace) : null;
}

interface OpenSession {
  usageId: number;
  userId: string;
  vcpus: number;
  /** The sandbox's own Active-CPU counter at the moment this session opened. */
  cpuBaselineMs: number;
}

const openSessions = new Map<string, OpenSession>();


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
export async function acquireWorkspace(projectId: string, resourceTier?: number): Promise<AcquiredWorkspace> {
  // Before the lock and before any create: a refusal issued after a machine
  // exists is not a refusal, it is a bill.
  const { allowsEscalation, assertWithinComputeBudget } = await import("./cost-governor.js");
  const headroom = await assertWithinComputeBudget();
  const service = runtimeService();
  const provider = runtimeProvider();
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project) {
      throw new RuntimeOperationError(`Project ${projectId} no longer exists`, "not_found");
    }

    // Only trust a stored handle from the provider that is live now. A Modal
    // sandbox id means nothing to Vercel and a retired CodeSandbox id means
    // nothing to either, so a mismatched row simply creates a new machine.
    const priorSandboxId = project.runtimeProvider === provider ? project.sandboxId : null;
    // Absent means "however big this project last needed", not "smallest":
    // escalation is persisted so a project that keeps timing out is not made to
    // rediscover the same limit on every new run.
    // Past the throttle line the stored tier is ignored outright. A project that
    // earned a bigger machine in a cheaper month still gets the small one while
    // the allowance is nearly gone, because the ceiling is monthly, not lifetime.
    const preferred = resourceTier ?? project.runtimeResourceTier ?? 0;
    const tier = allowsEscalation(headroom.level) ? preferred : 0;
    const detailed = "acquireDetailed" in service ? (service as VercelRuntimeService) : null;
    const acquired = detailed
      ? await detailed.acquireDetailed({ projectId, existingSandboxId: priorSandboxId, resourceTier: tier })
      : {
          workspace: await service.acquire({ projectId, existingSandboxId: priorSandboxId, resourceTier }),
          reattached: false,
          vcpus: 1,
        };
    const { workspace } = acquired;
    const reattached = acquired.reattached || (priorSandboxId !== null && workspace.sandboxId === priorSandboxId);

    await updateProject(projectId, {
      sandboxId: workspace.sandboxId,
      runtimeProvider: provider,
      runtimeVolumeSubPath: provider === "vercel" ? `projects/${projectId}` : volumeSubPath(projectId),
      bootupType: reattached ? "RESUME" : "CLEAN",
      isHibernated: false,
      isUpToDate: true,
      status: "ready",
      lastAccessedAt: new Date().toISOString(),
      lastError: null,
    });

    if (provider === "vercel") await openUsageRow(projectId, project.userId, workspace, reattached, acquired.vcpus);
    return { workspace, reattached };
  });
}

/**
 * Begin a ledger row for a session.
 *
 * The creation is charged here and once, because the allowance counts boots and
 * resumes differently and a resume must not be billed as a new machine.
 */
async function openUsageRow(
  projectId: string,
  userId: string,
  workspace: Workspace,
  reattached: boolean,
  vcpus: number
): Promise<void> {
  if (openSessions.has(projectId)) return;
  const handle = asVercelWorkspace(workspace);
  if (!handle) return;
  try {
    const usageId = await startUsageSession(
      { projectId, userId, runId: null, sandboxName: handle.sandboxId, kind: "agent", vcpus },
      { chargedCreation: !reattached }
    );
    openSessions.set(projectId, {
      usageId,
      userId,
      vcpus,
      // The counter belongs to the sandbox, not to this session: a reattached
      // machine already carries what it spent before we asked for it. Charging
      // the raw number would bill this run for its predecessor.
      cpuBaselineMs: handle.activeCpuUsageMs,
    });
  } catch (error) {
    // A ledger that cannot be written must not stop work from proceeding, but it
    // must say so: an unrecorded session is an understated month.
    console.warn("[runtime] usage session not recorded:", error instanceof Error ? error.message : error);
  }
}

/**
 * Close a session's ledger row.
 *
 * One close, with the platform's own numbers, rather than a running sample: the
 * row's wall clock is derived in Postgres from when it opened, and Active CPU
 * comes from the sandbox itself, so there is nothing to accumulate and no
 * interval to double-count.
 */
async function closeUsageRow(projectId: string, workspace: Workspace | undefined): Promise<void> {
  const session = openSessions.get(projectId);
  if (!session) return;
  openSessions.delete(projectId);
  try {
    const { closeUsageSession, usageRowAgeMs } = await import("@dai/db");
    const provisionedMs = await usageRowAgeMs(session.usageId);
    const spentMs = workspace ? asVercelWorkspace(workspace)?.activeCpuUsageMs : undefined;
    await closeUsageSession(
      session.usageId,
      {
        // Delta against the baseline, clamped: a resumed sandbox restarts its
        // counter, and going backwards must not credit the month.
        activeCpuMs: typeof spentMs === "number" ? Math.max(0, spentMs - session.cpuBaselineMs) : 0,
        provisionedMs,
        // The SDK reports no egress figure, so this stays 0 and the egress
        // ceiling is reported rather than enforced. Stated here so nobody reads
        // a zero as "nothing was transferred".
        egressBytes: 0,
      },
      { vcpus: session.vcpus }
    );
  } catch (error) {
    console.warn("[runtime] usage session not closed:", error instanceof Error ? error.message : error);
  }
}

export async function releaseWorkspace(workspace: Workspace): Promise<void> {
  // Releasing a handle does not stop the machine: the project keeps its sandbox
  // until it is terminated or the provider reclaims it, and the ledger row stays
  // open to reflect exactly that.
  workspace.close();
}

/** Terminate live compute for a project. The Volume and its files are untouched. */
export async function terminateRuntime(projectId: string, workspace?: Workspace): Promise<void> {
  const service = runtimeService();
  await service.destroy(projectId);
  await closeUsageRow(projectId, workspace);
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
  if (!project.sandboxId || project.runtimeProvider !== runtimeProvider()) return "provisioning";
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
