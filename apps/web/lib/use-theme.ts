"use client";

/**
 * A React binding for the theme that already lives on `<html class>` (set before
 * paint by app/layout.tsx). `useSyncExternalStore` observes the attribute
 * instead of copying it into state in an effect, so toggling from any surface —
 * including another tab — is reflected without a render cascade, and the server
 * snapshot matches the pre-paint default (dark).
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getTheme, setTheme as applyTheme, type Theme } from "./theme";

const SERVER_SNAPSHOT: Theme = "dark";

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export interface ThemeController {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export function useTheme(): ThemeController {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  const set = useCallback((next: Theme) => applyTheme(next), []);
  const toggle = useCallback(() => {
    applyTheme(getTheme() === "light" ? "dark" : "light");
  }, []);
  return useMemo(
    () => ({ theme, isDark: theme !== "light", setTheme: set, toggle }),
    [theme, set, toggle]
  );
}
