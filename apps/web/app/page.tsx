"use client";

/**
 * Landing page.
 *
 * Only describes behaviour the product actually has: the activity stream is the
 * backend's own sentences, checkpoints really revert files, budgets really stop
 * runs. No invented metrics, no dead links, no install command that does not
 * exist.
 */

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheck, Eye, Gauge, History, SquareTerminal, Sparkles } from "lucide-react";
import { useAuthenticated } from "@/lib/use-auth";
import { AppHeader, Wordmark } from "@/components/app-header";

const CAPABILITIES = [
  {
    icon: Sparkles,
    title: "It works in a real project directory",
    body: "DAI reads the repository, edits files and runs the project's own test and build commands. You never open a terminal.",
  },
  {
    icon: CircleCheck,
    title: "Every step is on the record",
    body: "The activity timeline is written by the agent loop: files read, files changed, commands run, test results, errors and retries.",
  },
  {
    icon: History,
    title: "Undo is a feature, not a promise",
    body: "Each run that changes files creates a checkpoint. Revert the run — or re-apply it — from the Changes panel, and see which files were restored.",
  },
  {
    icon: Gauge,
    title: "Cost limits are visible",
    body: "Activations, commands, runtime seconds and iterations are shown against the limits set by the backend, so a run stopped for cost reads as cost.",
  },
  {
    icon: Eye,
    title: "A preview you can click",
    body: "The dev server runs in the workspace and is shown in the app on its own HTTPS URL while the agent works.",
  },
  {
    icon: SquareTerminal,
    title: "Nothing to install",
    body: "Browser in, work out. The agent talks to one API, and your files live in the workspace, not in a laptop folder.",
  },
];

/** Sentences the backend really writes, used as the product illustration. */
const TIMELINE_SAMPLE = [
  { state: "reading", title: "Reading 8 relevant files", meta: "src/utils.ts · src/utils.test.ts · 8 files" },
  { state: "editing", title: "Edited 2 files", meta: "src/utils.ts · src/utils.test.ts" },
  { state: "testing", title: "Tests failed: 2 failures", meta: "vitest run · exit 1 · 4.2s" },
  { state: "diagnosing", title: "Diagnosing the failure", meta: "exit 1" },
  { state: "fixing", title: "Edited 1 file", meta: "src/utils.ts" },
  { state: "testing", title: "Tests passed", meta: "vitest run · 1.2s" },
  { state: "previewing", title: "Preview ready", meta: "localhost tunnel · port 3000" },
  { state: "completed", title: "Task complete", meta: "undo available" },
];

const STEPS = [
  { label: "Ask", body: "Describe the change in plain language. One prompt starts one run." },
  { label: "Watch", body: "Follow the timeline. Errors and retries are shown, not hidden." },
  { label: "Decide", body: "Keep it, continue a paused run, retry a different way, or undo the change." },
];

