import { describe, expect, it } from "vitest";
import { SandboxFilesystemNotFoundError, SandboxTimeoutError } from "modal";
import {
  RuntimeOperationError,
  configFromEnv,
  isFailure,
  sandboxName,
  toRuntimeError,
  volumeSubPath,
} from "../src/index.js";

describe("runtime config", () => {
  it("coerces timeouts to whole seconds, which Modal requires", () => {
    const config = configFromEnv({ MODAL_IDLE_TIMEOUT_MS: "1500", MODAL_TIMEOUT_MS: "999" } as NodeJS.ProcessEnv);
    expect(config.idleTimeoutMs).toBe(2_000);
    // 999ms would round to 0; it must never collapse to no timeout.
    expect(config.timeoutMs).toBeGreaterThanOrEqual(1_000);
  });

  it("falls back to defaults on garbage input rather than taking an unsafe value", () => {
    const config = configFromEnv({ MODAL_CPU: "abc", MODAL_MEMORY_MIB: "-5", MODAL_PREVIEW_PORTS: "0,99999" } as NodeJS.ProcessEnv);
    expect(config.cpu).toBe(1);
    expect(config.memoryMiB).toBe(2_048);
    expect(config.previewPorts).toEqual([3_000, 5_173, 8_080]);
  });

  it("parses preview ports and rejects out-of-range entries", () => {
    const config = configFromEnv({ MODAL_PREVIEW_PORTS: "3000, 4000, -1, 70000" } as NodeJS.ProcessEnv);
    expect(config.previewPorts).toEqual([3_000, 4_000]);
  });

  it("keeps each project's workspace isolated by subPath", () => {
    expect(volumeSubPath("abc-123")).toBe("projects/abc-123");
    // Two different projects must never resolve to the same mounted directory.
    expect(volumeSubPath("a")).not.toBe(volumeSubPath("b"));
  });

  it("produces a slug-safe Sandbox name within the provider limit", () => {
    const name = sandboxName("proj/../ev!l");
    expect(name).not.toMatch(/[^a-zA-Z0-9._-]/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("error classification", () => {
  it("treats a missing Sandbox as recreatable", () => {
    const error = toRuntimeError(new SandboxTimeoutError("gone"), "ctx");
    expect(error).toBeInstanceOf(RuntimeOperationError);
    expect(isFailure(error, "unavailable")).toBe(false);
    expect((error as RuntimeOperationError).failure).toBe("timeout");
  });

  it("maps a missing file to 404 and does NOT ask for recreation", () => {
    const error = toRuntimeError(new SandboxFilesystemNotFoundError("nope"), "ctx") as RuntimeOperationError;
    expect(error.statusCode).toBe(404);
    expect(error.recreate).toBe(false);
  });

  it("passes non-SDK errors through untouched", () => {
    const original = new TypeError("programming error");
    expect(toRuntimeError(original, "ctx")).toBe(original);
  });

  it("exposes an HTTP status the routes can surface directly", () => {
    const unavailable = new RuntimeOperationError("Sandbox gone", "unavailable");
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.recreate).toBe(true);
  });
});
