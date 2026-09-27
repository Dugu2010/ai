/**
 * The R2 mirror: a project's file tree readable without waking a sandbox.
 *
 * This exists because of a specific platform fact — every file operation on
 * `@vercel/sandbox`, reads included, resumes the VM, and listing a directory is
 * implemented as a `find`/`ls` *command*. Serving a cold project's tree from the
 * SDK would therefore spend both provisioned wall clock and Active CPU on
 * something the user only wanted to look at.
 *
 * Two rules keep the mirror honest:
 *
 *  1. It is written through by whoever changes a file, not rebuilt by scanning.
 *     Anything the agent edits lands here in the same operation.
 *  2. It is only trustworthy while it is clean. A command can write files the
 *     mirror never saw, so any `runCommand` marks the project dirty, and a dirty
 *     mirror must not answer a read. Callers ask `isReadable()` before serving.
 */

import type { ObjectStore } from "./object-store.js";

export interface MirrorManifest {
  /** Incremented on every clean→dirty transition; lets a reader detect a race. */
  generation: number;
  syncedAt: string | null;
  dirtyAt: string | null;
  fileCount: number;
  totalBytes: number;
}

export interface MirrorEntry {
  path: string;
  size: number;
  isDirectory: boolean;
}

const EMPTY_MANIFEST: MirrorManifest = {
  generation: 0,
  syncedAt: null,
  dirtyAt: null,
  fileCount: 0,
  totalBytes: 0,
};

export class WorkspaceMirror {
  private readonly store: ObjectStore;
  private readonly rootPrefix: string;
  private readonly workspaceRoot: string;

  constructor(deps: { store: ObjectStore; rootPrefix: string; workspaceRoot: string }) {
    this.store = deps.store;
    this.rootPrefix = deps.rootPrefix.replace(/^\/+|\/+$/g, "");
    this.workspaceRoot = deps.workspaceRoot.replace(/\/+$/, "");
  }

  /** Prefix for everything belonging to one project. */
  projectPrefix(projectId: string): string {
    return `${this.rootPrefix}/projects/${projectId}/`;
  }

  private manifestKey(projectId: string): string {
    return `${this.projectPrefix(projectId)}manifest.json`;
  }

  private dataKey(projectId: string, absolutePath: string): string | null {
    const relative = this.relative(absolutePath);
    if (relative === null) return null;
    return `${this.projectPrefix(projectId)}files/${relative}`;
  }

  /** Absolute workspace path → bucket-relative key, refusing anything that escapes. */
  private relative(absolutePath: string): string | null {
    if (typeof absolutePath !== "string" || absolutePath.length === 0) return null;
    const normalised = absolutePath.replace(/\/{2,}/g, "/");
    if (normalised.includes("..")) return null;
    if (normalised === this.workspaceRoot) return "";
    const prefix = `${this.workspaceRoot}/`;
    if (!normalised.startsWith(prefix)) return null;
    return normalised.slice(prefix.length);
  }

  private absolute(projectId: string, key: string): string | null {
    const marker = `${this.projectPrefix(projectId)}files/`;
    if (!key.startsWith(marker)) return null;
    const relative = key.slice(marker.length);
    return relative ? `${this.workspaceRoot}/${relative}` : null;
  }

