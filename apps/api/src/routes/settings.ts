import { Router, Request, Response } from "express";
import { getUserSettings, upsertUserSettings } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { NIM_BASE_URL, NIM_MODEL } from "../lib/env.js";
import { resolveNimConfig } from "../lib/nim-config.js";
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

/**
 * GET /api/settings/models
 * Proxies the configured provider's OpenAI-compatible /models endpoint so the
 * project UI can show a live model list. Falls back to a static list if the
 * provider is unreachable.
 */
const FALLBACK_MODELS: { id: string; owned_by?: string }[] = [
  { id: "meta/llama-3.1-405b-instruct", owned_by: "nvidia" },
  { id: "meta/llama-3.3-70b-instruct", owned_by: "nvidia" },
  { id: "deepseek-ai/deepseek-r1", owned_by: "deepseek" },
  { id: "qwen/qwen2.5-coder-32b-instruct", owned_by: "qwen" },
];

router.get("/models", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const config = await resolveNimConfig(user.userId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const upstream = await fetch(`${config.baseURL.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
      });
      if (!upstream.ok) {
        throw new Error(`Provider returned ${upstream.status}`);
      }
      const data: any = await upstream.json();
      const models = Array.isArray(data?.data)
        ? data.data
            .map((m: any) => ({ id: String(m?.id ?? ""), owned_by: m?.owned_by }))
            .filter((m: { id: string }) => m.id)
        : FALLBACK_MODELS;
      res.json({ models, source: "provider" });
    } finally {
      clearTimeout(timer);
    }
  } catch (error: any) {
    console.warn("[settings:models] falling back to static list:", error.message);
    res.json({ models: FALLBACK_MODELS, source: "fallback" });
  }
});

export default router;
