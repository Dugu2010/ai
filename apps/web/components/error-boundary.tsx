"use client";

import { Component, ReactNode } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-primary text-primary flex items-center justify-center p-4">
          <div className="max-w-md w-full text-center card">
            <div
              className="w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)" }}
            >
              <svg className="w-7 h-7" style={{ color: "var(--danger)" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3l9.5 16.5H2.5L12 3z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
            <p className="text-muted mb-6">{this.state.error?.message || "An unexpected error occurred"}</p>
            <button onClick={() => window.location.reload()} className="btn-primary w-full">
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
