/**
 * Simple in-memory rate limiter for auth endpoints.
 * Fine for a single Render instance; swap for Redis if you scale horizontally.
 */

interface RateLimitEntry {
  attempts: number;
  blockedUntil?: number;
  lastAttempt: number;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const EXPONENTIAL_BACKOFF_FACTOR = 2;
const INITIAL_BACKOFF_MS = 60 * 1000;

const failedAttempts = new Map<string, RateLimitEntry>();

/** Bound on tracked identifiers; a flood of distinct keys must not grow forever. */
const MAX_TRACKED_IDENTIFIERS = 10_000;

export function getIpIdentifier(req: { headers: Record<string, unknown> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // The right-most hop: the left-most is whatever the client put in the
    // header, so keying on it lets every request choose its own bucket and
    // defeats the limiter entirely.
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp) return realIp;
  return "unknown";
}

/** Drop windows that can no longer block anyone, so the map cannot grow without bound. */
function pruneExpired(now: number): void {
  for (const [key, entry] of failedAttempts) {
    const blocked = entry.blockedUntil && entry.blockedUntil > now;
    if (!blocked && now - entry.lastAttempt > WINDOW_MS) failedAttempts.delete(key);
  }
  if (failedAttempts.size <= MAX_TRACKED_IDENTIFIERS) return;
  const byAge = [...failedAttempts.entries()].sort((a, b) => a[1].lastAttempt - b[1].lastAttempt);
  for (const [key] of byAge.slice(0, failedAttempts.size - MAX_TRACKED_IDENTIFIERS)) {
    failedAttempts.delete(key);
  }
}

export function checkRateLimit(req: { headers: Record<string, unknown> }): {
  limited: boolean;
  retryAfter?: number;
} {
  const identifier = getIpIdentifier(req);
  const now = Date.now();
  const entry = failedAttempts.get(identifier);
  if (!entry) return { limited: false };

  if (entry.blockedUntil && now < entry.blockedUntil) {
    return { limited: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    entry.blockedUntil = undefined;
    entry.attempts = 0;
  }
  if (now - entry.lastAttempt > WINDOW_MS) {
    entry.attempts = 0;
    entry.lastAttempt = now;
    entry.blockedUntil = undefined;
    return { limited: false };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    const backoffMs = INITIAL_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_FACTOR, entry.attempts - MAX_ATTEMPTS);
    entry.blockedUntil = now + backoffMs;
    return { limited: true, retryAfter: Math.ceil(backoffMs / 1000) };
  }
  return { limited: false };
}

export function recordFailedAttempt(req: { headers: Record<string, unknown> }): void {
  const identifier = getIpIdentifier(req);
  const now = Date.now();
  pruneExpired(now);
  const entry = failedAttempts.get(identifier);
  if (entry) {
    entry.attempts++;
    entry.lastAttempt = now;
  } else {
    failedAttempts.set(identifier, { attempts: 1, lastAttempt: now });
  }
}

export function resetRateLimit(req: { headers: Record<string, unknown> }): void {
  failedAttempts.delete(getIpIdentifier(req));
}
