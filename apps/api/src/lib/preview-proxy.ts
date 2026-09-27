/**
 * Capability tokens for proxied previews.
 *
 * The previous provider issued an authenticated tunnel: the URL was useless
 * without a token the browser sent. Vercel's `sandbox.domain(port)` is a plain
 * public host, so handing it to the browser would expose a running dev server to
 * anyone who found the address — and preview URLs get shared, screenshotted and
 * pasted into chat.
 *
 * The fix has to survive one awkward constraint: a preview is an iframe, and an
 * iframe fetches its scripts, styles and XHRs without any Authorization header.
 * So the credential cannot be a session header; it has to travel with the URL.
 * That makes it a capability — bearer of the token gets the port — which is why
 * it is signed, short-lived, bound to one project and port, and never logged.
 */

import crypto from "crypto";
import { JWT_SECRET } from "./env.js";

const PURPOSE = "dai-preview";
/** Longer than a page glance, shorter than a work session left open. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${PURPOSE}:${payload}`).digest("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function issuePreviewToken(
  projectId: string,
  port: number,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const secret = JWT_SECRET();
  const expiresAt = now + ttlMs;
  const payload = `${projectId}.${port}.${expiresAt}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload, secret)}`;
}

export interface PreviewClaim {
  projectId: string;
  port: number;
  expiresAt: number;
}

/**
 * Verify a preview capability.
 *
 * Returns null rather than throwing on every failure mode — a bad token is an
 * ordinary unauthenticated request, not a server error. Expiry is checked here as
 * well as at issue time, because a token pasted into a document outlives its use.
 */
export function verifyPreviewToken(
  token: string | undefined,
  projectId: string,
  port: number,
  now: number = Date.now()
): PreviewClaim | null {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [claimProject, claimPort, claimExpiry] = payload.split(".");
  if (!claimProject || !claimPort || !claimExpiry) return null;

  let secret: string;
  try {
    secret = JWT_SECRET();
  } catch {
    // Missing secret means nothing here is verifiable; fail closed.
    return null;
  }
  if (!timingSafeEqual(signature, sign(payload, secret))) return null;
  if (claimProject !== projectId) return null;
  if (Number(claimPort) !== port) return null;
  const expiresAt = Number(claimExpiry);
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return null;
  return { projectId: claimProject, port, expiresAt };
}

/**
 * Rewrite an HTML document so its subresources come back through the proxy.
 *
 * A dev server emits absolute paths (`/src/app.tsx`, `/@vite/client`) and an
 * iframe pointed at `/preview/3000/` would resolve those against the API root and
 * 404. A `<base>` tag makes relative URLs work; absolute ones are rewritten here,
 * because that is the case a base tag cannot fix.
 *
 * Deliberately narrow: only `src`/`href`/`action` starting at the root are
 * touched. Rewriting inline script text would mean parsing JavaScript.
 */
export function rewriteHtmlPreviewPaths(html: string, prefix: string): string {
  const base = prefix.replace(/\/+$/, "");
  // Rewriting first matters: the `<base>` element is itself an `href` beginning
  // with a slash, so injecting it before this pass would have its own URL
  // prefixed, and every relative asset on the page would then resolve to nowhere.
  const rewritten = html.replace(
    /(\b(?:src|href|action)\s*=\s*)(["'])\/(?!\/)/g,
    (_match, attr: string, quote: string) => `${attr}${quote}${base}/`
  );
  return rewritten.replace(/(<head[^>]*>)/i, (_match, head: string) => `${head}<base href="${base}/">`);
}

/** Inbound path → upstream path, given the proxy prefix. */
export function upstreamPath(requestUrl: string, prefix: string): string {
  const rest = requestUrl.startsWith(prefix) ? requestUrl.slice(prefix.length) : requestUrl;
  const trimmed = rest.replace(/^\/+/, "");
  return trimmed ? `/${trimmed}` : "/";
}

/**
 * The URL a browser should use for a preview.
 *
 * `PUBLIC_API_URL` is the API's own externally reachable origin. Without it a
 * relative path is returned, which is correct for a same-origin deployment and
 * wrong for the usual one where the frontend lives on Vercel — so callers must
 * not assume, and `absolutePreviewUrl` says plainly when it could not absolutise.
 */
export function proxiedPreviewPath(projectId: string, port: number, now: number = Date.now()): string {
  const token = issuePreviewToken(projectId, port, now);
  return `/api/workspace/${projectId}/preview/p/${port}/${token}/`;
}

export function absolutePreviewUrl(projectId: string, port: number, now: number = Date.now()): string {
  const base = (process.env.PUBLIC_API_URL ?? "").replace(/\/+$/, "");
  const path = proxiedPreviewPath(projectId, port, now);
  return base ? `${base}${path}` : path;
}
