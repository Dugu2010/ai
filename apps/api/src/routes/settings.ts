import { Router, Request, Response } from "express";
import { getUserSettings, upsertUserSettings } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { NIM_BASE_URL, NIM_MODEL } from "../lib/env.js";
import { MAX_REQUEST_BODY_SIZE } from "../lib/validation.js";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/settings
 * Response contract with apps/web/app/settings/page.tsx:
 * { email, userId, model, baseUrl, apiKeySet }
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const settings = await getUserSettings(user.userId);
    if (!settings) {
      res.json({
        email: user.email,
        userId: user.userId,
        model: NIM_MODEL(),
        baseUrl: NIM_BASE_URL(),
        apiKeySet: false,
      });
      return;
    }
    res.json({
      email: user.email,
      userId: user.userId,
      model: settings.nimModel || NIM_MODEL(),
      baseUrl: settings.nimBaseURL || NIM_BASE_URL(),
      apiKeySet: !!settings.nimApiKeyEnc,
    });
  } catch (error: any) {
    console.error("[settings:GET]", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/settings
 * Body: { model?, baseUrl?, apiKey? } — apiKey only when the user typed one.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }

    const { model, baseUrl, apiKey } = req.body ?? {};
    const updates: {
      nimModel?: string;
      nimBaseURL?: string;
      nimApiKeyEnc?: string | null;
    } = {};

    if (typeof model === "string" && model.trim()) updates.nimModel = model.trim();
    if (typeof baseUrl === "string" && baseUrl.trim()) updates.nimBaseURL = baseUrl.trim();
    if (typeof apiKey === "string" && apiKey.trim()) {
      updates.nimApiKeyEnc = encrypt(apiKey.trim());
    }

    await upsertUserSettings(user.userId, updates);
    res.json({ success: true });
  } catch (error: any) {
    console.error("[settings:POST]", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
