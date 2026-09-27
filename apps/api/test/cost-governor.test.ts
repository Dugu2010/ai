import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  monthUsage: { activeCpuMs: 0, provisionedGbMs: 0, creations: 0, egressBytes: 0 },
  lastEscalatedAt: null as string | null,
  escalations: 0,
  openSessions: [] as Array<{ id: number; startedAt: string; vcpus: number }>,
  closed: [] as Array<{ id: number; reconciled: boolean }>,
}));

vi.mock("@dai/db", () => ({
  monthKey: (at?: Date) => `${(at ?? new Date()).getUTCFullYear()}-${String((at ?? new Date()).getUTCMonth() + 1).padStart(2, "0")}`,
  readMonthUsage: async () => ({ ...db.monthUsage }),
  lastEscalationAt: async () => db.lastEscalatedAt,
  recordEscalation: async () => {
    db.escalations += 1;
    return db.escalations;
  },
  listOpenUsageSessions: async () => db.openSessions,
  closeUsageSession: async (id: number, _usage: unknown, opts: { reconciled?: boolean }) => {
    db.closed.push({ id, reconciled: Boolean(opts.reconciled) });
  },
}));

import {
  allowsEscalation,
  allowsPreview,
  assertPreviewAllowed,
  assertWithinComputeBudget,
  nextTierAfterTimeout,
  previewRefusalReason,
  provisionedMsFor,
  readHeadroom,
  describeHeadroom,
  toGbHours,
} from "../src/lib/cost-governor.js";
import { RuntimeOperationError } from "@dai/runtime";
import type { MonthlyBudget } from "@dai/vercel";

const HOUR = 3_600_000;

// Hobby's real allotments, as the config exposes them.
const BUDGET: MonthlyBudget = {
  activeCpuMs: 5 * HOUR,
  provisionedGbHours: 420,
  creations: 5_000,
  egressBytes: 20 * 1024 * 1024 * 1024,
  haltFraction: 0.95,
  throttleFraction: 0.8,
  warnFraction: 0.6,
};

const configFor = (tierCount: number) =>
  ({
    budget: BUDGET,
    tiers: Array.from({ length: tierCount }, (_, index) => ({ vcpus: 2 ** index, label: "small" as const })),
  }) as never;

beforeEach(() => {
  db.monthUsage = { activeCpuMs: 0, provisionedGbMs: 0, creations: 0, egressBytes: 0 };
  db.lastEscalatedAt = null;
  db.escalations = 0;
  db.openSessions = [];
  db.closed = [];
});

describe("levels track the furthest-through metric", () => {
  it("is ok when nothing has been spent", async () => {
    const headroom = await readHeadroom(BUDGET);
    expect(headroom.level).toBe("ok");
    expect(headroom.fractions.activeCpuMs.fraction).toBe(0);
  });

  it("warns at 60% of command CPU", async () => {
    db.monthUsage.activeCpuMs = 3 * HOUR;
    expect((await readHeadroom(BUDGET)).level).toBe("warn");
  });

  it("throttles at 80% and stops allowing escalation or previews", async () => {
    db.monthUsage.activeCpuMs = 4.1 * HOUR;
    const headroom = await readHeadroom(BUDGET);
    expect(headroom.level).toBe("throttle");
    expect(allowsEscalation(headroom.level)).toBe(false);
    expect(allowsPreview(headroom.level)).toBe(false);
  });

  it("names running time as binding when memory is what is nearly gone", async () => {
    db.monthUsage.activeCpuMs = HOUR;
    db.monthUsage.provisionedGbMs = 400 * HOUR;
    const headroom = await readHeadroom(BUDGET);
    expect(headroom.binding).toBe("provisionedGbMs");
    expect(headroom.level).toBe("halt");
  });

  it("never treats egress as a stop condition it cannot act on", async () => {
    db.monthUsage.egressBytes = 19 * 1024 * 1024 * 1024;
    const headroom = await readHeadroom(BUDGET);
    expect(headroom.fractions.egressBytes.fraction).toBeGreaterThan(0.9);
    expect(headroom.level).toBe("ok");
    expect(headroom.binding).not.toBe("egressBytes");
  });

  it("reports the binding metric in the refusal, not a generic quota error", async () => {
    db.monthUsage.activeCpuMs = 5 * HOUR;
    await expect(assertWithinComputeBudget(new Date(), configFor(2))).rejects.toThrow(/command CPU/);
    expect((await readHeadroom(BUDGET)).level).toBe("halt");
  });
});

