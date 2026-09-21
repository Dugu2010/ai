import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Storage quota and workspace measurement.
 *
 * These run entirely against Postgres rows: nothing here may reach Modal, so
 * the tests assert that explicitly by leaving the provider unconfigured.
 */

const rows: Record<string, { workspaceBytes: number | null; id: string }> = {};
const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

vi.mock("@dai/db", () => ({
  getProject: async (id: string) => rows[id] ?? null,
  getProjectByUser: async (id: string) => rows[id] ?? null,
  updateProject: async (id: string, patch: Record<string, unknown>) => {
    updates.push({ id, patch });
    if (rows[id]) Object.assign(rows[id], patch);
    return rows[id] ?? null;
  },
  pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }) },
}));

// 1 KiB ceiling, set before the module reads its configuration.
process.env.MAX_PROJECT_WORKSPACE_BYTES = "1024";

const runtime = await import("../src/lib/runtime.js");
const { assertWithinStorageQuota, recordWorkspaceUsage, formatBytes, isRuntimeConfigured } = runtime;

beforeEach(() => {
  for (const key of Object.keys(rows)) delete rows[key];
  updates.length = 0;
});

describe("assertWithinStorageQuota", () => {
  it("lets a project with room to spare proceed", async () => {
    rows.p1 = { id: "p1", workspaceBytes: 512 };
    await expect(assertWithinStorageQuota("p1")).resolves.toBeUndefined();
  });

  it("refuses a project that has reached its allowance", async () => {
    rows.p2 = { id: "p2", workspaceBytes: 1024 };
    await expect(assertWithinStorageQuota("p2")).rejects.toThrow(/storage limit/);
  });

  it("refuses a project that has overshot it", async () => {
    rows.p3 = { id: "p3", workspaceBytes: 4096 };
    await expect(assertWithinStorageQuota("p3")).rejects.toThrow(/storage limit/);
  });

  it("does not block a project that has never been measured", async () => {
    rows.p4 = { id: "p4", workspaceBytes: null };
    await expect(assertWithinStorageQuota("p4")).resolves.toBeUndefined();
  });

  it("reports a missing project rather than an empty quota", async () => {
    await expect(assertWithinStorageQuota("gone")).rejects.toThrow(/no longer exists/);
  });

  it("states the real numbers in the message the user sees", async () => {
    rows.p5 = { id: "p5", workspaceBytes: 1024 };
    await expect(assertWithinStorageQuota("p5")).rejects.toThrow(/1\.0 KiB of 1\.0 KiB/);
  });

  it("enforces the quota with no execution runtime configured at all", async () => {
    // The whole point: refusing oversized work must not cost a Sandbox.
    expect(isRuntimeConfigured()).toBe(false);
    rows.p6 = { id: "p6", workspaceBytes: 9999 };
    await expect(assertWithinStorageQuota("p6")).rejects.toThrow(/storage limit/);
  });
});

describe("recordWorkspaceUsage", () => {
  it("stores the measurement the Sandbox already reported", async () => {
    rows.p7 = { id: "p7", workspaceBytes: null };
    const workspace = { workspaceUsageBytes: async () => 700 } as never;
    await expect(recordWorkspaceUsage(workspace, "p7")).resolves.toBe(700);
    expect(updates.some((entry) => entry.id === "p7" && entry.patch.workspaceBytes === 700)).toBe(true);
  });

  it("writes nothing when the measurement is unavailable", async () => {
    rows.p8 = { id: "p8", workspaceBytes: 10 };
    const workspace = { workspaceUsageBytes: async () => null } as never;
    await expect(recordWorkspaceUsage(workspace, "p8")).resolves.toBeNull();
    expect(updates.filter((entry) => entry.id === "p8")).toHaveLength(0);
    // A failed measurement must not silently read as "empty workspace".
    expect(rows.p8.workspaceBytes).toBe(10);
  });
});

describe("formatBytes", () => {
  it("keeps whole bytes exact and rounds larger units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(50 * 1024 * 1024 * 1024)).toBe("50.0 GiB");
  });
});
