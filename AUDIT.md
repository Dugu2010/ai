# DAI Audit — All Bugs

## Bug 1 — auth.ts:22 — base64url encoding broken
`apps/api/src/lib/auth.ts:22` — `replace(/_/g, "_")` is a no-op (replaces `_` with `_`). Should be `replace(/\//g, "_")`. Breaks JWT signing for any payload containing `/` in the base64 output.

## Bug 2 — env.ts:25 — JWT_SECRET fallback is empty string
`apps/api/src/lib/env.ts:25` — `getEnv("JWT_SECRET", "")` returns `""` when unset. Any missing JWT_SECRET silently produces empty-signature tokens. Should have no fallback (throw).

## Bug 3 — projects.ts:103-107 — 201 on sandbox provisioning error
`apps/api/src/routes/projects.ts:103-107` — When sandbox provisioning fails, handler returns `res.status(201)` (success) with error message embedded. Should return 503.

## Bug 4 — agent.ts:342-351 — No retry on sandbox resume
`apps/api/src/routes/agent.ts:342-351` — Sandbox resume is tried once with no retry. workspace.ts `ensureSandboxBooted` has 2 retries with 1500ms delay. agent.ts should match.

## Bug 5 — agent.ts:394 — Tools stripped silently without structured 503
`apps/api/src/routes/agent.ts:394` — When `sandboxReady` is false, agent loops exits immediately. The model is told "answer general questions" but the user-facing response is a generic assistant reply, not a structured 503. Should return structured 503 before SSE starts if sandbox unavailable.

## Bug 6 — page.tsx:485-487 — Duplicate skip-link
`apps/web/app/app/projects/[id]/page.tsx:485-487` — Has `<a href="#main-content">Skip to content</a>` duplicated from `apps/web/app/layout.tsx:44-50`. Only layout.tsx should have it.

## Bug 7 — page.tsx:458-467 — Blocking spinner on load
`apps/web/app/app/projects/[id]/page.tsx:458-467` — Uses `<div className="animate-spin ...">` spinner instead of skeleton. Should use skeletons (no blocking spinners).

## Bug 8 — page.tsx — No model chip in input row
Input row (page.tsx:691-711) lacks compact model selector chip inside the input row.

## Bug 9 — page.tsx — No empty-state prompt chips
Empty chat (page.tsx:661-688 when messages.length === 0) shows nothing. Should show centered panel with prompt chips ("List the files", "Run the tests", "Add a README").

## Bug 10 — page.tsx:513-515 — "Last active" hidden behind display:none
`apps/web/app/app/projects/[id]/page.tsx:513-515` — `display: none` inline style hides "Last active" info. Either remove it or show it.

## Bug 11 — page.tsx:232 — isNarrowViewport state unused
`apps/web/app/app/projects/[id]/page.tsx:233` — `isNarrowViewport` state is set by media query listener but never read in render. Dead code.

## Bug 12 — page.tsx:714-727 — Activity feed max-height 35%
`apps/web/app/app/projects/[id]/page.tsx:715` — `maxHeight: "35%"` on activity feed is fragile. Should be two scroll panes (2026 standard): conversation left, live activity feed right.

## Bug 13 — agent.ts:346 — openSandbox not resumeSandbox
`apps/api/src/routes/agent.ts:346` — Calls `codesandboxClient.openSandbox(project.sandboxId)` which delegates to `resumeSandbox`. While functionally equivalent, should directly use `resumeSandbox` for clarity. Also lacks retry.

## Bug 14 — codesandbox/src/index.ts:88-106 — Bootup polling fragile
`packages/codesandbox/src/index.ts:88-106` — Polls `(info as any).bootupType` with `as any` cast. Should use proper SDK types. Also never transitions to RUNNING in poll loop if SDK returns a different string.

## Bug 15 — auth.ts:21 — `replace(/\+/g, "-")` but missing `/` replace
`apps/api/src/lib/auth.ts:21` — Only replaces `+` → `-`. Missing the required `replace(/\//g, "_")` for proper base64url encoding.

## Bug 16 — agent.ts:333-336 — SSE headers correct but no flush delay handling
SSE headers are set correctly but there's no handling for chunked transfer encoding buffering. Fine for Express, but should verify.

## Bug 17 — page.tsx — No auto-scroll for activity feed
`page.tsx` — Messages scroll to bottom on new message (line 447-448) but activity feed does not auto-scroll.

## Bug 18 — globals.css — No explicit line-height on body
`globals.css:197-203` — Body font-family is set but no `line-height` property. Should be ~1.5 for readability.

## Bug 19 — codesandbox/src/index.ts — Poll reads bootupType from SandboxInfo
`packages/codesandbox/src/index.ts:97-106` — Poll loop reads `(info as any).bootupType` from `sdksandboxes.get()`, but `SandboxInfo` (types.d.ts:37-45) has NO `bootupType` field — only `Sandbox.bootupType` (Sandbox.d.ts:18) is the live, typed source. The cast never transitions, so bootup never advances. FIXED: poll `sandbox.bootupType`, wait setup steps for CLEAN/FORK.

## Bug 20 — agent.ts — Tool results never fed back to the model
`apps/api/src/routes/agent.ts:417-440` — In the agent loop, each tool result was persisted to DB but never pushed back into the `messages` array sent to `nim.chat()`. Without a `tool`-role message per `tool_call_id`, the model cannot plan the next step — the loop stalls after the first tool call. FIXED: `messages.push({ role: "tool", content, tool_call_id, name })` after each call.

## Bug 21 — agent.ts — Sandbox resume after SSE headers; no structured 503
`apps/api/src/routes/agent.ts:333-359` — Headers were flushed BEFORE the sandbox resume attempt, so an unavailable sandbox produced a broken SSE error instead of the spec's structured 503 JSON. FIXED: resume (2 tries/1500ms) happens before `flushHeaders()`; failure returns `503 { error, status: "error" }`.

## Bug 22 — agent.ts — catch ignores error.statusCode
`apps/api/src/routes/agent.ts:457` — The catch always replied 500, discarding `error.statusCode` (e.g. 503 thrown by `resolveNimConfig`). FIXED: `res.status(error.statusCode ?? 500)`.

## Bug 23 — exec timeoutMs dropped — audit only
`codesandbox/src/index.ts:291-315` — `client.commands.run` does not accept `timeoutMs`; a timed-out command relies on the SDK's internal timeout and reports `timedOut: false`. Documented, not user-visible in current flows.

---

Total: 23 bugs found.