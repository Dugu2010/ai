/**
 * Centralized environment access.
 * The API only fails at request time for vars it actually needs,
 * and reports which one is missing so Render logs are actionable.
 */

export function getEnv(name: string, fallback?: string): string {
  const val = process.env[name];
  if (val === undefined || val === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable: ${name}`);
  }
  return val;
}

export function getEnvOrWarn(name: string, fallback: string): string {
  const val = process.env[name];
  if (!val) {
    console.warn(`[env] ${name} is not set; using fallback`);
    return fallback;
  }
  return val;
}

export const JWT_SECRET = () => getEnv("JWT_SECRET");
export const JWT_ISSUER = () => getEnv("JWT_ISSUER", "dai-app");
export const JWT_EXPIRATION_SECONDS = () =>
  parseInt(process.env.JWT_EXPIRATION_SECONDS || "604800", 10); // 7 days

export const NIM_API_KEY = () => getEnv("NIM_API_KEY", "");
export const NIM_BASE_URL = () =>
  getEnv("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1");
export const NIM_MODEL = () =>
  getEnv("NIM_MODEL", "openai/gpt-oss-20b");
export const ENCRYPTION_KEY = () => getEnv("DAI_API_KEY_ENCRYPTION_KEY", "");

// Runtime compute lives behind lib/runtime.ts and the @dai/modal package.
// MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are read by the Modal SDK directly, and
// every tunable (cpu, memory, idle timeout, preview ports) comes from
// configFromEnv() in @dai/modal so no route hardcodes a provider value.
export const RUNTIME_MAX_COMMAND_TIMEOUT_MS = 300_000;
