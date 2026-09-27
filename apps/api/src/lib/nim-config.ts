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
  const platformBaseUrl = NIM_BASE_URL();
  let baseURL = platformBaseUrl;
  let model = NIM_MODEL();

  let userKey: string | null = null;
  const settings = await getUserSettings(userId);
  if (settings) {
    if (settings.nimApiKeyEnc) {
      const decrypted = decrypt(settings.nimApiKeyEnc);
      if (decrypted) userKey = decrypted;
    }
    if (settings.nimBaseURL) baseURL = settings.nimBaseURL;
    if (settings.nimModel) model = settings.nimModel;
  }

  // Every request to this URL carries the key in an Authorization header, so a
  // user-chosen host must never receive the shared platform key — it would walk
  // out of the product on the next agent run.
  const apiKey = userKey ?? (sameHost(baseURL, platformBaseUrl) ? NIM_API_KEY() : "");

  if (!apiKey) {
    throw Object.assign(
      new Error(
        userKey
          ? "No API key available."
          : "This provider base URL needs its own API key. Save one in Settings, or set the base URL back to the platform endpoint."
      ),
      { statusCode: 503 }
    );
  }
  return { apiKey, baseURL, model };
}

function sameHost(candidate: string, platform: string): boolean {
  try {
    return new URL(candidate).host === new URL(platform).host;
  } catch {
    return false;
  }
}
