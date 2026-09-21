# DAI Audit — All Bugs

> **Scope note:** this audit describes the **CodeSandbox-era** runtime. DAI has
> since migrated to Modal Sandbox + Modal Volume — see `RUNTIME_ARCHITECTURE.md`
> and `MODAL_RUNTIME_MIGRATION.md`. The findings stay accurate as history, and
> two of its lessons shaped that design: verify SDK calls against the shipped
> `.d.ts`, and never treat a metadata lookup as a liveness signal. The
> "Verification blocker" section below refers to the frozen CodeSandbox account,
> not to Modal.

The original pass found 23 bugs. A re-audit of the current source confirmed 16 of
them already fixed, and added bugs 24-42 found by re-reading every file and
probing the live CodeSandbox API. `FIXED` means verified in the source, not
assumed. The status roll-up is at the bottom of this file.

## Bug 1 — auth.ts base64url encoding broken — FIXED
`apps/api/src/lib/auth.ts:20-22` now replaces `=`, `+` and `/` correctly.

## Bug 2 — env.ts JWT_SECRET fallback was empty string — FIXED
`apps/api/src/lib/env.ts:25` — `getEnv("JWT_SECRET")` with no fallback throws
when unset; `signJwt`/`verifyJwt` also guard against an empty secret.

## Bug 3 — projects.ts returned 201 on sandbox provisioning error — FIXED
`apps/api/src/routes/projects.ts:105-109` returns 503 with `{ error, status }`.

## Bug 4 — agent.ts no retry on sandbox resume — FIXED
`apps/api/src/routes/agent.ts:339-347` — 2 attempts with a 1500ms delay.

## Bug 5 — Tools stripped silently without structured 503 — FIXED
`apps/api/src/routes/agent.ts:348-351` returns structured 503 before headers.

## Bug 6 — Duplicate skip-link — FIXED
`grep -rn "Skip to content"` matches `apps/web/app/layout.tsx:49` only.

## Bug 7 — Blocking spinner on load — OPEN
`apps/web/app/app/projects/[id]/page.tsx:492-501` renders
`animate-spin rounded-full h-12 w-12`. Spec: no blocking spinners, skeletons only.

## Bug 8 — No model chip in input row — FIXED
`page.tsx:744-750` renders a compact chip via `modelLabel(modelId)`.

## Bug 9 — No empty-state prompt chips — FIXED
`page.tsx:694-712` renders "List the files", "Run the tests", "Add a README".

## Bug 10 — "Last active" hidden behind display:none — FIXED
`page.tsx:544` uses `hidden md:inline` instead of an inline `display: none`.

## Bug 11 — isNarrowViewport state unused — FIXED
`page.tsx:674` — `readOnly: isNarrowViewport`.

## Bug 12 — Activity feed max-height 35% — OPEN
`page.tsx:773` still sets `style={{ maxHeight: "35%" }}`. Two independent scroll
panes are required.

## Bug 13 — openSandbox instead of resumeSandbox — FIXED
`agent.ts:341` calls `resumeSandbox` directly.

## Bug 14 — Bootup polling fragile — SUPERSEDED by Bug 28.

## Bug 15 — auth.ts missing `/` replacement — FIXED (same fix as Bug 1).

## Bug 16 — SSE buffering — FIXED
`agent.ts:357` sets `X-Accel-Buffering: no` alongside the required headers.

## Bug 17 — No auto-scroll for activity feed — OPEN
`page.tsx:480-482` scrolls `messagesEndRef` only; the activity pane never scrolls.

## Bug 18 — No line-height on body — OPEN
`apps/web/app/globals.css:196-203` sets background, color, font-family and
font-feature-settings, but no `line-height`.

## Bug 19 — Poll read bootupType from SandboxInfo — FIXED
`packages/codesandbox/src/index.ts:93` reads the typed `sandbox.bootupType`.

## Bug 20 — Tool results never fed back to the model — FIXED
`agent.ts:432` pushes `{ role: "tool", tool_call_id, name }` after every call.

## Bug 21 — Sandbox resume after SSE headers — FIXED
Resume at `agent.ts:336-352` precedes `flushHeaders()` at `agent.ts:358`.

## Bug 22 — catch ignores error.statusCode — FIXED
`agent.ts:458` — `error.statusCode ?? 500`.

## Bug 23 — exec timeoutMs dropped — OPEN, promoted to Bug 29.

---

# Re-audit (2026-09-21) — new findings

