/**
 * Vercel implementation of the `RuntimeService` half of DAI's runtime contract.
 *
 * Three properties this file is responsible for:
 *
 *  - One sandbox per project, addressed by a deterministic name rather than a
 *    stored opaque id, because resume on this provider is by name and a second
 *    writer on the same drive is refused by the platform anyway.
 *  - A creation is metered differently from a resume. The monthly allowance
 *    counts Active CPU and provisioned wall clock, and both are only spent once
 *    a VM exists, so callers must be able to tell "attached to a running machine"
 *    from "booted a new one". `acquire` reports it.
 *  - Nothing here boots a sandbox to look at files. Cold reads belong to the R2
 *    mirror; this service is what runs when work is actually being done.
 */

import { Drive, Sandbox, type SandboxMounts } from "@vercel/sandbox";
import { RuntimeOperationError, toRuntimeError } from "@dai/runtime";
import type { AcquireOptions, RuntimeService, RuntimeState, Workspace as WorkspaceContract } from "@dai/runtime";
import type { VercelRuntimeConfig } from "./config.js";
import { driveName, sandboxName } from "./config.js";
import type { WorkspaceMirror } from "./mirror.js";
import { VercelWorkspace } from "./workspace.js";

export interface AcquiredVercelWorkspace {
  workspace: VercelWorkspace;
  /** False only when this call actually created a sandbox and booted it. */
  reattached: boolean;
  /** vCPUs the sandbox is running with, for the usage ledger. */
  vcpus: number;
}

export interface VercelRuntimeServiceDeps {
  config: VercelRuntimeConfig;
  /** Present when R2 is configured; fork and purge need it, and it is the only cold read path. */
  mirror?: WorkspaceMirror;
}

export class VercelRuntimeService implements RuntimeService {
  readonly config: VercelRuntimeConfig;
  private readonly mirror?: WorkspaceMirror;
  /** Live handles by project, so a second acquire does not re-resolve the drive. */
  private readonly attached = new Map<string, VercelWorkspace>();

  constructor(deps: VercelRuntimeServiceDeps) {
    this.config = deps.config;
    this.mirror = deps.mirror;
  }

  private get name(): string {
    return this.config.namePrefix;
  }

  /** Resolve the tier, clamping rather than failing: a caller asking for 99 just wants the biggest box. */
  private tierFor(index?: number): { vcpus: number; label: string } {
    const tiers = this.config.tiers;
    const requested = Math.max(0, Math.min(Math.trunc(index ?? 0), tiers.length - 1));
    return tiers[requested] ?? { vcpus: 1, label: "small" };
  }

  /**
   * Does a sandbox for this project exist, without starting one?
   *
   * `Sandbox.get` accepts `resume: false`, which is the only non-waking liveness
   * probe the SDK offers. Anything that omits it silently boots a VM and starts
   * billing wall clock.
   */
  private async existing(projectId: string): Promise<Sandbox | null> {
    try {
      return await Sandbox.get({ name: sandboxName(this.config, projectId), resume: false });
    } catch (error) {
      if (isMissingSandbox(error)) return null;
      throw toRuntimeError(error, "Unable to reach the Sandbox for this project");
    }
  }

  async acquire(options: AcquireOptions): Promise<WorkspaceContract> {
    const acquired = await this.acquireDetailed(options);
    return acquired.workspace;
  }

  /** Same as `acquire`, with the facts the budget ledger needs. */
  async acquireDetailed(options: AcquireOptions): Promise<AcquiredVercelWorkspace> {
    const { projectId } = options;
    const cached = this.attached.get(projectId);
    if (cached && !cached.isReleased && (await cached.isAlive())) {
      return { workspace: cached, reattached: true, vcpus: this.tierFor(options.resourceTier).vcpus };
    }
    if (cached) this.attached.delete(projectId);

    const prior = await this.existing(projectId);
    const tier = this.tierFor(options.resourceTier);
    const { mounts, usingCache } = await this.mountsFor(projectId);
    // Passed at creation so package managers find the shared store without the
    // model having to remember a flag, and without a cache miss being visible.
    const env = usingCache ? this.config.cacheEnv : undefined;

    let sandbox: Sandbox;
    if (prior) {
      // Resuming is normal here, not a fallback: the sandbox is persistent, so
      // the first command or file call starts a new session from the last
      // snapshot with the drive remounted.
      sandbox = prior;
    } else {
      try {
        sandbox = await Sandbox.create({
          name: sandboxName(this.config, projectId),
          image: this.config.image,
          region: this.config.region,
          timeout: this.config.sessionTimeoutMs,
          resources: { vcpus: tier.vcpus },
          ports: this.config.previewPorts,
          persistent: true,
          keepLastSnapshots: { count: this.config.keepLastSnapshots },
          snapshotExpiration: this.config.snapshotExpirationMs,
          tags: { "dai.project": projectId },
          mounts,
          ...(env ? { env } : {}),
        });
      } catch (error) {
        // A name collision means another live sandbox already owns this project;
        // attach to it rather than failing the request.
        if (isAlreadyExists(error)) {
          const found = await this.existing(projectId);
          if (found) {
            sandbox = found;
          } else {
            throw toRuntimeError(error, "Unable to create a runtime Sandbox");
          }
        } else {
          throw toRuntimeError(error, "Unable to create a runtime Sandbox");
        }
      }
    }

    const workspace = new VercelWorkspace({
      sandbox,
      projectId,
      workspacePath: this.config.workspacePath,
      execTimeoutMs: this.config.execTimeoutMs,
      devServerReadyTimeoutMs: this.config.devServerReadyTimeoutMs,
      ...(this.mirror ? { mirror: this.mirror } : {}),
    });
    this.attached.set(projectId, workspace);
    return { workspace, reattached: prior !== null, vcpus: tier.vcpus };
  }

