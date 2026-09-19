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
const PORT = parseInt(process.env.PORT || "3000", 10);

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
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

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
app.listen(PORT, () => {
  console.log(`DAI API listening on port ${PORT}`);
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

connectWithRetries()
  .then(() => ensureSchema())
  .catch((err) => {
    console.error("Fatal DB init error:", err);
    process.exit(1);
  });
