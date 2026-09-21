# DAI Runtime Architecture

Final shape: **Vercel (Next.js frontend) → Render (Node/TS control plane) →
Modal (Sandbox compute + persistent Volume workspace), with NVIDIA NIM as the
model.** There is no user-facing terminal and no fake execution anywhere: every
file and command operation happens inside a Modal Sandbox.

```
Browser
  │  HTTPS, JWT cookie / Bearer, NEXT_PUBLIC_API_URL only
  ▼
Vercel  — Next.js 16 static + SSR frontend. No runtime SDK, no secrets.
  │  /api/...
  ▼
Render  — apps/api (Express control plane)
  │        auth · rate limit · validation · agent loop · NIM calls · Postgres
  ▼
Modal   — Sandbox (compute)  +  Volume (durable files)   [@dai/modal]
```

## Layering

| Layer | Location | Responsibility |
| --- | --- | --- |
| Contract | `packages/modal/src/types.ts` | `Workspace` / `RuntimeService` interfaces. The only thing the API may depend on. |
| Config | `packages/modal/src/config.ts` | All tunables from env, with whole-second coercion Modal requires. |
| Provider objects | `packages/modal/src/provider.ts` | App, shared Volume, named Image resolution. |
| Implementation | `packages/modal/src/runtime.ts` | Acquisition, exec, filesystem, dev server, previews, purge. |
| Errors | `packages/modal/src/errors.ts` | SDK failures → runtime failures with an HTTP status. |
| Binding | `apps/api/src/lib/runtime.ts` | Postgres-authoritative project↔Sandbox mapping, advisory locking. |

Route handlers (`agent.ts`, `projects.ts`, `workspace.ts`) import only the
binding layer and the `Workspace` type — never the Modal SDK.

## Persistent workspace

* One Modal **Volume**, `MODAL_VOLUME_NAME` (default `dai-workspaces`), holds all
  projects. Each project lives at subPath `projects/<projectId>` and is mounted
  at `/workspace` via `volume.withMountOptions({ subPath })`.
* Verified against the shipped SDK: `volumes` is `Record<mountPath, Volume>` —
  the compiled create path does
  `Object.entries(o.volumes).map(([mountPath, volume]) => volumeToMountProto(mountPath, volume))`,
  so the key really is the mount point.
* Chosen over one Volume per project so project count is not bounded by the
  provider's Volume limit, while subPath mounting still isolates each workspace.
* Source of truth for "which Sandbox serves this project" is **PostgreSQL**, not
  Modal. `sandboxes.fromName` resolves only while a Sandbox runs, and
  `sandboxes.list({ tags })` is used purely as a recovery aid.

Durability rule: a finished Modal Sandbox cannot execute further commands. Losing
compute therefore loses nothing, because files live in the Volume.

## Sandbox lifecycle

1. `acquireWorkspace(projectId)` takes a Postgres advisory xact lock
   (`pg_advisory_xact_lock(hashtext('dai-runtime:<id>'))`) so two concurrent
   requests cannot each create a Sandbox.
2. If the stored `sandbox_id` came from `runtime_provider = 'modal'`,
   `sandboxes.fromId()` is attempted and `sandbox.poll()` checked.
   `poll() === null` means still running → **reuse**.
3. Otherwise a Sandbox is created with: no `command` (Modal's documented default
   is "sleep indefinitely until timeout"), `workdir`, `volumes`, `cpu`,
   `memoryMiB`, `timeoutMs`, `idleTimeoutMs`, `encryptedPorts`,
   `readinessProbe` (`Probe.withExec` asserting `/workspace` exists), `name` and
   `tags['dai.project']`.
4. `waitUntilReady(60s)` gates use; a Sandbox that never becomes ready is
   terminated rather than handed to the caller.
5. Requests call `close()`, which is `sandbox.detach()` — local handles are
   released, the Sandbox stays up for the next request.

One Sandbox serves an entire agent run. Nothing provisions per command.

### Cost controls

* `MODAL_IDLE_TIMEOUT_MS` (default 5 min) lets Modal reclaim idle compute;
  `MODAL_TIMEOUT_MS` (default 4 h) is the hard ceiling. No keepalive pings or
  sleep loops — Modal counts open TCP connections as activity, so a keepalive
  would pin every project open and bill for it.
* Compute is not started to "initialize" a workspace (`ensureWorkspace` only
  resolves the Volume).
* Image build happens out of band, never in a request path.
* Dev-server reuse is checked by an actual TCP probe before launching anything,
  so a second server never stacks on one port.
* Searches are bounded (`head -200`) and `find` uses `-maxdepth`.

## Command execution

`sandbox.exec()` takes an **argv array**, not a shell string. DAI's agent tool
`run_command` keeps its shell-string contract by running
`["/bin/bash", "-lc", command]` inside the Sandbox. Every internal operation that
does not need a shell — `rename` (`/bin/mv -- a b`), `git`
(`/usr/bin/git status --porcelain`) — passes argv with no shell involved, so
paths can never become shell syntax.

