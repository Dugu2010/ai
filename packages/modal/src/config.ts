/**
 * Runtime configuration, resolved once from the environment.
 *
 * Credentials are never read here: the Modal SDK takes MODAL_TOKEN_ID and
 * MODAL_TOKEN_SECRET from the process environment itself, so the key stays in
 * the Render service and is never bundled into a client-visible string.
 */

/** Modal rejects `timeoutMs` values that are not whole seconds. */
function wholeSeconds(ms: number): number {
  const rounded = Math.max(1_000, Math.round(ms / 1_000) * 1_000);
  return rounded;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number[]): number[] {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 65_536);
  return parsed.length ? parsed : fallback;
}

export interface ModalRuntimeConfig {
  appName: string;
  /** Named, immutable image so Sandbox creation never rebuilds layers. */
  imageName: string;
  baseImage: string;
  /** Extra Dockerfile lines applied to the base image when building. */
  imageCommands: string[];
  /** Single shared Volume; each project mounts its own subPath at /workspace. */
  volumeName: string;
  workspacePath: string;
  cpu: number;
  memoryMiB: number;
  /** Whole-Sandbox ceiling; a Sandbox is killed past this age. */
  timeoutMs: number;
  /** Idle ceiling; Modal terminates a Sandbox with no activity for this long. */
  idleTimeoutMs: number;
  /** Default per-command timeout for exec. */
  execTimeoutMs: number;
  /** How long startDevServer waits for the port to actually listen. */
  devServerReadyTimeoutMs: number;
  /** Ports exposed as TLS tunnels; also the dev-server candidates. */
  previewPorts: number[];
  /** Null = provider default outbound access. Set true to deny all egress. */
  blockNetwork: boolean;
  outboundDomainAllowlist: string[];
}

export const DEFAULT_CONFIG: ModalRuntimeConfig = {
  appName: "dai",
  imageName: "dai-runtime",
  baseImage: "node:22-bookworm-slim",
  imageCommands: [
    "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl unzip python3 python3-venv build-essential ripgrep && rm -rf /var/lib/apt/lists/*",
    "RUN npm install --global bun@1",
  ],
  volumeName: "dai-workspaces",
  workspacePath: "/workspace",
  cpu: 1,
  memoryMiB: 2_048,
  timeoutMs: wholeSeconds(4 * 60 * 60 * 1_000),
  idleTimeoutMs: wholeSeconds(5 * 60 * 1_000),
  execTimeoutMs: wholeSeconds(120_000),
  devServerReadyTimeoutMs: wholeSeconds(60_000),
  previewPorts: [3_000, 5_173, 8_080],
  blockNetwork: false,
  outboundDomainAllowlist: [],
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ModalRuntimeConfig {
  const cpu = Number.parseFloat(env.MODAL_CPU ?? "");
  return {
    appName: env.MODAL_APP_NAME?.trim() || DEFAULT_CONFIG.appName,
    imageName: env.MODAL_IMAGE_NAME?.trim() || DEFAULT_CONFIG.imageName,
    baseImage: env.MODAL_BASE_IMAGE?.trim() || DEFAULT_CONFIG.baseImage,
    imageCommands: DEFAULT_CONFIG.imageCommands,
    volumeName: env.MODAL_VOLUME_NAME?.trim() || DEFAULT_CONFIG.volumeName,
    workspacePath: env.MODAL_WORKSPACE_PATH?.trim() || DEFAULT_CONFIG.workspacePath,
    cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : DEFAULT_CONFIG.cpu,
    memoryMiB: intFromEnv(env, "MODAL_MEMORY_MIB", DEFAULT_CONFIG.memoryMiB),
    timeoutMs: wholeSeconds(intFromEnv(env, "MODAL_TIMEOUT_MS", DEFAULT_CONFIG.timeoutMs)),
    idleTimeoutMs: wholeSeconds(intFromEnv(env, "MODAL_IDLE_TIMEOUT_MS", DEFAULT_CONFIG.idleTimeoutMs)),
    execTimeoutMs: wholeSeconds(intFromEnv(env, "MODAL_EXEC_TIMEOUT_MS", DEFAULT_CONFIG.execTimeoutMs)),
    devServerReadyTimeoutMs: wholeSeconds(
      intFromEnv(env, "MODAL_DEV_SERVER_READY_TIMEOUT_MS", DEFAULT_CONFIG.devServerReadyTimeoutMs)
    ),
    previewPorts: listFromEnv(env, "MODAL_PREVIEW_PORTS", DEFAULT_CONFIG.previewPorts),
    blockNetwork: env.MODAL_BLOCK_NETWORK === "true",
    outboundDomainAllowlist: (env.MODAL_OUTBOUND_DOMAIN_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

/** Deterministic per-project location inside the shared workspace Volume. */
export function volumeSubPath(projectId: string): string {
  return `projects/${projectId}`;
}

/** Modal Sandbox name, capped at 63 characters and slug-safe. */
export function sandboxName(projectId: string): string {
  return `dai-${projectId}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 63);
}
