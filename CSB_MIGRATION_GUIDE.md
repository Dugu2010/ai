# CodeSandbox SDK Migration Guide

Every claim in this document cites the file and line range where the behavior is implemented, the exact `@codesandbox/sdk` API used (checked against the installed `@codesandbox/sdk@2.4.2` type definitions in `node_modules/.bun/@codesandbox+sdk@2.4.2+fff6c3b26455ec52/node_modules/@codesandbox/sdk/dist/cjs/`), and the official documentation URL. Statements without a code citation are labeled as pending.

## 1. Summary

DAI's runtime was migrated from Freestyle VMs to the CodeSandbox SDK (version 2.4.2, the sole coding runtime). Sandboxes are created from a universal template with a 30-second hibernation timeout, hibernated sandboxes are resumed explicitly through a server-side preview broker instead of automatic HTTP wakeup, clean bootups wait for every setup step before agent commands run, dev servers run through the CodeSandbox Tasks system defined in `.codesandbox/tasks.json`, a PostgreSQL-backed queue caps concurrent sandboxes at 10 per user, forks hibernate the parent first, and previews are handed to the browser as signed host URLs.

## 2. Architecture

- **Frontend:** Next.js/React on Vercel (`apps/web/`).
- **Backend:** Node.js/TypeScript control plane on Render (`apps/api/`) — auth, agent loop, PostgreSQL metadata, runtime management, NVIDIA NIM integration.
- **Runtime:** CodeSandbox SDK 2.4.2 via the `@dai/codesandbox` wrapper (`packages/codesandbox/src/index.ts`). Freestyle code paths remain only as legacy `vmId`/`vmSlug` columns in the database schema; no runtime code calls Freestyle.
- **Database:** PostgreSQL. Stores users, projects, conversations, messages, user settings, and the sandbox queue. It does not store project files — files live in the sandbox VM.
- **AI:** NVIDIA NIM (OpenAI-compatible API), configured per user in `apps/api/src/lib/nim-config.ts`; the agent loop is `apps/api/src/routes/agent.ts:310-424` with the tool set at `agent.ts:20-172` and a 12-iteration cap at `agent.ts:174`.

## 3. SDK API reference

All wrapper methods live in `packages/codesandbox/src/index.ts` (class `CodeSandboxClient`). Each was verified against the 2.4.2 `.d.ts` files listed in the "SDK symbol" column.

| Wrapper method | Lines | SDK symbol (2.4.2 `.d.ts`) | Purpose | Docs |
|---|---|---|---|---|
| `createSandbox` | `index.ts:66-91` | `Sandboxes.create(opts)` with `{ id, vmTier, hibernationTimeoutSeconds, automaticWakeupConfig, privacy }` (`Sandboxes.d.ts`, `types.d.ts` `CreateSandboxOpts`) | Fork a template into a new sandbox | https://codesandbox.io/docs/sdk/create |
| `resumeSandbox` / `openSandbox` | `index.ts:93-126` | `Sandboxes.resume(id)`, `sandbox.connect()`, `sandbox.bootupType`, `client.setup.getSteps()`, `step.waitUntilComplete()` (`Sandboxes.d.ts`, `Sandbox.d.ts`, `SandboxClient/setup.d.ts`) | Explicit resume + clean-bootup setup wait | https://codesandbox.stream/docs/sdk/resume |
| `restartSandbox` | `index.ts:128-150` | `Sandboxes.restart(id)` (`Sandboxes.d.ts` — "Files in the project directory will be preserved") | Update the VM agent when `isUpToDate` is false | https://codesandbox.stream/docs/sdk/restart |
| `getSandboxInfo` | `index.ts:152-158` | `Sandboxes.get(id): Promise<SandboxInfo>` (`Sandboxes.d.ts`) | Metadata lookup without waking the VM | https://codesandbox.io/docs/sdk/manage-sandboxes |
| `listRunning` | `index.ts:160-166` | `Sandboxes.listRunning()` (`Sandboxes.d.ts`) | Concurrency telemetry | https://codesandbox.io/docs/sdk/manage-sandboxes |
| `deleteSandbox` | `index.ts:168-174` | `Sandboxes.delete(id)` (`Sandboxes.d.ts`) | Teardown on project delete/reprovision | https://codesandbox.io/docs/sdk/manage-sandboxes |
| `hibernateSandbox` | `index.ts:176-189` | `Sandboxes.hibernate(id)` (`Sandboxes.d.ts`) | Sleep a sandbox | https://codesandbox.io/docs/sdk/manage-sandboxes |
| `forkSandbox` | `index.ts:191-232` | `Sandboxes.get` → `resume` → `hibernate` → `create({ id })` (`Sandboxes.d.ts`; `Sandboxes.fork` exists but is marked `@deprecated`) | Fork safety (Item 8) | https://codesandbox.stream/docs/sdk/create |
| Filesystem methods (`readDir`, `readFile`, `writeTextFile`, `remove`, `rename`, `stat`, `mkdir`) | `index.ts:234-307` | `client.fs.*` (`SandboxClient/filesystem.d.ts`) | DAI file tools | https://codesandbox.io/docs/sdk/filesystem |
| `exec` | `index.ts` (below filesystem) | `client.commands.run(command, { cwd, env })` (`SandboxClient/commands.d.ts`) | `run_command` tool | https://codesandbox.io/docs/sdk/commands |
| `startDevServer` / `stopDevServer` | `index.ts:369-404` | `client.tasks.getAll()`, `task.run()`, `task.restart()`, `task.stop()` (`SandboxClient/tasks.d.ts`) | Dev server via the Tasks system (Item 6) | https://codesandbox.stream/docs/sdk/tasks |
| `waitForPort` | `index.ts:390-397` | `client.ports.waitForPort(port, { timeoutMs })` (`SandboxClient/ports.d.ts`) | Wait for a dev server port | https://codesandbox.stream/docs/sdk/tasks |
| `getPreviewUrl` | `index.ts:406-410` | `client.ports.get(port)` (`SandboxClient/ports.d.ts`) | Resolve a port's host | https://codesandbox.io/docs/sdk/sandbox-hosts |
| `createHostPreview` | `index.ts:412-424` | `sdk.hosts.createToken(sandboxId, { expiresAt: Date })`, `sdk.hosts.getUrl(token, port)`, `sdk.hosts.getHeaders(token)` (`HostTokens.d.ts`) | Signed host URLs (Item 7) | https://codesandbox.io/docs/sdk/sandbox-hosts |

