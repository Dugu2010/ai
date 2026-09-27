import { Router, Request, Response } from "express";
import { getProject } from "@dai/db";
import { verifyPreviewToken, rewriteHtmlPreviewPaths, upstreamPath } from "../lib/preview-proxy.js";

/**
 * Render-side proxy for a running dev server.
 *
 * Mounted before the authenticated workspace router and deliberately outside
 * `requireAuth`: an iframe cannot send an Authorization header, so the
 * credential has to be the capability in the URL. `verifyPreviewToken` is
 * therefore the only gate in this file, and it must stay that way — anything
 * added here that trusts the path alone widens what a leaked URL can do.
 *
 * The upstream address is the project's stored preview host, so answering a
 * proxied asset never acquires a sandbox: no boot, no command, no billed second.
 */
const router = Router();

/** Hop-by-hop headers that must not be forwarded verbatim. */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "set-cookie",
]);

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

const prefixFor = (projectId: string, port: number, token: string) =>
  `/api/workspace/${projectId}/preview/p/${port}/${token}`;

router.get("/:projectId/preview/p/:port/:token", async (req: Request, res: Response) => {
  const projectId = req.params.projectId!;
  const port = Number(req.params.port);
  const token = req.params.token ?? "";

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    res.status(400).send("Invalid port");
    return;
  }
  if (!verifyPreviewToken(token, projectId, port)) {
    // 404 rather than 403: an expired or forged capability should not confirm
    // that the project exists.
    res.status(404).send("This preview link is no longer valid.");
    return;
  }

  try {
    const project = await getProject(projectId);
    if (!project?.previewUrl) {
      res.status(503).send("This preview is not running.");
      return;
    }

    const upstreamBase = project.previewUrl.replace(/\/+$/, "");
    const prefix = prefixFor(projectId, port, token);
    // req.path excludes the query string; req.originalUrl keeps it, which a dev
    // server's own routing depends on.
    const inbound = req.originalUrl ?? req.path;
    const upstreamPathname = upstreamPath(inbound, prefix);
    const target = `${upstreamBase}${upstreamPathname}`;

    const upstream = await fetch(target, {
      redirect: "manual",
      headers: { accept: req.headers.accept ?? "*/*" },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);

    if (!upstream) {
      res.status(502).send("The preview server did not answer.");
      return;
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      // Rewrite a redirect that would otherwise escape the proxy and land the
      // browser on the bare public host.
      const location = upstream.headers.get("location") ?? "/";
      const rewritten = location.startsWith("/")
        ? `${prefix}${location}`
        : location.replace(upstreamBase, prefix);
      res.status(302).setHeader("Location", rewritten).end();
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    res.status(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    }
    res.setHeader("Cache-Control", "no-store");

    if (contentType.includes("text/html") && upstream.body) {
      const html = await upstream.text();
      // Cap the rewrite: an HTML body past this size is not a page anyone is
      // inspecting, and buffering it costs the API host memory.
      if (html.length <= MAX_PREVIEW_BYTES) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(rewriteHtmlPreviewPaths(html, prefix));
        return;
      }
      res.status(413).send("Preview document is too large to proxy.");
      return;
    }

    // Anything else is streamed straight through: no buffering, no Active CPU
    // anywhere in the chain.
    const reader = upstream.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
  } catch (error) {
    console.error("[preview-proxy]", error instanceof Error ? error.message : error);
    if (!res.headersSent) res.status(502).send("Preview is unavailable.");
  }
});

export { prefixFor as previewProxyPrefix };
export default router;
