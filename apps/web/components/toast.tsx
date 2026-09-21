"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

/**
 * Module-level handle to the live toast API, wired by the provider on mount.
 * Lets non-React code (and components outside the provider tree) raise toasts
 * through the plain `showToast(...)` helper below.
 */
let toastApi: ToastContextType | null = null;

/** Fire a toast from anywhere — no hook rules involved. */
export function showToast(message: string, type: ToastType = "info", duration: number = 4000) {
  if (toastApi) {
    toastApi.showToast(message, type, duration);
    return;
  }
  // No provider mounted yet — surface in console so it's never silently lost.
  console.warn(`[toast:${type}]`, message);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timeout = timeoutsRef.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const clear = useCallback(() => {
    for (const timeout of timeoutsRef.current.values()) clearTimeout(timeout);
    timeoutsRef.current.clear();
    setToasts([]);
  }, []);

  const pushToast = useCallback(
    (message: string, type: ToastType = "info", duration: number = 4000) => {
      const id = Math.random().toString(36).slice(2, 15);
      setToasts((prev) => [...prev, { id, message, type, duration }]);
      timeoutsRef.current.set(
        id,
        setTimeout(() => dismiss(id), duration)
      );
    },
    [dismiss]
  );

  // Declared last on purpose: the exposure effect must not reference callbacks
  // that do not exist yet, and it has to re-run when any of them change.
  useEffect(() => {
    toastApi = { toasts, showToast: pushToast, dismiss, clear };
  }, [toasts, pushToast, dismiss, clear]);

  useEffect(
    () => () => {
      // Only unhook on real unmount; the entry above re-arms it every change.
      toastApi = null;
    },
    []
  );

  // A tab left open mid-flight must not leave timers holding the map alive.
  useEffect(() => {
    const pending = timeoutsRef.current;
    return () => {
      for (const timeout of pending.values()) clearTimeout(timeout);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, showToast: pushToast, dismiss, clear }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 space-y-2" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICON_PATHS: Record<ToastType, string[]> = {
  success: ["M5 13l4 4L19 7"],
  error: ["M6 18L18 6M6 6l12 12"],
  warning: [
    "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  ],
  info: ["M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"],
};

const TOAST_COLORS: Record<ToastType, React.CSSProperties> = {
  success: { background: "var(--success)", borderColor: "color-mix(in srgb, var(--success) 70%, transparent)" },
  error: { background: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 70%, transparent)" },
  warning: { background: "var(--warning)", borderColor: "color-mix(in srgb, var(--warning) 70%, transparent)" },
  info: { background: "var(--accent-primary)", borderColor: "var(--accent-primary)" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // The slide-in is a CSS animation keyed on first paint, so no render-phase
  // or effect-phase state is needed to make the toast appear.
  return (
    <div
      className="toast-enter flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg"
      style={TOAST_COLORS[toast.type]}
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        {ICON_PATHS[toast.type].map((d) => (
          <path key={d} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
        ))}
      </svg>
      <span className="text-sm text-white">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-2 w-11 h-11 -my-3 flex items-center justify-center hover:opacity-75"
        aria-label="Dismiss notification"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
