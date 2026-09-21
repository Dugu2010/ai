"use client";

/**
 * Auth state as a store read.
 *
 * `localStorage` is external state, so it is subscribed to rather than peeked at
 * during render: the server snapshot is "signed out", the client snapshot is the
 * token the login flow wrote, and a token cleared in another tab propagates.
 */

import { useSyncExternalStore } from "react";
import { getToken } from "./api-client";

function subscribe(onChange: () => void): () => void {
  const onStorage = () => onChange();
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function getSnapshot(): boolean {
  return getToken() !== null;
}

const getServerSnapshot = (): boolean => false;

export function useAuthenticated(): boolean {
  // Module-level functions keep the store identity stable across renders.
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
