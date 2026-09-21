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
bun run test              # packages/modal (87) + apps/api (217) + apps/web (40); no credentials needed
bun run test:modal
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
Vercel (apps/web)  →  Render (apps/api + PostgreSQL)  →  Modal (Sandbox + Volume)
                                                  ↘  NVIDIA NIM (model)
```

This is the whole system. There is no other runtime, no container
orchestration, and no self-hosted compute tier. Do not introduce Kubernetes,
k3s, kind, Docker-in-the-backend, systemd units or any other execution
infrastructure, and do not treat host capabilities (Docker, sudo, cgroups) as
an invitation to change the deployment target. Adding a provider means
implementing the `Workspace`/`RuntimeService` contract in a new
`packages/*` module — and only when asked.

## Execution Runtime: Modal

DAI runs agent code inside **Modal Sandboxes** with a persistent **Modal Volume**
workspace. Formerly Freestyle, then CodeSandbox; both are fully removed.

Architecture: Vercel frontend → Render API (`apps/api`) → Modal (Sandbox +
Volume); NVIDIA NIM is the model. Read
`RUNTIME_ARCHITECTURE.md` and `MODAL_RUNTIME_MIGRATION.md` before touching the
runtime.

Key rules for edits here:

- `packages/modal` is the only place that imports the `modal` SDK. Routes use the
  `Workspace` / `RuntimeService` contract via `apps/api/src/lib/runtime.ts`.
- Verify SDK calls against `node_modules/modal/dist/index.d.ts`. The package is
  **0.x beta**, and the `.d.ts` is a single bundled file — grep it rather than
  trusting recalled or blogged APIs.
- Never resume a finished Sandbox; Modal cannot. Reattach to a live one via
  `sandboxes.fromId()` + `poll() === null`, else create a new Sandbox over the
  same Volume subPath. Postgres is the authoritative project→Sandbox mapping.
- Durable state lives in the Volume at `projects/<projectId>`, mounted at
  `/workspace`. Losing compute must never lose files.
- No keepalive or per-command provisioning: `idleTimeoutMs` reclaims compute,
  and open TCP connections count as Sandbox activity.
- Modal secrets (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`) belong to Render only.
  The frontend may read just `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_DAI_MODEL`.
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
