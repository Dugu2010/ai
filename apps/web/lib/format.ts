/**
 * Presentation helpers for values that arrive from the API as ISO strings,
 * durations or provider ids. Nothing here invents data: every function is a
 * total mapping from a fact we were given to a string we are allowed to show.
 */

/**
 * Provider model ids are never shown raw. Unknown ids degrade to their last
 * path segment, title-cased, rather than leaking `vendor/model-slug`.
 */
const MODEL_LABELS: Record<string, string> = {
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "qwen/qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder 32B",
  "meta/llama-3.3-70b": "Llama 3.3 70B",
  "meta/llama-3.1-405b-instruct": "Llama 3.1 405B",
  "nvidia/llama-3.1-nemotron-70b-instruct": "Nemotron 70B",
};

export function modelLabel(id?: string | null): string {
  if (!id) return "Model";
  const known = MODEL_LABELS[id.toLowerCase()];
  if (known) return known;
  const tail = id.split("/").pop() ?? id;
  return tail
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => (/^[0-9]/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const diff = Date.now() - at;
  if (diff < 45_000) return "Just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Wall-clock time of day, for places where an absolute stamp matters. */
export function clockTime(iso?: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(iso?: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "820ms" / "4.2s" — used for per-event durations reported by the backend. */
export function formatDuration(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** Elapsed run time, always derived from a server-provided start timestamp. */
export function formatElapsed(startIso?: string | null, endIso?: string | null, now?: number): string {
  if (!startIso) return "";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "";
  const explicitEnd = endIso ? Date.parse(endIso) : Number.NaN;
  const end = Number.isNaN(explicitEnd) ? (now ?? Date.now()) : explicitEnd;
  const ms = Math.max(0, end - start);
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function formatBytes(size?: number | null): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Collapse an over-long sentence into something that fits one timeline row. */
export function oneLine(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
