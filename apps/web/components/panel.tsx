"use client";

/**
 * Shared workspace chrome. One header rhythm, one tone vocabulary, one 44px icon
 * button — so panels read as one product instead of five implementations.
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { toneVar, type Tone } from "@/lib/agent-view";

export function PanelHeader({
  title,
  meta,
  actions,
  className = "",
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 px-3 h-11 shrink-0 border-b ${className}`}
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-panel)" }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <h2
          className="text-[11px] font-medium uppercase tracking-[0.08em] truncate"
          style={{ color: "var(--text-muted)" }}
        >
          {title}
        </h2>
        {meta}
      </div>
      {actions ? <div className="flex items-center gap-1 shrink-0">{actions}</div> : null}
    </div>
  );
}

export function ToneDot({ tone, live = false, size = 6 }: { tone: Tone; live?: boolean; size?: number }) {
  const color = toneVar(tone);
  return (
    <span
      aria-hidden="true"
      className={`rounded-full shrink-0 ${live ? "animate-pulse-slow" : ""}`}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: live ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` : undefined,
      }}
    />
  );
}

export function IconButton({
  label,
  onClick,
  children,
  disabled = false,
  active = false,
  tone = "neutral",
  className = "",
  type = "button",
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
  tone?: Tone;
  className?: string;
  type?: "button" | "submit";
}) {
  const color = tone === "neutral" ? "var(--text-muted)" : toneVar(tone);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active ? true : undefined}
      className={`inline-flex items-center justify-center rounded-md transition-colors min-h-[44px] min-w-[44px] px-2 hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
      style={{ color: active ? "var(--text-primary)" : color }}
    >
      {children}
    </button>
  );
}

export function TextButton({
  children,
  onClick,
  disabled = false,
  variant = "secondary",
  title,
  className = "",
  busy = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  title?: string;
  className?: string;
  busy?: boolean;
}) {
  const map: Record<string, string> = {
    primary: "btn-primary",
    secondary: "btn-secondary",
    ghost: "btn-ghost",
    danger: "btn-danger",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy || undefined}
      className={`btn ${map[variant] ?? "btn-secondary"} min-h-[44px] h-11 px-3 text-[13px] ${className}`}
    >
      {children}
    </button>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ? (
        <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>
          {icon}
        </span>
      ) : null}
      <p className="text-[13px]" style={{ color: "var(--text-secondary)", fontWeight: 510 }}>
        {title}
      </p>
      {hint ? (
        <p className="text-xs leading-5 max-w-[36ch]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function NoticeBar({
  tone,
  message,
  onDismiss,
  action,
}: {
  tone: Tone;
  message: string;
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  const color = toneVar(tone);
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className="flex items-start gap-2 px-3 py-2 rounded-md border text-[13px] leading-5"
      style={{
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
        color: "var(--text-secondary)",
      }}
    >
      <span aria-hidden="true" className="mt-1.5">
        <ToneDot tone={tone} />
      </span>
      <span className="flex-1 min-w-0" style={{ color }}>
        {message}
      </span>
      {action}
      {onDismiss ? (
        <IconButton label="Dismiss message" onClick={onDismiss} className="-mr-1">
          <X size={16} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}

export function Stat({ label, value, tone = "neutral" }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <span className="text-[13px] truncate" style={{ color: toneVar(tone), fontWeight: 510 }}>
        {value}
      </span>
    </div>
  );
}

export function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="text-xs text-right min-w-0 break-words" style={{ color: "var(--text-secondary)" }}>
        {value}
      </dd>
    </div>
  );
}