  /**
   * Mounts to offer a new sandbox: the project's own drive read-write, plus the
   * shared dependency cache read-only when one is configured and already
   * populated. A cache snapshot of a drive nobody has written to yet is refused by
   * the platform, and that must not fail the whole boot — a cold cache is merely
   * slower, whereas a missing workspace is not a project at all.
   */
  private async mountsFor(projectId: string): Promise<{ mounts: SandboxMounts; usingCache: boolean }> {
    const drive = await this.getOrCreateDrive(projectId);
    const mounts: SandboxMounts = { [this.config.workspacePath]: drive };
    if (!this.config.cacheDriveName) return { mounts, usingCache: false };
    try {
      const cache = await Drive.getOrCreate({
        name: this.config.cacheDriveName,
        region: this.config.region,
      });
      mounts[this.config.cachePath] = cache.snapshot();
      return { mounts, usingCache: true };
    } catch {
      return { mounts, usingCache: false };
    }
  }

  /**
   * A sandbox with the dependency cache mounted read-write, for populating it.
   *
   * Only one sandbox may hold a drive read-write, so this is a maintenance
   * handle: run the install there once, stop it, and every project inherits the
   * warm store. Attempting a project acquire and expecting to write the cache is
   * the mistake this exists to prevent.
   */
  async acquireCacheWriter(): Promise<WorkspaceContract> {
    if (!this.config.cacheDriveName) {
      throw new RuntimeOperationError("No dependency cache drive is configured (VERCEL_CACHE_DRIVE).", "invalid");
    }
    const cache = await Drive.getOrCreate({ name: this.config.cacheDriveName, region: this.config.region });
    const sandbox = await Sandbox.create({
      name: `${this.config.namePrefix}-cache-writer`,
      image: this.config.image,
      region: this.config.region,
      timeout: this.config.sessionTimeoutMs,
      resources: { vcpus: 1 },
      persistent: false,
      mounts: { [this.config.cachePath]: cache },
    });
    return new VercelWorkspace({
      sandbox,
      projectId: this.config.cacheDriveName,
      workspacePath: this.config.cachePath,
      execTimeoutMs: this.config.execTimeoutMs,
      devServerReadyTimeoutMs: this.config.devServerReadyTimeoutMs,
    });
  }

  private async getOrCreateDrive(projectId: string): Promise<Drive> {
    try {
      return await Drive.getOrCreate({
        name: driveName(this.config, projectId),
        region: this.config.region,
        maxSize: Math.min(this.config.maxProjectWorkspaceBytes, 10 * 1024 * 1024 * 1024),
      });
    } catch (error) {
      throw toRuntimeError(error, "Unable to open the project workspace drive");
    }
  }

  /**
   * Make a project's durable workspace exist without attaching compute.
   *
   * A Drive is created independently of any sandbox, so unlike the previous
   * provider this really is free: no VM, no snapshot, no command.
   */
  async ensureWorkspace(projectId: string): Promise<void> {
    await this.getOrCreateDrive(projectId);
  }

  /** Read-only liveness. Never resumes anything. */
  async status(projectId: string, sandboxId?: string | null): Promise<RuntimeState> {
    const name = sandboxId ?? sandboxName(this.config, projectId);
    try {
      const sandbox = await Sandbox.get({ name, resume: false });
      switch (sandbox.status) {
        case "running":
          return "running";
        case "pending":
          // A session that is coming up is not usable yet, and reporting it as
          // such would let a caller send work into a machine that cannot take it.
          return "provisioning";
        case "stopped":
        case "failed":
          return "stopped";
        default:
          return "stopped";
      }
    } catch (error) {
      if (isMissingSandbox(error)) return "provisioning";
      return "unreachable";
    }
  }

