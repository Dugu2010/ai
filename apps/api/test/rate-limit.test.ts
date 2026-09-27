import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit,
  getIpIdentifier,
  recordFailedAttempt,
  resetRateLimit,
} from "../src/lib/rate-limit.js";

/**
 * This limiter is the only thing between a caller and unlimited guesses at a
 * password, so which key it buckets by is a security decision, not a detail.
 */

const reqWith = (headers: Record<string, unknown>) => ({ headers } as never);
const req = (forwardedFor: string) => reqWith({ "x-forwarded-for": forwardedFor });

afterEach(() => {
  vi.useRealTimers();
  resetRateLimit(req("0.0.0.0"));
});

describe("getIpIdentifier", () => {
  it("keys on the hop the fronting proxy appended, not the one the client claimed", () => {
    expect(getIpIdentifier(req("1.2.3.4, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("uses the single value when there is only one hop", () => {
    expect(getIpIdentifier(req("203.0.113.10"))).toBe("203.0.113.10");
  });

  it("falls back to x-real-ip and then to a shared bucket", () => {
    expect(getIpIdentifier(reqWith({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(getIpIdentifier(reqWith({}))).toBe("unknown");
  });
});

describe("checkRateLimit", () => {
  it("still blocks when every request claims a different left-most hop", () => {
    const clientIp = "203.0.113.7";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedAttempt(req(`10.0.0.${attempt}, ${clientIp}`));
    }
    const verdict = checkRateLimit(req(`10.9.9.9, ${clientIp}`));
    expect(verdict.limited).toBe(true);
    expect(verdict.retryAfter).toBeGreaterThan(0);
  });

  it("does not punish an unrelated client for someone else's failures", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) recordFailedAttempt(req("198.51.100.1"));
    expect(checkRateLimit(req("198.51.100.2")).limited).toBe(false);
  });

  it("stops blocking once the window has aged out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let attempt = 0; attempt < 5; attempt += 1) recordFailedAttempt(req("198.51.100.20"));
    expect(checkRateLimit(req("198.51.100.20")).limited).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    expect(checkRateLimit(req("198.51.100.20")).limited).toBe(false);
  });

  it("prunes aged-out identifiers instead of retaining them forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < 50; i += 1) recordFailedAttempt(req(`198.51.100.${i}`));

    vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
    recordFailedAttempt(req("203.0.113.200"));

    // A brand new identifier arriving an hour later should not find the old
    // windows still resident; the map keeps only what can still block someone.
    let stillBlocking = 0;
    for (let i = 0; i < 50; i += 1) {
      if (checkRateLimit(req(`198.51.100.${i}`)).limited) stillBlocking += 1;
    }
    expect(stillBlocking).toBe(0);
  });
});
