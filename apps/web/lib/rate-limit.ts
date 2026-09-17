/**
 * Simple in-memory rate limiter for auth endpoints.
 *
 * LIMITATION: This uses a simple in-memory store (Map) to track failed login attempts.
 * This does NOT scale across multiple instances or server restarts. For production
 * deployments with multiple instances, use a shared store like Redis.
 */

interface RateLimitEntry {
  attempts: number;
  blockedUntil?: number; // timestamp in ms
  lastAttempt: number; // timestamp in ms
}

// Configuration
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const EXPONENTIAL_BACKOFF_FACTOR = 2;
const INITIAL_BACKOFF_MS = 60 * 1000; // 1 minute

// In-memory store (not shared across instances)
const failedAttempts = new Map<string, RateLimitEntry>();

export function getIpIdentifier(request: Request): string {
  // Try to get real IP from headers (proxy/load balancer)
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",");
    if (ips.length > 0) {
      const firstIp = ips[0];
      if (firstIp) {
        return firstIp.trim();
      }
    }
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  // Fall back to a generic identifier
  return "unknown";
}

export function checkRateLimit(request: Request): {
  limited: boolean;
  retryAfter?: number; // seconds
} {
  const identifier = getIpIdentifier(request);
  const now = Date.now();
  const entry = failedAttempts.get(identifier);

  if (!entry || typeof entry !== "object") {
    return { limited: false };
  }

  // Check if currently blocked due to exponential backoff
  if (entry.blockedUntil && now < entry.blockedUntil) {
    return {
      limited: true,
      retryAfter: Math.ceil((entry.blockedUntil - now) / 1000),
    };
  }

  // Clear blocked state if window has passed
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    entry.blockedUntil = undefined;
    entry.attempts = 0;
  }

  // Check if attempts are within the time window
  if (now - entry.lastAttempt > WINDOW_MS) {
    // Reset if outside window
    entry.attempts = 0;
    entry.lastAttempt = now;
    entry.blockedUntil = undefined;
    return { limited: false };
  }

  // Check if limit exceeded
  if (entry.attempts >= MAX_ATTEMPTS) {
    // Apply exponential backoff
    const backoffMs = INITIAL_BACKOFF_MS * Math.pow(EXPONENTIAL_BACKOFF_FACTOR, entry.attempts - MAX_ATTEMPTS);
    entry.blockedUntil = now + backoffMs;
    return {
      limited: true,
      retryAfter: Math.ceil(backoffMs / 1000),
    };
  }

  return { limited: false };
}

export function recordFailedAttempt(request: Request): void {
  const identifier = getIpIdentifier(request);
  const now = Date.now();
  const entry = failedAttempts.get(identifier);

  if (entry) {
    entry.attempts++;
    entry.lastAttempt = now;
  } else {
    failedAttempts.set(identifier, {
      attempts: 1,
      lastAttempt: now,
    });
  }
}

export function resetRateLimit(request: Request): void {
  const identifier = getIpIdentifier(request);
  failedAttempts.delete(identifier);
}
