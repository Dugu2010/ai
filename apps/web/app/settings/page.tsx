"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated, logout, fetchApi } from "../../lib/api-client";
import { getTheme, toggleTheme, THEME_STORAGE_KEY } from "../../lib/theme";

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
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  // Settings state
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isApiKeySet, setIsApiKeySet] = useState(false);

  // Debounced values for auto-save
  const debouncedBaseUrl = useDebounce(baseUrl, 500);
  const debouncedModelName = useDebounce(modelName, 500);
  const debouncedApiKey = useDebounce(apiKey, 500);

  // Auth redirect and settings fetch
  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkAuth = async () => {
      const auth = isAuthenticated();
      if (!auth) {
        router.push("/auth/login");
        return;
      }
      try {
        const res = await fetchApi("/api/settings");
        if (!res.ok) {
          throw new Error("Failed to fetch settings");
        }
        const data = await res.json();
        setEmail(data.email || "");
        setUserId(data.userId || "");
        setBaseUrl(data.baseUrl || "");
        setModelName(data.model || "");
        setIsApiKeySet(!!data.apiKeySet);
        setBaseUrl(data.baseUrl || "");
        setModelName(data.model || "");
        setIsApiKeySet(!!data.apiKeySet);
      } catch (err: any) {
        setError(err.message || "Failed to load settings");
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [router]);

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  // Auto-save on debounce changes
  useEffect(() => {
    if (typeof window === "undefined" || loading) return;
    if (!saving && !success) {
      handleSave();
    }
  }, [debouncedBaseUrl, debouncedModelName, debouncedApiKey]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const payload: any = {
        baseUrl: debouncedBaseUrl,
        model: debouncedModelName,
      };
      if (debouncedApiKey) {
        payload.apiKey = debouncedApiKey;
      }
      const res = await fetchApi("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save settings");
      }
      setSuccess("Settings saved successfully");
      setTimeout(() => {
        setSuccess("");
        setSaving(false);
      }, 2000);
    } catch (err: any) {
      setError(err.message || "Failed to save settings");
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      router.push("/auth/login");
    } catch {
      router.push("/auth/login");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-primary text-primary flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-primary text-primary">
      <header className="border-b border-[color:var(--border-color)] bg-primary/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <button
                 onClick={() => router.back()}
                className="text-text-secondary hover:text-primary"
                aria-label="Go back"
              >
                ←
              </button>
              <h1 className="text-2xl font-bold">Settings</h1>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
                className="p-2 rounded-lg border border-gray-700 hover:bg-gray-800 transition-colors"
                title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
              >
                {theme === "light" ? (
                  <span aria-hidden="true">🌙</span>
                ) : (
                  <span aria-hidden="true">☀️</span>
                )}
              </button>
            </div>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden text-text-secondary"
              aria-label="Toggle menu"
            >
              ☰
            </button>
          </div>
          {mobileMenuOpen && (
            <div className="md:hidden mt-4 flex flex-col gap-2">
              <button
                onClick={() => { router.back(); setMobileMenuOpen(false); }}
                className="px-4 py-2 bg-gray-800 rounded text-left"
              >
                ← Back
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Profile Section */}
        <section className="bg-secondary rounded-lg border border-[color:var(--border-color)] p-4 md:p-6">
          <h2 className="text-lg md:text-xl font-semibold mb-4">Profile</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-secondary text-sm mb-1">Email</label>
              <input
                type="email"
                value={email}
                disabled
                className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg text-muted"
              />
            </div>
            <div>
              <label className="block text-secondary text-sm mb-1">User ID</label>
              <input
                type="text"
                value={userId}
                disabled
                className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg text-muted"
              />
            </div>
          </div>
        </section>

        {/* NIM Configuration Section */}
        <section className="bg-secondary rounded-lg border border-[color:var(--border-color)] p-4 md:p-6">
          <h2 className="text-lg md:text-xl font-semibold mb-4">NIM Configuration</h2>
          <div className="space-y-6">
            <div>
              <label className="block text-secondary text-sm font-medium mb-2">
                Model Selection
              </label>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="e.g., meta/llama-3.1-405b-instruct"
                className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg focus:outline-none focus:border-[color:var(--accent-primary)]"
              />
              <p className="text-muted text-sm mt-1">
                Enter the NVIDIA NIM model name. Pre-populated from server if available.
              </p>
            </div>
            <div>
              <label className="block text-secondary text-sm font-medium mb-2">
                Base URL
              </label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://integrate.api.nvidia.com/v1"
                className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg focus:outline-none focus:border-[color:var(--accent-primary)]"
              />
              <p className="text-muted text-sm mt-1">
                Custom base URL for NVIDIA NIM endpoint.
              </p>
            </div>
          </div>
        </section>

        {/* API Key Section */}
        <section className="bg-secondary rounded-lg border border-[color:var(--border-color)] p-4 md:p-6">
          <h2 className="text-lg md:text-xl font-semibold mb-4">API Key</h2>
          <p className="text-secondary mb-4 text-sm">
            Your NVIDIA NIM API key is encrypted and stored securely on the server. It is never exposed to the browser in decrypted form.
          </p>
          <div className="mb-4">
            <label className="block text-secondary text-sm font-medium mb-2">
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isApiKeySet ? "••••••••••••••••" : "Enter your NVIDIA NIM API key"}
              className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg focus:outline-none focus:border-[color:var(--accent-primary)]"
            />
            <p className="text-muted text-sm mt-2">
              {isApiKeySet ? (
                <span className="text-green-400">✓ API key is configured</span>
              ) : (
                "Leave blank to keep current key"
              )}
            </p>
          </div>
        </section>

        {/* Session Section */}
        <section className="bg-secondary rounded-lg border border-[color:var(--border-color)] p-4 md:p-6">
          <h2 className="text-lg md:text-xl font-semibold mb-4">Session</h2>
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-red-600 rounded-lg hover:bg-red-700 text-primary text-sm font-medium"
          >
            Logout
          </button>
        </section>

        {/* Feedback Messages */}
        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/50 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}
        {success && !error && (
          <div className="p-4 bg-green-500/10 border border-green-500/50 rounded-lg text-green-400 text-sm">
            {success}
          </div>
        )}
        {saving && !success && (
          <div className="p-4 bg-yellow-500/10 border border-yellow-500/50 rounded-lg text-yellow-400 text-sm">
            Saving settings...
          </div>
        )}
      </main>
    </div>
  );
}