export default function LandingPage() {
  const router = useRouter();
  const authed = useAuthenticated();

  useEffect(() => {
    if (authed) router.replace("/app/projects");
  }, [authed, router]);

  const signInHref = authed ? "/app/projects" : "/auth/login";

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ background: "var(--bg-canvas)", color: "var(--text-primary)" }}>
      <AppHeader
        links={[
          { label: "How it works", href: "#how-it-works" },
          { label: "Capabilities", href: "#capabilities" },
        ]}
        right={
          <Link href={signInHref} className="btn btn-primary hidden sm:inline-flex px-4">
            Open workspace
          </Link>
        }
      />

      <main id="main-content" className="flex-1">
        <section className="hero-mesh">
          <div className="max-w-6xl mx-auto px-4 md:px-6 pt-16 md:pt-24 pb-12 md:pb-16 animate-fade-in-up">
            <p
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] mb-6"
              style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-pulse-slow" style={{ background: "var(--accent-primary)" }} aria-hidden="true" />
              Browser-based coding agent
            </p>
            <h1
              className="text-[34px] sm:text-5xl md:text-[56px] leading-[1.06] max-w-[18ch]"
              style={{ fontWeight: 510, letterSpacing: "-0.04em" }}
            >
              An agent that writes code, and shows its work.
            </h1>
            <p className="mt-5 max-w-[62ch] text-[15px] md:text-[17px] leading-7" style={{ color: "var(--text-secondary)" }}>
              DAI reads your project, edits files, runs the tests and keeps a live timeline of what it did. When a change is
              wrong, you revert that run — with the files it touched listed, not guessed.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Link href={signInHref} className="btn btn-primary px-6 w-full sm:w-auto">
                Start a workspace
              </Link>
              <a href="#how-it-works" className="btn btn-secondary px-6 w-full sm:w-auto">
                See what a run looks like
              </a>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="max-w-6xl mx-auto px-4 md:px-6 py-12 md:py-20">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-8 lg:gap-14 items-start">
            <div>
              <h2 className="text-[22px] md:text-[28px]" style={{ fontWeight: 510, letterSpacing: "-0.03em" }}>
                One run, start to finish
              </h2>
              <p className="mt-3 text-[15px] leading-7 max-w-[60ch]" style={{ color: "var(--text-secondary)" }}>
                The timeline is emitted by the agent loop at real transitions — an acquired workspace, a completed command, a
                parsed test summary. It is not animated filler, and it never prints the model’s raw tool calls into your chat.
              </p>
              <ol className="mt-8 space-y-5">
                {STEPS.map((step, index) => (
                  <li key={step.label} className="grid grid-cols-[28px_1fr] gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex items-center justify-center rounded-full font-mono text-[11px]"
                      style={{ width: 24, height: 24, background: "color-mix(in srgb, var(--accent-primary) 14%, transparent)", color: "var(--accent-primary)" }}
                    >
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="text-[14px]" style={{ fontWeight: 590 }}>
                        {step.label}
                      </h3>
                      <p className="text-[13px] leading-6 mt-0.5" style={{ color: "var(--text-muted)" }}>
                        {step.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div
              className="rounded-lg border overflow-hidden"
              style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)", boxShadow: "var(--shadow-elevated)" }}
            >
              <div className="flex items-center justify-between px-3 h-11 border-b" style={{ borderColor: "var(--border-subtle)" }}>
                <span className="text-[11px] uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
                  Activity
                </span>
                <span
                  className="badge"
                  style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 10%, transparent)" }}
                >
                  Completed
                </span>
              </div>
              <ol>
                {TIMELINE_SAMPLE.map((row) => (
                  <li key={row.title} className="flex items-start gap-2.5 px-3 py-2 border-b last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                    <span
                      aria-hidden="true"
                      className="mt-1 shrink-0 rounded-full"
                      style={{
                        width: 6,
                        height: 6,
                        background: row.state === "testing" && row.title.includes("failed") ? "var(--danger)" : row.state === "completed" ? "var(--success)" : "var(--accent)",
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] truncate" style={{ color: "var(--text-secondary)" }}>
                        {row.title}
                      </span>
                      <span className="block font-mono text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                        {row.meta}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="px-3 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                Illustrative rows in the product’s own wording.
              </p>
            </div>
          </div>
        </section>

        <section id="capabilities" className="max-w-6xl mx-auto px-4 md:px-6 pb-12 md:pb-20">
          <h2 className="text-[22px] md:text-[28px] mb-6" style={{ fontWeight: 510, letterSpacing: "-0.03em" }}>
            What is in the box
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {CAPABILITIES.map((item) => (
              <div key={item.title} className="rounded-lg border p-4" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
                <span aria-hidden="true" style={{ color: "var(--accent-primary)" }}>
                  <item.icon size={18} strokeWidth={1.75} />
                </span>
                <h3 className="text-[14px] mt-3 mb-1" style={{ fontWeight: 590 }}>
                  {item.title}
                </h3>
                <p className="text-[13px] leading-6" style={{ color: "var(--text-muted)" }}>
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <footer className="border-t" style={{ borderColor: "var(--border-color)" }}>
          <div className="max-w-6xl mx-auto px-4 md:px-6 py-10 flex flex-col md:flex-row justify-between gap-6">
            <div className="space-y-2">
              <Wordmark size={24} />
              <p className="text-[11px] max-w-[46ch] leading-5" style={{ color: "var(--text-muted)" }}>
                v0.1.0 · A browser front end, one API, and a sandboxed workspace per project.
              </p>
            </div>
            <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
              <Link href={signInHref} className="hover:text-primary">Sign in</Link>
              <Link href="/app/projects" className="hover:text-primary">Dashboard</Link>
              <Link href="/settings" className="hover:text-primary">Settings</Link>
            </nav>
          </div>
        </footer>
      </main>
    </div>
  );
}
