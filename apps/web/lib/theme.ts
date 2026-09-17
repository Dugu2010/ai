export const THEME_STORAGE_KEY = "theme-preference";

export type Theme = "light" | "dark";

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

export function getTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return getSystemTheme();
}

export function setTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(theme);
}

export function initializeTheme(): void {
  if (typeof window === "undefined") return;
  const theme = getStoredTheme() || getSystemTheme();
  document.documentElement.classList.add(theme);
}

export function toggleTheme(): Theme {
  const current = getTheme();
  const next = current === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}
