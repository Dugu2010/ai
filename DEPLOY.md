# Deployment Guide

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│  Vercel         │  HTTPS  │  Render          │
│  apps/web       │───────► │  apps/api        │
│  (Next.js UI)   │  Bearer │  (Express API)   │
│                 │  token  │  + Postgres      │
│  Only env var:  │         │  + Freestyle VMs │
│  NEXT_PUBLIC_   │         │  + NIM LLM       │
│  API_URL        │         │  All secrets     │
└─────────────────┘         └──────────────────┘
```

- **Vercel**: frontend only. One env var: `NEXT_PUBLIC_API_URL=https://<your-api>.onrender.com`
- **Render**: everything else — API, Postgres, JWT, encryption key, FREESTYLE_API_KEY, NIM_API_KEY.

## 1. Deploy the backend on Render

**Option A — Blueprint (recommended):**
1. Render Dashboard → **New → Blueprint** → select this repo.
2. Render reads `render.yaml`: creates the API service + a free Postgres DB and wires `DATABASE_URL` automatically.
3. In the service's **Environment** tab, add (if you have them):
   - `FREESTYLE_API_KEY`
   - `NIM_API_KEY`
4. Deploy. The schema auto-creates on first boot (`ensureSchema`).

**Option B — Manual:**
1. New → **PostgreSQL** → create → copy the *Internal Database URL*.
2. New → **Web Service** → repo → settings:
   - Root Directory: `apps/api`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Health Check Path: `/health`
3. Env vars: `DATABASE_URL`, `JWT_SECRET` (`openssl rand -hex 32`), `DAI_API_KEY_ENCRYPTION_KEY`, `ALLOWED_ORIGINS` (your Vercel URLs, comma-separated), plus `FREESTYLE_API_KEY` / `NIM_API_KEY` when available.

## 2. Point the frontend at it (Vercel)

1. Vercel Project → Settings → Environment Variables:
   - `NEXT_PUBLIC_API_URL` = `https://<your-api>.onrender.com` (no trailing slash)
2. Redeploy the frontend.

> ⚠️ `NEXT_PUBLIC_*` vars are baked in at build time — after changing it, trigger a redeploy.

## 3. Verify

```bash
curl https://<your-api>.onrender.com/health
# → {"status":"ok",...}

curl -X POST https://<your-api>.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"password123","name":"You"}'
# → {"userId":"...","email":"...","token":"..."}
```

Open the Vercel app → log in → create a project.

## What works without FREESTYLE/NIM keys

| Feature | Status |
|---|---|
| Register/Login/JWT auth | ✅ needs only Postgres |
| Project CRUD (list/create/delete metadata) | ✅ project saves; VM shows "provisioning" if Freestyle missing |
| Settings (model, base URL, encrypted API key) | ✅ |
| Workspace files/commands/preview | needs `FREESTYLE_API_KEY` |
| Agent code edits + commands on the VM | needs `FREESTYLE_API_KEY` + `NIM_API_KEY` (or per-user NIM key saved in Settings) |

## Local development

```bash
# 1. Install (bun or npm)
bun install

# 2. Build internal packages
bun run build:packages

# 3. Backend
cd apps/api && cp .env.example .env   # fill in values
bun run dev                            # http://localhost:3000

# 4. Frontend (new terminal)
cd apps/web
NEXT_PUBLIC_API_URL=http://localhost:3000 bun run dev   # http://localhost:3001
```