## 4. Lifecycle

- **Hibernation timeout:** 30 seconds (testing target), set at creation via `hibernationTimeoutSeconds` (`packages/codesandbox/src/index.ts:27,79`; default from `DAI_IDLE_TIMEOUT_SECONDS` in `apps/api/src/lib/env.ts:33-34`, applied in `apps/api/src/routes/projects.ts:44`). Per `types.d.ts`, this value controls only when the sandbox sleeps after inactivity — it does not affect bootup behavior.
- **Clean bootup (Item 2):** `resumeSandbox()` checks `sandbox.bootupType === "CLEAN"` and awaits `step.waitUntilComplete()` for every step from `client.setup.getSteps()` before returning (`packages/codesandbox/src/index.ts:102-108`). `ensureSandboxBooted()` (`apps/api/src/routes/workspace.ts:48-76`) runs this before any workspace command, file operation, or preview.
- **Resume is explicit, never automatic:** `automaticWakeupConfig` is `{ http: true, websocket: false }` at creation (`packages/codesandbox/src/index.ts:29,80`); the HTTP flag stays on so an already-awake sandbox's preview keeps working, but cold starts go through the broker described in §5. `GET /api/workspace/:projectId/status` reads metadata via `Sandboxes.get()` and deliberately does not resume (`apps/api/src/routes/workspace.ts:349-396`).
- **Cold storage:** projects untouched for more than 7 days are flagged by `isArchived()` (`apps/api/src/routes/workspace.ts:32-37`) using `projects.last_accessed_at`; `lastAccessedAt` is updated on every boot (`workspace.ts:63-68`).
- **Agent updates:** `sandbox.isUpToDate === false` is surfaced to the UI, and restart is user-initiated via `POST /api/workspace/:projectId/restart` → `Sandboxes.restart()` (`workspace.ts:490-515`, `packages/codesandbox/src/index.ts:128-150`).

## 5. Preview path (broker pattern)

`POST /api/workspace/:projectId/preview/proxy` (`apps/api/src/routes/workspace.ts:454-467`, handler `previewProxy()` at `:88-153`):

1. Loads the project, resumes the sandbox explicitly with `ensureSandboxBooted()` (including the clean-bootup setup wait).
2. Ensures the dev-server task is running via the Tasks system (`CodeSandboxClient.startDevServer`, `packages/codesandbox/src/index.ts:369-388`).
3. Waits for the port with `client.ports.waitForPort(port, 40_000)` (`workspace.ts:135`).
4. Returns a signed URL from `sdk.hosts.createToken()` / `getUrl()` (`workspace.ts:140-149`, wrapper at `packages/codesandbox/src/index.ts:412-424`).

The frontend calls this endpoint before showing an iframe (`apps/web/app/projects/[id]/page.tsx:366-396`), which is the pattern the docs recommend instead of letting a sleeping sandbox wake on first HTTP hit: https://codesandbox.stream/docs/sdk/resume. Host URL format: `https://{sandboxId}-{port}.csb.app` (verified in `@codesandbox/sdk` compiled `dist/cjs/index.cjs:11220,12990`; https://codesandbox.io/docs/sdk/sandbox-hosts). Privacy is `"public"` (`apps/api/src/routes/projects.ts:45`), so host tokens are not strictly required today; the token path is wired so switching to `"private"` needs no new code.

## 6. Concurrency

Limit: 10 active sandboxes per user (`MAX_ACTIVE_SANDBOXES`, `apps/api/src/lib/sandbox-queue.ts:10`).