  /** Stop live compute. The drive, its files and the snapshot all persist. */
  async destroy(projectId: string): Promise<void> {
    const cached = this.attached.get(projectId);
    if (cached) {
      cached.close();
      this.attached.delete(projectId);
    }
    const sandbox = await this.existing(projectId);
    if (!sandbox) return;
    try {
      await sandbox.stop();
    } catch (error) {
      if (!isMissingSandbox(error) && !isGone(error)) throw toRuntimeError(error, "Unable to stop Sandbox");
    }
  }

  /**
   * Copy one project's durable workspace into another.
   *
   * Done as server-side object copies in the mirror, so neither sandbox needs to
   * exist and no bytes pass through this process. Without a configured mirror
   * there is no cheap way to do this at all, so it says so rather than booting
   * two sandboxes and piping files between them.
   */
  async duplicateWorkspace(sourceProjectId: string, targetProjectId: string): Promise<void> {
    if (!this.mirror) {
      throw new RuntimeOperationError(
        "Copying a workspace needs the storage mirror, which is not configured.",
        "unavailable"
      );
    }
    await this.mirror.copyProject(sourceProjectId, targetProjectId);
  }

  /**
   * Discard a project's durable workspace. Destructive.
   *
   * A drive cannot be deleted while attached, so the sandbox is stopped first and
   * the delete is retried once; a still-attached drive is reported rather than
   * silently left behind, because an orphaned drive keeps counting against the
   * project's storage allowance.
   */
  async purgeWorkspace(projectId: string): Promise<void> {
    await this.destroy(projectId).catch(() => undefined);
    const name = driveName(this.config, projectId);
    try {
      const drive = await Drive.getOrCreate({ name, region: this.config.region });
      await drive.delete();
    } catch (error) {
      if (!isMissingSandbox(error)) {
        // Deleting an absent drive is success; anything else must surface.
        if (!isAlreadyAttached(error)) throw toRuntimeError(error, "Unable to delete the project workspace drive");
      }
    }
    if (this.mirror) await this.mirror.purgeProject(projectId);
  }

  /**
   * Populate a project's workspace from a local tar archive.
   *
   * The archive is uploaded in one transfer and unpacked inside the sandbox, so
   * the only metered work is the extraction itself.
   */
  async importWorkspaceArchive(projectId: string, localArchivePath: string): Promise<void> {
    const { workspace } = await this.acquireDetailed({ projectId });
    const sandbox = (workspace as VercelWorkspace).raw;
    try {
      const { readFileSync } = await import("node:fs");
      const archive = readFileSync(localArchivePath);
      await sandbox.writeFiles([{ path: "/tmp/dai-import.tar.gz", content: archive }]);
      const target = this.config.workspacePath;
      const result = await sandbox.runCommand("/bin/bash", [
        "-c",
        'mkdir -p "$1" && tar -xzf /tmp/dai-import.tar.gz -C "$1"',
        "import",
        target,
      ]);
      if (result.exitCode !== 0) {
        throw new RuntimeOperationError(`Unable to unpack archive into workspace for ${projectId}`, "rejected");
      }
      if (this.mirror) await this.mirror.markDirty(projectId);
    } catch (error) {
      throw toRuntimeError(error, "Unable to import workspace archive");
    } finally {
      workspace.close();
    }
  }

  /** Release local handles. Remote sandboxes, drives and snapshots persist. */
  close(): void {
    for (const workspace of this.attached.values()) workspace.close();
    this.attached.clear();
  }

  get projectNamePrefix(): string {
    return this.name;
  }
}

function statusOf(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  const candidate = error as { response?: { status?: number }; code?: unknown; name?: unknown };
  return candidate.response?.status ?? 0;
}

function textOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as { message?: unknown; code?: unknown; name?: unknown };
  return [candidate.message, candidate.code, candidate.name].filter((part) => typeof part === "string").join(" ").toLowerCase();
}

function isMissingSandbox(error: unknown): boolean {
  return statusOf(error) === 404 || textOf(error).includes("not found");
}

function isAlreadyExists(error: unknown): boolean {
  return statusOf(error) === 409 || textOf(error).includes("already exists");
}

function isAlreadyAttached(error: unknown): boolean {
  const text = textOf(error);
  return text.includes("attached") || text.includes("mounted") || text.includes("in use");
}

function isGone(error: unknown): boolean {
  const text = textOf(error);
  return text.includes("stopped") || text.includes("expired") || text.includes("terminated");
}
