import { describe, expect, it } from "vitest";
import {
  absolutePreviewUrl,
  issuePreviewToken,
  proxiedPreviewPath,
  rewriteHtmlPreviewPaths,
  upstreamPath,
  verifyPreviewToken,
} from "../src/lib/preview-proxy.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-value-for-preview-tests";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const PROJECT = "8f14e45f-ceea-467a-a9d5-6e2b1f0a0b1c";

describe("preview capability tokens", () => {
  it("round-trips a token bound to one project and port", () => {
    const token = issuePreviewToken(PROJECT, 3000, NOW);
    expect(verifyPreviewToken(token, PROJECT, 3000, NOW)).toMatchObject({ projectId: PROJECT, port: 3000 });
  });

  it("rejects a token replayed against another project", () => {
    const token = issuePreviewToken(PROJECT, 3000, NOW);
    expect(verifyPreviewToken(token, "other-project", 3000, NOW)).toBeNull();
  });

  it("rejects a token replayed against another port", () => {
    const token = issuePreviewToken(PROJECT, 3000, NOW);
    expect(verifyPreviewToken(token, PROJECT, 5173, NOW)).toBeNull();
  });

  it("rejects a forged signature", () => {
    const token = issuePreviewToken(PROJECT, 3000, NOW);
    const [payload] = token.split(".");
    const tampered = `${payload}.${"A".repeat(40)}`;
    expect(verifyPreviewToken(tampered, PROJECT, 3000, NOW)).toBeNull();
  });

  it("rejects a payload rewritten to claim another project", () => {
    // The signature must cover the binding, not merely be present.
    const token = issuePreviewToken(PROJECT, 3000, NOW);
    const [, signature] = token.split(".");
    const fake = Buffer.from(`other-project.3000.${NOW + 10_000}`).toString("base64url");
    expect(verifyPreviewToken(`${fake}.${signature}`, "other-project", 3000, NOW)).toBeNull();
  });

  it("expires", () => {
    const token = issuePreviewToken(PROJECT, 3000, NOW, 60_000);
    expect(verifyPreviewToken(token, PROJECT, 3000, NOW + 30_000)).not.toBeNull();
    expect(verifyPreviewToken(token, PROJECT, 3000, NOW + 61_000)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [undefined, "", "no-dot", "a.b", "!!!!.b"]) {
      expect(verifyPreviewToken(bad, PROJECT, 3000, NOW)).toBeNull();
    }
  });

  it("produces a path a browser can actually load", () => {
    const path = proxiedPreviewPath(PROJECT, 3000, NOW);
    expect(path.startsWith(`/api/workspace/${PROJECT}/preview/p/3000/`)).toBe(true);
    expect(path.endsWith("/")).toBe(true);
    const token = path.split("/")[7];
    expect(verifyPreviewToken(token, PROJECT, 3000, NOW)).not.toBeNull();
  });

  it("is relative when the API's own origin is unknown", () => {
    delete process.env.PUBLIC_API_URL;
    expect(absolutePreviewUrl(PROJECT, 3000, NOW).startsWith("/api/")).toBe(true);
    process.env.PUBLIC_API_URL = "https://dai-api.onrender.com/";
    expect(absolutePreviewUrl(PROJECT, 3000, NOW).startsWith("https://dai-api.onrender.com/api/")).toBe(true);
    delete process.env.PUBLIC_API_URL;
  });
});

describe("rewriting a proxied document", () => {
  const PREFIX = `/api/workspace/${PROJECT}/preview/p/3000/TOKEN`;

  it("anchors relative URLs with a base tag", () => {
    const out = rewriteHtmlPreviewPaths("<html><head><title>t</title></head><body>", PREFIX);
    expect(out).toContain(`<base href="${PREFIX}/">`);
  });

  it("rewrites root-absolute assets back through the proxy", () => {
    const html = '<script type="module" src="/@vite/client"></script><link href="/src/index.css" rel="stylesheet">';
    const out = rewriteHtmlPreviewPaths(html, PREFIX);
    expect(out).toContain(`src="${PREFIX}/@vite/client"`);
    expect(out).toContain(`href="${PREFIX}/src/index.css"`);
  });

  it("leaves scheme-relative and full URLs alone", () => {
    const html = '<img src="//cdn.example.com/a.png"><a href="https://example.com/x">x</a>';
    expect(rewriteHtmlPreviewPaths(html, PREFIX)).toBe(html);
  });

  it("does not rewrite text that is not a URL attribute", () => {
    const html = "<p>use /workspace for files</p>";
    expect(rewriteHtmlPreviewPaths(html, PREFIX)).toBe(html);
  });

  it("maps an inbound request path onto the upstream server", () => {
    expect(upstreamPath(`${PREFIX}/src/app.tsx?raw`, PREFIX)).toBe("/src/app.tsx?raw");
    expect(upstreamPath(`${PREFIX}/`, PREFIX)).toBe("/");
    expect(upstreamPath(PREFIX, PREFIX)).toBe("/");
  });
});
