/**
 * Motion policy for the workspace. The app uses short transitions only, and any
 * script-driven movement defers to the user's system preference.
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Scroll a node into view, without animation when motion is reduced. */
export function scrollToNode(node: Element | null, block: ScrollLogicalPosition = "end"): void {
  if (!node) return;
  node.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block });
}
