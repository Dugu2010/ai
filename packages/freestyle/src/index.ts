import { Freestyle } from "freestyle";
import type {
  Vm,
  VmData,
  VmState,
  DirEntry,
  ExecResult as SdkExecResult,
  SnapshotIdOrSlug,
} from "freestyle";

export type { VmState };

export interface ExecResult {
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number | null;
}

export interface PreviewTarget {
  url: string;
  domain: string;
}

const DEFAULT_SNAPSHOT: SnapshotIdOrSlug = "freestyle/ubuntu";

/**
 * Compute an Ubuntu-style shell timeout wrapper: maps a wall-clock limit onto
 * `timeout(1)` so long dev servers are not killed by exec timeouts. Kept for
 * parity with the exec() timeoutMs contract.
 */
export class FreestyleClient {
  private client: Freestyle;
  /** Handle for the VM this client is currently pointed at, if any. */
  private vm: Vm | null = null;
  private vmId: string | null = null;

  constructor(apiKey: string) {
    this.client = new Freestyle({ apiKey });
  }

  // ------------------------------------------------------------------
  // VM lifecycle
  // ------------------------------------------------------------------

  /**
   * Create a VM.
   *
   * Firewall rules are required by the API; we allow the VM outbound public
   * access (so npm/pip installs work) and inbound public HTTP on dev ports
   * (so previews work without a TLS rule).
   *
   * Returns { vmId, slug, state, domain } — `domain` is the *.style.dev
   * ingress domain minted by the create-time TLS rule, which is how the
   * platform expects you to publish a VM's port publicly.
   */
  async createVM(
    slug: string,
    opts: { idleTimeoutSeconds?: number; devPort?: number } = {}
  ): Promise<{ vmId: string; slug: string | null; state: VmState | string; domain: string | null }> {
    const devPort = opts.devPort ?? 3000;
    // Ingress rule: public HTTPS on *.style.dev -> this VM's dev port.
    const tlsDomain = `${slug}.style.dev`;

    const { vm, vmId, data, tlsRules } = await this.client.vms.create({
      slug,
      idleTimeoutSeconds: opts.idleTimeoutSeconds,
      snapshotId: DEFAULT_SNAPSHOT,
      firewall: {
        rules: [
          // Outbound internet (npm, pip, git clone, ...)
          { action: "allow", source: {}, destination: { public: true } },
        ],
      },
      tls: {
        rules: [
          {
            action: "allow" as const,
            domain: tlsDomain,
            source: { public: true },
            destination: { port: devPort },
          },
        ],
      },
    });

    this.vm = vm;
    this.vmId = vmId;

    const domain = tlsRules?.[0]?.domain ?? tlsDomain;
    return {
      vmId,
      slug: data?.slug ?? slug,
      state: data?.state ?? "starting",
      domain,
    };
  }

  /** Fetch the current VM record by id or slug. */
  async getVM(vmId: string): Promise<{ id: string; slug: string | null; state: VmState | string } | null> {
    try {
      const data: VmData = await this.client.vms.get(vmId);
      return { id: data.id, slug: data.slug ?? null, state: data.state };
    } catch {
      return null;
    }
  }

  /** Point this client at an existing VM without a network round-trip. */
  refVM(vmId: string): void {
    this.vm = this.client.vms.ref(vmId);
    this.vmId = vmId;
  }

  async deleteVM(vmId: string): Promise<void> {
    try {
      await this.client.vms.delete(vmId);
    } catch {
      // Ignore not-found — delete should be idempotent.
    }
  }

  async pauseVM(): Promise<void> {
    await this.vmOrThrow().pause();
  }

  async startVM(): Promise<void> {
    await this.vmOrThrow().start();
  }

  async updateIdleTimeout(seconds: number): Promise<void> {
    await this.vmOrThrow().update({ idleTimeoutSeconds: seconds });
  }

  // ------------------------------------------------------------------
  // Filesystem
  // ------------------------------------------------------------------

