"use client";

import { useEffect, useRef } from "react";

/**
 * The bench's keyboard, as one listener on the window.
 *
 * Editing keys are single letters on purpose — that's the grammar every cutting
 * room uses — which means they have to stay out of the way of typing. Anything
 * originating inside a field, a textarea or a contenteditable is left alone,
 * and so is anything carrying a modifier the binding didn't ask for.
 */

export interface EditorShortcutHandlers {
  togglePlay: () => void;
  /** Move the playhead by `seconds`, signed. */
  nudge: (seconds: number) => void;
  toStart: () => void;
  toEnd: () => void;
  /** Lift the selected shot, or pull the selected layer or track. */
  removeSelected: () => void;
  undo: () => void;
  redo: () => void;
  /** Pull the selected shot's in-point up to the playhead. */
  trimIn: () => void;
  trimOut: () => void;
  splitAtPlayhead: () => void;
  /**
   * Run the clock at `rate` — J/K/L. Negative is backwards, 0 is a stop where
   * the playhead stands.
   */
  shuttle: (rate: number) => void;
}

/**
 * The speeds J and L step through. Pressing the same key again goes faster,
 * which is the shuttle every cutting room has; pressing the other one starts
 * over at 1× in that direction rather than subtracting a notch, because "go
 * back" should never come out as "go forward slower".
 */
const SHUTTLE_SPEEDS = [1, 2, 4] as const;

/** One frame at the film's rate — the smallest step a nudge can mean. */
export const DEFAULT_FPS = 30;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useEditorShortcuts(
  handlers: EditorShortcutHandlers,
  { fps = DEFAULT_FPS, enabled = true }: { fps?: number; enabled?: boolean } = {},
) {
  /*
   * The handlers close over the live document and are rebuilt every render.
   * Reading them through a ref keeps the listener itself stable, so the window
   * isn't re-subscribed on every keystroke, vote and remote edit.
   */
  const latest = useRef(handlers);
  latest.current = handlers;

  /** Where the shuttle currently stands, as a signed multiple of 1×. */
  const shuttleRate = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target)) return;
      const handlers = latest.current;

      const mod = event.metaKey || event.ctrlKey;
      const key = event.key;

      if (mod) {
        const lower = key.toLowerCase();
        if (lower === "z") {
          event.preventDefault();
          if (event.shiftKey) handlers.redo();
          else handlers.undo();
          return;
        }
        if (lower === "y") {
          event.preventDefault();
          handlers.redo();
          return;
        }
        // Every other chord belongs to the browser.
        return;
      }

      if (event.altKey) return;

      const frame = 1 / (fps > 0 ? fps : DEFAULT_FPS);

      switch (key) {
        case " ":
          event.preventDefault();
          shuttleRate.current = 0;
          handlers.togglePlay();
          return;
        case "ArrowLeft":
          event.preventDefault();
          handlers.nudge(event.shiftKey ? -1 : -frame);
          return;
        case "ArrowRight":
          event.preventDefault();
          handlers.nudge(event.shiftKey ? 1 : frame);
          return;
        case "Home":
          event.preventDefault();
          handlers.toStart();
          return;
        case "End":
          event.preventDefault();
          handlers.toEnd();
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          handlers.removeSelected();
          return;
        case "[":
          event.preventDefault();
          handlers.trimIn();
          return;
        case "]":
          event.preventDefault();
          handlers.trimOut();
          return;
        default:
          break;
      }

      const lower = key.toLowerCase();

      if (lower === "s") {
        event.preventDefault();
        handlers.splitAtPlayhead();
        return;
      }

      if (lower === "j" || lower === "k" || lower === "l") {
        event.preventDefault();
        // Holding the key down would otherwise ratchet to 4× in a few
        // milliseconds — a shuttle steps once per press.
        if (event.repeat) return;
        const direction = lower === "l" ? 1 : lower === "j" ? -1 : 0;
        if (direction === 0) {
          shuttleRate.current = 0;
        } else if (Math.sign(shuttleRate.current) !== direction) {
          shuttleRate.current = direction;
        } else {
          const step = SHUTTLE_SPEEDS.indexOf(
            Math.abs(shuttleRate.current) as (typeof SHUTTLE_SPEEDS)[number],
          );
          shuttleRate.current =
            direction * SHUTTLE_SPEEDS[Math.min(step + 1, SHUTTLE_SPEEDS.length - 1)];
        }
        handlers.shuttle(shuttleRate.current);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fps, enabled]);
}

/** What the "?" card in the toolbar lists, in the order it lists it. */
export const SHORTCUT_LEGEND: { keys: string; what: string }[] = [
  { keys: "Space", what: "Play / pause" },
  { keys: "← →", what: "Nudge one frame" },
  { keys: "⇧ ← →", what: "Nudge one second" },
  { keys: "Home / End", what: "Jump to the top or the tail" },
  { keys: "[ / ]", what: "Trim the shot's in / out to the playhead" },
  { keys: "J K L", what: "Shuttle back / stop / forward — press again for 2×, 4×" },
  { keys: "S", what: "Split the shot at the playhead" },
  { keys: "Delete", what: "Take the shot, layer or track out" },
  { keys: "⌘Z / ⌘⇧Z", what: "Undo / redo" },
];
