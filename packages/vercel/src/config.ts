/**
 * Configuration for the Vercel execution provider.
 *
 * Every value is environment-driven so no route hardcodes a provider setting, and
 * the cost ceilings live here rather than in the call sites that enforce them —
 * the governor in apps/api reads the same numbers the provider was built from.
 */

import type { SandboxRegion } from "@vercel/sandbox";

/** One bootable machine shape. Memory is fixed per vCPU by the platform. */
export interface ResourceTier {
  vcpus: number;
  /** Human-facing label used in activity titles and the budget meter. */
  label: "small" | "medium" | "large";
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix inside the bucket, so one bucket can serve several environments. */
  rootPrefix: string;
}

/**
 * Monthly ceilings.
 *
 * These are the Vercel *Hobby* allotments. Exceeding one does not produce a
 * bill — it pauses sandbox creation for 30 days — so the app must stop itself
 * short of them, which is why `haltFraction` is below 1.
 */
export interface MonthlyBudget {
  activeCpuMs: number;
  /** Provisioned memory GB-hours; billed on wall clock including idle. */
  provisionedGbHours: number;
  creations: number;
  egressBytes: number;
  /** Fraction of each ceiling at which new sandboxes are refused outright. */
  haltFraction: number;
  /** Fraction at which expensive behaviour (escalation, previews) switches off. */
  throttleFraction: number;
  /** Fraction at which the user is first told. */
  warnFraction: number;
}

export interface VercelRuntimeConfig {
  /** Sandbox name prefix; the deterministic name is the resume key. */
  namePrefix: string;
  /** Drive name prefix for per-project workspaces. */
  drivePrefix: string;
  image: string;
  region: SandboxRegion;
  /** Absolute path the project drive is mounted at. */
  workspacePath: string;
  /** Session length for a boot. Kept short: an idle VM bills the month. */
  sessionTimeoutMs: number;
  /** Hard ceiling for a single command. */
  execTimeoutMs: number;
  devServerReadyTimeoutMs: number;
  previewPorts: number[];
  /** Escalation ladder, smallest first. Index is `AcquireOptions.resourceTier`. */
  tiers: ResourceTier[];
  /**
   * One shared drive holding package-manager caches, mounted read-only into every
   * project. Installing dependencies is the single largest Active-CPU cost in the
   * product, and it is mostly avoidable if the store is already warm.
   */
  cacheDriveName: string;
  cachePath: string;
  /** Environment each package manager reads to find its cache. */
  cacheEnv: Record<string, string>;
  /** Snapshots pile up against a 15 GB lifetime allowance; keep only the latest. */
  keepLastSnapshots: number;
  snapshotExpirationMs: number;
  /** Cap on a project's mirrored workspace bytes. */
  maxProjectWorkspaceBytes: number;
  r2: R2Config;
  budget: MonthlyBudget;
}

const HOUR_MS = 3_600_000;
const GIB = 1024 * 1024 * 1024;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

function parsePortList(raw: string | undefined): number[] {
  if (!raw) return [3000];
  const ports = raw
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535);
  return ports.length > 0 ? ports : [3000];
}

/**
 * The tiers we are allowed to ask for.
 *
 * Hobby refuses more than 4 vCPUs, and the useful ceiling is lower still: a
 * bigger machine finishes sooner but does not spend fewer CPU-seconds, so it
 * only buys wall-clock, which is the cheaper of the two constraints here.
 */
