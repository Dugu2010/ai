# DAI

A browser-based AI coding agent. It reads, edits and tests your project inside a
hosted workspace, and shows a real activity timeline of what it did — there is
no terminal to operate.

## Architecture

```
Vercel                    Render                        Modal
──────                    ──────                        ─────
apps/web          ──►     apps/api            ──►      Sandbox  (compute)
Next.js 16 frontend       Express control plane        Volume   (persistent
                        PostgreSQL                     project files)
                                │
                                └──►  NVIDIA NIM  (the model)
```

| Tier | Responsibility | Notes |
|---|---|---|
| **Vercel** | Frontend only | Reads one env var, `NEXT_PUBLIC_API_URL`. No provider SDK and no backend secret is ever shipped to the browser. |
| **Render** | Backend / control plane | Express API in `apps/api`, PostgreSQL, JWT auth, encrypted-at-rest user keys, budgets and rate limits. |
| **NVIDIA NIM** | AI provider | The only model backend. Accessed server-side. |
| **Modal** | Runtime + persistent storage | One Sandbox per agent run over a per-project Volume subPath mounted at `/workspace`. Durable files survive compute being reclaimed. |

**This is the whole system.** There is no second execution provider, no
container orchestration tier and no self-hosted cluster. Kubernetes is **not**
part of DAI, and adding it is not an improvement to be discovered — a new
runtime would mean deliberately implementing the `Workspace`/`RuntimeService`
contract in a new `packages/*` module.

## Layout

```
apps/web        Next.js 16 App Router frontend
apps/api        Express control plane
packages/modal  The only place that imports the Modal SDK
packages/db     PostgreSQL access
packages/nim    NVIDIA NIM client
packages/types  Shared contracts between frontend and API
docs/archive    Superseded reports — see docs/archive/README.md
scripts         Out-of-band jobs (runtime image build, workspace migration)
```

## Current documentation

- [`RUNTIME_ARCHITECTURE.md`](RUNTIME_ARCHITECTURE.md) — how the runtime works
  and the rules that govern changes to it. Read before touching `packages/modal`
  or `apps/api/src/lib/runtime.ts`.
- [`MODAL_RUNTIME_MIGRATION.md`](MODAL_RUNTIME_MIGRATION.md) — how the previous
  providers were removed, and what was verified versus not.
- [`FINAL_VERIFICATION.md`](FINAL_VERIFICATION.md) — the latest gate results,
  known issues, and an explicit list of what remains unverified.
- [`DEPLOY.md`](DEPLOY.md) — deploying to Vercel and Render.
- [`AGENTS.md`](AGENTS.md) — commands and constraints for working in this repo.

## Development

```bash
bun install
bun run build:packages
cd apps/api && cp .env.example .env   # fill in values
bun run dev:api                        # http://localhost:3000
bun run dev:web                        # http://localhost:3001
```

Checks — none of which require provider credentials or spend anything:

```bash
bun run typecheck   # all workspaces
bun run lint
bun run test        # packages/modal + apps/api + apps/web
bun run build
```

`apps/api` resolves workspace packages from their built `dist/`, so run
`bun run build:packages` after editing `packages/*`.

## Environment

Backend (Render): `DATABASE_URL`, `JWT_SECRET`, `DAI_API_KEY_ENCRYPTION_KEY`,
`NIM_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `ALLOWED_ORIGINS`.

Frontend (Vercel): `NEXT_PUBLIC_API_URL` only.
