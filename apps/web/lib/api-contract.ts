/**
 * Wire shapes the browser reads from the Render API.
 *
 * Shared domain types come from `@dai/types`; this file only describes the
 * transport envelopes around them (status payloads, list results) so no type is
 * ever defined twice.
 */

import type { FileKind, Project } from "@dai/types";
import { fetchApi } from "./api-client";
import { readString } from "./sse";

/** One entry from `GET /api/workspace/:id?path=`. */
export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number | null;
}

/**
 * `GET /api/workspace/:id/status`. `state` is provider-neutral: the runtime
 * reports a stopped Sandbox as `hibernated`, so the UI never names a provider.
 */
export interface WorkspaceStatus {
  state: string;
  sandboxId: string | null;
  runtimeProvider: string | null;
  previewUrl: string | null;
  devServerRunning: boolean;
  devServerPort: number | null;
  lastError: string | null;
  isHibernated: boolean;
  isArchived: boolean;
  bootupType: string | null;
  isUpToDate: boolean | null;
}

/** `POST /api/workspace/:id/preview`. */
export interface PreviewStartResult {
  url: string | null;
  port: number | null;
  reused: boolean;
  portUp: boolean;
  note: string | null;
}

/** `GET /api/projects/:id`. */
export type ProjectResponse = Partial<Project>;

/** Every project's files live under this path inside its workspace. */
export const WORKSPACE_ROOT = "/workspace";

/** Extract the `{error}` field of a failed response, with a fallback. */
export async function errorFromResponse(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  if (body && typeof body === "object") {
    const message = readString((body as Record<string, unknown>).error);
    if (message) return message;
  }
  return `${fallback} (${res.status})`;
}

/**
 * One place that turns a non-2xx response into a thrown Error carrying the
 * backend's own message, so panels never render "undefined" on failure.
 */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchApi(url, init);
  if (!res.ok) throw new Error(await errorFromResponse(res, "Request failed"));
  return (await res.json()) as T;
}

/** Guard a list endpoint that could answer with an error envelope. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

