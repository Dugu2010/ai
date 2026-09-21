import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { ensureSchema } from "./lib/schema.js";
import authRoutes from "./routes/auth.js";
import projectRoutes from "./routes/projects.js";
import agentRoutes from "./routes/agent.js";
import settingsRoutes from "./routes/settings.js";
import conversationRoutes from "./routes/conversations.js";
import workspaceRoutes from "./routes/workspace.js";

const app = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

// ---------- CORS ----------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow server-to-server / curl (no Origin header)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true); // open during setup; set ALLOWED_ORIGINS in prod
    // Vercel preview deployments get random per-deployment subdomains
    // (e.g. ai-38m3p7s7q-wither2.vercel.app), so they can never be fully
    // listed. Allow any *.vercel.app origin that ends with the project's
    // account/team suffix (wither2.vercel.app). Set VERCEL_DOMAIN_SUFFIX to
    // change it, or leave it empty to disable the wildcard.
    const vercelSuffix = (process.env.VERCEL_DOMAIN_SUFFIX || "wither2.vercel.app").toLowerCase();
    try {
      const o = new URL(origin);
      const hostname = o.hostname.toLowerCase();
      if (
        vercelSuffix &&
        o.protocol === "https:" &&
        (hostname === vercelSuffix || hostname.endsWith("." + vercelSuffix))
      ) {
        return callback(null, true);
      }
    } catch {
      callback(new Error("Not allowed by CORS"));
      return;
    }
    if (allowedOrigins.some((allowed) => {
      try {
        const a = new URL(allowed);
        const o = new URL(origin);
        // Compare hostnames case-insensitively so Dugu2010 vs dugu2010 works
        return a.hostname.toLowerCase() === o.hostname.toLowerCase() && a.protocol === o.protocol;
      } catch {
        return false;
      }
    })) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

// ---------- Request logging ----------
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path !== "/health") {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});

// ---------- Routes ----------
// `/health` is the Render health check path (render.yaml healthCheckPath);
// `/api/health` is the path the app and its verification scripts call.
const health = (_req: Request, res: Response) => {
  res.json({ ok: true });
};
app.get("/health", health);
app.get("/api/health", health);

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/projects", agentRoutes); // POST /api/projects/:id/agent
app.use("/api/settings", settingsRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/workspace", workspaceRoutes);

// 404 for unknown API paths
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ---------- Error handling ----------
app.use((err: Error & { statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.message === "Not allowed by CORS") {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  console.error("[error]", err.message);
  res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
});

// ---------- Boot ----------
// Listen immediately so health checks pass during DB cold starts (Render free
// tier sleeps); connect + migrate in the background with retries.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`DAI API listening on 0.0.0.0:${PORT}`);
  console.log(`CORS origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "(open — set ALLOWED_ORIGINS)"}`);
});

async function connectWithRetries(maxRetries = 10): Promise<void> {
  const { pool } = await import("@dai/db");
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query("SELECT 1");
      console.log("[db] connected");
      return;
    } catch (e: any) {
      console.warn(`[db] connection attempt ${attempt}/${maxRetries} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2000, 10000)));
    }
  }
  console.error("[db] Could not connect to Postgres after retries. Check DATABASE_URL.");
  process.exit(1);
}

// ---------- Sandbox queue worker (Item 5) ----------
// Handlers run queued create/resume jobs when a concurrency slot frees up.
// Queue state lives in PostgreSQL (sandbox_queue), so this survives Render restarts.
async function startQueueWorker(): Promise<void> {
  const { registerSandboxJobHandler, startSandboxQueueWorker } = await import("./lib/sandbox-queue.js");
  const { getProject } = await import("@dai/db");

  registerSandboxJobHandler("create", async (job) => {
    const project = await getProject(job.projectId);
    if (!project) return; // project deleted while queued — completing the job is correct
    const { provisionSandbox } = await import("./routes/projects.js");
    await provisionSandbox(project);
  });

  registerSandboxJobHandler("resume", async (job) => {
    const project = await getProject(job.projectId);
    if (!project) return;
    // "Resume" is a queue-era name for what Modal calls acquire: reattach to the
    // stored Sandbox if it is still running, otherwise mount a new one over the
    // same durable Volume. A finished Modal Sandbox is never resumed.
    const { acquireWorkspace, isRuntimeConfigured, releaseWorkspace } = await import("./lib/runtime.js");
    if (!isRuntimeConfigured()) return;
    const { workspace } = await acquireWorkspace(project.id);
    releaseWorkspace(workspace);
  });

  await startSandboxQueueWorker();
  console.log("[sandbox-queue] worker started");
}

connectWithRetries()
  .then(() => ensureSchema())
  .then(() => startQueueWorker())
  .catch((err) => {
    console.error("Fatal DB init error:", err);
    process.exit(1);
  });