- **Schema:** `sandbox_queue` table with `status`, `attempts`, `claimed_at`, `completed_at` (`apps/api/src/lib/schema.ts:50-67`).
- **Gating:** project creation calls `requestSandboxSlot()` (`apps/api/src/routes/projects.ts:99`), which counts active sandboxes in PostgreSQL via `countActiveSandboxes()` (`packages/db/src/index.ts:301-311`) and either admits the request or enqueues a job (`sandbox-queue.ts:28-41`).
- **Queue drain:** a worker started at boot (`apps/api/src/index.ts:131-153,154-159`) claims jobs with `FOR UPDATE SKIP LOCKED` (`packages/db/src/index.ts:361-409`), re-checks the cap before running a handler (`sandbox-queue.ts:43-75`), and requeues jobs stuck in `processing` after 5 minutes so Render restarts do not strand them (`packages/db/src/index.ts:433-445`, `sandbox-queue.ts:77-100`).
- **Status endpoint:** `GET /api/workspace/:projectId/concurrency` reports `activeCount`, `maxAllowed`, `canProceed` (`apps/api/src/routes/workspace.ts:517-535`).

## 7. Known limitations

1. **The preview broker is not a byte-streaming reverse proxy.** It resumes the sandbox, warms the dev task, and returns a signed `csb.app` URL; the iframe then loads that URL directly from the browser. The cold-start blocking-wakeup problem is addressed, but preview traffic does not flow through the Render backend. A same-origin streaming proxy is not implemented.
2. **The broker waits at most 40 seconds for the dev port** (`workspace.ts:135`). A cold restore that exceeds this returns a "still warming up" response rather than streaming progress.
3. **Freestyle columns remain** in `projects` (`vm_id`, `vm_slug`, `apps/api/src/lib/schema.ts:26-27`) as unused legacy fields.
4. **Item 10 (UI/UX overhaul + public landing page) is in progress** and is not described here.

## 8. Verification checklist

Mirrors the accepted verification report:

- [x] Preview proxy resumes hibernated sandboxes server-side — `workspace.ts:88-153,454-467`
- [x] `lastAccessedAt` updates on boot — `workspace.ts:63-68`
- [x] Archived (cold-storage) warning data — `workspace.ts:32-37`, UI banner in `apps/web/app/projects/[id]/page.tsx:469-473`
- [x] Concurrency guard prevents more than 10 active sandboxes per user — `sandbox-queue.ts:10,28-75`, `packages/db/src/index.ts:301-311,361-409`
- [x] Dev server runs via the Tasks system with `.codesandbox/tasks.json` (`templates/dai-universal/.codesandbox/tasks.json`) — no `shells.run()` call exists in the codebase
- [x] Host tokens use `sdk.hosts.createToken`/`getUrl` — `packages/codesandbox/src/index.ts:412-424`
- [x] Fork safety: resume + hibernate before fork — `packages/codesandbox/src/index.ts:191-232`
- [x] Clean bootup: `bootupType === "CLEAN"` awaits all setup steps — `packages/codesandbox/src/index.ts:102-108`
- [x] All runtime columns exist in the schema, including `sandbox_id`/`sandbox_slug` — `apps/api/src/lib/schema.ts:24-25,43-44`
- [ ] Item 10 UI/UX overhaul + public landing page — in progress

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/workspace/:projectId` | GET/POST | List directory; file write/create/delete/rename |
| `/api/workspace/:projectId/file` | GET | Read file contents |
| `/api/workspace/:projectId/command` | POST | Run a shell command in the sandbox |
| `/api/workspace/:projectId/status` | GET | Sandbox state without waking it |
| `/api/workspace/:projectId/preview` | POST | Start dev task + return preview URL |
| `/api/workspace/:projectId/preview/proxy` | POST | Preview broker (explicit resume + signed URL) |
| `/api/workspace/:projectId/preview/stop` | POST | Stop the dev task |
| `/api/workspace/:projectId/restart` | POST | Restart sandbox to update the VM agent |
| `/api/workspace/:projectId/concurrency` | GET | Concurrency slot status |
| `/api/projects/:id/fork` | POST | Fork with parent hibernation |
| `/api/projects/:id/agent` | POST | Agent loop (NIM + sandbox tools) |

## Documentation index

- Creating sandboxes: https://codesandbox.io/docs/sdk/create
- Resuming sandboxes (clean bootups, wakeup guidance): https://codesandbox.stream/docs/sdk/resume
- Setup steps: https://codesandbox.stream/docs/sdk/setup
- Tasks: https://codesandbox.stream/docs/sdk/tasks
- Templates (`tasks.json`): https://codesandbox.io/docs/sdk/templates
- Sandbox hosts (host tokens): https://codesandbox.io/docs/sdk/sandbox-hosts
- Managing sandboxes (hibernate/restart/delete): https://codesandbox.io/docs/sdk/manage-sandboxes
- Update sandbox: https://codesandbox.stream/docs/sdk/update-sandbox
- Core concepts: https://codesandbox.stream/docs/sdk/core-concepts
