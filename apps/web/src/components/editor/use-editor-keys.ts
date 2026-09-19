"use client";

import { useEffect, useRef } from "react";
import { findKeyEntry, type KeyAction } from "./keymap";

/**
 * The bench's keyboard, wired once at the window.
 *
 * Every decision about *which* keys exist lives in `keymap.ts` — including
 * the guard that keeps a press out of this when somebody is typing into a
 * field or nudging a slider. All this does is run them.
 */
export function useEditorKeys(
  enabled: boolean,
  onAction: (action: KeyAction, event: KeyboardEvent) => void,
) {
  // The handler reads whatever the bench last rendered, without the listener
  // being torn down and rebuilt on every keystroke's worth of state change.
  const latest = useRef(onAction);
  latest.current = onAction;

  useEffect(() => {
    if (!enabled) return;
    function onKey(event: KeyboardEvent) {
      const entry = findKeyEntry(event);
      if (!entry) return;
      // Space scrolls, arrows scroll, Backspace used to navigate back. A key
      // the bench claims is a key the browser doesn't get.
      event.preventDefault();
      latest.current(entry.id, event);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
