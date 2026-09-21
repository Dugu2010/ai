# Deployment Guide

## Architecture

```
┌──────────────────┐        ┌───────────────────┐        ┌──────────────────┐
│  Vercel          │ HTTPS  │  Render           │ gRPC   │  Modal           │
│  apps/web        │──────► │  apps/api         │──────► │  Sandbox compute │
│  Next.js UI      │ Bearer │  Express + Pg     │        │  + Volume files  │
│                  │        │  agent loop       │        └──────────────────┘
│ NEXT_PUBLIC_     │        │  + NVIDIA NIM     │              ▲
│ API_URL          │        │  ALL SECRETS      │──────────────┘
│ (+ optional      │        └───────────────────┘   MODAL_TOKEN_ID/SECRET
│  NEXT_PUBLIC_    │             Postgres holds the project → Sandbox mapping
│  DAI_MODEL)      │
└──────────────────┘
```

- **Vercel**: frontend only. `NEXT_PUBLIC_API_URL` (and optionally
  `NEXT_PUBLIC_DAI_MODEL`). No Modal SDK, no runtime secrets — these are
  build-time inlined into public JS, so nothing sensitive belongs here.
- **Render**: the control plane and every secret — `DATABASE_URL`, `JWT_SECRET`,
  `DAI_API_KEY_ENCRYPTION_KEY`, `NIM_API_KEY`, `MODAL_TOKEN_ID`,
  `MODAL_TOKEN_SECRET`.
- **Modal**: isolated Sandbox compute plus the persistent `dai-workspaces` Volume.

See `RUNTIME_ARCHITECTURE.md` for runtime behaviour and
`MODAL_RUNTIME_MIGRATION.md` for the CodeSandbox→Modal move.

## 0. Prepare Modal (once)

1. Create an API token at <https://modal.com/settings/api-keys>.
2. Choose the App / Volume / Image names you will use (defaults: `dai`,
   `dai-workspaces`, `dai-runtime`) and set them on Render if you differ.
3. Build and publish the runtime image **from somewhere with the token**, since
   it must not happen inside a request path:

```bash
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... bun run tsx scripts/build-runtime-image.ts
```

If this is skipped, project creation and every workspace call fail with a clear
503 naming the missing image.

## 1. Deploy the backend on Render

**Option A — Blueprint (recommended):**
1. Render Dashboard → **New → Blueprint** → select this repo.
2. `render.yaml` creates the API service + a free Postgres DB and wires
   `DATABASE_URL` automatically. The build command bootstraps bun and runs
   `build:packages` then `build:api`, which is required because `dist/` is
   gitignored and `apps/api` resolves workspace packages from their build output.
3. Add these as **secret** env vars in the service's Environment tab:
   - `MODAL_TOKEN_ID`
   - `MODAL_TOKEN_SECRET`
   - `NIM_API_KEY`
4. Deploy. `ensureSchema()` creates tables and retires legacy CodeSandbox runtime
   identifiers on first boot.

**Option B — Manual:**
1. New → **PostgreSQL** → create → copy the *Internal Database URL*.
2. New → **Web Service** → settings:
   - Root Directory: `apps/api`
   - Build Command: `npm install -g bun && bun install && bun run build:packages && bun run build:api`
   - Start Command: `npm start`
   - Health Check Path: `/health`
3. Env vars: `DATABASE_URL`, `JWT_SECRET` (`openssl rand -hex 32`),
   `DAI_API_KEY_ENCRYPTION_KEY`, `ALLOWED_ORIGINS` (your Vercel URLs,
   comma-separated), `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `NIM_API_KEY`.
   Runtime tuning (`MODAL_CPU`, `MODAL_MEMORY_MIB`, `MODAL_IDLE_TIMEOUT_MS`,
   `MODAL_VOLUME_NAME`, `MODAL_PREVIEW_PORTS`) is optional; see
   `apps/api/.env.example`.

`PORT` is honoured — the service listens on `0.0.0.0:$PORT` (default `4000`).

## 2. Point the frontend at it (Vercel)

1. Vercel → Settings → Environment Variables:
   - `NEXT_PUBLIC_API_URL` = `https://<your-api>.onrender.com` (no trailing slash)
2. Redeploy.

> ⚠️ `NEXT_PUBLIC_*` values are baked in at build time — a change needs a redeploy.

## 3. Verify

```bash
curl https://<your-api>.onrender.com/api/health
# → {"ok":true}

curl -X POST https://<your-api>.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"password123","name":"You"}'
# → {"userId":"...","email":"...","token":"..."}
```

Then create a project in the app and confirm a Modal Sandbox appears in the
Modal dashboard tagged `dai.project=<projectId>`.

## What works without Modal / NIM keys

| Feature | Status |
|---|---|
| Register/Login/JWT auth | ✅ needs only Postgres |
| `/api/health`, project list/create metadata | ✅ create returns `201` with `status: "provisioning"` and an explanatory `lastError` |
| Settings (model, base URL, encrypted key) | ✅ |
| Workspace files / commands / preview | 503 with an actionable message |
| Agent runs | 503 **before** SSE headers are sent, so no half-open stream |
| Agent conversation + commands | needs `MODAL_TOKEN_ID`/`SECRET` + `NIM_API_KEY` (or a per-user NIM key in Settings) |

The API boots and serves health checks even with no runtime configured; failures
are typed and reported rather than crashing the process.

## Migrating existing projects

```bash
bun run tsx scripts/migrate-runtime.ts --dry-run
bun run tsx scripts/migrate-runtime.ts [--import-dir /path/to/exported-archives]
```

See `MODAL_RUNTIME_MIGRATION.md` — including the caveat that files exported from
the previous provider must already be available as archives.

## Local development

```bash
bun install
bun run build:packages          # required before typechecking/running apps/api

# Backend — .env.local is loaded automatically; see apps/api/.env.example
cd apps/api
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... DATABASE_URL=... JWT_SECRET=dev \
  bun run dev                   # http://localhost:4000

# Frontend (new terminal)
cd apps/web
NEXT_PUBLIC_API_URL=http://localhost:4000 bun run dev   # http://localhost:3001

# Checks
cd .. && bun run typecheck && bun run test
```
