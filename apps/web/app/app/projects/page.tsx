"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAuthenticated, fetchApi } from "@/lib/api-client";
import { useToast } from "@/components/toast";
import { ThemeToggle } from "@/components/theme-toggle";

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  previewUrl?: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

function useAuthRedirect() {
  const router = useRouter();
  useEffect(() => {
    if (!isAuthenticated()) router.replace("/auth/login");
  }, [router]);
}

function statusStyle(status: string): { bg: string; fg: string } {
  if (status === "ready") return { bg: "color-mix(in srgb, var(--success) 14%, transparent)", fg: "var(--success)" };
  if (status === "provisioning" || status === "queued") return { bg: "color-mix(in srgb, var(--warning) 14%, transparent)", fg: "var(--warning)" };
  if (status === "error") return { bg: "color-mix(in srgb, var(--danger) 14%, transparent)", fg: "var(--danger)" };
  return { bg: "var(--bg-tertiary)", fg: "var(--text-muted)" };
}

export default function ProjectsPage() {
  useAuthRedirect();
  const router = useRouter();
  const { showToast } = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi("/api/projects");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || `Failed to load projects (${res.status})`);
      }
      const data = await res.json();
      setProjects(Array.isArray(data) ? (data as Project[]) : []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Auto-derive the slug from the name until the user edits it manually.
  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) {
      setSlug(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50)
      );
    }
  };

  const createProject = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim() || !SLUG_RE.test(slug) || creating) return;
      setCreating(true);
      try {
        const res = await fetchApi("/api/projects", {
          method: "POST",
          body: JSON.stringify({ slug, name: name.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as any).error || `Failed to create project (${res.status})`);
        showToast("Project created", "success");
        setName("");
        setSlug("");
        setSlugTouched(false);
        if ((data as any).id) {
          // The new VM provisions in the background; the project view polls status.
          router.push(`/app/projects/${(data as any).id}`);
        } else {
          await fetchProjects();
        }
      } catch (err: any) {
        showToast(err.message || "Failed to create project", "error");
      } finally {
        setCreating(false);
      }
    },
    [name, slug, creating, fetchProjects, showToast, router]
  );

  const slugError = slug && !SLUG_RE.test(slug)
    ? "3–50 chars: lowercase letters, numbers, hyphens; must start/end with a letter or number"
    : undefined;

  return (
    <div className="min-h-screen bg-primary text-primary flex flex-col">
      <header className="glass sticky top-0 z-40 border-b" style={{ height: "var(--header-h)" }}>
        <div className="max-w-6xl mx-auto px-4 md:px-6 h-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              aria-label="DAI home"
              className="w-8 h-8 rounded-md flex items-center justify-center text-white"
              style={{ background: "var(--accent-primary)" }}
            >
              <span className="font-semibold text-sm">D</span>
            </Link>
            <span style={{ fontWeight: 590 }}>Projects</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/settings" className="btn btn-ghost" style={{ color: "var(--text-muted)" }}>
              Settings
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main id="main-content" className="flex-1">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-8 md:py-12">
          {/* Create project */}
          <section className="card mb-8">
            <h1 className="text-xl mb-4" style={{ fontWeight: 590 }}>New project</h1>
            <form onSubmit={createProject} className="flex flex-col md:flex-row gap-3">
              <div className="flex-1">
                <label htmlFor="project-name" className="sr-only">Project name</label>
                <input
                  id="project-name"
                  type="text"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="My app"
                  className="input"
                  maxLength={80}
                />
              </div>
              <div className="flex-1">
                <label htmlFor="project-slug" className="sr-only">Project slug</label>
                <input
                  id="project-slug"
                  type="text"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  placeholder="my-app"
                  className="input font-mono"
                  maxLength={50}
                  aria-invalid={slugError ? "true" : undefined}
                  aria-describedby={slugError ? "slug-error" : undefined}
                />
              </div>
              <button
                type="submit"
                disabled={creating || !name.trim() || !SLUG_RE.test(slug)}
                className="btn btn-primary md:w-auto"
              >
                {creating ? "Creating…" : "Create project"}
              </button>
            </form>
            {slugError && (
              <p id="slug-error" role="alert" className="text-xs mt-2" style={{ color: "var(--danger)" }}>
                {slugError}
              </p>
            )}
            <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
              Each project gets a real Linux VM with your dev server on an HTTPS preview URL.
            </p>
          </section>

          {/* Error / loading / list */}
          {error && (
            <div
              className="p-3 mb-6 flex justify-between items-center rounded-lg border"
              style={{
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                borderColor: "color-mix(in srgb, var(--danger) 35%, transparent)",
              }}
            >
              <span style={{ color: "var(--danger)" }}>{error}</span>
              <button onClick={fetchProjects} className="btn btn-danger min-h-[44px] px-3">
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="skeleton h-36" />
              <div className="skeleton h-36" />
              <div className="skeleton h-36" />
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-16">
              <p style={{ color: "var(--text-muted)" }}>No projects yet — create your first one above.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((p) => {
                const s = statusStyle(p.status);
                return (
                  <Link
                    key={p.id}
                    href={`/app/projects/${p.id}`}
                    className="card flex flex-col gap-2 transition-colors"
                    style={{ boxShadow: "var(--shadow-ring)" }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate" style={{ fontWeight: 590 }}>{p.name}</span>
                      <span className="badge flex-shrink-0" style={{ background: s.bg, color: s.fg }}>
                        {p.status}
                      </span>
                    </div>
                    <span className="font-mono text-xs truncate" style={{ color: "var(--text-muted)" }}>
                      {p.slug}
                    </span>
                    <span className="text-sm mt-1" style={{ color: "var(--accent-primary)" }}>
                      Open project →
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
