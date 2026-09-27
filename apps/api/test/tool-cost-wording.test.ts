import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_OPERATIONS } from "../src/lib/agent-loop.js";
import { TOOLS } from "../src/lib/agent-run.js";
import { needsRuntime } from "../src/lib/runtime-policy.js";

/**
 * The model decides what to spend by reading these sentences, so a description
 * that disagrees with the cost table is a bug with a price attached — this file
 * exists because one of them claimed listing files was free at a moment the SDK
 * was implementing it as a `find`.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const descriptionOf = new Map(TOOLS.map((tool) => [tool.function.name, tool.function.description]));

describe("tool descriptions match the cost table", () => {
  it("classifies every tool the model is offered", () => {
    for (const tool of TOOLS) {
      expect(TOOL_OPERATIONS[tool.function.name]).toBeTruthy();
    }
  });

  it("names a tool metered exactly when its operation spends Active CPU", () => {
    for (const [name, operation] of Object.entries(TOOL_OPERATIONS)) {
      const description = descriptionOf.get(name);
      if (description === undefined) continue;
      const saysMetered = /METERED/.test(description);
      expect([name, saysMetered]).toEqual([name, needsRuntime(operation).activeCpuCost]);
    }
  });

  it("never claims a workspace operation is free", () => {
    // "Free" was true of nothing on either provider: even the cheapest call needs
    // an awake machine, which is itself the billable thing.
    for (const tool of TOOLS) {
      expect(tool.function.description).not.toMatch(/\bfree\b/i);
    }
  });

  it("does not tell the model that listing or searching files is free", () => {
    const prompt = read("../src/routes/agent.ts");
    expect(prompt).not.toMatch(/listing, searching and editing files is free/i);
    expect(prompt).toMatch(/METERED|metered/);
  });
});
