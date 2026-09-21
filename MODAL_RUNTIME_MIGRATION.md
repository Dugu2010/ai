# CodeSandbox → Modal Runtime Migration

Completed in-repository migration of DAI's execution runtime from CodeSandbox to
Modal. CodeSandbox is fully removed; there is no fallback path.

## Verification status — read first

| Check | Result |
| --- | --- |
| `bun run typecheck` | exit 0 |
| `bun run build` (web + api + packages) | exit 0 |
| `bun run test` | exit 0 — 50 tests (33 runtime, 17 API validation) |
| `bun run lint:modal` | exit 0 |
| `bun run lint` (web) | exit 1 — **pre-existing** 31 errors, byte-identical before and after this migration; none introduced here |
| API boots without Modal credentials | yes; `/api/health` → `200 {"ok":true}` |
| `POST /api/projects` unauthenticated | 401 |
| `POST /api/projects/:id/agent` with no runtime | `503 application/json`, actionable message |
| `GET /api/workspace/:id/status` with no runtime | `state: "unreachable"` |
| **Live Modal integration** | **NOT VERIFIED — no credentials in this environment** |

`packages/modal/test/live/sandbox.live.test.ts` and `scripts/e2e.ts` require a
funded Modal account:

```
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... DATABASE_URL=... \
  bunx vitest run --config packages/modal/vitest.live.config.ts
```

Until that passes, no claim in this document about real Modal behaviour is
verified — only that the code matches the SDK's shipped type declarations.

## Why the API is trustworthy

Every call was checked against the installed package's own
`node_modules/modal/dist/index.d.ts`, not against memory or older examples
(same discipline noted in `AGENTS.md`: if it is not in the `.d.ts`, it does not
exist). Findings that changed the design:

* Package `modal` @ **0.10.1** — repository `modal-labs/modal-client`,
  Apache-2.0, maintainers at `@modal.com`. **Beta (0.x): breaking changes may
  ship in 0.x releases.** The npm name also carries unrelated 2013–2015 history
  (versions up to 1.2.0); `latest` is the 2026-era 0.x line.
* `sandboxes.create(app, image, params)` requires **both** an App and an Image.
* `SandboxCreateParams.volumes` is `Record<mountPath, Volume>`; the compiled
  client maps `Object.entries(...)` to `(mountPath, volume)` pairs.
* `SandboxInfo`-style metadata has no state field; `sandbox.poll()` (`null` =
  running) is the non-waking liveness signal.
* `volumes` has **no `create()`** — `fromName(name, { createIfMissing })` is the
  provisioning path.
* `exec()` takes an **argv array**; `SandboxExecParams` has a real `timeoutMs`.
* `filesystem.writeText(data, remotePath)` — payload first.
* `Probe.withTcp/withExec` + `waitUntilReady` exist; `Probe` only gates Sandbox
  creation, so dev-server readiness needs its own TCP check.
* `createConnectToken({ port }) → { url, token }` is the authenticated HTTP
  preview mechanism.
* Timeouts must be whole seconds; the client throws otherwise.
* Memory snapshots (`experimentalSnapshot`, `experimentalFromSnapshot`) are
  documented as **early preview**, and `SandboxCreateParams` carries
  `experimentalEnableSnapshot`. They are **not used**; the Volume is the primary
  durable store. `snapshotFilesystem`/`snapshotDirectory` are likewise unused.

## Design decisions

1. **Persistent workspace = Volume + per-project subPath**, mounted at
   `/workspace`. Sandboxes are disposable compute. This follows Modal's own
   statement that a finished Sandbox cannot execute further commands while
   Volumes persist.
2. **Postgres is the authoritative mapping.** Modal's named lookup only resolves
   while a Sandbox is running, so `runtime_sandbox_id`/`sandbox_id` plus a live
   `poll()` decide reuse; tag listing is recovery only.