  async readManifest(projectId: string): Promise<MirrorManifest> {
    const bytes = await this.store.get(this.manifestKey(projectId));
    if (!bytes) return { ...EMPTY_MANIFEST };
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Partial<MirrorManifest>;
      return {
        generation: Number(parsed.generation) || 0,
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : null,
        dirtyAt: typeof parsed.dirtyAt === "string" ? parsed.dirtyAt : null,
        fileCount: Number(parsed.fileCount) || 0,
        totalBytes: Number(parsed.totalBytes) || 0,
      };
    } catch {
      // A corrupt manifest is treated as dirty rather than as an empty clean
      // mirror: answering a read with "no files" would look like data loss.
      return { ...EMPTY_MANIFEST, dirtyAt: new Date().toISOString() };
    }
  }

  private async writeManifest(projectId: string, manifest: MirrorManifest): Promise<void> {
    await this.store.put(this.manifestKey(projectId), JSON.stringify(manifest), "application/json");
  }

  /**
   * Whether the mirror may answer reads for this project.
   *
   * False when never synced, when a command ran since the last sync, or when no
   * sync marker exists at all. Callers fall back to the sandbox in that case and
   * pay for it, which is the correct trade: a stale tree is worse than a slow one.
   */
  async isReadable(projectId: string): Promise<boolean> {
    const manifest = await this.readManifest(projectId);
    return manifest.syncedAt !== null && manifest.dirtyAt === null;
  }

  async readFile(projectId: string, absolutePath: string): Promise<Buffer | null> {
    const key = this.dataKey(projectId, absolutePath);
    if (!key) return null;
    return this.store.get(key);
  }

  async stat(projectId: string, absolutePath: string): Promise<{ size: number } | null> {
    const key = this.dataKey(projectId, absolutePath);
    if (!key) return null;
    return this.store.head(key);
  }

  /** One-level listing of a directory, derived from key shapes rather than a scan API. */
  async list(projectId: string, absoluteDir: string): Promise<MirrorEntry[] | null> {
    const relative = this.relative(absoluteDir);
    if (relative === null) return null;
    const marker = `${this.projectPrefix(projectId)}files/`;
    const prefix = relative ? `${marker}${relative}/` : marker;
    const objects = await this.store.list(prefix);
    if (objects.length === 0 && absoluteDir !== this.workspaceRoot) {
      // An empty result is ambiguous: it can mean an empty directory or a
      // directory that was never mirrored. Let the caller decide.
      return [];
    }
    const entries = new Map<string, MirrorEntry>();
    for (const object of objects) {
      const path = this.absolute(projectId, object.key);
      if (!path) continue;
      const rest = path.slice(absoluteDir === this.workspaceRoot ? this.workspaceRoot.length + 1 : absoluteDir.length + 1);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        entries.set(rest, { path, size: object.size, isDirectory: false });
      } else {
        const name = rest.slice(0, slash);
        const dirPath = `${absoluteDir === this.workspaceRoot ? this.workspaceRoot : absoluteDir}/${name}`;
        if (!entries.has(name)) entries.set(name, { path: dirPath, size: 0, isDirectory: true });
      }
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async putFile(projectId: string, absolutePath: string, content: string | Uint8Array): Promise<void> {
    const key = this.dataKey(projectId, absolutePath);
    if (!key) throw new Error(`refusing to mirror a path outside the workspace: ${absolutePath}`);
    await this.store.put(key, content);
    await this.touchManifest(projectId);
  }

  async deleteFile(projectId: string, absolutePath: string): Promise<void> {
    const key = this.dataKey(projectId, absolutePath);
    if (!key) return;
    await this.store.delete(key);
    await this.touchManifest(projectId);
  }

  /** Delete every mirrored path under a directory (for renames and removals). */
  async deleteTree(projectId: string, absoluteDir: string): Promise<void> {
    const key = this.dataKey(projectId, absoluteDir);
    if (!key) return;
    await this.store.deletePrefix(`${key}/`);
    await this.touchManifest(projectId);
  }

  /**
   * Recompute the sync marker from what is actually in the bucket.
   *
   * Cost is one listing plus one small write, both on Cloudflare, so this is the
   * cheap path; a full re-scan of the sandbox is the expensive one it replaces.
   */
  private async touchManifest(projectId: string): Promise<void> {
    const previous = await this.readManifest(projectId);
    const objects = await this.store.list(`${this.projectPrefix(projectId)}files/`);
    await this.writeManifest(projectId, {
      generation: previous.generation,
      syncedAt: new Date().toISOString(),
      dirtyAt: null,
      fileCount: objects.length,
      totalBytes: objects.reduce((total, object) => total + object.size, 0),
    });
  }

  /**
   * Mark the mirror untrustworthy after something ran a command.
   *
   * Idempotent, and deliberately does not clear `syncedAt`: the bytes are still
   * there, they are just no longer known to be complete.
   */
  async markDirty(projectId: string): Promise<void> {
    const manifest = await this.readManifest(projectId);
    if (manifest.dirtyAt !== null) return;
    await this.writeManifest(projectId, {
      ...manifest,
      generation: manifest.generation + 1,
      dirtyAt: new Date().toISOString(),
    });
  }

  async markClean(projectId: string): Promise<void> {
    await this.touchManifest(projectId);
  }

  async totalBytes(projectId: string): Promise<number | null> {
    const manifest = await this.readManifest(projectId);
    if (manifest.syncedAt === null) return null;
    return manifest.totalBytes;
  }

  /** Server-side copy of one project's mirror into another. Used by fork. */
  async copyProject(sourceProjectId: string, targetProjectId: string): Promise<void> {
    const sourceMarker = `${this.projectPrefix(sourceProjectId)}files/`;
    const objects = await this.store.list(sourceMarker);
    for (const object of objects) {
      const path = this.absolute(sourceProjectId, object.key);
      if (!path) continue;
      const targetKey = this.dataKey(targetProjectId, path);
      if (!targetKey) continue;
      await this.store.copy(object.key, targetKey);
    }
    await this.touchManifest(targetProjectId);
  }

  async purgeProject(projectId: string): Promise<void> {
    await this.store.deletePrefix(this.projectPrefix(projectId));
  }
}