describe("previews are the first thing declined", () => {
  const NOW = new Date("2026-09-27T12:00:00Z");

  it("allows a dev server while the month is fresh", async () => {
    expect(await previewRefusalReason(NOW, configFor(2))).toBeNull();
    await expect(assertPreviewAllowed(NOW, configFor(2))).resolves.toBeUndefined();
  });

  it("refuses once running time passes the throttle line, and says when it lifts", async () => {
    db.monthUsage.provisionedGbMs = 340 * HOUR;
    const reason = await previewRefusalReason(NOW, configFor(2));
    expect(reason).toMatch(/running time/i);
    expect(reason).toMatch(/2026-10-01/);
    // The refusal is also a tool result, so it has to carry the alternative.
    expect(reason).toMatch(/file tools/);
  });

  it("throws a quota failure, not a generic error, for the route form", async () => {
    db.monthUsage.activeCpuMs = 4.5 * HOUR;
    const error = await assertPreviewAllowed(NOW, configFor(2)).catch((e) => e);
    expect(error).toBeInstanceOf(RuntimeOperationError);
    expect(error.failure).toBe("quota");
    expect(error.statusCode).toBe(429);
  });
});

describe("unit conversion", () => {
  it("converts provisioned GB-milliseconds to GB-hours", () => {
    expect(toGbHours(2 * HOUR)).toBe(2);
    expect(toGbHours(0)).toBe(0);
  });

  it("measures elapsed wall clock from an ISO start, and never backwards", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    expect(provisionedMsFor("2026-09-27T11:30:00Z", now)).toBe(30 * 60_000);
    expect(provisionedMsFor("2026-09-27T13:00:00Z", now)).toBe(0);
    expect(provisionedMsFor("not a date", now)).toBe(0);
  });
});

describe("escalation is bounded", () => {
  const NOW = new Date("2026-09-27T12:00:00Z");

  it("steps up once, and only while there is room", async () => {
    expect(await nextTierAfterTimeout("p1", 0, configFor(3), "ok", NOW)).toBe(1);
    expect(db.escalations).toBe(1);
  });

  it("refuses a second escalation inside the week", async () => {
    db.lastEscalatedAt = "2026-09-24T12:00:00Z";
    expect(await nextTierAfterTimeout("p1", 0, configFor(3), "ok", NOW)).toBe(0);
    expect(db.escalations).toBe(0);
  });

  it("allows escalation again once the week has passed", async () => {
    db.lastEscalatedAt = "2026-09-19T12:00:00Z";
    expect(await nextTierAfterTimeout("p1", 0, configFor(3), "ok", NOW)).toBe(1);
  });

  it("never escalates at the largest tier, so a timeout cannot spend forever", async () => {
    expect(await nextTierAfterTimeout("p1", 2, configFor(3), "ok", NOW)).toBe(2);
    expect(db.escalations).toBe(0);
  });

  it("never escalates under throttle or halt", async () => {
    expect(await nextTierAfterTimeout("p1", 0, configFor(3), "throttle", NOW)).toBe(0);
    expect(await nextTierAfterTimeout("p1", 0, configFor(3), "halt", NOW)).toBe(0);
    expect(db.escalations).toBe(0);
  });

  it("keeps warn permissive: the point is to inform before it restricts", async () => {
    expect(await nextTierAfterTimeout("p1", 0, configFor(3), "warn", NOW)).toBe(1);
  });
});

describe("reconciliation", () => {
  it("closes sessions nobody reported, flagged as estimates", async () => {
    db.openSessions = [
      { id: 1, startedAt: "2026-09-27T10:00:00Z", vcpus: 1 },
      { id: 2, startedAt: "2026-09-27T11:00:00Z", vcpus: 2 },
    ];
    expect(await reconcileCount()).toBe(2);
    expect(db.closed).toEqual([
      { id: 1, reconciled: true },
      { id: 2, reconciled: true },
    ]);
  });
});

async function reconcileCount(): Promise<number> {
  // Imported late so the mocked module is already installed.
  const { reconcileOpenSessions } = await import("../src/lib/cost-governor.js");
  return reconcileOpenSessions(0);
}

describe("spend is legible", () => {
  it("states the month, the level and both scarce quantities", async () => {
    db.monthUsage = { activeCpuMs: 1.5 * HOUR, provisionedGbMs: 40 * HOUR, creations: 12, egressBytes: 0 };
    const headroom = await readHeadroom(BUDGET);
    const text = describeHeadroom(headroom, BUDGET);
    expect(text).toContain("1.50/5 command-CPU hours");
    expect(text).toContain("40.0/420 running GB-hours");
    expect(text).toContain("12/5000 sandbox boots");
    expect(text).toMatch(/level ok/);
  });
});
