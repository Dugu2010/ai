"use client";

/**
 * Overlays for small screens: a left drawer (file explorer) and a full-screen
 * sheet (preview, runtime details). Both are focus-trapped and close on Escape
 * through the shared `useFocusTrap` hook, and both keep the trigger focused when
 * they close.
 */

import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { IconButton } from "./panel";

function Scrim({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="absolute inset-0"
      style={{ background: "rgba(0, 0, 0, 0.55)" }}
      onClick={onClose}
      aria-hidden="true"
    />
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <Scrim onClose={onClose} />
      <aside
        ref={ref}
        aria-label={title}
        className="absolute left-0 top-0 h-full w-[300px] max-w-[86vw] flex flex-col border-r animate-fade-in"
        style={{ background: "var(--bg-canvas)", borderColor: "var(--border-color)" }}
      >
        <div
          className="flex items-center justify-between px-3 h-12 shrink-0 border-b"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-panel)" }}
        >
          <h2 className="text-[13px]" style={{ fontWeight: 590 }}>
            {title}
          </h2>
          <IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </aside>
    </div>
  );
}

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <Scrim onClose={onClose} />
      <section
        ref={ref}
        aria-label={title}
        className="absolute inset-0 flex flex-col animate-fade-in"
        style={{ background: "var(--bg-canvas)" }}
      >
        <div
          className="flex items-center justify-between px-3 h-12 shrink-0 border-b"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-panel)" }}
        >
          <h2 className="text-[13px]" style={{ fontWeight: 590 }}>
            {title}
          </h2>
          <IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </section>
    </div>
  );
}