  async mkdir(path: string): Promise<void> {
    await this.vmOrThrow().fs.mkdir(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.vmOrThrow().fs.writeTextFile(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    const vm = this.vmOrThrow();
    try {
      if (!(await vm.fs.exists(path))) return null;
      return await vm.fs.readTextFile(path);
    } catch {
      return null;
    }
  }

  /**
   * List a directory. The SDK's DirEntry is { name, kind: "file" |
   * "directory" | "symlink" } — it does not carry size; use stat() for size.
   */
  async readDir(path: string): Promise<FileEntry[]> {
    try {
      const entries: DirEntry[] = await this.vmOrThrow().fs.readDir(path);
      return entries.map((e) => ({
        name: e.name,
        path: path === "/" ? `/${e.name}` : `${path.replace(/\/$/, "")}/${e.name}`,
        kind: (e.kind === "directory" || e.kind === "symlink" ? e.kind : "file") as FileEntry["kind"],
        size: null,
      }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean } | null> {
    try {
      const s = await this.vmOrThrow().fs.stat(path);
      return { size: s.size ?? 0, isDirectory: s.isDirectory };
    } catch {
      return null;
    }
  }

  async remove(path: string): Promise<void> {
    await this.vmOrThrow().fs.remove(path);
  }

  /**
   * Copy a file. Uses fs-native read/write (byte-exact), not shell cp, so it
   * works even when the guest has no cp binary.
   */
  async cp(src: string, dest: string): Promise<void> {
    const content = await this.readFile(src);
    if (content === null) throw new Error(`Source file not found: ${src}`);
    await this.writeTextFile(dest, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // Native mv via exec: correct for files AND directories. fs.remove +
    // re-write would recurse into directories byte-by-byte and lose symlinks.
    const result = await this.exec(`mv -f -- ${shellQuote(oldPath)} ${shellQuote(newPath)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to rename ${oldPath} -> ${newPath}`);
    }
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------

  /**
   * Run a command in the guest. The API's ExecOptions has no cwd — commands
   * run through the guest shell from the home dir — so we `cd` first.
   * `options.timeoutMs` maps to both the API's wall-clock limit and an
   * in-guest `timeout(1)` wrapper.
   */
  async exec(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult> {
    const vm = this.vmOrThrow();
    const timeoutMs = Math.min(Math.max(options?.timeoutMs ?? 120_000, 1_000), 300_000);

    const parts: string[] = [];
    if (options?.cwd) {
      parts.push(`cd ${shellQuote(options.cwd)} 2>/dev/null || cd /workspace`);
    }
    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        parts.push(`export ${k}=${shellQuote(v)}`);
      }
    }
    // In-guest timeout guard: the API kills the exec at timeoutMs with a null
    // statusCode; `timeout` makes the guest process die first so we get a
    // clean exit code 124 and any partial output.
    parts.push(`timeout --signal=TERM --kill-after=5 ${Math.round(timeoutMs / 1000)}s ${command}`);
    const effectiveCommand = parts.join(" && ");

    const startedAt = Date.now();
    try {
      const result: SdkExecResult = await vm.exec({
        command: effectiveCommand,
        timeoutMs: timeoutMs + 5_000, // API-side grace beyond the in-guest limit
      });
      return {
        stdout: result.stdout ?? null,
        stderr: result.stderr ?? null,
        exitCode: result.statusCode ?? null,
        durationMs: Date.now() - startedAt,
        timedOut: result.statusCode === null,
      };
    } catch (e: any) {
      return {
        stdout: null,
        stderr: e?.message || "Command execution failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: true,
      };
    }
  }

  async searchFiles(dir: string, pattern: string): Promise<string[]> {
    const result = await this.exec(`find . -type f -name ${shellQuote(pattern)} 2>/dev/null || true`, {
      cwd: dir,
      timeoutMs: 30_000,
    });
    if (!result.stdout) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((rel) => joinPath(dir, rel));
  }

  async searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]> {
    // grep -I skips binary files; -r over /workspace can be big so cap output.
    const result = await this.exec(
      `grep -rIn -- ${shellQuote(pattern)} . 2>/dev/null | head -100 || true`,
      { cwd: dir, timeoutMs: 30_000 }
    );
    if (!result.stdout) return [];
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(":", line.indexOf(":") + 1); // second colon
        const relPath = idx > 0 ? line.slice(0, idx) : line;
        const rest = idx > 0 ? line.slice(idx + 1) : "";
        const colon = rest.indexOf(":");
        return {
          path: joinPath(dir, relPath),
          line: parseInt(colon > 0 ? rest.slice(0, colon) : "0", 10) || 0,
          content: colon > 0 ? rest.slice(colon + 1) : rest,
        };
      });
  }

  async getGitStatus(cwd: string): Promise<{
    branch: string | null;
    staged: string[];
    modified: string[];
    untracked: string[];
    raw: string;
  }> {
    const branch = await this.exec(`git rev-parse --abbrev-ref HEAD 2>/dev/null || true`, { cwd, timeoutMs: 15_000 });
    const status = await this.exec(`git status --porcelain 2>/dev/null || true`, { cwd, timeoutMs: 15_000 });

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    if (status.stdout) {
      for (const line of status.stdout.split("\n")) {
        if (line.length < 4) continue;
        const xy = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (!file) continue;
        if (xy === "??") untracked.push(file);
        else if (xy[0] !== " " && xy[0] !== "?") staged.push(file);
        else if (xy[1] !== " " && xy[1] !== "?") modified.push(file);
      }
    }

    return { branch: branch.stdout?.trim() || null, staged, modified, untracked, raw: status.stdout || "" };
  }

  async getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }> {
    const [staged, unstaged] = await Promise.all([
      this.exec(`git diff --cached 2>/dev/null || true`, { cwd, timeoutMs: 15_000 }),
      this.exec(`git diff 2>/dev/null || true`, { cwd, timeoutMs: 15_000 }),
    ]);
    return { staged: staged.stdout || "", unstaged: unstaged.stdout || "" };
  }

  // ------------------------------------------------------------------
  // Dev server / preview
  // ------------------------------------------------------------------

  /**
   * Start a long-running dev server as a named PTY session on the VM.
   *
   * PTY sessions are owned by the guest agent and survive both this process
   * restarting and the websocket detaching, so the API process restarting
   * (Render deploys) does not kill the user's dev server — the previous
   * implementation leaked a websocket and died with it.
   *
   * `sessionSlug` is get-or-create: re-calling with the same slug returns the
   * live session instead of double-starting. Pass `restart: true` to close
   * the existing one and boot a fresh server.
   */
  async startDevServer(
    cwd: string,
    command: string,
    port: number,
    opts: { sessionSlug?: string; restart?: boolean } = {}
  ): Promise<{ sessionId: number; restarted: boolean; reused: boolean }> {
    const vm = this.vmOrThrow();
    const sessionSlug = opts.sessionSlug ?? "dev-server";

    // Get-or-create edge cases: a session with this slug already exists in
    // any state, open() returns *that* one and never runs `exec`. So:
    //  - running + !restart  -> reuse it as-is
    //  - exited, or restart  -> close it, then open fresh
    let existing: { state: string; sessionId: number } | undefined;
    try {
      const { sessions } = await vm.pty.list();
      const s = sessions.find((x) => x.slug === sessionSlug);
      if (s) existing = { state: s.state, sessionId: s.sessionId };
    } catch {
      // list() failed — fall through and try open() directly.
    }

    if (existing && existing.state === "running" && !opts.restart) {
      return { sessionId: existing.sessionId, restarted: false, reused: true };
    }
    if (existing) {
      try {
        await vm.pty.close(sessionSlug);
      } catch {
        // Already gone.
      }
    }

    const session = await vm.pty.open({
      exec: `cd ${shellQuote(cwd)} && PORT=${port} ${command}`,
      cols: 120,
      rows: 30,
      slug: sessionSlug,
      onData: () => {},
      onExit: () => {},
    });

    return { sessionId: session.sessionId, restarted: !!existing, reused: false };
  }

  /** Check whether the named dev-server PTY session is still alive. */
  async devServerRunning(sessionSlug = "dev-server"): Promise<boolean> {
    try {
      const { sessions } = await this.vmOrThrow().pty.list();
      const s = sessions.find((x) => x.slug === sessionSlug);
      return !!s && s.state === "running";
    } catch {
      return false;
    }
  }

  async stopDevServer(sessionSlug = "dev-server"): Promise<void> {
    try {
      await this.vmOrThrow().pty.close(sessionSlug);
    } catch {
      // Already gone.
    }
  }

  /** Best-effort port probe — true once something answers on the port. */
  async waitForPort(port: number, timeoutMs = 45_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.exec(
        `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ || true`,
        { timeoutMs: 10_000 }
      );
      const code = (r.stdout || "").trim();
      if (code && code !== "000") return true;
      await new Promise((r2) => setTimeout(r2, 1500));
      // Only keep probing while the process manager is alive.
      if (!(await this.devServerRunning())) return false;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Preview URL
  // ------------------------------------------------------------------

  /**
   * The public preview URL for a port on this VM. Prefer the ingress domain
   * recorded at VM create (stored in project row); construct style.dev URL
   * as the default shape.
   */
  async getPreviewUrl(port: number, domainSuffix: string): Promise<string> {
    const slug = this.vm ? (await this.vm.data()).slug : null;
    const domain = slug ? `${slug}.${domainSuffix}` : `dai.${domainSuffix}`;
    return `https://${domain}`;
  }

  // ------------------------------------------------------------------
  // TLS rules (public ingress for a port)
  // ------------------------------------------------------------------

  /**
   * Publish a port publicly: HTTPS on `domain` -> this VM's `port`.
   * Domains under style.dev are free and need no verification.
   */
  async createTlsRule(domain: string, port: number): Promise<{ domain: string; port: number }> {
    await this.client.tls.rules.create({
      action: "allow",
      domain,
      source: { public: true },
      destination: { vmId: this.vmId!, port },
    });
    return { domain, port };
  }

  async listTlsRules(): Promise<{ id: string; domain: string; port: number | null }[]> {
    const { rules } = await this.client.tls.rules.list({ vmId: this.vmId! });
    return rules.map((r) => ({
      id: r.id,
      domain: r.domain,
      port: r.destination?.port ?? null,
    }));
  }

  // ------------------------------------------------------------------

  private vmOrThrow(): Vm {
    if (!this.vm) throw new Error("No VM handle — call refVM(vmId) or createVM() first");
    return this.vm;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinPath(dir: string, rel: string): string {
  const d = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${d}/${rel.replace(/^\.\//, "")}`;
}

export { Freestyle };