3. **One Sandbox per agent run**, reused by reattach; never per command.
4. **Idle reclamation via `idleTimeoutMs`**, not homemade keepalives (open TCP
   connections count as activity, so a keepalive would pin every project open).
5. **No shell for internal ops**: `mv`/`git` run as argv. Only the agent's
   `run_command` uses `bash -lc`, inside the Sandbox, after allowlist validation.
6. **Named immutable image**, built out of band.
7. **Provider-neutral interface**, so the frontend and routes are unchanged in
   contract and a future provider swap touches one package.

## Database changes

Additive only — no column dropped, no project deleted.

| Column | Purpose |
| --- | --- |
| `projects.runtime_provider` | `'modal'` once provisioned; `'codesandbox_retired'` for legacy rows |
| `projects.runtime_volume_subpath` | `projects/<id>` within the shared Volume |
| `projects.legacy_sandbox_id` | previous provider's identifier, preserved |
| `projects.runtime_migration_status` | `modal_workspace_ready` \| `modal_files_imported` \| `modal_awaiting_import` \| `modal_import_failed` |

`sandbox_id` is reused to hold the live Modal Sandbox id because it is part of
the public API shape. Legacy-only columns (`sandbox_slug`, `vm_id`, `vm_slug`,
`bootup_type`, `is_up_to_date`, `preview_domain`) remain, are still returned, and
are documented deprecated.

`ensureSchema()` runs one idempotent retirement statement at startup: it copies
`sandbox_id` → `legacy_sandbox_id`, nulls `sandbox_id`, sets
`runtime_provider = 'codesandbox_retired'` and status `provisioning`, for rows
that still hold a pre-Modal id. This is deliberate: a CodeSandbox id left in
`sandbox_id` would make every acquire a reattach against an id Modal has never
seen. The retired row's own log line reports how many rows were affected.

## Running the migration

```bash
# 1. Provision the runtime image (once per environment).
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... bun run tsx scripts/build-runtime-image.ts

# 2. Boot the API (or run the migration directly) so ensureSchema() retires old ids.

# 3. Preview, then apply.
bun run tsx scripts/migrate-runtime.ts --dry-run
bun run tsx scripts/migrate-runtime.ts

# 4. With previously exported project archives present:
bun run tsx scripts/migrate-runtime.ts --import-dir /path/to/exports
   # looks for <legacy_sandbox_id>.tar.gz | .tgz | .tar, then <slug>, then <id>
```

`migrate-runtime.ts` provisions each project's Volume subPath, records
`runtime_migration_status`, and unpacks any archive **server-side** in one
`copyFromLocal` + `tar -xzf` — not one request per file. It never deletes
anything and never contacts CodeSandbox.

### File transfer: what is and is not possible

This repository's CodeSandbox account was **frozen** during the prior session
(`Your workspace has been frozen`, reproduced on resume of two existing
sandboxes and on a fresh create), and `sandboxes.delete` fails the same way. So
old project files could not be read programmatically here. Practical consequence:

* Projects migrated **without** an archive land in `modal_awaiting_import`: an
  empty but valid workspace. They are not silently emptied and not deleted; the
  status says so and the legacy id is retained.
* To carry real files across, export each project from CodeSandbox while the
  account is still accessible, name the tarball by `legacy_sandbox_id`, and
  re-run step 4.
* Four empty Sandbox records created by failed provisioning attempts during the
  prior session's verification remain on that account for the same reason.

## Environment variables

Removed, unread by any code: `CODESANDBOX_API_KEY`, `DAI_IDLE_TIMEOUT_SECONDS`,
`DAI_PREVIEW_DOMAIN_SUFFIX`, `FREESTYLE_API_KEY`, `DAI_NODE_SNAPSHOT_ID`,
`DAI_WORKSPACE_ROOT`, `NEXTAUTH_URL`.

