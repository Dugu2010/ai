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

export const JWT_SECRET = () => getEnv("JWT_SECRET", "");
export const JWT_ISSUER = () => getEnv("JWT_ISSUER", "dai-app");
export const JWT_EXPIRATION_SECONDS = () =>
  parseInt(process.env.JWT_EXPIRATION_SECONDS || "604800", 10); // 7 days

export const CODESANDBOX_API_KEY = () => getEnv("CODESANDBOX_API_KEY", "");
export const NIM_API_KEY = () => getEnv("NIM_API_KEY", "");
export const NIM_BASE_URL = () =>
  getEnv("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1");
export const NIM_MODEL = () => getEnv("NIM_MODEL", "meta/llama-3.1-405b-instruct");
export const ENCRYPTION_KEY = () => getEnv("DAI_API_KEY_ENCRYPTION_KEY", "");

export const IDLE_TIMEOUT_SECONDS = () =>
  parseInt(process.env.DAI_IDLE_TIMEOUT_SECONDS || "30", 10);
export const PREVIEW_DOMAIN_SUFFIX = () =>
  getEnv("DAI_PREVIEW_DOMAIN_SUFFIX", "csb.app");
