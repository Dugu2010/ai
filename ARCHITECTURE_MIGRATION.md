# DAI Architecture Migration

## Final Architecture

### Vercel (Frontend Only)
- Next.js static/SSR frontend
- React components only
- **No backend secrets**
- **No database access**
- **No VM management**
- **No AI/LLM calls**

### Render (Backend/Control Plane)
- Express.js API server
- PostgreSQL database
- Freestyle VM management
- NVIDIA NIM integration
- All secrets (JWT, encryption keys, API keys)

---

## Route Ownership

| Route | Owned By | Notes |
|-------|----------|-------|
| `/api/auth/*` | Render | Login, logout, current user |
| `/api/projects/*` | Render | Project CRUD, VM creation |
| `/api/workspace/*` | Render | File operations, commands, preview |
| `/api/settings/*` | Render | User settings, API key storage |
| `/api/conversations/*` | Render | Chat history |

---

## Environment Variable Ownership

### Vercel (Frontend)
| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_API_URL` | `https://your-api.onrender.com` |

### Render (Backend)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT token signing (min 32 bytes) |
| `CSRF_SECRET` | CSRF token signing (min 32 bytes) |
| `DAI_API_KEY_ENCRYPTION_KEY` | API key encryption (min 32 bytes) |
| `FREESTYLE_API_KEY` | VM provisioning |
| `NIM_API_KEY` | LLM access |

---

## Authentication Flow

1. User logs in via `/api/auth/login` (Render)
2. Render returns JWT token
3. Frontend stores token in localStorage
4. All API calls include `Authorization: Bearer <token>`
5. Logout clears token and redirects to login

### CORS Configuration (Render)
```
ALLOWED_ORIGINS=https://your-app.vercel.app
```

---

## Local Development

```bash
# Terminal 1: Start API (Render backend locally)
cd apps/api
bun install
bun start  # Port 3000

# Terminal 2: Start frontend (Vercel)
cd apps/web
bun install
NEXT_PUBLIC_API_URL=http://localhost:3000 bun dev  # Port 3001
```

---

## Deployment Steps

### 1. Render Backend
1. Create new Node.js project
2. Set root to `apps/api`
3. Add all environment variables (DATABASE_URL, JWT_SECRET, etc.)
4. Deploy

### 2. Vercel Frontend
1. Create new project
2. Add environment variable: `NEXT_PUBLIC_API_URL`
3. Set to Render API URL
4. Deploy

---

## Migration Risks

1. **Cookie/Cross-origin**: Authentication now uses Bearer tokens instead of cookies. Frontend already adapted.
2. **VM Persistence**: Existing VMs may need reconnection to new backend instance.
3. **Database Migration**: PostgreSQL must be accessible from Render.
4. **API Versioning**: If future API changes occur, frontend may need updates.

---

## Security Summary

| Component | Secrets | Backend Logic |
|-----------|---------|---------------|
| **Vercel** | ❌ None | ❌ None |
| **Render** | ✅ All | ✅ All |

This separation ensures that even if Vercel is compromised, backend secrets and data remain protected.