Required: `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`. Optional with defaults:
`MODAL_APP_NAME=dai`, `MODAL_IMAGE_NAME=dai-runtime`,
`MODAL_VOLUME_NAME=dai-workspaces`, `MODAL_BASE_IMAGE=node:22-bookworm-slim`,
`MODAL_CPU=1`, `MODAL_MEMORY_MIB=2048`, `MODAL_TIMEOUT_MS=14400000`,
`MODAL_IDLE_TIMEOUT_MS=300000`, `MODAL_EXEC_TIMEOUT_MS=120000`,
`MODAL_DEV_SERVER_READY_TIMEOUT_MS=60000`, `MODAL_PREVIEW_PORTS=3000,5173,8080`,
`MODAL_BLOCK_NETWORK=false`, `MODAL_OUTBOUND_DOMAIN_ALLOWLIST=` (empty uses
Modal's default egress; set it to narrow outbound access for package installs).

## Removals

* `packages/codesandbox/` — deleted.
* `packages/freestyle/` — deleted. This was the *previous* migration's leftover:
  depended on by `apps/api` **and `apps/web`** and built/typechecked, but
  imported by no source file at all. The frontend no longer carries any backend
  runtime dependency.
* `CSB_MIGRATION_GUIDE.md` — deleted.
* Workspace scripts, tsconfig references, `paths`, dependencies and lockfile
  entries for both packages — updated; `@dai/modal` added in their place.
* Runtime imports of the old SDK in `agent.ts`, `projects.ts`, `workspace.ts`,
  `index.ts` and `lib/env.ts` — gone.

## Frontend

Unchanged in contract and provider-agnostic: it still calls the Render backend
via `NEXT_PUBLIC_API_URL` and never imports Modal. `hibernated` in the status
vocabulary now means "no live Sandbox, workspace intact".

## Remaining risks

1. **Unverified against live Modal.** Type-level correctness against shipped
   declarations is not behavioural proof. Run the live suite before trusting
   this in production.
2. **Modal JS SDK is 0.x beta** — a minor release can break the adapter. Pin
   `modal` exactly (currently `0.10.1`) and re-run the live suite on bumps.
3. **`bash`/`sh` are on the command allowlist** because the agent needs shells,
   so that allowlist is not the security boundary — Sandbox isolation and the
   per-project Volume subPath are. Pinned by a test that documents the limitation
   rather than pretending it away.
4. **File transfer for legacy projects** depends on archives exported while the
   CodeSandbox account is reachable; automated extraction is impossible while it
   is frozen.
5. **Volume growth is unreclaimed** — per-project subPaths accumulate; deletion
   purges the subPath, but nothing prunes abandoned dependency trees.
   `node_modules` lives inside the workspace and counts toward stored bytes.
6. **Egress is Modal's default** unless `MODAL_OUTBOUND_DOMAIN_ALLOWLIST` is set;
   package installation needs broad outbound access today.

## Official references consulted

`modal.com/docs/sdk/js/latest`, `/docs/sdk/js/latest/Sandbox`,
`/docs/sdk/js/latest/Volume`, `/docs/sdk/js/latest/Secret`,
`/docs/guide/sandboxes`, `/docs/guide/sandbox-networking`,
`/docs/guide/sandbox-v2`, `/docs/cli/latest/image`, `/docs/sdk/js/releases`,
`/pricing`.

## Not implemented

**Aggregate runtime metrics.** The requested provider-aware metrics — Sandbox
creation time, cumulative active execution time, command counts, preview
lifecycle, failure and cleanup counters — were not built: there is no store for
them and nothing consumes them today. What exists is narrower and real: each
`ExecResult` carries `durationMs` and `timedOut`, per-project runtime state is
derivable from `projects.runtime_provider` / `sandbox_id` /
`last_accessed_at`, and failures surface as typed `RuntimeOperationError`
statuses. Adding a metrics table is a deliberate follow-up, not something this
document should claim as done.

No billing claim is made either: the pricing page was not read in enough detail
to map individual commands to billing units, so nothing in the code reports cost.
