"use client";

/**
 * Header shared by the marketing surface, dashboard and settings — one
 * 64px bar, one logo, one place the theme control lives.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

export interface AppHeaderLink {
  label: string;
  href: string;
  external?: boolean;
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="flex items-center justify-center text-white"
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          background: "var(--accent-primary)",
          fontSize: size * 0.5,
          fontWeight: 590,
        }}
      >
        D
      </span>
      <span style={{ fontWeight: 590, fontSize: size * 0.64, letterSpacing: "-0.02em" }}>DAI</span>
    </span>
  );
}

export function AppHeader({
  links = [],
  right,
  title,
}: {
  links?: AppHeaderLink[];
  right?: ReactNode;
  title?: ReactNode;
}) {
  return (
    <header
      className="sticky top-0 z-40 border-b glass"
      style={{ borderColor: "var(--border-color)", height: "var(--header-h)" }}
    >
      <div className="h-full max-w-6xl mx-auto px-4 md:px-6 flex items-center gap-4">
        <Link href="/" aria-label="DAI home">
          <Wordmark />
        </Link>
        {title ? (
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            {title}
          </span>
        ) : null}
        {links.length > 0 ? (
          <nav aria-label="Primary" className="ml-auto hidden md:flex items-center gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="px-3 inline-flex items-center text-[13px] rounded-md transition-colors min-h-[44px] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                style={{ color: "var(--text-secondary)", fontWeight: 510 }}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        ) : (
          <div className="ml-auto" />
        )}
        <div className="flex items-center gap-1">
          {right}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
