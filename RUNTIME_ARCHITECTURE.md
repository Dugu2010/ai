# DAI Runtime Architecture

Final shape: **Vercel (Next.js frontend) → Render (Node/TS control plane +
PostgreSQL) → Vercel Sandbox + Drives (compute and the live workspace) →
Cloudflare R2 (durable mirror)**, with NVIDIA NIM as the model. There is no
user-facing terminal and no fake execution anywhere: every file and command
operation happens inside a sandbox or against its mirror.

`RUNTIME_PROVIDER` chooses the provider. Vercel is the target and Modal is
retained only to read old workspaces; `VERCEL_RUNTIME_MIGRATION.md` is the
ordering, and states the platform facts that shaped the design — chiefly that
Active CPU is spent only by `runCommand`, while an awake sandbox bills
provisioned memory on wall clock whether or not it is doing anything.

```
Browser
  │  HTTPS, Bearer JWT only (no cookie credential), NEXT_PUBLIC_API_URL only
  ▼
Vercel  — Next.js 16 static + SSR frontend. No runtime SDK, no secrets.
  │  /api/...
  ▼
Render  — apps/api (Express control plane)
  │        auth · rate limit · validation · agent loop · budget · Postgres · NIM
  ├──▶ Vercel Sandbox + Drive   [@dai/vercel]  compute and the working copy
  ├──▶ Cloudflare R2            [@dai/vercel]  the mirror cold reads are served from
  └──▶ NVIDIA NIM                              the model
```

## Layering