`SandboxExecParams.timeoutMs` is a real provider timeout, so the previous
provider's silently-dropped `timeoutMs` and its `Promise.race` workaround are
both gone. A deadline breach returns a normal `ExecResult` with `timedOut: true`
instead of throwing, so the agent loop still receives a tool result.

stdout and stderr are explicitly piped and drained concurrently before `wait()`.

## Filesystem

`SandboxFilesystem` (`readText`, `writeText`, `listFiles`, `stat`, `remove`,
`makeDirectory`, `copyFromLocal`) rather than shelling out to a local filesystem.
Note `writeText(data, remotePath)` — payload first.

Path confinement stays in `apps/api/src/lib/validation.ts` (`validatePath`),
applied in the routes and the agent tool executor before any call reaches the
runtime: single URL-decode, control-character rejection, `..` rejection, and a
`/workspace/` prefix check that also rejects sibling prefixes like
`/workspacex`. Covered by `apps/api/test/validation.test.ts`.

## Previews and dev servers

* `startDevServer` launches `setsid nohup sh -c "<cmd>" > /tmp/dai-dev-<port>.log
  2>&1 & echo $! > /tmp/dai-dev-<port>.pid`, so the server outlives the exec that
  started it and its process group can be signalled on stop.
* Readiness is a bounded TCP probe against `127.0.0.1:<port>` with exponential
  backoff up to `MODAL_DEV_SERVER_READY_TIMEOUT_MS` — never a fixed sleep.
* `getPreviewUrl(port)` uses `sandbox.createConnectToken({ port })`, which returns
  `{ url, token }`. The token is required to reach the URL, so previews are
  authenticated rather than a public proxy. `POST
  /api/workspace/:id/preview` and `/preview/proxy` both return `token` alongside
  `url`.
* Ports are declared at creation via `MODAL_PREVIEW_PORTS` as `encryptedPorts`
  (TLS).

## Secrets

`MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`, `DATABASE_URL`, `JWT_SECRET`,
`DAI_API_KEY_ENCRYPTION_KEY` and `NIM_API_KEY` exist only in the Render service.
The only `NEXT_PUBLIC_*` variables the frontend reads are `NEXT_PUBLIC_API_URL`
and `NEXT_PUBLIC_DAI_MODEL`. Verified by scanning the built `apps/web/.next`
output for `ModalClient`, `@dai/modal` and `MODAL_TOKEN_SECRET` — none present —
and `apps/web/package.json` carries no runtime-provider dependency.

Sandbox-side secrets, when needed, go through
`client.secrets.fromObject(...)` / `SandboxCreateParams.secrets`. They are never
baked into the image.

## Runtime image

`MODAL_BASE_IMAGE` (default `node:22-bookworm-slim`) plus git, python3,
build-essential, ripgrep, bun. Built once and published under
`MODAL_IMAGE_NAME` (`dai-runtime`) by `scripts/build-runtime-image.ts`;
`ModalProvider.image()` resolves it by name at runtime, so Sandbox creation never
rebuilds layers. The image carries no mutable project state — that is the
Volume's job.

## Failure recovery

| Symptom | Handling |
| --- | --- |
| Stored Sandbox gone / unknown id | Classified as `unavailable` → new Sandbox over the same Volume subPath |
| Name collision on create | `sandboxes.list({ tags })` finds the live owner and attaches |
| Never becomes ready | Terminated; 503 surfaced, unusable handle never returned |
| Command deadline exceeded | `ExecResult.timedOut`, non-fatal to the agent run |
| Missing file / directory | `not_found` → `null` for reads, parent-dir create + single retry for writes |
| No credentials | Structured JSON 503 with an actionable message; server still boots and serves `/api/health` |

`RuntimeOperationError` carries `failure`, `statusCode` and `recreate`. Routes map
it straight to an HTTP status; SSE headers are only flushed after the runtime is
attached, so a failure can never leave a half-open stream.

## API contracts preserved

`GET /api/health`, `POST /api/projects`, `GET/DELETE /api/projects/:id`,
`POST /api/projects/:id/agent` (SSE: `tool_call`, `tool_result`,
`assistant_delta`, `done`, `error`), and the whole `/api/workspace/:id/*` surface
keep their shapes. Modal has no hibernation, so a stopped Sandbox is reported
using the existing `state: "hibernated"` value, and `bootupType` is repurposed as
provider-neutral (`CLEAN` new, `RESUME` reattached) instead of changing the
frontend.

## Concurrency

Two layers: the Postgres advisory lock in `acquireWorkspace`, and
`countActiveSandboxes` / `MAX_ACTIVE_SANDBOXES` (10) with the existing
`sandbox_queue` table for cross-request provisioning backpressure.

## Agent loop, budgets and reversibility

The loop lives in `apps/api/src/lib/agent-loop.ts`; `routes/agent.ts` is a thin
HTTP/SSE adapter and holds no agent logic.

### Runtime decision layer

