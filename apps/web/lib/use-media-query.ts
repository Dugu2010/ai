"use client";

/**
 * Media queries that must drive behaviour rather than layout.
 *
 * Layout is expressed in CSS breakpoints; this hook exists for the places where
 * a Tailwind class cannot change behaviour: making the editor read-only below
 * `sm`, and choosing the mobile pane shell below `lg`. It is a store read, so the
 * server snapshot is `false` and the client subscribes after hydration.
 */

import { useCallback, useSyncExternalStore } from "react";

export const NARROW_QUERY = "(max-width: 639px)";
export const WIDE_QUERY = "(min-width: 1024px)";

function subscribeTo(query: string, onChange: () => void): () => void {
  const list = window.matchMedia(query);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => subscribeTo(query, onChange), [query]);
  const getSnapshot = useCallback(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
