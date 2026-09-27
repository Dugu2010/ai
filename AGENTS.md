# AGENTS.md

## Project Overview
This is a monorepo for the ai project (Dugu2010/ai). It contains multiple packages and applications.

## Development Setup

### Package Manager
- **Bun** is the primary package manager. Use `bun install` to install dependencies.
- Alternative: `npm` can be used but `bun install` is preferred.

### Build Commands
```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Build specific app (web)
bun run build --filter=web
```

### Lint and Typecheck
```bash
# Lint all packages
bun run lint

# Typecheck all packages
bun run typecheck
```

### Tests
```bash
bun run test              # modal (92) + vercel (67) + api (309) + web (47); no credentials needed
bun run test:modal
bun run test:vercel
bun run test:api
bun run test:web

# Live Modal integration — creates real Sandboxes, needs a funded account:
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... DATABASE_URL=... \
  bunx vitest run --config packages/modal/vitest.live.config.ts
```

`bun run lint` and `bun run typecheck` are both clean (0 errors). The two
remaining `apps/web` warnings are deliberate: `postcss.config.mjs` keeps its
export inline-compatible shape, and `lib/api-client.ts` uses a full-page
`location.replace` on 401 so the Back button cannot return to a dead session.

## Fixed Architecture — do not migrate it

```
Vercel (apps/web)  →  Render (apps/api + PostgreSQL)  →  provider runtime
                             │                    (Vercel Sandbox + Drives, or Modal)
                             └─ Cloudflare R2 (workspace mirror)
                                                        ↘  NVIDIA NIM (model)
```

This is the whole system. There is no container orchestration and no
self-hosted compute tier. Do not introduce Kubernetes, k3s, kind,
Docker-in-the-backend, systemd units or any other execution infrastructure, and
do not treat host capabilities (Docker, sudo, cgroups) as an invitation to
change the deployment target. The **API and PostgreSQL stay on Render** by
decision: the agent loop holds one long-lived request, the sandbox queue runs on
an interval, and cancellation and rate limiting are in-process — all of which
need a persistent process, which Vercel Functions' 300-second ceiling does not.

Adding a provider still means implementing the `Workspace`/`RuntimeService`
contract in a new `packages/*` module — never branching on provider inside
`apps/api` except through `runtimeProvider()`.

## Execution Runtime: Vercel Sandbox (Modal is the legacy provider)

DAI runs agent code in **Vercel Sandboxes**, with one **Vercel Drive** mounted at
`/workspace` per project as the live tree and **Cloudflare R2** as the durable
mirror. `RUNTIME_PROVIDER` selects the provider and defaults to `vercel`;
`modal` is the legacy value, kept only for instances still holding workspaces in
the Modal Volume (see `VERCEL_RUNTIME_MIGRATION.md`). Formerly Freestyle, then
CodeSandbox; both fully removed.

Read `RUNTIME_ARCHITECTURE.md` and `VERCEL_RUNTIME_MIGRATION.md` before touching
the runtime.

Key rules for edits here:

- Each SDK is imported by exactly one package: `@vercel/sandbox` and the S3
  client by `packages/vercel`, `modal` by `packages/modal`. Routes use the
  `Workspace`/`RuntimeService` contract from `@dai/runtime` via
  `apps/api/src/lib/runtime.ts`.
- Verify SDK calls against the installed `dist/*.d.ts`, not documentation prose or
  memory. Both providers ship ESM and CJS builds, so classification of provider
  errors is structural (`response.status`) because `instanceof` can fail across
  that boundary.
- **Never boot a machine to look at files.** Reading or listing a cold project's
  tree is served from the R2 mirror; `coldMirrorProject()` gates it. Every Vercel
  file API resumes the sandbox, and `fs.readdir`/`stat`/`rename`/`rm` are
  implemented as *commands* inside the SDK, so they cost metered CPU.
- Installing dependencies is the largest Active-CPU cost. `VERCEL_CACHE_DRIVE`
  names a shared drive mounted read-only at `/dai-cache` with package-manager
  cache env vars set on every sandbox; populate it with
  `VercelRuntimeService.acquireCacheWriter()` (only one sandbox may hold a drive
  read-write). A snapshot of a never-written cache drive is refused by the
  platform, and the provider degrades to no-cache rather than failing the boot.
- Only `runCommand` spends Active CPU. Provisioned memory is billed as wall clock
  of a running VM including idle, so an un-stopped sandbox is the faster way to
  exhaust the month.
- The monthly budget is enforced **before** acquiring, at 95% of the Hobby
  allotment, because exceeding it pauses sandbox creation for 30 days rather than
  producing a bill. See `apps/api/src/lib/cost-governor.ts`.
- Sandboxes are persistent and resumable by name (`dai-<projectId>`); the
  Modal-era rule "never resume a finished sandbox" does not carry over. Postgres
  remains the authoritative project→sandbox mapping.
- Losing compute must never lose files: the mirror is written through on every
  mutation and a project is marked dirty whenever a command could have written
  files the mirror never saw.
- Provider secrets (`VERCEL_TOKEN`, `MODAL_TOKEN_ID`/`SECRET`, `R2_*` keys,
  `NIM_API_KEY`) belong to Render only. The frontend may read just
  `NEXT_PUBLIC_API_URL`.
- Vercel preview URLs carry no token. The browser is never given
  `sandbox.domain(port)`: `apps/api/src/routes/preview.ts` proxies it and the
  credential is a short-lived HMAC capability in the path, because an iframe
  cannot send an Authorization header. The proxy router is mounted **before**
  `requireAuth` on purpose — the token is the credential there, so do not add
  anything to that file that trusts the path alone.
- `apps/api` resolves workspace packages from their built `dist/`, so after
  editing `packages/*` run `bun run build:packages` before typechecking the API.

## Puter Provider Integration

### Overview
The Puter provider is configured in `~/.config/kilo/kilo.jsonc` as an OpenAI-compatible provider that proxies requests through `puter-api-proxy` running locally.

### Proxy Service (puter-api-proxy)
- **Location:** `/tmp/puter-api-proxy/`
- **API Endpoint:** `http://localhost:3800`
- **API Key:** `sk-puter-proxy`
- **Puter Auth Token:** Stored in `/tmp/puter-api-proxy/.env`

### Systemd Service
The proxy runs as a systemd user service:
```bash
# Check status
systemctl --user status puter-api-proxy.service

# View logs
journalctl --user -u puter-api-proxy.service -f

# Restart
systemctl --user restart puter-api-proxy.service
```

Service file: `~/.config/systemd/user/puter-api-proxy.service`

### Environment Variables (Required)
Set these when working with Puter models:
```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
```

### Available Models
The proxy auto-fetches ~1009 models from Puter. Recommended models (best value):
- **gpt-5-nano** ($0.05/M tokens) - Fastest, cheapest, no tool calling
- **deepseek-v4-flash** ($0.14/M tokens) - Good balance of speed and quality
- **gpt-5.6-luna** - High quality with tool calling support

### Testing the Proxy
```bash
# List models
curl -s "http://localhost:3800/v1/models" -H "Authorization: Bearer sk-puter-proxy"

# Test a chat completion
curl -s -X POST http://localhost:3800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-puter-proxy" \
  -d '{"model":"gpt-5-nano","messages":[{"role":"user","content":"Hello"}],"max_tokens":10}'
```

### Notes
- The proxy has smart fallback routing across models if a requested model is unavailable
- If the proxy is not running, Kilo cannot use Puter models
- The puter-api-proxy source is in /tmp which is ephemeral; if the system restarts, the git clone at /tmp/puter-api-proxy may need to be restored
