"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated, logout, fetchApi } from "../../lib/api-client";
import { getTheme, toggleTheme, type Theme } from "../../lib/theme";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");

  // Settings state
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isApiKeySet, setIsApiKeySet] = useState(false);

  // Debounced values for auto-save
  const debouncedBaseUrl = useDebounce(baseUrl, 700);
  const debouncedModelName = useDebounce(modelName, 700);
  const debouncedApiKey = useDebounce(apiKey, 700);
  const loadedRef = useRef(false);
  const skipSaveRef = useRef(true); // don't auto-save the values we just loaded

  // Auth redirect + settings fetch
  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/auth/login");
      return;
    }
    (async () => {
      try {
        const res = await fetchApi("/api/settings");
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to fetch settings");
        const data = await res.json();
        setEmail(data.email || "");
        setUserId(data.userId || "");
        setBaseUrl(data.baseUrl || "");
        setModelName(data.model || "");
        setIsApiKeySet(!!data.apiKeySet);
      } catch (err: any) {
        setError(err.message || "Failed to load settings");
      } finally {
        setLoading(false);
        // Allow auto-save only after the first paint of loaded values
        setTimeout(() => (skipSaveRef.current = false), 300);
      }
    })();
  }, [router]);

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  // Auto-save when debounced values settle (after initial load)
  const handleSave = useCallback(async (payloadOverride?: { baseUrl?: string; model?: string; apiKey?: string }) => {
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, string> = {
        baseUrl: payloadOverride?.baseUrl ?? debouncedBaseUrl,
        model: payloadOverride?.model ?? debouncedModelName,
      };
      const key = payloadOverride?.apiKey ?? debouncedApiKey;
      if (key) payload.apiKey = key;
      const res = await fetchApi("/api/settings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save settings");
      }
      if (key) {
        setIsApiKeySet(true);
        setApiKey("");
      }
      setSuccess("Settings saved");
      setTimeout(() => setSuccess(""), 2000);
    } catch (err: any) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }, [debouncedBaseUrl, debouncedModelName, debouncedApiKey]);

  useEffect(() => {
    if (loading || skipSaveRef.current) return;
    handleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedBaseUrl, debouncedModelName, debouncedApiKey]);

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      router.push("/auth/login");
    }
  };

  const handleToggleTheme = () => {
    const next = toggleTheme();
    setTheme(next);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-primary text-primary flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-primary mx-auto mb-4" />
          <p className="text-muted">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-primary text-primary">
      <header className="border-b glass sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <button onClick={() => router.push("/")} className="btn-ghost" aria-label="Go back">
                ←
              </button>
              <h1 className="text-2xl font-bold">Settings</h1>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleToggleTheme}
                aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
                className="btn-ghost"
                title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
              >
                {theme === "light" ? <span aria-hidden="true">🌙</span> : <span aria-hidden="true">☀️</span>}
              </button>
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden btn-ghost"
                aria-label="Toggle menu"
              >
                ☰
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Profile */}
        <section className="card animate-fade-in-up">
          <h2 className="text-lg font-semibold mb-4">Profile</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-secondary text-sm mb-1">Email</label>
              <input type="email" value={email} disabled readOnly className="input opacity-70" />
            </div>
            <div>
              <label className="block text-secondary text-sm mb-1">User ID</label>
              <input type="text" value={userId} disabled readOnly className="input opacity-70 font-mono text-xs" />
            </div>
          </div>
        </section>

        {/* NIM Configuration */}
        <section className="card animate-fade-in-up" style={{ animationDelay: "60ms" }}>
          <h2 className="text-lg font-semibold mb-4">NIM Configuration</h2>
          <div className="space-y-5">
            <div>
              <label htmlFor="model" className="block text-secondary text-sm font-medium mb-2">Model</label>
              <input
                id="model"
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="e.g., meta/llama-3.1-405b-instruct"
                className="input"
              />
              <p className="text-muted text-sm mt-1">NVIDIA NIM model used by the agent for this account.</p>
            </div>
            <div>
              <label htmlFor="baseUrl" className="block text-secondary text-sm font-medium mb-2">Base URL</label>
              <input
                id="baseUrl"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://integrate.api.nvidia.com/v1"
                className="input"
              />
              <p className="text-muted text-sm mt-1">OpenAI-compatible endpoint for NIM.</p>
            </div>
          </div>
        </section>

        {/* API Key */}
        <section className="card animate-fade-in-up" style={{ animationDelay: "120ms" }}>
          <h2 className="text-lg font-semibold mb-4">API Key</h2>
          <p className="text-secondary mb-4 text-sm">
            Your NVIDIA NIM API key is encrypted (AES-256-GCM) and stored on the server.
            It is never sent back to the browser.
          </p>
          <label htmlFor="apiKey" className="block text-secondary text-sm font-medium mb-2">API Key</label>
          <div className="flex gap-2">
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isApiKeySet ? "•••••••••••••••• (configured)" : "Enter your NVIDIA NIM API key"}
              className="input"
              autoComplete="off"
            />
            <button onClick={() => handleSave()} disabled={saving} className="btn-primary whitespace-nowrap">
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
          <p className="text-muted text-sm mt-2">
            {isApiKeySet ? (
              <span className="text-emerald-500">✓ API key is configured</span>
            ) : (
              "Paste your key and press Save"
            )}
          </p>
        </section>

        {/* Session */}
        <section className="card animate-fade-in-up" style={{ animationDelay: "180ms" }}>
          <h2 className="text-lg font-semibold mb-4">Session</h2>
          <button onClick={handleLogout} className="btn-danger">Logout</button>
        </section>

        {/* Feedback */}
        <div aria-live="polite">
          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/40 rounded-lg text-red-500 text-sm animate-fade-in">
              {error}
            </div>
          )}
          {success && !error && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-emerald-500 text-sm animate-fade-in">
              ✓ {success}
            </div>
          )}
          {saving && !success && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/40 rounded-lg text-amber-600 dark:text-amber-400 text-sm animate-fade-in">
              Saving…
            </div>
          )}
        </div>

        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 md:hidden" onClick={() => setMobileMenuOpen(false)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="absolute right-0 top-0 h-full w-64 bg-primary border-l p-4">
              <button onClick={handleLogout} className="btn-danger w-full">Logout</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
