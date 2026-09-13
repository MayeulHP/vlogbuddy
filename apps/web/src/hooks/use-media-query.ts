"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A media query as React state.
 *
 * Most of the responsive work in ROLLCALL is CSS, which is where it belongs.
 * This is for the handful of places that measure in JavaScript — the light
 * table plots cards at absolute pixel offsets, and the cut strip sizes frames
 * from a constant — where the number itself has to change, not just a class.
 *
 * `useSyncExternalStore` rather than an effect: the server has no matchMedia,
 * so the first client paint has to agree with the markup it's hydrating.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia?.(query).matches) ?? false,
    // Server-rendered markup is the desktop layout; the client corrects it on
    // the first paint, before anything is interactive.
    () => false,
  );
}

/** Phone-width. Matches the `sm` breakpoint the components use. */
export function useIsCompact(): boolean {
  return useMediaQuery("(max-width: 639px)");
}

/** Anything driven by a fingertip, at any width. */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
