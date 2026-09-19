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

export function getIpIdentifier(req: { headers: Record<string, unknown> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0];
    if (first) return first.trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") return realIp;
  return "unknown";
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