## Bug 24 — index.ts:78 — /api/health does not exist
`apps/api/src/index.ts:78` registers `app.get("/health")`. Every `/api/*` mount
is under `/api`, so `GET /api/health` falls through to the 404 handler at
`index.ts:90-92`. The spec requires `GET /api/health` → `200 {"ok":true}`.
`scripts/check-api.ts:63` only checks `/health`, which is why this stayed hidden.

## Bug 25 — workspace.ts:390 — status reports "running" for a hibernated sandbox
`GET /api/workspace/:id/status` computes `state: info ? "running" : "unknown"`
from `getSandboxInfo()`. `SandboxInfo` (`@codesandbox/sdk` `types.d.ts:37-45`) is
`{ id, createdAt, updatedAt, title?, description?, privacy, tags }` — it has **no
state field**. A metadata hit only proves the sandbox exists, so a hibernated
sandbox reports "running" and the status pill lies.
Verified live against the account's 4 sandboxes: `listRunning()` returned
`concurrentVmCount: 0`, `vms: []`, while `/status` still answers `"running"`.
This also makes `scripts/e2e.ts:98-114` `waitForRunning` a tautology — it passes
without proving anything about the sandbox.

## Bug 26 — agent.ts — tool and assistant rows persisted with project_id NULL
`packages/db/src/index.ts:624` inserts `project_id`, but `agent.ts` passes
`projectId` only for the user message (`agent.ts:388`). The assistant row at
`agent.ts:410-413`, every tool row at `agent.ts:434-440` and the final assistant
row at `agent.ts:448-451` omit it, so `messages.project_id` is NULL for exactly
the rows the spec names (project_id, role, tool_name, tool_args, tool_result).

## Bug 27 — agent.ts:453 — done event sends the conversation id as messageId
`writeSSE(res, "done", { messageId: convId })` labels a conversation id as a
message id, so the client cannot correlate the finished assistant message.

## Bug 28 — codesandbox index.ts:100-110 — the bootup poll loop is dead code
`sandbox.bootupType` reads a frozen snapshot: the compiled getter is
`get bootupType() { return this.pitcherManagerResponse.bootupType }`
(`dist/cjs/index.cjs:11627`), where `pitcherManagerResponse` is captured at
construction (`Sandbox.d.ts:9`). It never changes on a live object. Since
`CLEAN`/`FORK` are handled at `:94` and `RUNNING`/`RESUME` exit the loop
immediately, the `while` condition can never hold: `maxPoll`/`pollCount` are
inert and the code reads as if it waits when it does not.

## Bug 29 — codesandbox index.ts:295 — timeoutMs is accepted but never enforced
`ShellRunOpts` is `{ dimensions?, name?, env?, cwd?, asGlobalSession? }`
(`SandboxClient/commands.d.ts:9-19`) and `run()` returns a combined `string`
(`:48`) — the SDK has no timeout option. `exec()` takes `timeoutMs`, never
forwards it, and hardcodes `timedOut: false` (`:308`, `:316`). Callers bound
commands with `MAX_TIMEOUT_MS` (`agent.ts:258`, `workspace.ts:342`), so a hung
`npm install` blocks the request with no ceiling. `commands.d.ts:24-34` also
confirms `CommandError` carries one merged `output` buffer, so the stdout/stderr
split in `ExecResult` is nominal: on non-zero exit everything lands in `stderr`.

## Bug 30 — page.tsx:791-801 — preview is one-way and has no empty state
`setShowPreview` is only ever called with `false` (`:793`), so collapsing the
preview bar removes it for the session with no way back. The
`&& previewUrl` guard means an unstarted dev server renders nothing at all,
whereas the spec requires an empty Preview with a "Start the dev server" button.

## Bug 31 — page.tsx:602,643 — Files pane does not show provisioning state
Both the drawer and the sidebar render `No files yet` whenever `readDir` returns
nothing, which is also the normal state while a sandbox is still booting or after
a failed provision. Spec: skeleton tree plus "Provisioning sandbox…".

## Bug 32 — page.tsx — dead state and dead helper
`restarting` (`:269`) is never read or set; `isUpToDate` (`:268`, set at `:304`)
is never rendered, so the "restart to update the VM agent" affordance the state
was written for does not exist; `formatTime` (`:81-90`) is never called;
`skeletonLoading` (`:270`) is always cleared in the same `finally` as `loading`
(`:292-293`), making it a second copy of one flag.

