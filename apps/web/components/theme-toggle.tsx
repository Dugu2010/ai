"use client";

/**
 * The theme control. State comes from the `<html class>` attribute through
 * `useTheme`, so every instance on screen agrees and no value is copied into
 * local state in an effect.
 */

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/use-theme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme !== "light";
  return (
    <button
      type="button"
      onClick={toggle}
      className="btn btn-ghost min-h-[44px] min-w-[44px] w-11 px-0"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  );
}