`lib/runtime-policy.ts` exposes `needsRuntime(operation)` for every operation in
the union. The classification is a provider fact, not a preference: Modal's
JavaScript `Volume` has no file API, and `SandboxFilesystem` is constructed over
an `exec` function, so workspace I/O is always compute. Rather than hide that,
the cost is made explicit and metered.

Genuinely free operations — project and runtime metadata, conversation history,
the activity timeline, checkpoint listings and diffs, and the undo/redo
*decisions* — are served from PostgreSQL and never touch Modal. `GET
/api/workspace/:id/checkpoints` and `GET /api/projects/:id/agent/status` are the
clearest examples: the Changes panel and the timeline render with no compute at
all.

`RuntimeBudget` gates, and its limits are env-configurable:

| Limit | Default | Effect when hit |
| --- | --- | --- |
| `MAX_RUNTIME_ACTIVATIONS_PER_AGENT_RUN` | 1 | no second Sandbox is started for a run |
| `MAX_EXEC_CALLS_PER_AGENT_RUN` | 40 | tool calls return a budget error; run ends `budget_exhausted` |
| `MAX_RUNTIME_SECONDS_PER_AGENT_RUN` | 600 | same, on wall-clock |
| `MAX_COMMAND_TIMEOUT` | 300000 | clamps every command's own deadline |
| `MAX_AGENT_ITERATIONS` | 12 | loop stops before the next model call |

Exhaustion emits `agent.budget.exhausted` with the reason, and the run's outcome
distinguishes "stopped for cost" from "failed", so the UI never has to guess.

### Cost discipline actually implemented

- One activation per run; every later tool reuses the same attached Sandbox.
- All file edits a model turn requests are applied by ONE
  `workspace.applyFileMutations` call, not one per file.
- Reads are deduplicated through a per-run cache, because a second read is a
  second command on this provider.
- Undo/redo is likewise a single batched, compare-and-swap command.
- Workspace size is measured with `du` on a Sandbox that is already open, never
  by starting one just to ask.
- No keepalive, and no timer anywhere in the activity path: `activity.ts` and
  `agent-loop.ts` contain no `setTimeout`/`setInterval`, so nothing can emit a
  progress event that does not correspond to work.
- The one deliberate poll is bounded and factual: `waitForPort` probes the
  listening socket with backoff so a preview waits for a real service rather
  than for a fixed sleep.

### Activity timeline, without chain of thought

`lib/activity.ts` defines typed events and the emitter. Rules:

- Titles are built from results that came back: a real file count, a real exit
  code, a parsed failure count, a real tunnel URL.
- Events are persisted before being published, so a reload reproduces the exact
  timeline.
- The prompt sent to NIM, and anything the model emits besides its answer and
  its tool calls, never reaches this channel. There is no `reasoning`/
  `thinking` field anywhere in the NIM path — asserted by tests.
- The one "planning" style message the user can see is guidance the *server*
  writes when it interrupts a loop, not recovered model state.

### Loop detection

`lib/loop-detector.ts` fingerprints each step (`callKey`), the error signature,
and whether the workspace actually changed. It reports `identical_call`,
`repeated_failure`, `thrashing` and `no_progress`. The key design point: a
repeated command is only a loop when nothing changed in between, so an agent
running the same test file while genuinely fixing failures is not interrupted.

First detection injects one bounded strategy change. A second detection pauses
the run, emits `agent.loop.detected`, and hands the user
Continue / Retry differently / Undo. A stuck run is never silently retried
forever and never simply fails without explanation.

### Undo and rollback

`lib/checkpoint-service.ts` records, per run, the pre- and post-image of every
path it intended to change. Pre-images are captured in one batched read *before*
any write lands, so "before" is the state the agent actually found. A path
touched twice keeps its original pre-image.

Restore is compare-and-swap: each entry carries `expectCurrent`, so a file the
user edited in the meantime is reported as a conflict and left alone rather than
clobbered. Files over `MAX_CHECKPOINT_FILE_BYTES`, or holding binary content, are
recorded as non-reversible with a reason and then skipped — undo says so instead
of half-reverting silently. `partial` status exists precisely so the UI cannot
offer a redo that would not line up.

### Storage quota

Modal has no per-project quota, so `MAX_PROJECT_WORKSPACE_BYTES` (default 50
GiB) is enforced by DAI: usage is measured on an already-open Sandbox, stored on
the project, and checked from PostgreSQL *before* a run starts. Exceeding it
refuses the run with a stated reason rather than continuing to grow.

Deletion terminates tagged Sandboxes, removes only that project's subPath, and
cascades its metadata. `purgeTarget()` rejects anything that is not exactly one
directory under `projects/`, because the cleanup runs against a mount of the
shared Volume and a malformed id there would delete every project's files.

### Authentication

The API accepts a Bearer token only. It previously also read an `auth_token`
cookie that nothing ever set; since there is no CSRF token anywhere in the
system, that unused path was a cross-site request forgery surface waiting for a
future cookie, so it was removed. Consequence worth stating plainly: DAI has no
CSRF protection because it has no cookie credential to protect — introducing
cookie sessions later requires adding a CSRF secret first.