| Layer | Location | Responsibility |
| --- | --- | --- |
| Contract | `packages/runtime/src/contract.ts` | `Workspace` / `RuntimeService`, `AcquireOptions`, `RuntimeState`. The only thing the API may depend on. |
| Error vocabulary | `packages/runtime/src/errors.ts` | `RuntimeOperationError`, the `RuntimeFailure` union, the failure→status table, the classifier registry. |
| Vercel implementation | `packages/vercel/src/` | `runtime` (sandbox + drive lifecycle), `workspace` (the contract's 20 members), `mirror`/`object-store` (R2), `blob-store` (checkpoint images), `config`, `errors`. |
| Modal implementation (legacy) | `packages/modal/src/` | Kept so migration can read the old Volume; re-exports the contract from `@dai/runtime`. |
| Binding | `apps/api/src/lib/runtime.ts` | Postgres-authoritative project↔sandbox mapping, advisory locking, the usage ledger, mirror wiring. |
| Policy | `apps/api/src/lib/runtime-policy.ts` | What each operation costs, and the per-run budget. |
| Budget | `apps/api/src/lib/cost-governor.ts` | The monthly ceiling: ledger reads, throttle levels, escalation rules. |

Route handlers import only the binding layer and the `Workspace` type. Exactly
one package imports `@vercel/sandbox`, one imports the S3 client, one imports
`modal` — asserted by `apps/api/test/harness-guard.test.ts` and by the frontend
build scan.

## Two copies of every file

* **The Drive is the working copy.** `dai-workspace-<projectId>`, mounted
  read-write at `/workspace`. NVMe, survives stops, `maxSize` set to the smaller
  of `MAX_PROJECT_WORKSPACE_BYTES` and 10 GB, and only one sandbox may hold it at
  a time.
* **R2 is the read path.** `<R2_ROOT_PREFIX>/projects/<id>/files/<relative>`,
  plus `manifest.json` recording `syncedAt`, `totalBytes`, `generation` and
  `dirtyAt`. Every file this app writes goes to both targets.
* **Consequence:** a cold project is browsable, readable and name-searchable with
  no sandbox running — strictly cheaper than the previous provider, where every
  read was a billed command.
* **The dirty flag is the honesty mechanism.** A command can create files the
  mirror never saw, so *any* `runCommand` marks the project dirty and
  `isReadable()` is false until a resync clears it. A corrupt manifest reads as
  dirty, never as empty. `coldMirrorProject()` therefore requires three things at
  once: the caller owns the project, no sandbox is running (otherwise the live
  tree is authoritative and the mirror is by definition a moment behind it), and
  the mirror is clean. Returning null is always safe — the caller attaches compute
  and pays. Returning a stale tree is not.

## Sandbox lifecycle

1. `acquireWorkspace(projectId, resourceTier?)` asks the governor first
   (`assertWithinComputeBudget`): a refusal issued after `Sandbox.create` is not a
   refusal, it is a bill.
2. Then a Postgres advisory xact lock
   (`pg_advisory_xact_lock(hashtext('dai-runtime:<id>'))`) so two concurrent
   requests cannot both provision.
3. Liveness is probed **without waking anything** — `Sandbox.get({ name, resume:
   false })` is the SDK's only non-waking read. Absent → create.
4. Names are deterministic (`dai-<projectId>`), because resume is addressed by
   name. Postgres stays authoritative for project metadata, and a stored id from
   the *other* provider is ignored rather than trusted.
5. Creation asks for the resolved tier's vCPUs, the preview ports,
   `persistent: true`, `keepLastSnapshots: { count: 1 }`, a short
   `sessionTimeoutMs` (15 min default) and the mounts.
6. `close()` releases the local handle only; the sandbox stays up until its
   session ends, then snapshots. The next command resumes it.

One sandbox serves an entire agent run. Nothing provisions per command.

### Cost controls

* **Monthly ledger.** `runtime_usage` holds one row per session: vCPUs, Active CPU
  taken from the sandbox's own `activeCpuUsageMs` counter as a delta against the
  baseline at acquisition, provisioned wall clock derived in Postgres from the
  row's own age, and whether the session was a creation or a resume.
  `runtime_quota_state` rolls up a calendar month. Totals come from the ledger,
  never from process memory. **Egress is not measured** — the SDK reports no
  figure, so the column stays 0 and the egress ceiling is reported rather than
  enforced; nothing may read that zero as "transferred nothing".
* **Throttle levels** are fractions of the worst *controllable* metric: warn
  ≥60%, throttle ≥80% (previews declined, escalation blocked, the stored tier
  ignored in favour of the smallest), halt ≥95% (`failure: "quota"` → HTTP 429
  naming the metric that bound and the date the month resets). Egress is excluded
  from the level: refusing to boot cannot make a transfer cheaper.
* **Escalation is bounded** — one step per project per week, only after a real
  command `timedOut`, never past the top tier, never while throttled. A timeout at
  the top tier pauses the run through `LoopDetector` instead of buying a bigger
  machine that would also time out.
* **Reconciliation.** A process killed mid-run leaves an open row, and an open row
  understates the month — the one error that lets a budget be blown. The
  `sandbox-queue` tick closes sessions older than 90 minutes using wall clock and
  zero CPU: pessimistic in the safe direction.
* **Dependency cache.** One shared drive (`VERCEL_CACHE_DRIVE`) mounted read-only
  at `/dai-cache`, with `npm_config_cache`, `YARN_CACHE_FOLDER`, `PNPM_HOME`,
  `PIP_CACHE_DIR`, `GOMODCACHE` and `GOCACHE` pointed at it at creation. `npm
  install` is the largest single Active-CPU cost in the product; a warm store turns
  most of it into local copies. Only `acquireCacheWriter()` mounts it read-write,
  because a project sandbox cannot write it — and a drive nobody has written to yet
  refuses to snapshot, so `mountsFor()` falls back to a workspace-only boot rather
  than failing: a cold cache is merely slower, whereas a missing workspace is not a
  project.
* Searches are one bounded command each: `find` capped at depth 12 and 200 paths,
  `grep -rIn` capped at 200 matches. A listing is never walked directory by
  directory, because `fs.readdir` is itself a `find` — that would pay one command
  per directory for the same answer.

## Command execution

`sandbox.runCommand()` takes **argv**, not a shell string. The agent's
`run_command` keeps its shell-string contract by running
`["/bin/bash", "-lc", command]`. Every internal operation that does not need a
shell — rename, `git`, `grep`, `tar` — passes argv with explicit paths, so a
filename can never become shell syntax.

`timeoutMs` is enforced by the SDK. A breach returns a normal `ExecResult` with
`timedOut: true` rather than throwing, so the loop always receives a tool result.
`timedOut` is derived from exit code *and* duration (`exitCode !== 0 &&
durationMs >= timeoutMs - 250`): an ordinary failure that happens to run long is
not relabelled, because a timeout is the signal that escalates the machine and a
false one spends money.

stdout and stderr are piped and drained concurrently before `wait()`.

## Filesystem

`readFileToBuffer` and `writeFiles` are HTTP transfers to the sandbox; the rest of
`fs.*` is not what it looks like. In the installed SDK, `fs.readdir` runs `find`,
`fs.stat` runs `stat`, `fs.rm` runs `rm`, `fs.rename` runs `mv` and recursive
`fs.mkdir` runs `mkdir -p`. So "file API" does not mean "free" — only the two byte
transfers are, and the classification in `runtime-policy.ts` says so per operation
rather than by method name.

Multi-file work stays batched (`applyFileMutations` in one call, `readFilesBatch`
sequential over paths), and every write carries `expectCurrent`
(compare-and-swap) so undo refuses to clobber a file the user edited in the
meantime. Path confinement lives in `apps/api/src/lib/validation.ts`
(`validatePath`): single URL-decode, control-character rejection, `..` rejection,
and a `/workspace/` prefix check that also rejects sibling prefixes like
`/workspacex`. Covered by `apps/api/test/validation.test.ts`.

## Previews and dev servers

`sandbox.domain(port)` is a **public host with no token** — unlike the previous
provider's authenticated tunnel — and preview URLs get shared, screenshotted and
pasted into chat. An iframe also cannot send an `Authorization` header, so the
credential has to travel in the URL, which makes it a capability.

So the provider host is never handed to the browser.
`apps/api/src/lib/preview-proxy.ts` issues an HMAC-SHA256 token over
`projectId.port.expiresAt` (6 h, signed with `JWT_SECRET`), and the browser
receives `PUBLIC_API_URL/api/preview/<token>/…`. `routes/preview.ts` verifies it,
binds the requested port to the token's claim (a token for 3000 cannot reach
5432), strips hop-by-hop headers, rewrites absolute paths in HTML and injects
`<base>` **after** rewriting — the reverse order double-prefixes every asset, which
a test catches rather than production. `/api/preview/*` is mounted before
`requireAuth` because an iframe cannot authenticate; the token is its own
credential, and is redacted in the request log.

