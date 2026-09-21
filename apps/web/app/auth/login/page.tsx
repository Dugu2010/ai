"use client";

/**
 * Sign in / create account.
 *
 * One form, two modes. Validation is per-field and inline, submission failures
 * are reported in the caller's words, and a network failure says the API could
 * not be reached rather than blaming the password.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Lock, TriangleAlert } from "lucide-react";
import { fetchApi, isAuthenticated, setAuthState } from "@/lib/api-client";
import { useAuthenticated } from "@/lib/use-auth";
import { Wordmark } from "@/components/app-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { NoticeBar } from "@/components/panel";

interface AuthResponse {
  token?: string;
  email?: string;
  userId?: string;
  error?: string;
}

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
}

const STRENGTH: Array<{ label: string; color: string }> = [
  { label: "Very weak", color: "var(--danger)" },
  { label: "Weak", color: "var(--danger)" },
  { label: "Fair", color: "var(--warning)" },
  { label: "Good", color: "var(--warning)" },
  { label: "Strong", color: "var(--success)" },
];

function validateEmail(value: string): string | undefined {
  if (!value.trim()) return "Email is required";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return "Enter a valid email address";
  return undefined;
}

function validatePassword(value: string, registering: boolean): string | undefined {
  if (!value) return "Password is required";
  if (value.length < 8) return "Use at least 8 characters";
  if (value.length > 128) return "Use fewer than 128 characters";
  if (!registering) return undefined;
  if (!/[0-9]/.test(value)) return "Include at least one number";
  return undefined;
}

function passwordScore(value: string): number {
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value)) score += 1;
  if (/[^a-zA-Z0-9]/.test(value)) score += 1;
  return Math.min(score, STRENGTH.length) - 1;
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  error,
  autoComplete,
  placeholder,
  trailing,
  hint,
}: {
  id: string;
  label: string;
  type: "text" | "email" | "password";
  value: string;
  onChange: (value: string) => void;
  error?: string;
  autoComplete?: string;
  placeholder?: string;
  trailing?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="input h-11 min-h-[44px] text-[14px] pr-11"
        />
        {trailing}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[11px] mt-1.5" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      {hint}
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const authed = useAuthenticated();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const registering = mode === "register";

  useEffect(() => {
    if (authed && isAuthenticated()) router.replace("/app/projects");
  }, [authed, router]);

  const strength = useMemo(() => {
    if (!password) return null;
    const index = Math.max(0, passwordScore(password));
    const entry = STRENGTH[index] ?? { label: "Very weak", color: "var(--danger)" };
    return { index, ...entry };
  }, [password]);

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    const emailError = validateEmail(email);
    if (emailError) next.email = emailError;
    const passwordError = validatePassword(password, registering);
    if (passwordError) next.password = passwordError;
    if (registering) {
      if (!name.trim()) next.name = "Name is required";
      if (confirm !== password) next.confirm = "Passwords do not match";
    }
    return next;
  };

  const submit = async () => {
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      const res = await fetchApi("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          password,
          name: registering ? name.trim() : undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as AuthResponse | null;
      if (!res.ok || !data?.token) {
        throw new Error(data?.error || (registering ? "Could not create the account" : "Email or password is not recognised"));
      }
      setAuthState(data.token, data.email ?? email.trim(), data.userId ?? "");
      router.replace("/app/projects");
    } catch (err) {
      // fetch() rejects with a TypeError when the request never reached the API:
      // offline, DNS, or a CORS rejection. Say that, not "wrong password".
      const message =
        err instanceof Error && err.name === "TypeError"
          ? "Cannot reach the server. Check your connection, and that the API is awake (free tiers sleep)."
          : err instanceof Error && err.message
            ? err.message
            : "Authentication failed";
      setFormError(message);
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ background: "var(--bg-canvas)" }}>
      <div className="flex items-center justify-between px-4 md:px-6 h-16">
        <Link href="/" aria-label="DAI home">
          <Wordmark />
        </Link>
        <ThemeToggle />
      </div>

      <main id="main-content" className="flex-1 flex items-start justify-center px-4 pb-16">
        <div className="w-full max-w-[420px] pt-4 md:pt-10">
          <h1 className="text-[26px] leading-tight" style={{ fontWeight: 590, letterSpacing: "-0.03em" }}>
            {registering ? "Create your account" : "Sign in to DAI"}
          </h1>
          <p className="mt-1.5 text-[13px] leading-6" style={{ color: "var(--text-muted)" }}>
            {registering
              ? "Your workspaces, files and settings are stored against this account."
              : "Use the account your workspaces belong to."}
          </p>

          <form
            className="mt-6 rounded-lg border p-4 md:p-6 space-y-4"
            style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {formError ? <NoticeBar tone="danger" message={formError} /> : null}

            {registering ? (
              <Field
                id="name"
                label="Name"
                type="text"
                value={name}
                onChange={setName}
                error={errors.name}
                autoComplete="name"
                placeholder="Your name"
              />
            ) : null}

            <Field
              id="email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              error={errors.email}
              autoComplete="email"
              placeholder="you@example.com"
            />

            <Field
              id="password"
              label="Password"
              type={reveal ? "text" : "password"}
              value={password}
              onChange={setPassword}
              error={errors.password}
              autoComplete={registering ? "new-password" : "current-password"}
              placeholder={registering ? "At least 8 characters" : "Your password"}
              trailing={
                <button
                  type="button"
                  onClick={() => setReveal((prev) => !prev)}
                  aria-label={reveal ? "Hide password" : "Show password"}
                  className="absolute right-0 top-0 h-11 w-11 inline-flex items-center justify-center rounded-md"
                  style={{ color: "var(--text-muted)" }}
                >
                  {reveal ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                </button>
              }
              hint={
                strength && registering ? (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex gap-1 flex-1" role="meter" aria-valuenow={strength.index + 1} aria-valuemin={1} aria-valuemax={STRENGTH.length} aria-label="Password strength">
                      {STRENGTH.map((entry, index) => (
                        <span
                          key={entry.label}
                          className="flex-1 rounded-full"
                          style={{
                            height: 3,
                            background: index <= strength.index ? strength.color : "color-mix(in srgb, var(--text-primary) 10%, transparent)",
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {strength.label}
                    </span>
                  </div>
                ) : null
              }
            />

            {registering ? (
              <Field
                id="confirm"
                label="Confirm password"
                type={reveal ? "text" : "password"}
                value={confirm}
                onChange={setConfirm}
                error={errors.confirm}
                autoComplete="new-password"
                placeholder="Repeat the password"
              />
            ) : null}

            <button type="submit" disabled={submitting} className="btn btn-primary w-full">
              {submitting ? <Lock size={14} aria-hidden="true" /> : null}
              {submitting ? (registering ? "Creating account…" : "Signing in…") : registering ? "Create account" : "Sign in"}
            </button>

            <div className="flex items-center justify-between gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setMode(registering ? "signin" : "register");
                  setErrors({});
                  setFormError(null);
                  setConfirm("");
                }}
                className="text-[12px] underline-offset-4 hover:underline"
                style={{ color: "var(--text-muted)", minHeight: 44 }}
              >
                {registering ? "I already have an account" : "Create a new account"}
              </button>
              <Link href="/" className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                Home
              </Link>
            </div>
          </form>

          <p className="mt-4 flex items-start gap-2 text-[11px] leading-5" style={{ color: "var(--text-muted)" }}>
            <TriangleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            If the API is on a sleeping free tier, the first request can take a few seconds to wake.
          </p>
        </div>
      </main>
    </div>
  );
}
