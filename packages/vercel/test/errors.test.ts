import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RuntimeOperationError, failureKindOf, isFailure, toRuntimeError } from "@dai/runtime";
// Importing the provider is what registers its classifier; the assertion below
// depends on this side effect happening exactly once.
import "../src/errors.js";
import { classifyVercelError } from "../src/errors.js";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function apiError(status: number, message: string): Error {
  // Named like the SDK's class, since classification is structural: an error
  // arriving from the CJS build is not `instanceof` the imported one.
  return Object.assign(new Error(message), { name: "APIError", response: { status } });
}

describe("provider errors reach the shared vocabulary", () => {
  it("maps a missing sandbox to a reattachable unavailability, not a 404", () => {
    // The caller's correct response to "no such sandbox" is to create one, so it
    // must not surface as the not-found a caller would show to a user.
    expect(classifyVercelError(apiError(404, "sandbox dai-p1 not found"))).toBe("unavailable");
    expect(classifyVercelError(apiError(404, "drive not found"))).toBe("not_found");
  });

  it("maps a control-plane rate limit to the quota failure", () => {
    expect(classifyVercelError(apiError(429, "too many requests"))).toBe("quota");
    const converted = toRuntimeError(apiError(429, "slow down"), "refused");
    expect(converted).toBeInstanceOf(RuntimeOperationError);
    expect((converted as RuntimeOperationError).statusCode).toBe(429);
    expect((converted as RuntimeOperationError).recreate).toBe(false);
  });

  it("treats a 5xx as a machine that cannot be reached rather than a bad request", () => {
    expect(classifyVercelError(apiError(503, "upstream failure"))).toBe("unavailable");
    expect(classifyVercelError(apiError(400, "invalid mount path"))).toBe("invalid");
  });

  it("still classifies anything already converted", () => {
    const wrapped = toRuntimeError(apiError(409, "drive attached"), "busy");
    expect(isFailure(wrapped, "already_exists")).toBe(true);
    expect(failureKindOf(wrapped)).toBe("already_exists");
  });

  it("leaves unrelated errors alone", () => {
    const error = new TypeError("cannot read properties of undefined");
    expect(toRuntimeError(error, "while listing")).toBe(error);
  });
});

/**
 * The rule AGENTS.md has always stated for providers, restated for this one:
 * the SDK is allowed in exactly one package, so a route can never acquire a
 * provider-specific dependency by accident.
 */
describe("only this package imports the provider SDKs", () => {
  const apiLayer = [
    "../../../apps/api/src/lib/runtime.ts",
    "../../../apps/api/src/routes/workspace.ts",
    "../../../apps/api/src/routes/projects.ts",
    "../../../apps/api/src/routes/rollback.ts",
    "../../../apps/api/src/lib/checkpoint-service.ts",
    "../../../apps/api/src/lib/agent-loop.ts",
    "../../../apps/api/src/lib/agent-run.ts",
  ];

  it("keeps @vercel/sandbox out of the API layer", () => {
    for (const file of apiLayer) {
      expect(read(file)).not.toMatch(/@vercel\/sandbox/);
    }
  });

  it("keeps the S3 client inside one module", () => {
    expect(read("../src/runtime.ts")).not.toMatch(/@aws-sdk/);
    expect(read("../src/workspace.ts")).not.toMatch(/@aws-sdk/);
    expect(read("../src/mirror.ts")).not.toMatch(/@aws-sdk/);
  });
});