`startDevServer` launches the command detached with its log and pid under `/tmp`,
so the server outlives the call that started it and a stop can signal the process
group. Readiness is a bounded TCP probe against `127.0.0.1:<port>` with
exponential backoff up to `VERCEL_DEV_SERVER_READY_TIMEOUT_MS`, never a fixed
sleep, and a server already listening on the port is reused rather than stacked.

A dev server is refused once the month is throttled (`previewRefusalReason()`),
both from the HTTP routes and from the model's own `start_dev_server` tool — where
the refusal is returned as the tool result, so the model finishes with file tools
instead of retrying. An awake preview VM is the most expensive thing this app can
leave running, which is why it is the first thing switched off.

## Secrets

`VERCEL_TOKEN` (or `VERCEL_OIDC_TOKEN` + `VERCEL_PROJECT_ID`), `R2_*`,
`DATABASE_URL`, `JWT_SECRET`, `DAI_API_KEY_ENCRYPTION_KEY`, `NIM_API_KEY` and the
legacy `MODAL_TOKEN_*` exist only in the Render service. The only
`NEXT_PUBLIC_*` variables the frontend reads are `NEXT_PUBLIC_API_URL` and
`NEXT_PUBLIC_DAI_MODEL` — verified by scanning the built `apps/web/.next` output
for provider SDK names and secret names, none present, and `apps/web/package.json`
carries no runtime-provider dependency.

Sandbox-side environment is limited to the cache paths above. User-supplied project
secrets are injected per command, never baked into an image and never written to
the drive.

## Runtime image

`VERCEL_SANDBOX_IMAGE` (default `vercel/sandbox/node:22`). There is no image build
in the request path and no builder: the platform image carries node, git, grep and
tar, which is all the contract uses. Project state never lives in the image — that
is the drive's job.

## Failure recovery

