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

  // The boundary is the Sandbox plus the per-project Volume subPath, not this
  // allowlist: `bash` and `sh` must stay available to the agent. What the list
  // can still do is refuse an indiscriminate wipe, so the payload pass strips
  // quoting and scans the whole command rather than only its first word.
  it.each([
    "bash -c 'rm -rf /'",
    'sh -c "rm -rf /"',
    "bash -lc \"rm -rf /*\"",
    "bash -c 'rm -rf ~'",
    "bash -c 'rm -rf --no-preserve-root /'",
    "bash -c 'rm -rf /workspace'",
    "echo hi && rm -rf /",
    "node build.js; rm -rf ~",
    "bash -c 'mkfs.ext4 /dev/sda'",
    "bash -c 'dd if=/dev/zero of=/dev/sda'",
    ":(){ :|:& };:",
  ])("refuses a destructive payload wrapped in a shell: %s", (command) => {
    expect(validateCommand(command).valid).toBe(false);
  });

  // Payloads reached through an allowlisted interpreter must still be checked
  // for over-matching: an ordinary build-cache clean is routine agent work.
  it.each([
    "bash -c 'npm test'",
    "sh -c 'echo built'",
    "bash -c 'rm -rf node_modules'",
    "bash -c 'rm -rf dist coverage'",
    "bash -c 'rm -rf /workspace/build'",
    "bash -c 'rm -rf ./tmp'",
    "bash -c 'for f in *.ts; do echo $f; done'",
    "bash -c \"find . -name '*.log' -delete\"",
    "npm run build && npm test",
  ])("still allows ordinary agent work: %s", (command) => {
    expect(validateCommand(command).valid).toBe(true);
  });

  // Pre-existing allowlist behaviour, pinned so it cannot quietly widen: a bare
  // `rm`/`find` is refused for not being an allowlisted program, independently
  // of the payload scan above.
  it.each(["rm -rf node_modules", "find . -delete", "du -sh /", "kill -9 1"])(
    "refuses a program that is not allowlisted: %s",
    (command) => {
      const result = validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not allowed/);
    }
  );
});