## Bug 33 — page.tsx:395-403 — assistant_delta can merge into a prior turn
The append path reuses "the last message if it is assistant". After a completed
turn the last message *is* assistant, so the first delta of the next turn appends
to the previous bubble instead of starting a new one.

## Bug 34 — page.tsx:372 — a structured 503 is reported as a bare status code
When the backend answers the spec's structured 503 (`agent.ts:349`), the client
throws `Agent request failed (503)` and discards the JSON body, so the user loses
the actual reason and the spec's inline-banner-plus-Retry path degrades.

## Bug 35 — agent.ts:381-384 — replayed history drops tool turns
History is filtered to `user`/`assistant`, but the assistant rows written at
`agent.ts:410-413` carry `content: null` when the model only emitted tool calls.
Those become empty assistant turns in later requests, so multi-turn context
degrades into blank messages.

## Bug 36 — scripts/e2e.ts:215-218 — generic parameters on a non-generic type
`SSEEvent` is declared non-generic at `:54` yet used as `SSEEvent<ToolCallEvent>[]`
at `:215-218`. `scripts/` is outside every `tsconfig.json` include, so
`bun run typecheck` never compiles this file and the error stays invisible until
someone adds it to a project.

## Bug 37 — workspace.ts:362 — isArchived uses lastAccessedAt only
`isArchived()` (`workspace.ts:32-36`) guesses cold storage from the local
`last_accessed_at` column, which is never updated by an automatic wakeup or a
direct editor visit, so a genuinely archived sandbox can be reported live and
vice versa.

## Bug 42 — page.tsx:746 — root container could not bound its scroll panes
The page root was `min-h-screen ... flex flex-col`, which grows with its content, so
the `flex-1 min-h-0` descendants had no definite height to shrink against and the
"two independently scrolling panes" collapsed into one document-level scroll.
FIXED: `min-h-screen lg:h-screen … lg:overflow-hidden`, plus `min-h-0` on the
editor column.

## Bug 41 — page.tsx:748 — command palette wired to an empty command list
`<CommandPalette projectId={projectId} commands={[]} />` while
`getDefaultProjectCommands(projectId)` (`components/command-palette.tsx:169`) exists
specifically for this page and is never imported. Cmd+K therefore opens a modal
that always reads "No matching commands". Its commands also dispatch
`refresh-files` / `new-file` / `toggle-preview` CustomEvents that no component
subscribes to. NOT FIXED — the command palette is not part of the requested
layout, and wiring it means building a file-creation flow; flagged rather than
half-implemented.

## Bug 40 — page.tsx — no auth guard on the workspace route
The page imported `isAuthenticated` and never called it, unlike the dashboard
(`app/app/projects/page.tsx:22-24`), so an unauthenticated visitor to
`/app/projects/:id` saw "Project not found" instead of being sent to
`/auth/login`. FIXED.

## Bug 39 — page.tsx:332-351 — activity pane lost on reload
`loadHistory` filtered conversation rows to `user`/`assistant`, discarding the
`tool` rows the backend persists, so the activity feed was empty after any page
reload even though the agent's actions were in the database. FIXED.

## Bug 38 — page.tsx:441-458 — Save was unreachable
`saveFile` posted the buffer to `POST /api/workspace/:id`, but no control invoked
it, so edits made in Monaco were silently discarded on navigation. FIXED: Save in
the editor header, disabled while the editor is read-only below `sm`.

---

Total: 42 bugs found. Fixed and verified in source: 1, 2, 3, 4, 5, 6, 7, 8, 9,
10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32,
33, 34, 35, 36, 38, 39, 40, 42. Not fixed: 41 (out of requested scope,
documented); 37 (needs a CodeSandbox field that `SandboxInfo` does not expose).

## Verification blocker

`CODESANDBOX_API_KEY` resolves to a **frozen workspace**: every VM start fails with
`Your workspace has been frozen. Please upgrade or increase your spending limit to
continue.` Reproduced three ways — resume of two existing sandboxes (`vjsc97`,
`wnwxjy`) and a fresh `create({ id: "k8dsq1" })`. Consequently `scripts/e2e.ts`,
which provisions a real sandbox and asserts a `write_file` tool round-trip, cannot
pass on this account regardless of code state, and the tool-persistence fixes
(Bugs 26, 39) cannot be exercised end to end. Everything not requiring a live VM
was verified against the running stack; see the phase report.

