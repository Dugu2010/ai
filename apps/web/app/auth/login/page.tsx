"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated, setAuthState, fetchApi } from "../../../lib/api-client";

interface ValidationErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
  name?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<ValidationErrors>({});

  useEffect(() => {
    if (isAuthenticated()) {
      router.push("/app/projects");
    }
  }, [router]);

  const validateEmail = (email: string): string | undefined => {
    if (!email) return "Email is required";
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(email)) return "Invalid email address";
    return undefined;
  };

  const validatePassword = (password: string): string | undefined => {
    if (!password) return "Password is required";
    if (password.length < 8) return "Password must be at least 8 characters";
    if (password.length > 128) return "Password must be less than 128 characters";
    return undefined;
  };

  const validateConfirmPassword = (password: string, confirmPassword: string): string | undefined => {
    if (isRegister && password !== confirmPassword) {
      return "Passwords do not match";
    }
    return undefined;
  };

  const validateName = (name: string): string | undefined => {
    if (isRegister && !name.trim()) return "Name is required";
    if (name.length > 100) return "Name must be less than 100 characters";
    return undefined;
  };

  const getPasswordStrength = (password: string): { score: number; label: string; color: string } => {
    let score = 0;
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;
    const strengths: { label: string; color: string }[] = [
      { label: "Very Weak", color: "var(--danger)" },
      { label: "Weak", color: "color-mix(in srgb, var(--danger) 70%, var(--warning))" },
      { label: "Fair", color: "var(--warning)" },
      { label: "Good", color: "color-mix(in srgb, var(--warning) 60%, var(--success))" },
      { label: "Strong", color: "var(--success)" },
    ];
    const idx = Math.min(score, 4); return { score, label: (strengths[idx]! as any).label, color: (strengths[idx]! as any).color };
  };

  const validateForm = () => {
    const newErrors: ValidationErrors = {};
    const emailError = validateEmail(email);
    if (emailError) newErrors.email = emailError;
    const passwordError = validatePassword(password);
    if (passwordError) newErrors.password = passwordError;
    if (isRegister) {
      const nameError = validateName(name);
      if (nameError) newErrors.name = nameError;
      const confirmError = validateConfirmPassword(password, confirmPassword);
      if (confirmError) newErrors.confirmPassword = confirmError;
    }
    return newErrors;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const newErrors = validateForm();
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    setLoading(true);
    setErrors({});
    try {
      const res = await fetchApi("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          name: isRegister ? name : undefined,
        }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // Non-JSON response (e.g. HTML error page from a proxy)
      }
      if (!res.ok) {
        throw new Error(data?.error || `Authentication failed (${res.status})`);
      }
      if (!data?.token) {
        throw new Error("Authentication failed: no token returned");
      }
      setAuthState(data.token, data.email, data.userId);
      router.push("/app/projects");
    } catch (err: any) {
      // fetch() throws a TypeError ("Failed to fetch") when the request never
      // reaches the API: network error, DNS failure, or a CORS rejection.
      setError(
        err?.name === "TypeError"
          ? "Cannot reach the server. Check your connection, and that the API is awake (free tiers sleep)."
          : err?.message || "Authentication failed",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleInlineEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    if (e.target.value) {
      const error = validateEmail(e.target.value);
      setErrors((prev) => ({ ...prev, email: error || undefined }));
    } else {
      setErrors((prev) => ({ ...prev, email: undefined }));
    }
  };

  const handleInlinePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (e.target.value) {
      const error = validatePassword(e.target.value);
      setErrors((prev) => ({ ...prev, password: error || undefined }));
    } else {
      setErrors((prev) => ({ ...prev, password: undefined }));
    }
  };

  const handleConfirmPasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmPassword(e.target.value);
    if (e.target.value) {
      const error = validateConfirmPassword(password, e.target.value);
      setErrors((prev) => ({ ...prev, confirmPassword: error || undefined }));
    } else {
      setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
    }
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    if (e.target.value) {
      const error = validateName(e.target.value);
      setErrors((prev) => ({ ...prev, name: error || undefined }));
    } else {
      setErrors((prev) => ({ ...prev, name: undefined }));
    }
  };

  const passwordStrength = getPasswordStrength(password);

  const emailError = errors.email;
  const passwordError = errors.password;
  const confirmError = errors.confirmPassword;
  const nameError = errors.name;

  return (
    <div className="min-h-screen bg-primary flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-primary mb-2">DAI</h1>
          <p className="text-muted">
            {isRegister ? "Create your account" : "Sign in to your account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-secondary rounded-2xl p-8 border shadow-soft">
          {error && (
            <div
              className="mb-6 p-3 rounded-lg text-sm"
              role="alert"
              style={{
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 50%, transparent)",
                color: "var(--danger)",
              }}
            >
              {error}
            </div>
          )}

          {isRegister && (
            <div className="mb-5">
              <label htmlFor="name" className="block text-primary text-sm font-medium mb-2">Full Name</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={handleNameChange}
                placeholder="John Doe"
                aria-invalid={nameError ? "true" : undefined}
                aria-describedby={nameError ? "name-error" : undefined}
                className={`w-full px-4 py-3 bg-primary/50 border rounded-lg text-primary placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary transition-colors ${nameError ? "border-[color:var(--danger)]" : "border-tertiary"}`}
              />
              {nameError && <p id="name-error" role="alert" className="text-sm mt-1" style={{ color: "var(--danger)" }}>{nameError}</p>}
            </div>
          )}

          <div className="mb-5">
             <label htmlFor="email" className="block text-primary text-sm font-medium mb-2">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={handleInlineEmailChange}
              placeholder="you@example.com"
              aria-invalid={emailError ? "true" : undefined}
              aria-describedby={emailError ? "email-error" : undefined}
               className={`w-full px-4 py-3 bg-primary/50 border rounded-lg text-primary placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary transition-colors ${emailError ? "border-[color:var(--danger)]" : "border-tertiary"}`}
            />
            {emailError && <p id="email-error" role="alert" className="text-sm mt-1" style={{ color: "var(--danger)" }}>{emailError}</p>}
          </div>

          <div className="mb-5">
             <label htmlFor="password" className="block text-primary text-sm font-medium mb-2">Password</label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={handleInlinePasswordChange}
                placeholder="••••••••"
                aria-invalid={passwordError ? "true" : undefined}
                aria-describedby={passwordError ? "password-error" : undefined}
                className={`w-full px-4 py-3 bg-primary/50 border rounded-lg text-primary placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary transition-colors pr-12 ${passwordError ? "border-[color:var(--danger)]" : "border-tertiary"}`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                 className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary rounded"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {password && (
              <div className="mt-2" role="progressbar" aria-valuenow={passwordStrength.score} aria-valuemin={0} aria-valuemax={4}>
                <div className="flex gap-1 h-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                     <div
                       key={i}
                       className="flex-1 rounded"
                       style={i < passwordStrength.score ? { background: passwordStrength.color } : { background: "var(--bg-tertiary)" }}
                     />
                  ))}
                </div>
                 <p className="text-xs text-muted mt-1">{passwordStrength.label}</p>
              </div>
            )}              {passwordError && <p id="password-error" role="alert" className="text-sm mt-1" style={{ color: "var(--danger)" }}>{passwordError}</p>}
          </div>

          {isRegister && (
            <div className="mb-5">
               <label htmlFor="confirmPassword" className="block text-primary text-sm font-medium mb-2">Confirm Password</label>
              <div className="relative">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={handleConfirmPasswordChange}
                  placeholder="••••••••"
                  aria-invalid={confirmError ? "true" : undefined}
                  aria-describedby={confirmError ? "confirm-password-error" : undefined}
                   className={`w-full px-4 py-3 bg-primary/50 border rounded-lg text-primary placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary transition-colors pr-12 ${confirmError ? "border-[color:var(--danger)]" : "border-tertiary"}`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary rounded"
                >
                  {showConfirmPassword ? "Hide" : "Show"}
                </button>
              </div>
              {confirmError && <p id="confirm-password-error" role="alert" className="text-sm mt-1" style={{ color: "var(--danger)" }}>{confirmError}</p>}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-accent-primary hover:bg-accent-hover rounded-lg text-primary font-medium disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary transition-colors"
          >
            {loading ? (isRegister ? "Creating account..." : "Signing in...") : isRegister ? "Create account" : "Sign in"}
          </button>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => {
                setIsRegister(!isRegister);
                setError("");
                setErrors({});
                setPassword("");
                setConfirmPassword("");
              }}
              className="text-muted hover:text-primary text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary rounded"
            >
              {isRegister ? "Already have an account? Sign in" : "Don't have an account? Create one"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
