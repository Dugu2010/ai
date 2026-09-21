"use client";

/**
 * Dashboard: the projects this account owns, and the one action that matters —
 * start a workspace. Real loading, empty and error states; no filler.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FolderPlus, Layers, TriangleAlert } from "lucide-react";
import type { Project, ProjectStatus } from "@dai/types";
import { requestJson, asArray } from "@/lib/api-contract";
import { isAuthenticated } from "@/lib/api-client";
import { useAuthenticated } from "@/lib/use-auth";
import { relativeTime } from "@/lib/format";
import { toneVar, type Tone } from "@/lib/agent-view";
import { AppHeader } from "@/components/app-header";
import { EmptyState, NoticeBar, PanelHeader, TextButton, ToneDot } from "@/components/panel";
import { Skeleton } from "@/components/loading-skeleton";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

const STATUS_VIEW: Record<ProjectStatus, { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "success" },
  provisioning: { label: "Provisioning", tone: "warning" },
  paused: { label: "Idle", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  archived: { label: "Archived", tone: "warning" },
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function ProjectCard({ project }: { project: Project }) {
  const view = STATUS_VIEW[project.status as ProjectStatus] ?? { label: project.status, tone: "neutral" as Tone };
  return (
    <Link
      href={`/app/projects/${project.id}`}
      className="group flex flex-col gap-2 p-4 rounded-lg border transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)]"
      style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] truncate" style={{ fontWeight: 590, letterSpacing: "-0.01em" }}>
          {project.name}
        </h3>
        <span className="badge shrink-0" style={{ color: toneVar(view.tone), background: `color-mix(in srgb, ${toneVar(view.tone)} 10%, transparent)` }}>
          <ToneDot tone={view.tone} />
          {view.label}
        </span>
      </div>
      <p className="font-mono text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
        {project.slug}
      </p>
      {project.description ? (
        <p className="text-[12px] leading-5 line-clamp-2" style={{ color: "var(--text-secondary)" }}>
          {project.description}
        </p>
      ) : null}
      <p className="mt-auto flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
        <span aria-hidden="true">·</span>
        {project.lastAccessedAt ? `Opened ${relativeTime(project.lastAccessedAt)}` : "Never opened"}
      </p>
    </Link>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const authed = useAuthenticated();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await requestJson<Project[]>("/api/projects");
      setProjects(asArray<Project>(rows));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load your projects");
    }
  }, []);

  useEffect(() => {
    if (!authed) {
      if (!isAuthenticated()) router.replace("/auth/login");
      return;
    }
    void (async () => {
      await load();
    })();
  }, [authed, load, router]);

  const slugError = slug && !SLUG_RE.test(slug) ? "3–50 characters: lowercase letters, numbers and hyphens, starting and ending with a letter or number." : null;

  const canSubmit = useMemo(() => name.trim().length > 0 && SLUG_RE.test(slug) && !creating, [name, slug, creating]);

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await requestJson<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: name.trim() }),
      });
      router.push(`/app/projects/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create the project");
      setCreating(false);
      await load();
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ background: "var(--bg-canvas)" }}>
      <AppHeader
        title="Projects"
        links={[{ label: "Settings", href: "/settings" }]}
      />

      <main id="main-content" className="flex-1">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-8 md:py-12 space-y-8">
          <section
            className="rounded-lg border overflow-hidden"
            style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
          >
            <PanelHeader title="New workspace" />
            <form
              className="p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="grid md:grid-cols-[1fr_1fr_auto] gap-3">
                <div>
                  <label htmlFor="project-name" className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
                    Name
                  </label>
                  <input
                    id="project-name"
                    type="text"
                    value={name}
                    maxLength={80}
                    autoComplete="off"
                    placeholder="Docs site"
                    onChange={(event) => {
                      setName(event.target.value);
                      if (!slugTouched) setSlug(slugify(event.target.value));
                    }}
                    className="input h-11 min-h-[44px] text-[14px]"
                  />
                </div>
                <div>
                  <label htmlFor="project-slug" className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
                    Address
                  </label>
                  <input
                    id="project-slug"
                    type="text"
                    value={slug}
                    maxLength={50}
                    autoComplete="off"
                    placeholder="docs-site"
                    aria-invalid={slugError ? true : undefined}
                    aria-describedby={slugError ? "project-slug-help" : undefined}
                    onChange={(event) => {
                      setSlugTouched(true);
                      setSlug(event.target.value.toLowerCase());
                    }}
                    className="input h-11 min-h-[44px] font-mono text-[13px]"
                  />
                </div>
                <div className="flex items-end">
                  <button type="submit" disabled={!canSubmit} className="btn btn-primary w-full md:w-auto px-5">
                    <FolderPlus size={15} aria-hidden="true" />
                    {creating ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>
              <div id="project-slug-help" className="mt-2 space-y-1">
                {slugError ? (
                  <p className="text-[11px]" style={{ color: "var(--danger)" }}>
                    {slugError}
                  </p>
                ) : null}
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  A workspace is a persistent project directory with its own dev server and preview URL. Provisioning takes a
                  moment; DAI starts working as soon as it is ready.
                </p>
              </div>
              {createError ? (
                <div className="mt-3">
                  <NoticeBar tone="danger" message={createError} />
                </div>
              ) : null}
            </form>
          </section>

          <section aria-labelledby="projects-heading" className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="projects-heading" className="text-[13px] uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)", fontWeight: 510 }}>
                Your workspaces
              </h2>
              {projects && projects.length > 0 ? (
                <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {projects.length}
                </span>
              ) : null}
            </div>

            {error ? (
              <NoticeBar
                tone="danger"
                message={error}
                action={<TextButton variant="ghost" onClick={() => void load()} className="text-[12px]">Retry</TextButton>}
              />
            ) : null}

            {!projects && !error ? (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="rounded-lg border p-4 space-y-2" style={{ borderColor: "var(--border-color)" }}>
                    <Skeleton style={{ height: 16, width: "60%" }} />
                    <Skeleton style={{ height: 10, width: "40%" }} />
                    <Skeleton style={{ height: 10, width: "80%" }} />
                  </div>
                ))}
              </div>
            ) : projects && projects.length === 0 ? (
              <div className="rounded-lg border" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
                <EmptyState
                  icon={<Layers size={18} strokeWidth={1.75} />}
                  title="No workspaces yet"
                  hint="Create one above. DAI gives it a real project directory, then reads, edits and tests inside it."
                />
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {projects?.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            )}
          </section>

          <p className="flex items-start gap-2 text-[11px] leading-5 max-w-[70ch]" style={{ color: "var(--text-muted)" }}>
            <TriangleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            Workspaces idle without compute after a while. The files stay; the next run reattaches what is needed.
          </p>
        </div>
      </main>
    </div>
  );
}