| Symptom | Handling |
| --- | --- |
| Stored sandbox gone, or from the other provider | Non-waking `get` misses → create over the same drive |
| Name collision on create | Re-probe by name and attach to the live owner |
| Drive cannot be opened | Mapped runtime error; the project is marked not-ready rather than half-mounted |
| Command deadline exceeded | `ExecResult.timedOut`, non-fatal, and the only trigger for escalation |
| Missing file / directory | `not_found` → `null` for reads; parent `mkdir` + single retry for writes |
| Cache drive not snapshot-able | Boot without the cache |
| Mirror manifest corrupt | Treated as dirty → cold reads decline and compute answers |
| Open ledger row from a killed process | Closed by the queue tick |
| No credentials | Structured JSON 503 with an actionable message; the server still boots and serves `/api/health` |

`RuntimeOperationError` carries `failure`, `statusCode` and `recreate`. SDK errors
are mapped by a **registered classifier** — structural checks (HTTP status, error
name), never `instanceof`, which breaks across the ESM/CJS dual build — so one
process can load two providers during migration and each owns its own mapping.
Routes map it straight to an HTTP status; SSE headers are flushed only after the
runtime is attached, so a failure can never leave a half-open stream.

## API contracts preserved

`GET /api/health`, `POST /api/projects`, `GET/DELETE /api/projects/:id`,
`POST /api/projects/:id/agent` (SSE: `tool_call`, `tool_result`,
`assistant_delta`, `done`, `error`) and the whole `/api/workspace/:id/*` surface
keep their shapes. `bootupType` is provider-neutral (`CLEAN` created, `RESUME`
attached) and `state: "hibernated"` still means "no live compute", so the frontend
needed no changes for the swap.

## Concurrency

