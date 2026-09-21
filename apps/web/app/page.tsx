"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAuthenticated } from "../lib/api-client";
import { ThemeToggle } from "../components/theme-toggle";

const FEATURES = [
  {
    title: "Real Linux VM",
    body: "Full Node, Python, Git and a real shell in an isolated Modal Sandbox — not an emulation layer.",
  },
  {
    title: "Live Preview",
    body: "Your dev server on a real HTTPS URL. DAI resumes it automatically when the VM wakes up.",
  },
  {
    title: "AI Agent Loop",
    body: "DAI inspects files, edits code, runs commands, reads the output, then fixes what breaks.",
  },
  {
    title: "Persistent State",
    body: "Files and processes survive sessions. The VM hibernates when idle and picks up where it left off.",
  },
];

export default function LandingPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Mobile hamburger menu (below md — responsive 2F)
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setAuthed(isAuthenticated());
    setReady(true);
  }, []);

  // Signed-in visitors land on the dashboard, not the marketing page.
  useEffect(() => {
    if (ready && authed) router.replace("/app");
  }, [ready, authed, router]);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — leave the command visible.
    }
  }, []);

  const installTabs = [
    { id: "bun", label: "bun", command: "bun create dai-app" },
    { id: "npm", label: "npm", command: "npm create dai-app@latest" },
    { id: "pnpm", label: "pnpm", command: "pnpm create dai-app" },
  ] as const;

  const [activeTab, setActiveTab] = useState<(typeof installTabs)[number]["id"]>("bun");
  const activeInstall = installTabs.find((t) => t.id === activeTab)!;

  return (
    <div className="min-h-screen bg-primary text-primary flex flex-col">
      {/* 1. Header bar — sticky, 64px, hairline bottom border (Linear nav pattern) */}
      <header className="glass sticky top-0 z-50 border-b" style={{ height: "var(--header-h)" }}>
        <div className="max-w-6xl mx-auto px-4 md:px-6 h-full flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2" aria-label="DAI home">
            <div
              className="w-8 h-8 rounded-md flex items-center justify-center text-white"
              style={{ background: "var(--accent-primary)" }}
            >
              <span className="font-semibold text-sm">D</span>
            </div>
            <span className="text-lg" style={{ fontWeight: 590 }}>DAI</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm" style={{ fontWeight: 510, color: "var(--text-muted)" }} aria-label="Primary">
            <a href="#features" className="hover:text-primary transition-colors">Features</a>
            <a href="#example" className="hover:text-primary transition-colors">Example</a>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
              GitHub
            </a>
            <a href="#footer" className="hover:text-primary transition-colors">Pricing</a>
            <Link href="/app" className="hover:text-primary transition-colors">Dashboard</Link>
          </nav>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href={ready && authed ? "/app" : "/auth/login"} className="btn btn-primary hidden sm:inline-flex">
              Get Started
            </Link>
            {/* Nav collapses to hamburger below md (responsive 2F) */}
            <button
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              className="md:hidden w-11 h-11 flex items-center justify-center rounded hover:bg-secondary"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                {menuOpen
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />}
              </svg>
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" aria-label="Mobile" className="md:hidden border-t" style={{ borderColor: "var(--border-color)" }}>
            <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col">
              <a href="#features" onClick={() => setMenuOpen(false)} className="py-3 text-sm hover:text-primary transition-colors" style={{ color: "var(--text-secondary)" }}>Features</a>
              <a href="#example" onClick={() => setMenuOpen(false)} className="py-3 text-sm hover:text-primary transition-colors" style={{ color: "var(--text-secondary)" }}>Example</a>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="py-3 text-sm hover:text-primary transition-colors" style={{ color: "var(--text-secondary)" }}>GitHub</a>
              <a href="#footer" onClick={() => setMenuOpen(false)} className="py-3 text-sm hover:text-primary transition-colors" style={{ color: "var(--text-secondary)" }}>Pricing</a>
              <Link href="/app" onClick={() => setMenuOpen(false)} className="py-3 text-sm hover:text-primary transition-colors" style={{ color: "var(--text-secondary)" }}>Dashboard</Link>
            </div>
          </nav>
        )}
      </header>

      <main id="main-content" className="flex-1">
        {/* 2. Hero — concrete headline, mesh gradient at hero scale only (Vercel pattern) */}
        <section className="hero-mesh">
          <div className="max-w-6xl mx-auto px-4 md:px-6 pt-24 pb-16 md:pt-32 md:pb-24 text-center animate-fade-in-up">
            <p
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs mb-8"
              style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
            >
              <span
                className="w-2 h-2 rounded-full animate-pulse-slow"
                style={{ background: "var(--accent-primary)" }}
              />
              Browser-based coding agent
            </p>
            <h1
              className="text-4xl md:text-6xl leading-[1.05]"
              style={{ fontWeight: 510, letterSpacing: "-0.045em" }}
            >
              Your AI coding agent.
              <br />
              Browser-based, no terminal required.
            </h1>
            <p
              className="mt-6 max-w-2xl mx-auto text-base md:text-lg"
              style={{ color: "var(--text-secondary)" }}
            >
              DAI works inside a real Linux VM: it reads your code, edits files, runs
              commands and starts dev servers — you stay in the browser the whole time.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href={ready && authed ? "/app" : "/auth/login"} className="btn btn-primary w-full sm:w-auto px-6">
                Get Started
              </Link>
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary w-full sm:w-auto px-6"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* 3. Install command — copy-to-clipboard, tabbed (Vercel component pattern) */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-8">
          <div className="max-w-xl mx-auto">
            <div className="flex items-center gap-1 mb-2" role="tablist" aria-label="Package manager">
              {installTabs.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="btn btn-ghost px-3 min-h-[44px] text-xs"
                  style={activeTab === tab.id ? { color: "var(--text-primary)" } : undefined}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div
              className="flex items-center justify-between rounded-lg px-4"
              style={{
                background: "color-mix(in srgb, var(--text-primary) 4%, transparent)",
                boxShadow: "var(--shadow-ring)",
                height: "var(--touch-target)",
              }}
            >
              <code className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>
                <span style={{ color: "var(--accent-primary)", marginRight: 8 }}>$</span>
                {activeInstall.command}
              </code>
              <button
                onClick={() => copy(activeInstall.command, activeTab)}
                className="btn btn-ghost px-3 min-h-[44px] text-xs"
                aria-label={`Copy ${activeInstall.command}`}
              >
                {copied === activeTab ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </section>

        {/* 4. Feature highlights — 4 cards, surface-color depth (Linear card pattern) */}
        <section id="features" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24">
          <h2 className="text-2xl md:text-3xl mb-10" style={{ fontWeight: 510, letterSpacing: "-0.03em" }}>
            What you get
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="card">
                <h3 className="text-base mb-2" style={{ fontWeight: 590 }}>{f.title}</h3>
                <p className="text-sm leading-6" style={{ color: "var(--text-muted)" }}>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 5. Quick example — real code showing the agent at work */}
        <section id="example" className="max-w-6xl mx-auto px-4 md:px-6 pb-16 md:pb-24">
          <div className="grid lg:grid-cols-2 gap-8 items-center">
            <div>
              <h2 className="text-2xl md:text-3xl mb-4" style={{ fontWeight: 510, letterSpacing: "-0.03em" }}>
                See it work
              </h2>
              <p className="text-base leading-6" style={{ color: "var(--text-secondary)" }}>
                One prompt in chat. The agent inspects the failing test, edits the
                function, re-runs the suite, and reports what changed — as an activity
                timeline, not a wall of logs.
              </p>
            </div>
            <div className="command-output expanded" style={{ padding: "var(--space-4)" }}>
              <pre style={{ maxHeight: "none", overflow: "visible" }}>
{`> you: fix the failing test in utils.test.ts

  agent  read_file   src/utils.test.ts
  agent  read_file   src/utils.ts
  agent  edit_file   src/utils.ts  (+2 −1)
  agent  run_tests   bun test

  ✓ 14 passed (1.2s)

> agent: parseDuration("90s") was returning NaN — the
  seconds branch ran after the minutes branch. Reordered
  the cases and re-ran the suite. All green.`}
              </pre>
            </div>
          </div>
        </section>

        {/* 6. Social proof — omitted: no genuine stars/downloads/adopter data yet */}
        {/* 7. Footer */}
        <footer id="footer" className="border-t" style={{ borderColor: "var(--border-color)" }}>
          <div className="max-w-6xl mx-auto px-4 md:px-6 py-12 flex flex-col md:flex-row justify-between gap-8">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs"
                  style={{ background: "var(--accent-primary)" }}
                >
                  D
                </div>
                <span style={{ fontWeight: 590 }}>DAI</span>
              </div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                MIT License · v0.1.0
              </p>
            </div>
            <nav className="flex flex-wrap gap-x-8 gap-y-2 text-sm" style={{ color: "var(--text-muted)" }}>
              <a href="#features" className="hover:text-primary transition-colors">Docs</a>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                GitHub
              </a>
              <a href="#footer" className="hover:text-primary transition-colors">Changelog</a>
              <a href="#footer" className="hover:text-primary transition-colors">Status</a>
            </nav>
          </div>
        </footer>
      </main>
    </div>
  );
}
