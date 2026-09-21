"use client";

/**
 * Settings.
 *
 * Account identity, the model the agent calls, the endpoint it calls and the
 * provider key stored against the account. Saving is explicit: nothing is
 * written on load, and the key field only sends a value when you typed one.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, LogOut } from "lucide-react";
import { isAuthenticated, logout } from "@/lib/api-client";
import { asArray, requestJson } from "@/lib/api-contract";
import { useAuthenticated } from "@/lib/use-auth";
import { useTheme } from "@/lib/use-theme";
import { modelLabel } from "@/lib/format";
import { AppHeader } from "@/components/app-header";
import { EmptyState, NoticeBar, PanelHeader } from "@/components/panel";
import { Skeleton } from "@/components/loading-skeleton";
import { useToast } from "@/components/toast";

interface SettingsResponse {
  email?: string;
  userId?: string;
  model?: string;
  baseUrl?: string;
  apiKeySet?: boolean;
}

interface ModelsResponse {
  models?: string[];
  source?: string;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
      <PanelHeader title={title} />
      <div className="p-4 space-y-4">
        {description ? (
          <p className="text-[12px] leading-5" style={{ color: "var(--text-muted)" }}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

function ReadField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <p
        className="input h-11 min-h-[44px] flex items-center truncate select-text"
        style={{ color: "var(--text-muted)", background: "color-mix(in srgb, var(--text-primary) 2%, transparent)" }}
        title={value}
      >
        <span className={mono ? "font-mono text-[13px]" : "text-[13px]"}>{value || "—"}</span>
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const authed = useAuthenticated();
  const { theme, toggle } = useTheme();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (authed) return;
    if (!isAuthenticated()) router.replace("/auth/login");
  }, [authed, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJson<SettingsResponse>("/api/settings");
      setEmail(data.email ?? "");
      setUserId(data.userId ?? "");
      setModel(data.model ?? "");
      setBaseUrl(data.baseUrl ?? "");
      setApiKeySet(Boolean(data.apiKeySet));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to load settings");
    } finally {
      setLoading(false);
    }
    // The provider list is a convenience; the form works without it.
    try {
      const models = await requestJson<ModelsResponse>("/api/settings/models");
      setProviderModels(asArray<string>(models?.models));
    } catch {
      setProviderModels([]);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void (async () => {
      await load();
    })();
  }, [authed, load]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const payload: Record<string, string> = { model, baseUrl };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      await requestJson<{ success: boolean }>("/api/settings", { method: "POST", body: JSON.stringify(payload) });
      if (apiKey.trim()) {
        setApiKeySet(true);
        setApiKey("");
      }
      setSaved(true);
      showToast("Settings saved", "success");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    await logout();
    router.replace("/auth/login");
  };

  const canSave = !loading && !saving && model.trim().length > 0 && baseUrl.trim().length > 0;

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ background: "var(--bg-canvas)" }}>
      <AppHeader
        title="Settings"
        links={[{ label: "Projects", href: "/app/projects" }]}
        right={
          <Link href="/app/projects" className="btn btn-ghost hidden sm:inline-flex px-3" style={{ color: "var(--text-muted)" }}>
            <ArrowLeft size={14} aria-hidden="true" />
            Projects
          </Link>
        }
      />

      <main id="main-content" className="flex-1">
        <div className="max-w-[720px] mx-auto px-4 md:px-6 py-8 md:py-12 space-y-4">
          {loadError ? (
            <NoticeBar
              tone="danger"
              message={loadError}
              action={
                <button type="button" onClick={() => void load()} className="btn btn-ghost px-2 text-[12px]">
                  Retry
                </button>
              }
            />
          ) : null}

          {loading ? (
            <div className="space-y-4" aria-label="Loading settings">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-lg border p-4 space-y-3" style={{ borderColor: "var(--border-color)" }}>
                  <Skeleton style={{ height: 12, width: "22%" }} />
                  <Skeleton style={{ height: 44 }} />
                  <Skeleton style={{ height: 44, width: "70%" }} />
                </div>
              ))}
            </div>
          ) : (
            <>
              <Section title="Account" description="The account these workspaces belong to. Sign out to switch.">
                <div className="grid sm:grid-cols-2 gap-3">
                  <ReadField label="Email" value={email} />
                  <ReadField label="User id" value={userId} mono />
                </div>
                <button type="button" onClick={() => void signOut()} className="btn btn-danger self-start px-4">
                  <LogOut size={14} aria-hidden="true" />
                  Sign out
                </button>
              </Section>

              <Section title="Appearance" description="Dark is the default; light is the alternative palette.">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px]" style={{ color: "var(--text-secondary)", fontWeight: 510 }}>
                      {theme === "light" ? "Light" : "Dark"}
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      Applies to this browser and every page.
                    </p>
                  </div>
                  <button type="button" onClick={toggle} className="btn btn-secondary px-4">
                    Switch to {theme === "light" ? "dark" : "light"}
                  </button>
                </div>
              </Section>

              <Section
                title="Model"
                description="The model the agent uses for this account, and the OpenAI-compatible endpoint it is served from."
              >
                <div>
                  <label htmlFor="model" className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
                    Model id
                  </label>
                  <input
                    id="model"
                    list="provider-models"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="input h-11 min-h-[44px] font-mono text-[13px]"
                  />
                  <datalist id="provider-models">
                    {providerModels.map((entry) => (
                      <option key={entry} value={entry} />
                    ))}
                  </datalist>
                  <p className="text-[11px] mt-1.5" style={{ color: "var(--text-muted)" }}>
                    Shown in the workspace as “{modelLabel(model)}”.
                    {providerModels.length > 0 ? ` ${providerModels.length} models offered by the endpoint.` : ""}
                  </p>
                </div>
                <div>
                  <label htmlFor="baseUrl" className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
                    Base URL
                  </label>
                  <input
                    id="baseUrl"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="input h-11 min-h-[44px] font-mono text-[13px]"
                    placeholder="https://example.com/v1"
                  />
                </div>
              </Section>

              <Section
                title="Provider key"
                description="Encrypted at rest on the API and never sent back to the browser. Leave blank to keep the stored key."
              >
                <div>
                  <label htmlFor="apiKey" className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
                    API key
                  </label>
                  <input
                    id="apiKey"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="off"
                    placeholder={apiKeySet ? "Configured — paste a new key to replace it" : "Paste your provider key"}
                    className="input h-11 min-h-[44px] font-mono text-[13px]"
                  />
                  {apiKeySet && !apiKey ? (
                    <p className="text-[11px] mt-1.5" style={{ color: "var(--success)" }}>
                      A key is stored for this account.
                    </p>
                  ) : null}
                </div>
              </Section>

              <div className="rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center gap-3" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
                <div className="flex-1 min-w-0" aria-live="polite">
                  {saveError ? (
                    <p className="text-[12px]" style={{ color: "var(--danger)" }}>
                      {saveError}
                    </p>
                  ) : saved ? (
                    <p className="text-[12px]" style={{ color: "var(--success)" }}>
                      Saved.
                    </p>
                  ) : (
                    <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Changes apply to the next run.
                    </p>
                  )}
                </div>
                <button type="button" onClick={() => void save()} disabled={!canSave} className="btn btn-primary px-5">
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>

              {!email && !loadError ? (
                <EmptyState title="No settings returned" hint="The account may not be provisioned yet. Retry from the banner above." />
              ) : null}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