Two layers: the Postgres advisory lock in `acquireWorkspace`, and
`countActiveSandboxes` / `MAX_ACTIVE_SANDBOXES` (10, Hobby's concurrent limit)
with the `sandbox_queue` table for cross-request provisioning backpressure. The
platform refuses a second read-write mount of one drive anyway.

## Agent loop, budgets and reversibility

The loop lives in `apps/api/src/lib/agent-loop.ts`; `routes/agent.ts` is a thin
HTTP/SSE adapter and holds no agent logic.

### What each operation costs

`lib/runtime-policy.ts` classifies every `RuntimeOperation` on three axes rather
than one boolean, because the two providers disagree about what is expensive:

| Axis | Meaning |
| --- | --- |
| `location` | `r2` (no compute at all) · `control_plane` (needs an awake sandbox, spends no CPU) · `sandbox_exec` (runs a command) |
| `requiresRunningSandbox` | Whether a machine must be awake |
| `activeCpuCost` | Whether the monthly Active-CPU allowance is spent |

Only the two byte transfers are unmetered: `fs.read` and `fs.write` — and
therefore undo, which writes a stored image back the same way. Everything else
ends up as a `runCommand`, including the operations whose method names suggest
otherwise: in the installed SDK `fs.list`, `fs.delete`, `fs.rename` and
`fs.search_name` are `find`, `rm`, `mv` and `find`. `needsRuntime().cost` is
*derived* from those axes rather than stated a third time, and
`apps/api/test/runtime-policy.test.ts` pins the metered set by name so a method
rename cannot quietly change what the app charges for.

Free of workspace bytes entirely, and answered from PostgreSQL: project and
runtime metadata, conversation history, the activity timeline, checkpoint listings
and diffs, and the undo/redo *decisions*. `GET /api/workspace/:id/checkpoints` and
`GET /api/projects/:id/agent/status` are the clearest examples: the Changes panel
and the timeline render with no compute at all.

### Per-run budget

| Limit | Default | Effect when hit |
| --- | --- | --- |
| `MAX_RUNTIME_ACTIVATIONS_PER_AGENT_RUN` | 1 | no second machine is started for a run |
| `MAX_EXEC_CALLS_PER_AGENT_RUN` | 40 | commands return a budget error; the run ends `budget_exhausted` |
| `MAX_FILE_OPS_PER_AGENT_RUN` | 600 | file tools decline — a separate ceiling, so a file-only task can never spend the command budget |
| `MAX_RUNTIME_SECONDS_PER_AGENT_RUN` | 600 | per-iteration wall clock, i.e. the provisioned memory the run is holding |
| `MAX_COMMAND_TIMEOUT` | 300000 | clamps every command's own deadline |
| `MAX_AGENT_ITERATIONS` | 12 | the loop stops before the next model call |

Exhaustion emits `agent.budget.exhausted` with the reason, and the run's outcome
distinguishes "stopped for cost" from "failed", so the UI never has to guess.

### Cost discipline actually implemented

- One activation per run; every later tool reuses the same attached machine.
- All file edits a model turn requests are applied by ONE
  `workspace.applyFileMutations` call, not one per file.
- Reads are deduplicated through a per-run cache — now to save control-plane
  transfers and awake seconds, not commands.
- Workspace size comes from the mirror manifest where it can; `du` runs only when
  it cannot, and only on a machine that is already open.
- No keepalive, and no timer anywhere in the activity path: `activity.ts` and
  `agent-loop.ts` contain no `setTimeout`/`setInterval`, so nothing can emit a
  progress event that does not correspond to work.
- The one deliberate poll is bounded and factual: `waitForPort` probes the
  listening socket with backoff so a preview waits for a real service rather than
  for a fixed sleep.
- The system prompt and the tool descriptions state the economics, because a model
  told only what it *may* do will `cat` a file it could have read.

### Activity timeline, without chain of thought

`lib/activity.ts` defines typed events and the emitter. Rules:

- Titles are built from results that came back: a real file count, a real exit
  code, a parsed failure count, a real preview URL.
- Events are persisted before being published, so a reload reproduces the exact
  timeline.
- The prompt sent to NIM, and anything the model emits besides its answer and its
  tool calls, never reaches this channel. There is no `reasoning`/`thinking` field
  anywhere in the NIM path — asserted by tests.
- The one "planning" style message the user can see is guidance the *server*
  writes when it interrupts a loop, not recovered model state.

### Loop detection

`lib/loop-detector.ts` fingerprints each step (`callKey`), the error signature,
and whether the workspace actually changed. It reports `identical_call`,
`repeated_failure`, `thrashing` and `no_progress`. The key design point: a
repeated command is only a loop when nothing changed in between, so an agent
running the same test file while genuinely fixing failures is not interrupted.

First detection injects one bounded strategy change. A second detection pauses the
run, emits `agent.loop.detected`, and hands the user Continue / Retry differently
/ Undo. A stuck run is never silently retried forever and never simply fails
without explanation.

### Undo and rollback

`lib/checkpoint-service.ts` records, per run, the pre- and post-image of every
path it intended to change. Pre-images are captured in one batched read *before*
any write lands, so "before" is the state the agent actually found. A path touched
twice keeps its original pre-image.

Restore is compare-and-swap: each entry carries `expectCurrent`, so a file the user
edited in the meantime is reported as a conflict and left alone rather than
clobbered.

Images no longer live in Postgres TEXT columns. `content_before_key` /
`content_after_key` name objects in R2 (`CheckpointBlobs`), deleted together with
the checkpoint. When no object store is configured the store is absent rather than
stubbed — a missing image *throws*, because a null content would make undo delete a
user's file — and legacy rows that still carry inline content are read from it.
Files at or above `MAX_CHECKPOINT_FILE_BYTES`, or holding binary content, are
recorded as non-reversible with a reason and then skipped, so undo says so instead
of half-reverting silently. `partial` status exists precisely so the UI cannot
offer a redo that would not line up.

### Storage quota

`MAX_PROJECT_WORKSPACE_BYTES` (default 50 GiB) is enforced by DAI from the
measurement stored on the project, checked from PostgreSQL *before* a run starts;
the drive's own `maxSize` is a second, provider-side cap. Deletion stops the
sandbox, deletes the drive — retrying once, since an attached drive cannot be
deleted — and removes the project's R2 prefix. `purgeTarget()` rejects anything
that is not exactly one directory under `projects/`, because the cleanup runs
against shared storage and a malformed id there would delete every project's files.

### Authentication

The API accepts a Bearer token only. It previously also read an `auth_token`
cookie that nothing ever set; since there is no CSRF token anywhere in the
system, that unused path was a cross-site request forgery surface waiting for a
future cookie, so it was removed. Consequence worth stating plainly: DAI has no
CSRF protection because it has no cookie credential to protect — introducing
cookie sessions later requires adding a CSRF secret first. The one deliberate
exception is `/api/preview/*`, unauthenticated by design and protected instead by
its signed, short-lived, port-bound capability.
