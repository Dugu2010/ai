# Runtime migration: Modal → Vercel Sandbox + Drives + Cloudflare R2

The provider is selected by configuration, not by a code deployment. That is
deliberate: the switch has an ordering, and a project whose files have not been
imported yet must keep running on the provider that still holds them.

```
RUNTIME_PROVIDER=modal     default; Modal Sandboxes + Modal Volume
RUNTIME_PROVIDER=vercel    Vercel Sandbox + per-project Drive + R2 mirror
```

Both providers implement the same contract (`@dai/runtime`), so nothing in
`apps/api/src/routes`, the agent loop or the checkpoint layer changes between
them. `packages/modal` is retained as the legacy provider and as the reader that
performs the import below — it is not deleted until every workspace has been
verified in R2.

## Why this split, and not "R2 everywhere"

Two platform facts decided the shape, both verified against the installed SDK's
type declarations rather than documentation prose:

- A Vercel **Drive** is persistent POSIX block storage mounted into a sandbox. It
  is the only place `git`, `npm install` and in-place writes can happen, so it is
  the live `/workspace`.
- **R2 is object storage.** No rename, no random writes, no directory listing that
  behaves like a filesystem. It cannot host a working tree — but it has no egress
  fees, and Vercel makes data downloaded *into* a sandbox free, which makes it the
  ideal place for the durable copy.

The part that is easy to get wrong: every Vercel file operation, including
`sandbox.readFile`, is wrapped in an automatic resume, and `fs.readdir`, `fs.stat`,
`fs.rename` and `fs.rm` are implemented by the SDK as `find`/`ls`/`mv`/`rm`
**commands**. So "just read it from the sandbox" would boot a VM for a directory
listing — and provisioned memory bills wall clock of a running VM including idle,
which on Hobby (420 GB-hours) runs out faster than the 5 hours of Active CPU.
Hence: **R2 is the read path for a cold project**, and the drive is the working
copy only while something is actually running.

## Order of operations

1. **Provision R2.** Create a bucket and an RFC-4688-style S3 token restricted to
   it. Set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` on Render. The mirror is optional: with no R2 config
   the Vercel provider still works, every read just costs a sandbox.
2. **Provision Vercel.** `VERCEL_TOKEN` (project scoped) plus, if you use OIDC
   locally, `VERCEL_PROJECT_ID`. Choose `VERCEL_SANDBOX_REGION` and keep every
   drive in that same region — a drive cannot change region after creation, and a
   sandbox must match its drive's region.
3. **Import the files, still on Modal.**

   ```bash
   bun run tsx scripts/migrate-runtime-v2.ts --dry-run
   bun run tsx scripts/migrate-runtime-v2.ts
   ```

   For each project it attaches the Modal sandbox, lists files excluding
   `node_modules` and `.git`, reads them in batches of 40 and writes them to
   `workspaces/projects/<id>/files/...`. It then marks the mirror clean, so the
   first read after cutover is served from R2 rather than booting a machine.
   It is re-runnable: an already-imported project is skipped, and it never deletes
   anything from the Modal Volume. A non-zero exit means at least one project did
   not import — do not proceed past it.
4. **Flip the provider.** Set `RUNTIME_PROVIDER=vercel` and restart the API. On
   boot `ensureSchema()` retires Modal identifiers — `sandbox_id` moves to
   `legacy_sandbox_id`, `runtime_provider` becomes `vercel`, the project returns
   to `provisioning` so the next acquire mounts a drive. That UPDATE is gated on
   the provider already being `vercel`; it cannot fire on a deployment still using
   Modal, which would clear live handles and orphan running sandboxes.
5. **Warm the dependency cache (optional, recommended).** Set
   `VERCEL_CACHE_DRIVE=dai-deps`, then run one install inside a writer sandbox:

   ```ts
   const writer = await service.acquireCacheWriter();
   await writer.exec("npm install --prefer-offline", { cwd: "/dai-cache" });
   await writer.terminate();
   ```

   Every later project sandbox mounts that drive read-only at `/dai-cache` with
   `npm_config_cache`, `PNPM_HOME`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`,
   `GOMODCACHE` and `GOCACHE` pointed into it, so a repeat install is mostly
   local copies instead of downloads and compiles.
6. **Confirm, then retire.** Open a cold project: the file tree and a file body
   should render with no sandbox anywhere in the Vercel dashboard. Then a run.
   Only after a period of no incidents is `packages/modal` and the `modal`
   dependency removable, along with `MODAL_TOKEN_*`.

## Rollback

Set `RUNTIME_PROVIDER=modal`. The import is additive, so the Modal Volume still
holds every pre-import file. Anything the agent changed *after* the import is not
in Modal, so note the import timestamp before rolling back a busy project.

## Cost model, and why it is enforced in the app

On the free tier, exceeding a quota does not produce a bill — it pauses sandbox
creation for thirty days, which takes the product away entirely. So
`apps/api/src/lib/cost-governor.ts` refuses a boot at **95%** of any controllable
ceiling, before the machine exists:

| Level | Reached at | Effect |
| --- | --- | --- |
| `ok` | < 60% | normal |
| `warn` | 60% | banner in the timeline and status |
| `throttle` | 80% | no escalation, no dev-server autostart, smallest machine only |
| `halt` | 95% | new runs refused with 429 and a reset date; reading, diffs and undo keep working |

Egress is measured and reported but is never a stop condition: the app cannot make
a transfer cheaper by refusing to run, so refusing would disable the product for a
number it cannot act on.

Sizing follows the same logic: boot at 1 vCPU, escalate one tier **only** after a
command genuinely times out, at most once per project per week, never while
throttled, and never past the largest tier — a timeout at the top tier ends the
run instead of buying a bigger machine that also times out.

Ledger rows are closed from the platform's own numbers
(`activeCpuUsageMs`, wall clock measured by Postgres), and the queue worker's tick
closes any row left open by a killed process, because an open row means the month's
total is understated — the precise error that lets a budget be overspent.

## Previews

`sandbox.domain(port)` is a **public** host with no token, unlike the previous
provider's authenticated tunnel. So the API stores that host and never returns
it: browsers get `/api/workspace/<id>/preview/p/<port>/<capability>/`, proxied by
`apps/api/src/routes/preview.ts`, and the capability is an HMAC over
project + port + expiry (6 h) signed with `JWT_SECRET`. Root-absolute asset URLs
in the served HTML are rewritten back through the proxy and a `<base>` tag is
injected, because a dev server emits `/src/app.tsx`-style paths that would
otherwise resolve against the API root. Tokens are redacted in the request log.

Two known limits, both from not being able to test against a live sandbox here:
**HMR websockets are not proxied** (the upgrade header set is stripped), so a
preview loads and works but does not live-reload through the proxy; and the HTML
rewrite covers `src`/`href`/`action` attributes only, not URLs constructed inside
JavaScript. If either matters in practice, the alternative is to hand out the
provider host directly and accept that it is public for as long as the sandbox
lives.

## Known limits of what was verified

Everything above is unit-tested against fakes (`bun run test`, 465 tests), and the
provider is typechecked against the installed `@vercel/sandbox` 3.5.0
declarations. Not verified against real accounts, because none were available
here: drive single-writer refusal behaviour under a stale advisory lock, snapshot
size against the 15 GB lifetime allowance, whether control-plane file reads count
toward the 20 GB egress figure, and the exact `domain(port)` exposure. Step 5 of
the order of operations is where those get answered, and each is a measurement
rather than a guess.
