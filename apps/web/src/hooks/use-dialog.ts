"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * What a dialog owes the keyboard.
 *
 * The lightbox, the review deck and the phone inspector are all full-screen
 * things that the rest of the page should stop existing behind — but they were
 * plain divs, so Tab walked straight out of them into the light table
 * underneath, and closing one left focus on nothing.
 *
 * Returns a ref for the dialog's outer element. Put `role="dialog"`,
 * `aria-modal="true"` and a label on that same element; this only handles
 * behaviour.
 *
 * Focus goes to the container rather than the first button on purpose: the
 * review deck reads Space and the arrow keys as verdicts, and a focused button
 * would swallow them.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  // The close handler changes identity on most renders; a ref keeps the effect
  // from tearing down and re-running the focus dance on every keystroke.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;

    node?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;

      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and catch the case where focus is on the container
      // itself — Tab from there should enter the dialog, not leave the page.
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
      // Back where it came from — unless the trigger has since gone away.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return ref;
}
