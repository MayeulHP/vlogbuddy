"use client";

import { useEffect, useRef, useState } from "react";
import { MIN_CLIP_SPAN, formatFine } from "@vlogbuddy/shared";
import { cn } from "@/lib/cn";

/**
 * The whole source as a bar, with the kept window sitting inside it.
 *
 * Two range sliders in two rows could never show a window: you read one number,
 * then the other, and the picture of "this much out of all that" never arrives
 * — and In could be pushed past Out, with only a clamp after the fact to say
 * otherwise. One bar carrying both handles is the same mental model as the
 * strip upstairs, where the same edit is made with a hand instead.
 *
 * The handles are focusable sliders rather than styled divs, because a div with
 * pointer handlers is unreachable without a pointer and trimming isn't an
 * optional part of an editor.
 *
 * Generic over what is being trimmed — a shot's source footage or a track's
 * audio file — because the gesture, the arithmetic and the keyboard contract
 * are the same in both rooms, and two copies of it would drift.
 */
export function TrimBar({
  source,
  start,
  end,
  minSpan = MIN_CLIP_SPAN,
  openEnd = false,
  startLabel = "In",
  endLabel = "Out",
  tall = false,
  onChange,
  onScrub,
}: {
  /** Length of the whole source, in seconds. The bar's full width. */
  source: number;
  start: number;
  end: number;
  minSpan?: number;
  /**
   * The out point isn't a point: the window runs on past whatever this bar can
   * show, so there is no handle to grab and nothing to put a time on.
   */
  openEnd?: boolean;
  startLabel?: string;
  endLabel?: string;
  /** A thumb on the floor needs more to aim at than a cursor on the bench. */
  tall?: boolean;
  onChange: (next: { start?: number; end?: number }) => void;
  /**
   * Where the handle is, in source seconds, as it moves — so the room this bar
   * sits in can show or play the frame under it. Left out, the bar is silent
   * and the gesture is exactly as it was.
   */
  onScrub?: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Same split as the strip's drag: state so the window follows the pointer,
  // a ref so pointerup can commit the final value without reading state from
  // inside an updater.
  const [drag, setDrag] = useState<{ edge: "start" | "end"; value: number } | null>(null);
  const dragRef = useRef<{ edge: "start" | "end"; value: number } | null>(null);
  const dragging = drag !== null;

  const inPoint = drag?.edge === "start" ? drag.value : start;
  const outPoint = drag?.edge === "end" ? drag.value : end;

  function bound(edge: "start" | "end", seconds: number): number {
    return edge === "start"
      ? round2(clamp(seconds, 0, (openEnd ? source : end) - minSpan))
      : round2(clamp(seconds, start + minSpan, source));
  }

  /**
   * Nothing is dispatched for an edge that lands where it started: the edit
   * behind this bar takes something off the auto-cut for good, and a fumbled
   * grab shouldn't be able to do that.
   */
  function commit(edge: "start" | "end", seconds: number) {
    const value = bound(edge, seconds);
    // Leave the playhead where the handle was put, whether or not the value
    // moved — landing somewhere other than what you're looking at is worse.
    onScrub?.(value);
    if (edge === "start" && value !== start) onChange({ start: value });
    if (edge === "end" && value !== end) onChange({ end: value });
  }

  useEffect(() => {
    if (!dragging) return;

    const at = (clientX: number) => {
      const box = trackRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return 0;
      return ((clientX - box.left) / box.width) * source;
    };

    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const next = { edge: current.edge, value: bound(current.edge, at(event.clientX)) };
      dragRef.current = next;
      setDrag(next);
      onScrub?.(next.value);
    };
    const up = () => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (current) commit(current.edge, current.value);
    };
    // A cancelled gesture was the browser's, not an edit.
    const cancel = () => {
      dragRef.current = null;
      setDrag(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, source, start, end, openEnd, minSpan, onChange, onScrub]);

  function grab(event: React.PointerEvent, edge: "start" | "end") {
    event.stopPropagation();
    event.preventDefault();
    const next = { edge, value: edge === "start" ? start : end };
    dragRef.current = next;
    setDrag(next);
    // Grabbing a handle already says "show me here", before the hand moves.
    onScrub?.(next.value);
  }

  /** Arrows walk the handle; shift takes a second at a time. */
  function nudge(event: React.KeyboardEvent, edge: "start" | "end") {
    const current = edge === "start" ? start : end;
    const step = event.shiftKey ? 1 : 0.1;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = current - step;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = current + step;
    if (event.key === "PageDown") next = current - 5;
    if (event.key === "PageUp") next = current + 5;
    if (event.key === "Home") next = edge === "start" ? 0 : start + minSpan;
    if (event.key === "End") next = edge === "start" ? (openEnd ? source : end) - minSpan : source;
    if (next === null) return;
    event.preventDefault();
    commit(edge, next);
  }

  const pct = (seconds: number) => `${clamp((seconds / source) * 100, 0, 100)}%`;
  const edges = openEnd ? (["start"] as const) : (["start", "end"] as const);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="timecode text-2xs text-ink-300">
          {startLabel} {formatFine(inPoint)}
        </span>
        <span className="timecode text-2xs tabular-nums text-paper-200">
          {openEnd ? "plays out" : `${(outPoint - inPoint).toFixed(1)}s`}
        </span>
        <span className="timecode text-2xs text-ink-300">
          {openEnd ? "to the end" : `${endLabel} ${formatFine(outPoint)}`}
        </span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={(event) => {
          // A press on the bare source moves whichever end is nearer, so the
          // coarse version of this gesture doesn't need aim either.
          const box = trackRef.current?.getBoundingClientRect();
          if (!box || box.width === 0) return;
          const seconds = ((event.clientX - box.left) / box.width) * source;
          const edge =
            openEnd || Math.abs(seconds - start) <= Math.abs(seconds - end) ? "start" : "end";
          commit(edge, seconds);
        }}
        className={cn(
          "relative touch-none select-none border border-[color:var(--hair-dark)] bg-ink-900 bg-hatch",
          tall ? "h-12" : "h-9",
        )}
        title={`${formatFine(source)} in all`}
      >
        <span
          aria-hidden
          style={{ left: pct(inPoint), right: `${clamp(100 - (outPoint / source) * 100, 0, 100)}%` }}
          className="absolute inset-y-0 bg-signal-600/25"
        />

        {/* An open window doesn't stop at the right edge, so it isn't drawn as
            if it did — the arrow is where the missing out handle would be. */}
        {openEnd && (
          <span
            aria-hidden
            className="timecode absolute inset-y-0 right-0 flex items-center pr-1 text-2xs text-signal-400"
          >
            ▸
          </span>
        )}

        {edges.map((edge) => {
          const value = edge === "start" ? inPoint : outPoint;
          return (
            <button
              key={edge}
              type="button"
              role="slider"
              aria-label={edge === "start" ? `${startLabel} point` : `${endLabel} point`}
              aria-valuemin={edge === "start" ? 0 : round2(start + minSpan)}
              aria-valuemax={
                edge === "start" ? round2((openEnd ? source : end) - minSpan) : round2(source)
              }
              aria-valuenow={round2(value)}
              aria-valuetext={`${edge === "start" ? startLabel : endLabel} at ${formatFine(value)} of ${formatFine(source)}`}
              onPointerDown={(event) => grab(event, edge)}
              onKeyDown={(event) => nudge(event, edge)}
              style={{ left: pct(value) }}
              className="trim-grip absolute inset-y-0 flex w-8 -translate-x-1/2 cursor-ew-resize touch-none items-stretch justify-center focus:outline-none focus-visible:bg-signal-500/20"
            >
              <span className="w-[3px] bg-signal-500" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The grid every value this bar emits sits on. Anything derived from two of
 * them — a duration read off an in and an out point — has to come back through
 * here, or the float noise churns a timeline revision on every pass.
 */
export function round2(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}
