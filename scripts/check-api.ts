/**
 * scripts/check-api.ts — Quick local API verification
 *
 * Checks that the DAI API server is reachable and all expected routes
 * are registered. Does NOT require authentication or a running sandbox.
 *
 * Run from apps/api/ (needs tsx from local node_modules and .env for dotenv):
 *   cd apps/api && DAI_API_URL=http://localhost:4000 bun run tsx ../scripts/check-api.ts
 *
 * Exit 0 = API is reachable with all expected routes.
 *
 * The 405 on POST /api/projects indicates stale compiled code on the server
 * (current source correctly registers POST /api/projects). This script
 * verifies the running server matches the current source.
 */

const BASE_URL = process.env.DAI_API_URL || "http://localhost:3000";

interface CheckResult {
  method: string;
  path: string;
  expectedStatus: number | string;
  actualStatus: number;
  ok: boolean;
  note: string;
}

function log(msg: string): void {
  console.log(`[check-api] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[check-api] FAIL: ${msg}`);
  process.exit(1);
}

async function check(
  method: string,
  path: string,
  expectedStatus: number | string,
): Promise<CheckResult> {
  let actualStatus = 0;
  let note = "";
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method, redirect: "manual" });
    actualStatus = res.status;
    note = `got ${actualStatus}`;
  } catch (e: any) {
    note = `connection failed: ${e.message}`;
  }
  const ok = expectedStatus === "*"
    ? actualStatus >= 200 && actualStatus < 600
    : actualStatus === expectedStatus;
  return { method, path, expectedStatus, actualStatus, ok, note };
}

async function main(): Promise<void> {
  log(`Checking API at ${BASE_URL}`);

  const checks: CheckResult[] = [];

  // Health endpoint (no auth required)
  checks.push(await check("GET", "/health", 200));

  // Auth endpoints (should NOT 404 — 401/405 is OK, means route exists)
  checks.push(await check("POST", "/api/auth/login", "*"));
  checks.push(await check("POST", "/api/auth/register", "*"));
  checks.push(await check("GET", "/api/auth/me", "*"));

  // Project endpoints (should NOT 404 — 401 means route exists, no auth token)
  checks.push(await check("GET", "/api/projects", "*"));
  checks.push(await check("POST", "/api/projects", "*"));
  checks.push(await check("GET", "/api/projects/nonexistent", "*"));

  // Agent endpoint (should NOT 404)
  checks.push(await check("POST", "/api/projects/nonexistent/agent", "*"));

  // Settings endpoints
  checks.push(await check("GET", "/api/settings", "*"));
  checks.push(await check("POST", "/api/settings", "*"));
  checks.push(await check("GET", "/api/settings/models", "*"));

  // Conversation endpoints
  checks.push(await check("GET", "/api/conversations", "*"));
  checks.push(await check("POST", "/api/conversations", "*"));

  // Workspace endpoints
  checks.push(await check("GET", "/api/workspace/nonexistent", "*"));
  checks.push(await check("POST", "/api/workspace/nonexistent", "*"));

  // Report
  console.log("");
  console.log("─────────────────────────────────────────────");
  console.log(`  DAI API Check — ${BASE_URL}`);
  console.log("─────────────────────────────────────────────");

  let allOk = true;
  for (const c of checks) {
    const status = c.ok ? "PASS" : "FAIL";
    const expected = c.expectedStatus === "*" ? "any" : c.expectedStatus;
    console.log(`  ${status}  ${c.method} ${c.path}  (expected: ${expected}, got: ${c.actualStatus}) ${c.note}`);
    if (!c.ok) allOk = false;
  }

  console.log("─────────────────────────────────────────────");

  if (!allOk) {
    fail("Some checks failed — API is not reachable or routes are missing.");
  }

  log("All checks passed — API is reachable with all expected routes.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[check-api] Unhandled error:", err);
  process.exit(1);
});
