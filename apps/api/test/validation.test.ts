import { describe, expect, it } from "vitest";
import { MAX_TIMEOUT_MS, validateCommand, validateCommandOptions, validatePath } from "../src/lib/validation.js";

// Built programmatically so the source never needs control-character literals.
const CONTROL_CHARS = ["\u0000", "\u0001", "\u001f", "\u007f"].map((char) => `/workspace/a${char}b.ts`);

describe("workspace path confinement", () => {
  it("accepts paths inside the workspace root", () => {
    expect(validatePath("/workspace")).toEqual({ valid: true, normalized: "/workspace" });
    expect(validatePath("/workspace/src/App.tsx").valid).toBe(true);
  });

  it("rejects empty and non-string input", () => {
    expect(validatePath("").valid).toBe(false);
    expect(validatePath("   ").valid).toBe(false);
    expect(validatePath(undefined as unknown as string).valid).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(validatePath("src/App.tsx").valid).toBe(false);
    expect(validatePath("./etc/passwd").valid).toBe(false);
  });

  it("rejects sibling-prefix escapes such as /workspacex", () => {
    // The classic bug is a bare startsWith("/workspace") matching "/workspacex".
    const result = validatePath("/workspacex/a.txt");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/workspace boundaries/);
  });

  it("rejects raw traversal", () => {
    expect(validatePath("/workspace/../etc/passwd").valid).toBe(false);
    expect(validatePath("/workspace/../../etc/shadow").valid).toBe(false);
    expect(validatePath("../outside").valid).toBe(false);
  });

  it("rejects URL-encoded traversal", () => {
    expect(validatePath("/workspace/%2e%2e/etc/passwd").valid).toBe(false);
    expect(validatePath("/workspace/%2E%2E/package.json").valid).toBe(false);
    expect(validatePath("/workspace/%2e%2e%2f%2e%2e/etc/passwd").valid).toBe(false);
  });

  it("never lets a double-encoded traversal escape the workspace", () => {
    // Decoding happens once, so %252e%252e stays a literal directory name.
    // Either outcome is acceptable; the security property is confinement.
    const result = validatePath("/workspace/%252e%252e/etc/passwd");
    if (result.valid) {
      // Confined: it resolves to literal directories under /workspace, not to
      // the real /etc/passwd.
      expect(result.normalized).toMatch(/^\/workspace(\/|$)/);
    } else {
      expect(result.valid).toBe(false);
    }
  });

  it("rejects NUL and other control characters", () => {
    for (const path of CONTROL_CHARS) {
      expect(validatePath(path).valid).toBe(false);
    }
  });

  it("rejects paths outside the workspace entirely", () => {
    for (const path of ["/etc/passwd", "/root/.ssh/id_rsa", "/proc/self/environ"]) {
      expect(validatePath(path).valid).toBe(false);
    }
  });
});

describe("command hardening", () => {
  it("allows ordinary build and test commands", () => {
    for (const command of ["npm install", "npm test", "node index.js", "git status", "python3 -m pytest"]) {
      expect(validateCommand(command).valid).toBe(true);
    }
  });

  it("rejects binaries outside the allowlist", () => {
    for (const command of ["shutdown now", "mkfs.ext4 /dev/sda", "nc -lvnp 4444"]) {
      const result = validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not allowed/);
    }
  });

  it("rejects the documented destructive patterns", () => {
    for (const command of ["chmod 777 /app", "rm -rf /", "rm -rf /etc"]) {
      expect(validateCommand(command).valid).toBe(false);
    }
  });

  it("rejects chained destructive commands", () => {
    expect(validateCommand("echo hi; rm -rf /").valid).toBe(false);
  });

  it("rejects an empty command", () => {
    expect(validateCommand("").valid).toBe(false);
    expect(validateCommand("   ").valid).toBe(false);
  });

  it("enforces the timeout ceiling", () => {
    expect(validateCommandOptions({ command: "npm test", timeoutMs: MAX_TIMEOUT_MS + 1 }).valid).toBe(false);
    expect(validateCommandOptions({ command: "npm test", timeoutMs: 5_000 }).valid).toBe(true);
  });

  it("validates the working directory of a command", () => {
    expect(validateCommandOptions({ command: "npm test", cwd: "/etc" }).valid).toBe(false);
    expect(validateCommandOptions({ command: "npm test", cwd: "/workspace" }).valid).toBe(true);
  });

  // Documents a real, pre-existing limitation rather than pretending it away:
  // `bash` is allowlisted because the agent needs shells, so the pattern list
  // cannot be the security boundary. Isolation comes from the Modal Sandbox and
  // the per-project Volume subPath, not from this allowlist.
  it("pins the known bash-allowlist limitation", () => {
    expect(validateCommand("bash -c 'rm -rf /'").valid).toBe(true);
  });
});
