import { getUserSettings } from "@dai/db";
import { decrypt } from "./crypto.js";
import { NIM_API_KEY, NIM_BASE_URL, NIM_MODEL } from "./env.js";

export interface ResolvedNimConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * Resolve model config: user settings first, then env defaults.
 * Base URL and API key are intentionally env-driven (with optional user
 * overrides) — only the model is user-selectable from the project UI.
 */
export async function resolveNimConfig(userId: string): Promise<ResolvedNimConfig> {
  let apiKey = NIM_API_KEY();
  let baseURL = NIM_BASE_URL();
  let model = NIM_MODEL();

  const settings = await getUserSettings(userId);
  if (settings) {
    if (settings.nimApiKeyEnc) {
      const decrypted = decrypt(settings.nimApiKeyEnc);
      if (decrypted) apiKey = decrypted;
    }
    if (settings.nimBaseURL) baseURL = settings.nimBaseURL;
    if (settings.nimModel) model = settings.nimModel;
  }

  if (!apiKey) {
    throw Object.assign(
      new Error("No API key available. Set NIM_API_KEY on the backend or save one in Settings."),
      { statusCode: 503 }
    );
  }
  return { apiKey, baseURL, model };
}
