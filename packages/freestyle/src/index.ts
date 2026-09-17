import { Freestyle } from "freestyle";

export { Freestyle } from "freestyle";

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
  kind: "file" | "directory";
  size: number;
}

export interface TlsRule {
  action: "allow";
  domain: string;
  port: number;
}

export class FreestyleClient {
  private client: Freestyle;
  private vm: any | null = null;
  private vmId: string | null = null;
  private devServerSessionId: number | null = null;

  constructor(apiKey: string) {
    this.client = new Freestyle({ apiKey });
  }

  async createVM(slug: string, idleTimeoutSeconds: number): Promise<any> {
    const { vm, vmId } = await this.client.vms.create({
      slug,
      idleTimeoutSeconds,
      firewall: {
        rules: [
          {
            action: "allow",
            source: { public: true },
            destination: { public: true },
          },
        ],
      },
      networks: [{ vpc: "default", ipv4: false, ipv6: true }],
    });

    this.vm = vm;
    this.vmId = vmId;

    return {
      vmId,
      slug: (vm as any).data?.slug ?? null,
      state: (vm as any).data?.state ?? "provisioning",
    };
  }

  async getVM(vmId: string): Promise<any | null> {
    try {
      const vm = await this.client.vms.get(vmId);
      return {
        vmId: vm.id,
        slug: (vm as any).slug ?? null,
        state: (vm as any).state,
      };
    } catch {
      return null;
    }
  }

  async refVM(vmId: string) {
    this.vm = (this.client.vms as any).ref(vmId);
    this.vmId = vmId;
  }

  async deleteVM(vmId: string): Promise<void> {
    try {
      await this.client.vms.delete(vmId);
    } catch {
      // Ignore not found
    }
  }

  async pauseVM(): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    await this.vm.pause();
  }

  async startVM(): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    await this.vm.start();
  }

  async updateIdleTimeout(seconds: number): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    await this.vm.update({ idleTimeoutSeconds: seconds });
  }

  async mkdir(path: string): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    await this.vm.fs.mkdir(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    await this.vm.fs.writeTextFile(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    if (!this.vm) throw new Error("No VM handle");
    const exists = await this.vm.fs.exists(path);
    if (!exists) return null;
    try {
      const content = await this.vm.fs.readTextFile(path);
      return content;
    } catch {
      return null;
    }
  }

  async readDir(path: string): Promise<FileEntry[]> {
    if (!this.vm) throw new Error("No VM handle");
    try {
      const entries = await this.vm.fs.readDir(path);
      return entries.map((e: any) => ({
        name: e.name,
        path: `${path}/${e.name}`,
        kind: (e as any).isDirectory ? "directory" : "file",
        size: (e as any).size ?? 0,
      }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean } | null> {
    if (!this.vm) throw new Error("No VM handle");
    try {
      const info = await this.vm.fs.stat(path);
      return {
        size: (info as any).size ?? 0,
        isDirectory: (info as any).isDirectory ?? false,
      };
    } catch {
      return null;
    }
  }

  async remove(path: string): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    await this.vm.fs.remove(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.remove(newPath);
    await this.cp(oldPath, newPath);
    await this.remove(oldPath);
  }

  async cp(src: string, dest: string): Promise<void> {
    if (!this.vm) throw new Error("No VM handle");
    const content = await this.readFile(src);
    if (content === null) throw new Error(`Source file not found: ${src}`);
    await this.writeTextFile(dest, content);
  }

  async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    if (!this.vm) throw new Error("No VM handle");
    const timeoutMs = options?.timeoutMs ?? 300000;
    try {
      const result = await this.vm.exec({
        command,
        cwd: options?.cwd,
        timeoutMs,
      });
      return {
        stdout: result.stdout ?? null,
        stderr: result.stderr ?? null,
        exitCode: result.statusCode ?? null,
        durationMs: result.durationMs ?? 0,
        timedOut: false,
      };
    } catch (e: any) {
      return {
        stdout: null,
        stderr: e.message || "Command execution failed",
        exitCode: null,
        durationMs: 0,
        timedOut: true,
      };
    }
  }

  async searchFiles(dir: string, pattern: string): Promise<string[]> {
    const result = await this.exec(`find ${dir} -type f -name "${pattern}" 2>/dev/null || true`);
    if (!result.stdout) return [];
    return result.stdout.split("\n").filter((line) => line.length > 0);
  }

  async searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]> {
    const result = await this.exec(`grep -rn --include="*" "${pattern}" ${dir} 2>/dev/null | head -100 || true`);
    if (!result.stdout) return [];
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split(":");
        return {
          path: parts[0] || "",
          line: parseInt(parts[1] || "0", 10),
          content: parts.slice(2).join(":") || "",
        };
      });
  }

  async getGitStatus(cwd: string): Promise<{ branch: string | null; staged: string[]; modified: string[]; untracked: string[]; raw: string }> {
    const branch = await this.exec(`git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`, { cwd });
    const rawStatus = await this.exec(`git status --porcelain 2>/dev/null || true`, { cwd });

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    if (rawStatus.stdout) {
      for (const line of rawStatus.stdout.split("\n")) {
        if (line.length < 2) continue;
        const status = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (file) {
          if (status[0] === "M" || status[0] === "A") {
            staged.push(file);
          } else if (status[0] === " M" || status[1] === "M") {
            modified.push(file);
          } else if (status[0] === "?" || status[1] === "?") {
            untracked.push(file);
          }
        }
      }
    }

    return {
      branch: branch.stdout?.trim() || null,
      staged,
      modified,
      untracked,
      raw: rawStatus.stdout || "",
    };
  }

  async getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }> {
    const staged = await this.exec(`git diff --cached 2>/dev/null || true`, { cwd });
    const unstaged = await this.exec(`git diff 2>/dev/null || true`, { cwd });
    return {
      staged: staged.stdout || "",
      unstaged: unstaged.stdout || "",
    };
  }

  async startDevServer(cwd: string, command: string, port: number): Promise<number> {
    if (!this.vm) throw new Error("No VM handle");
    const user = this.vm.linuxUser("developer");
    const session = await user.pty.open({
      exec: command,
      cols: 80,
      rows: 24,
      onData: () => {},
    });

    this.devServerSessionId = session.sessionId;
    return session.sessionId;
  }

  async stopDevServer(): Promise<void> {
    if (!this.vm || this.devServerSessionId === null) return;
    try {
      await this.vm.linuxUser("developer").pty.close(this.devServerSessionId);
    } catch {
      // Ignore
    }
    this.devServerSessionId = null;
  }

  getDevServerRunning(): boolean {
    return this.devServerSessionId !== null;
  }

  async createTlsRule(domain: string, port: number): Promise<TlsRule> {
    if (!this.vmId) throw new Error("No VM ID");
    await this.client.tls.rules.create({
      action: "allow",
      domain,
      source: { public: true },
      destination: { vmId: this.vmId, port },
    });
    return { action: "allow", domain, port };
  }

  async getPreviewUrl(port: number, domainSuffix: string): Promise<string> {
    const slug = this.vm?.data?.slug ?? "dai";
    const domain = `${slug}.${domainSuffix}`;
    return `https://${domain}:${port}`;
  }
}
