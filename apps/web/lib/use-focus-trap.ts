import { useEffect, useRef, type RefObject } from "react";

/**
 * Traps keyboard focus inside `containerRef` while `active` is true (modal
 * drawer semantics): Tab/Shift+Tab cycle within the container, focus is moved
 * to the first focusable element on activation, Escape invokes `onClose`, and
 * focus returns to the previously focused element (the trigger) on
 * deactivation. No-op when `active` is false.
 *
 * `onClose` is read through a ref so callers can pass an inline arrow without
 * re-running the effect on every render.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const selector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => !el.hasAttribute("disabled"),
      );

    focusables()[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // stopPropagation: an open CommandPalette (window-level listener) must
        // not also react to the same Escape while a drawer is on top.
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (!container.contains(current)) {
        // Focus escaped (e.g. clicked the scrim) — pull it back in.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [active, containerRef]);
}
