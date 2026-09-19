import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { createUser, getUserByEmailWithPassword, getUserById } from "@dai/db";
import { checkRateLimit, recordFailedAttempt, resetRateLimit } from "../lib/rate-limit.js";
import { requireAuth, getAuthUser, signJwt } from "../lib/auth.js";
import { JWT_EXPIRATION_SECONDS } from "../lib/env.js";
import { MAX_REQUEST_BODY_SIZE } from "../lib/validation.js";

const router = Router();

/**
 * Login or register. If the email doesn't exist and a name was provided,
 * the account is created — matches the frontend's isRegister flow.
 */
router.post("/login", async (req: Request, res: Response) => {
  try {
    const rateLimit = checkRateLimit(req);
    if (rateLimit.limited) {
      res.status(429).json({
        error: "Too many failed attempts. Please try again later.",
        retryAfter: rateLimit.retryAfter,
      });
      return;
    }

    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }

    const { email, password, name } = req.body ?? {};
    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Email and password required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();

    let user = await getUserByEmailWithPassword(normalizedEmail);
    if (!user) {
      // Registration path
      if (!name || typeof name !== "string" || !name.trim()) {
        recordFailedAttempt(req);
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const created = await createUser(normalizedEmail, name.trim(), passwordHash);
      user = {
        id: created.id,
        email: created.email,
        name: created.name,
        password_hash: passwordHash,
        created_at: created.createdAt,
        updated_at: created.updatedAt,
      };
    } else {
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        recordFailedAttempt(req);
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
    }

    resetRateLimit(req);
    const token = signJwt({ userId: user.id, email: user.email });

    res.json({
      userId: user.id,
      email: user.email,
      token,
      expiresInSeconds: JWT_EXPIRATION_SECONDS(),
    });
  } catch (error: any) {
    // Surface misconfiguration clearly (e.g. missing JWT_SECRET, DB down)
    console.error("[auth/login]", error.message);
    res.status(500).json({ error: error.message || "Authentication failed" });
  }
});

router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  const dbUser = await getUserById(user.userId);
  if (!dbUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ email: dbUser.email, userId: dbUser.id, name: dbUser.name });
});

router.post("/logout", requireAuth, async (req: Request, res: Response) => {
  resetRateLimit(req);
  res.setHeader(
    "Set-Cookie",
    "auth_token=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0"
  );
  res.json({ success: true });
});

export default router;
