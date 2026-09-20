import { redirect } from "next/navigation";

/**
 * Route /app: the authenticated dashboard entry.
 *
 * Auth is client-side (localStorage token), so this server component performs a
 * cheap unconditional redirect to /app/projects. The projects page redirects
 * unauthenticated visitors to /auth/login via useAuthRedirect.
 */
export default function AppIndexPage() {
  redirect("/app/projects");
}
