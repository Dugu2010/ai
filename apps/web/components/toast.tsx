"use client";

import { useEffect, useState, createContext, useContext, useCallback, useRef } from "react";

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
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Expose the live API to the module-level `showToast` helper.
  useEffect(() => {
    toastApi = { toasts, showToast, dismiss, clear };
    return () => {
      toastApi = null;
    };
  });

  const showToast = useCallback(
    (message: string, type: ToastType = "info", duration: number = 4000) => {
      const id = Math.random().toString(36).substring(2, 15);
      const toast: Toast = { id, message, type, duration };

      setToasts((prev) => [...prev, toast]);

      const timeout = setTimeout(() => {
        dismiss(id);
      }, duration);

      timeoutsRef.current.set(id, timeout);
    },
    []
  );

  const dismiss = useCallback((id: string) => {
    const timeout = timeoutsRef.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clear = useCallback(() => {
    timeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
    timeoutsRef.current.clear();
    setToasts([]);
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismiss, clear }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setMounted(true);
    setTimeout(() => setVisible(true), 10);
  }, []);

  const colors = {
    success: "bg-emerald-600 border-emerald-500",
    error: "bg-red-600 border-red-500",
    warning: "bg-amber-600 border-amber-500",
    info: "bg-accent-primary border-accent-primary",
  };

  const icons = {
    success: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    warning: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    info: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg transition-all duration-300 ${colors[toast.type]} ${
        visible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-full"
      } ${mounted ? "" : "translate-x-full"}`}
    >
      {icons[toast.type]}
       <span className="text-primary text-sm">{toast.message}</span>
      <button
        onClick={onDismiss}
        className="ml-2 hover:opacity-75"
        aria-label="Dismiss"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