const DEFAULT_TIERS: ResourceTier[] = [
  { vcpus: 1, label: "small" },
  { vcpus: 2, label: "medium" },
  { vcpus: 4, label: "large" },
];

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): VercelRuntimeConfig {
  const maxTierVcpus = intEnv("VERCEL_SANDBOX_MAX_VCPUS", 4);
  const tiers = DEFAULT_TIERS.filter((tier) => tier.vcpus <= maxTierVcpus);
  if (tiers.length === 0) tiers.push({ vcpus: 1, label: "small" });

  return {
    namePrefix: strEnv("VERCEL_SANDBOX_NAME_PREFIX", "dai"),
    drivePrefix: strEnv("VERCEL_DRIVE_PREFIX", "dai-workspace"),
    image: strEnv("VERCEL_SANDBOX_IMAGE", "vercel/sandbox/node:22"),
    // Region must match the drive's region; pinning both to one value keeps a
    // project from being split across two.
    region: strEnv("VERCEL_SANDBOX_REGION", "iad1") as SandboxRegion,
    workspacePath: strEnv("VERCEL_WORKSPACE_PATH", "/workspace"),
    sessionTimeoutMs: intEnv("VERCEL_SANDBOX_SESSION_TIMEOUT_MS", 15 * 60_000),
    execTimeoutMs: intEnv("VERCEL_SANDBOX_EXEC_TIMEOUT_MS", 120_000),
    devServerReadyTimeoutMs: intEnv("VERCEL_DEV_SERVER_READY_TIMEOUT_MS", 60_000),
    previewPorts: parsePortList(env.VERCEL_PREVIEW_PORTS),
    tiers,
    cacheDriveName: strEnv("VERCEL_CACHE_DRIVE", ""),
    cachePath: strEnv("VERCEL_CACHE_PATH", "/dai-cache"),
    cacheEnv: {
      npm_config_cache: "/dai-cache/npm",
      YARN_CACHE_FOLDER: "/dai-cache/yarn",
      PNPM_HOME: "/dai-cache/pnpm",
      PIP_CACHE_DIR: "/dai-cache/pip",
      // Go's module and build caches, for projects that are not JavaScript.
      GOMODCACHE: "/dai-cache/go/pkg/mod",
      GOCACHE: "/dai-cache/go/build",
    },
    keepLastSnapshots: intEnv("VERCEL_SNAPSHOT_KEEP_LAST", 1),
    snapshotExpirationMs: intEnv("VERCEL_SNAPSHOT_EXPIRATION_MS", 7 * 24 * HOUR_MS),
    maxProjectWorkspaceBytes: intEnv("MAX_PROJECT_WORKSPACE_BYTES", 50 * GIB),
    r2: {
      accountId: strEnv("R2_ACCOUNT_ID", ""),
      bucket: strEnv("R2_BUCKET", ""),
      accessKeyId: strEnv("R2_ACCESS_KEY_ID", ""),
      secretAccessKey: strEnv("R2_SECRET_ACCESS_KEY", ""),
      rootPrefix: strEnv("R2_ROOT_PREFIX", "workspaces"),
    },
    budget: {
      // Hobby: 5 active CPU hours, 420 GB-hours provisioned memory,
      // 5,000 creations, 20 GB egress.
      activeCpuMs: intEnv("MONTHLY_ACTIVE_CPU_MS", 5 * HOUR_MS),
      provisionedGbHours: intEnv("MONTHLY_PROVISIONED_GB_HOURS", 420),
      creations: intEnv("MONTHLY_SANDBOX_CREATIONS", 5_000),
      egressBytes: intEnv("MONTHLY_EGRESS_BYTES", 20 * GIB),
      haltFraction: Number(env.QUOTA_HALT_FRACTION ?? 0.95),
      throttleFraction: Number(env.QUOTA_THROTTLE_FRACTION ?? 0.8),
      warnFraction: Number(env.QUOTA_WARN_FRACTION ?? 0.6),
    },
  };
}

/** Credentials the SDK needs. Read lazily so a dev machine without them still imports the module. */
export function isRuntimeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VERCEL_TOKEN || (env.VERCEL_OIDC_TOKEN && env.VERCEL_PROJECT_ID));
}

/** R2 is optional at boot: a project can run with no mirror, it just cannot be read cold. */
export function isMirrorConfigured(config: VercelRuntimeConfig): boolean {
  const { accountId, bucket, accessKeyId, secretAccessKey } = config.r2;
  return Boolean(accountId && bucket && accessKeyId && secretAccessKey);
}

/** Deterministic sandbox name for a project: the resume key, so it must never vary. */
export function sandboxName(config: VercelRuntimeConfig, projectId: string): string {
  return `${config.namePrefix}-${projectId}`;
}

/** Deterministic drive name for a project. */
export function driveName(config: VercelRuntimeConfig, projectId: string): string {
  return `${config.drivePrefix}-${projectId}`;
}
