"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BEAT_HIT_WINDOW,
  MIN_CLIP_SPAN,
  MAX_LAYERS,
  TRANSITIONS,
  TRANSITION_GLYPHS,
  TRANSITION_LABELS,
  audioTrackSpan,
  clipDuration,
  clipStartTimes,
  formatDuration,
  formatFine,
  beatsBetween,
  overlapsPrevious,
  type AudioTrack,
  type BeatGrid,
  type Clip,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import type { BeatStatus } from "@/lib/beat-status";
import { useIsTouch } from "@/hooks/use-media-query";
import { RotatedMedia } from "@/lib/rotated-media";
import { makeSnap, quantize } from "@/lib/snap";
import { useDialog } from "@/hooks/use-dialog";
import { AnchoredPopover } from "./anchored-popover";
import { cn } from "@/lib/cn";
import type { Selection } from "./selection";

/**
 * The bench, as a stack of lanes on one shared clock.
 *
 * The base track still reads as a strip of shots you can drag into order, but
 * everything above and below it is pinned to absolute time — so a layer lines
 * up with the shot it sits over, and a second music cue lines up with the
 * moment it's meant to land. That only works if every lane uses the same
 * pixels-per-second, which is why widths here are computed from the clock
 * rather than clamped for legibility. Zoom is the answer to a shot too small
 * to grab.
 *
 * Every gesture on every lane is a pointer gesture. HTML5 drag-and-drop would
 * be less code for the reorder, but it never fires under a fingertip, and a
 * bench that is read-only on a phone isn't a bench.
 */

/**
 * Lane heights, twice.
 *
 * A 30px audio block is a comfortable target for a pointer and a miserable one
 * for a thumb, and the lane names can't take a fifth of a 375px screen. So the
 * bench has a touch set of numbers as well as a desk set.
 *
 * `grip` is the width of a trim handle's *hit* zone rather than the hairline it
 * paints: the edge of a shot is a 1px idea and a thumb is not.
 */
const LANES = {
  desk: { ruler: 22, layer: 34, base: 78, audio: 30, gutter: "w-[74px]", grip: 14, marker: 24 },
  touch: { ruler: 26, layer: 44, base: 88, audio: 40, gutter: "w-[52px]", grip: 26, marker: 24 },
} as const;

/**
 * The lane names, twice over.
 *
 * A 52px gutter can't hold "Picture" or "Layer 1", and a gutter wide enough to
 * would cost a fifth of a 375px strip — which is the footage, the part nobody
 * can get back. So the phone gets the short forms; the names are the same
 * words the inspector uses, cut down rather than renamed.
 */
const LANE_NAMES = {
  desk: { picture: "Picture", layer: (n: number) => `Layer ${n}`, bed: "Music", cue: (n: number) => `Sound ${n}`, bpm: (b: number) => `${b} bpm` },
  touch: { picture: "Pic", layer: (n: number) => `L${n}`, bed: "Music", cue: (n: number) => `S${n}`, bpm: (b: number) => `${b}` },
} as const;

/**
 * The strip of the ruler the beats get when there's a pulse to draw. Bought
 * rather than borrowed: the second labels already fill the ruler, and beats
 * overprinted on them would read as part of the timecode.
 */
const BEAT_STRIP = 10;

/** Under this many pixels apart, beats stop being separate marks to the eye. */
const MIN_BEAT_GAP = 7;

const MIN_SCALE = 6;
const MAX_SCALE = 140;

/**
 * Where the playhead lands when the strip turns the page, as a fraction of the
 * visible width. Left of centre because the interesting part of a film is the
 * part that hasn't played yet: a centred playhead spends half the strip on
 * footage you've just watched.
 */
const PAGE_INSET = 0.15;


/**
 * What the strip toolbar can add. One order, one set of words, used by the
 * buttons here and by the phone's sheet — so the two can't drift apart.
 */
export type AddKind = "shot" | "layer" | "sound";

export const ADD_KINDS: { kind: AddKind; label: string }[] = [
  { kind: "shot", label: "+ Shot" },
  { kind: "layer", label: "+ Layer" },
  { kind: "sound", label: "+ Sound" },
];

/** Past this the pointer is dragging, under it it's still a tap that selects. */
const DRAG_SLOP = 4;

export function TimelineTracks({
  timeline,
  mediaById,
  music,
  beat,
  durations,
  totalDuration,
  selection,
  onSelect,
  onDispatch,
  playheadTime,
  onSeek,
  onBackToGather,
  addOpen,
  onAddOpenChange,
  renderAddPicker,
  anchoredPickers,
  className,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  music: MusicItemView[];
  /** The music's pulse, for the ruler — and the reason there isn't one. */
  beat: BeatStatus;
  durations: Record<string, number | null>;
  totalDuration: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onDispatch: (op: TimelineOp) => void;
  playheadTime: number;
  onSeek: (t: number) => void;
  onBackToGather?: () => void;
  /**
   * The three add-verbs live on the strip toolbar because what they add lands
   * on the strip, but the bench owns the state: below `md` the same pickers
   * come up as a bottom sheet instead of a popover, and only the bench knows
   * which it is.
   */
  addOpen: AddKind | null;
  onAddOpenChange: (kind: AddKind | null) => void;
  renderAddPicker: (kind: AddKind, done: () => void) => React.ReactNode;
  /** md and up: hang the picker off its button. Below, the bench sheets it. */
  anchoredPickers: boolean;
  /** The bench hands the strip the leftover height under the picture. */
  className?: string;
}) {
  const touch = useIsTouch();
  const lanes = touch ? LANES.touch : LANES.desk;
  const names = touch ? LANE_NAMES.touch : LANE_NAMES.desk;
  const [scale, setScale] = useState(28);
  const laneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The handlers below live on the DOM node rather than on React props (a
  // wheel listener has to be non-passive to be allowed to zoom), so they read
  // the clock and the zoom out of refs instead of a stale closure.
  const playheadRef = useRef(playheadTime);
  const scaleRef = useRef(scale);
  playheadRef.current = playheadTime;
  scaleRef.current = scale;

  const musicById = useMemo(() => new Map(music.map((m) => [m.id, m])), [music]);

  /**
   * Where the shots sit as stored. The magnets snap to these rather than to the
   * live layout below: a trim in flight moves every later cut, and magnets that
   * slide around under the pointer are worse than no magnets.
   */
  const committed = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);

  /** Clip boundaries double as magnets — layers usually want to hit a cut. */
  const snapPoints = useMemo(() => {
    const points = new Set<number>([0, totalDuration]);
    for (const clip of timeline.clips) points.add(committed[clip.id] ?? 0);
    return [...points].sort((a, b) => a - b);
  }, [timeline.clips, committed, totalDuration]);

  const snap = useMemo(() => makeSnap(snapPoints, scale), [snapPoints, scale]);

  // --- dragging blocks along the clock ------------------------------------
  type Drag = {
    mode: "move" | "resize";
    /** Which end a resize took hold of. A move ignores it. */
    edge: "start" | "end";
    target: "layer" | "audio" | "clip";
    id: string;
    pointerX: number;
    origin: number;
    delta: number;
    /** Set once the pointer has travelled far enough to mean it. */
    moved: boolean;
  };
  // The drag lives in a ref as well as in state: state so the ghost follows the
  // pointer, the ref so the pointerup handler can commit it without reading
  // state from inside an updater — which would dispatch mid-render.
  /**
   * Which cut has its transition picker open, named by the *second* shot —
   * `transitionIn` lives on the clip a transition brings in, so that's the clip
   * every op here patches.
   */
  const [transitionAt, setTransitionAt] = useState<string | null>(null);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const travel = event.clientX - current.pointerX;
      const next = {
        ...current,
        delta: travel / scale,
        moved: current.moved || Math.abs(travel) > DRAG_SLOP,
      };
      dragRef.current = next;
      setDrag(next);
    };

    /**
     * The browser took the gesture over — a vertical pan on a phone, most
     * likely. It never meant to be an edit, so it doesn't become one.
     */
    const cancel = () => {
      dragRef.current = null;
      setDrag(null);
    };

    const up = () => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current) return;

      const value = current.origin + current.delta;

      if (current.target === "clip") {
        const clip = timeline.clips.find((c) => c.id === current.id);
        if (!clip) return;

        if (current.mode === "move") {
          if (!current.moved) return;
          const from = timeline.clips.findIndex((c) => c.id === current.id);
          const gap = indexAt(value, timeline, committed, durations);
          const to = gap > from ? gap - 1 : gap;
          if (from !== -1 && to !== from) {
            onDispatch({ type: "clip.move", clipId: current.id, toIndex: to });
          }
          return;
        }

        // A trim that rounds to nothing dispatches nothing: `clip.update`
        // hands the shot's timing away from the auto-cut for good, and a
        // fumbled grab shouldn't be able to do that silently.
        const patch = trimPatch(clip, durations[clip.mediaItemId] ?? null, current.edge, current.delta);
        if (patch) onDispatch({ type: "clip.update", clipId: clip.id, patch });
        return;
      }

      const start = clamp(snap(value), 0, Math.max(0, totalDuration - MIN_CLIP_SPAN));

      if (current.target === "layer") {
        const layer = timeline.layers.find((l) => l.id === current.id);
        if (!layer) return;
        onDispatch({
          type: "layer.update",
          layerId: current.id,
          patch:
            current.mode === "move"
              ? { startAt: start }
              : current.edge === "end"
                ? { duration: Math.max(MIN_CLIP_SPAN, round3(snap(layer.startAt + value) - layer.startAt)) }
                : headPatch(layer.startAt, layer.duration, start),
        });
      } else {
        const track = timeline.audio.find((t) => t.id === current.id);
        if (!track) return;
        const span = audioTrackSpan(track, totalDuration);
        onDispatch({
          type: "audio.update",
          trackId: current.id,
          patch:
            current.mode === "move"
              ? { startAt: start }
              : current.edge === "end"
                ? { duration: Math.max(MIN_CLIP_SPAN, round3(snap(track.startAt + value) - track.startAt)) }
                : headPatch(track.startAt, span, start),
        });
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [dragging, scale, snap, timeline, committed, durations, totalDuration, onDispatch]);

  function startDrag(event: React.PointerEvent, spec: Omit<Drag, "pointerX" | "delta" | "moved">) {
    event.stopPropagation();
    event.preventDefault();
    const next = { ...spec, pointerX: event.clientX, delta: 0, moved: false };
    dragRef.current = next;
    setDrag(next);
  }

  /** Lane-relative seconds under the pointer, for gestures that aim at a place. */
  function timeAt(event: React.PointerEvent): number {
    const box = laneRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return (event.clientX - box.left) / scale;
  }

  /** Where a block sits right now, including any drag in flight. */
  function ghost(target: "layer" | "audio", id: string, start: number, span: number) {
    if (!drag || drag.id !== id || drag.target !== target) return { start, span };
    if (drag.mode === "move") {
      return { start: clamp(drag.origin + drag.delta, 0, totalDuration), span };
    }
    if (drag.edge === "end") {
      return { start, span: Math.max(MIN_CLIP_SPAN, drag.origin + drag.delta) };
    }
    // Dragging the head leaves the tail where it is.
    const end = start + span;
    const head = clamp(drag.origin + drag.delta, 0, end - MIN_CLIP_SPAN);
    return { start: head, span: end - head };
  }

  /**
   * The trim under the pointer, resolved through exactly the code that will
   * commit it — so what the strip shows while you drag and what lands in the
   * document can't drift apart.
   */
  const trim = (() => {
    if (!drag || drag.target !== "clip" || drag.mode !== "resize") return null;
    const clip = timeline.clips.find((c) => c.id === drag.id);
    if (!clip) return null;
    const source = durations[clip.mediaItemId] ?? null;
    const patch = trimPatch(clip, source, drag.edge, drag.delta);
    const shown = patch ? { ...clip, ...patch } : clip;
    return { clip: shown, edge: drag.edge, source, span: clipDuration(shown, source) };
  })();

  /**
   * Positions including that trim. The base track is a sequence, so shortening
   * one shot pulls every shot after it earlier — a ghost floating over its
   * neighbours would be lying about what letting go does.
   */
  const live = layout(timeline, durations, trim && { id: trim.clip.id, span: trim.span });

  const moveDrag = drag && drag.target === "clip" && drag.mode === "move" && drag.moved ? drag : null;
  const dropGap = moveDrag ? indexAt(moveDrag.origin + moveDrag.delta, timeline, live.starts, durations) : null;

  const transitionClip = transitionAt
    ? timeline.clips.find((c) => c.id === transitionAt) ?? null
    : null;

  const contentWidth = Math.max(320, Math.max(totalDuration, live.total) * scale);

  // --- following the playhead, and zooming about a point -------------------
  /*
   * The strip turns the page rather than panning under the playhead: a
   * continuously centred strip means the footage is always moving, which makes
   * it impossible to read a shot while the film plays. So the view only moves
   * when the playhead walks off the end of it.
   *
   * `follow` goes off the moment the user scrolls by hand — they're reading
   * somewhere else and being yanked back mid-gesture is the worst thing the
   * strip could do. It comes back on at the next seek or selection, or when
   * the playhead they went to look at leaves the view again of its own accord.
   */
  const follow = useRef(true);
  const sawPlayhead = useRef(true);
  /** Set across a scroll we caused, so it doesn't read as the user's. */
  const selfScroll = useRef(false);

  function scrollToTime(box: HTMLDivElement, time: number) {
    selfScroll.current = true;
    box.scrollLeft = clamp(
      time * scaleRef.current - box.clientWidth * PAGE_INSET,
      0,
      Math.max(0, box.scrollWidth - box.clientWidth),
    );
  }

  function playheadVisible(box: HTMLDivElement): boolean {
    const x = playheadRef.current * scaleRef.current;
    return x >= box.scrollLeft && x <= box.scrollLeft + box.clientWidth;
  }

  function keepPlayheadInView() {
    const box = scrollRef.current;
    // A drag in flight owns the pointer and the view; moving the ground under
    // it would send the block somewhere nobody asked for.
    if (!box || dragRef.current) return;
    const visible = playheadVisible(box);
    if (follow.current) {
      if (!visible) scrollToTime(box, playheadRef.current);
      return;
    }
    if (visible) {
      sawPlayhead.current = true;
      return;
    }
    if (sawPlayhead.current) {
      follow.current = true;
      scrollToTime(box, playheadRef.current);
    }
  }

  /** A seek or a selection is the user pointing at a moment: go there. */
  function resumeFollow() {
    follow.current = true;
    sawPlayhead.current = true;
  }

  useEffect(keepPlayheadInView, [playheadTime, scale]);

  const selectionKey = selection.kind === "none" ? "none" : `${selection.kind}:${selection.id}`;
  useEffect(() => {
    resumeFollow();
    keepPlayheadInView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  /*
   * Zoom keeps the time under the anchor — the playhead, the pointer, two
   * fingers — pinned to the same screen x. Scrolling has to happen after the
   * new width is laid out, so the anchor is parked here and spent in a layout
   * effect rather than applied alongside `setScale`.
   */
  const pendingZoom = useRef<{ time: number; px: number } | null>(null);

  function zoomAbout(next: number, time: number, px: number) {
    pendingZoom.current = { time, px };
    setScale(clamp(next, MIN_SCALE, MAX_SCALE));
  }

  useLayoutEffect(() => {
    const box = scrollRef.current;
    const anchor = pendingZoom.current;
    pendingZoom.current = null;
    if (!box || !anchor) return;
    selfScroll.current = true;
    box.scrollLeft = clamp(
      anchor.time * scale - anchor.px,
      0,
      Math.max(0, box.scrollWidth - box.clientWidth),
    );
  }, [scale]);

  /** The buttons zoom about the playhead, or about the middle if it's away. */
  function zoomBy(factor: number) {
    const box = scrollRef.current;
    if (!box) {
      setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE));
      return;
    }
    const x = playheadTime * scale - box.scrollLeft;
    const inside = x >= 0 && x <= box.clientWidth;
    const px = inside ? x : box.clientWidth / 2;
    const time = inside ? playheadTime : (box.scrollLeft + box.clientWidth / 2) / scale;
    zoomAbout(scale * factor, time, px);
  }

  /** The whole film across the visible width — the way back from lost. */
  function fitToWidth() {
    const box = scrollRef.current;
    const span = Math.max(totalDuration, live.total);
    if (!box || span <= 0) return;
    zoomAbout(box.clientWidth / span, 0, 0);
  }

  const empty = timeline.clips.length === 0;

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;

    const onScroll = () => {
      if (selfScroll.current) {
        selfScroll.current = false;
        return;
      }
      follow.current = false;
      sawPlayhead.current = playheadVisible(box);
    };

    const onWheel = (event: WheelEvent) => {
      // Trackpad pinch reaches the page as ctrl+wheel; cmd+wheel is the
      // keyboard version of the same intent.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const px = event.clientX - box.getBoundingClientRect().left;
        const time = (box.scrollLeft + px) / scaleRef.current;
        zoomAbout(scaleRef.current * Math.exp(-event.deltaY * 0.01), time, px);
        return;
      }
      // Plain wheel stays the page's. Shift+wheel is horizontal scrolling in
      // every editor there has ever been, and only some browsers do it for us.
      if (event.shiftKey && event.deltaX === 0 && event.deltaY !== 0) {
        event.preventDefault();
        box.scrollLeft += event.deltaY;
      }
    };

    // Pinch, as two fingers rather than a gesture event: Safari's is
    // proprietary and Chrome doesn't send it at all.
    const fingers = new Map<number, number>();
    let pinch: { dist: number; scale: number; time: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      fingers.set(event.pointerId, event.clientX);
      pinch = null;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!fingers.has(event.pointerId)) return;
      fingers.set(event.pointerId, event.clientX);
      if (fingers.size !== 2 || dragRef.current) return;
      const [a, b] = [...fingers.values()];
      const dist = Math.abs(a - b);
      if (dist < 20) return;
      const px = (a + b) / 2 - box.getBoundingClientRect().left;
      if (!pinch) {
        pinch = { dist, scale: scaleRef.current, time: (box.scrollLeft + px) / scaleRef.current };
        return;
      }
      zoomAbout(pinch.scale * (dist / pinch.dist), pinch.time, px);
    };
    const onPointerUp = (event: PointerEvent) => {
      fingers.delete(event.pointerId);
      if (fingers.size < 2) pinch = null;
    };

    box.addEventListener("scroll", onScroll, { passive: true });
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("pointerdown", onPointerDown);
    box.addEventListener("pointermove", onPointerMove);
    box.addEventListener("pointerup", onPointerUp);
    box.addEventListener("pointercancel", onPointerUp);
    return () => {
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("pointerdown", onPointerDown);
      box.removeEventListener("pointermove", onPointerMove);
      box.removeEventListener("pointerup", onPointerUp);
      box.removeEventListener("pointercancel", onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty]);

  /**
   * Where the cuts fall, for the beat marks. Read off the live layout rather
   * than the committed one so that dragging an edge shows you, tick by tick,
   * the beat you're about to land on.
   */
  const cutTimes = timeline.clips
    .slice(1)
    .map((clip) => live.starts[clip.id] ?? 0)
    .concat(live.total);

  /** The ruler grows to make room for the beats rather than sharing its rows. */
  const rulerHeight = lanes.ruler + (beat.grid ? BEAT_STRIP : 0);

  function seekFromEvent(event: React.MouseEvent) {
    const box = laneRef.current?.getBoundingClientRect();
    if (!box) return;
    resumeFollow();
    onSeek(clamp((event.clientX - box.left) / scale, 0, totalDuration));
  }

  if (empty) {
    return (
      <div className={cn("border border-[color:var(--hair-dark)] bg-ink-850 bg-hatch px-6 py-12 text-center", className)}>
        <p className="eyebrow-light">Empty strip</p>
        <p className="headline mt-2 text-2xl text-paper-100">Nothing has made the cut</p>
        <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-ink-400">
          The film builds itself out of the crew&apos;s marks. Go and mark some footage, or drag
          the cut line down to let more in.
        </p>
        {onBackToGather && (
          <button onClick={onBackToGather} className="btn-outline-dark mt-4">
            Back to the floor
          </button>
        )}
      </div>
    );
  }

  // Lanes run top to bottom the way they stack in the frame: the topmost layer
  // is the one you see first, so it's the one drawn first.
  const usedLayers = new Set(timeline.layers.map((l) => l.layer));
  const layerLanes = Array.from({ length: MAX_LAYERS }, (_, i) => MAX_LAYERS - i).filter(
    (n) => usedLayers.has(n) || n === 1,
  );

  return (
    <section className={cn("flex flex-col border border-[color:var(--hair-dark)] bg-ink-850", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--hair-dark)] px-2 py-1.5 sm:px-3 sm:py-2">
        {/*
          The verbs sit on the thing they act on. "Reel 02 · Strip" was
          decoration in the one place a friend looks for "how do I add
          something?", and the answer used to be two tabs away in a side column
          that duplicated the lanes.
        */}
        <div className="flex min-w-0 items-center gap-1">
          {ADD_KINDS.map(({ kind, label }) => {
            const open = addOpen === kind;
            return (
              <div key={kind} className="relative shrink-0">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => onAddOpenChange(open ? null : kind)}
                  className={cn(
                    "flex min-h-[34px] items-center border px-2 font-mono text-2xs uppercase tracking-label transition-colors",
                    open
                      ? "border-paper-100 bg-paper-100 text-ink-900"
                      : "border-[color:var(--hair-dark)] text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                  )}
                >
                  {label}
                </button>
                {open && anchoredPickers && (
                  <AnchoredPopover
                    label={label}
                    onClose={() => onAddOpenChange(null)}
                    style={{ width: 300 }}
                    className="left-0 top-full mt-1"
                  >
                    {renderAddPicker(kind, () => onAddOpenChange(null))}
                  </AnchoredPopover>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <p className="eyebrow-light hidden xl:block">
            Drag shots to reorder · drag their edges to trim
          </p>
          <div className="flex items-stretch border border-[color:var(--hair-dark)]">
            <button
              onClick={() => zoomBy(1 / 1.5)}
              className="flex min-h-[34px] min-w-[34px] items-center justify-center px-2 font-mono text-[13px] text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper-100"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              onClick={() => zoomBy(1.5)}
              className="flex min-h-[34px] min-w-[34px] items-center justify-center border-l border-[color:var(--hair-dark)] px-2 font-mono text-[13px] text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper-100"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              onClick={fitToWidth}
              className="flex min-h-[34px] items-center justify-center border-l border-[color:var(--hair-dark)] px-2 font-mono text-2xs uppercase tracking-wide text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper-100"
              aria-label="Fit the whole film on screen"
              title="Fit the whole film on screen"
            >
              Fit
            </button>
          </div>
        </div>
      </div>

      {/*
        The lanes take whatever height is left under the picture rather than a
        stack of their own — `min-h-0` so the flex child is allowed to be
        shorter than its content and scroll instead of pushing the page.
      */}
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        {/* Lane names, parked outside the scroll so they're always readable. */}
        <div className={cn(lanes.gutter, "shrink-0 border-r border-[color:var(--hair-dark)]")}>
          <div
            style={{ height: rulerHeight }}
            className="flex items-end justify-end px-2 pb-0.5"
          >
            {beat.grid && (
              <span className="eyebrow-light truncate">{names.bpm(Math.round(beat.grid.bpm))}</span>
            )}
          </div>
          {layerLanes.map((n) => (
            <div
              key={n}
              style={{ height: lanes.layer }}
              className="flex items-center border-t border-[color:var(--hair-dark)] px-2"
            >
              <span className="eyebrow-light truncate" title={`Layer ${n}`}>
                {names.layer(n)}
              </span>
            </div>
          ))}
          <div
            style={{ height: lanes.base }}
            className="flex items-center border-t border-[color:var(--hair-dark)] px-2"
          >
            <span className="eyebrow-light" title="Picture">
              {names.picture}
            </span>
          </div>
          {timeline.audio.map((track, i) => (
            <div
              key={track.id}
              style={{ height: lanes.audio }}
              className="flex items-center border-t border-[color:var(--hair-dark)] px-2"
            >
              <span
                className="eyebrow-light truncate"
                title={track.role === "bed" ? "Music" : `Sound ${i + 1}`}
              >
                {track.role === "bed" ? names.bed : names.cue(i + 1)}
              </span>
            </div>
          ))}
        </div>

        <div
          ref={scrollRef}
          className="scrollbar-thin scrollbar-dark touch-scroll-x min-w-0 flex-1 overflow-x-auto"
        >
          <div ref={laneRef} className="relative" style={{ width: contentWidth }}>
            {/* Ruler */}
            <div
              onClick={seekFromEvent}
              style={{ height: rulerHeight }}
              className="relative cursor-pointer select-none"
            >
              {ticks(totalDuration, scale).map((t) => (
                <div key={t} className="absolute top-0" style={{ left: t * scale }}>
                  <div className="h-1.5 w-px bg-ink-600" />
                  <span className="ml-1 font-mono text-2xs tabular-nums text-ink-500">
                    {formatDuration(t)}
                  </span>
                </div>
              ))}

              {/*
                The music, made visible. A tall lit mark is a cut that landed on
                a beat — which is the only way anyone can tell whether "cut on
                the beat" did anything, since what it changes is a fraction of a
                second nobody can see in a waveform.
              */}
              {beat.grid && (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0"
                  style={{ height: BEAT_STRIP }}
                  aria-hidden
                >
                  {beatTicks(beat.grid, cutTimes, Math.max(totalDuration, live.total), scale).map(
                    ({ t, hit }) => (
                      <div
                        key={t}
                        style={{ left: t * scale, height: hit ? BEAT_STRIP : 3 }}
                        className={cn("absolute bottom-0 w-px", hit ? "bg-signal-500" : "bg-ink-600")}
                      />
                    ),
                  )}
                </div>
              )}
            </div>

            {/* Layer lanes */}
            {layerLanes.map((laneNumber) => (
              <div
                key={laneNumber}
                onClick={seekFromEvent}
                style={{ height: lanes.layer }}
                className="relative border-t border-[color:var(--hair-dark)] bg-ink-900/40"
              >
                {timeline.layers
                  .filter((l) => l.layer === laneNumber)
                  .map((layer) => {
                    const { start, span } = ghost("layer", layer.id, layer.startAt, layer.duration);
                    const media = mediaById.get(layer.mediaItemId);
                    const active =
                      selection.kind === "layer" && selection.id === layer.id;
                    const width = Math.max(14, span * scale);
                    return (
                      <div
                        key={layer.id}
                        onPointerDown={(e) =>
                          startDrag(e, {
                            mode: "move",
                            edge: "start",
                            target: "layer",
                            id: layer.id,
                            origin: layer.startAt,
                          })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect({ kind: "layer", id: layer.id });
                        }}
                        style={{
                          left: start * scale,
                          width,
                          backgroundImage: media?.thumbnailUrl
                            ? `url(${media.thumbnailUrl})`
                            : undefined,
                        }}
                        className={cn(
                          "group absolute inset-y-[3px] cursor-grab touch-none overflow-hidden border bg-ink-800 bg-cover bg-center",
                          active
                            ? "border-signal-500 ring-1 ring-signal-500"
                            : "border-tape-500/70 hover:border-paper-200/70",
                        )}
                      >
                        <span className="absolute inset-0 bg-ink-950/45" />
                        <span className="absolute inset-y-0 left-1 flex items-center truncate pr-3 font-mono text-2xs text-paper-100">
                          {media?.originalFilename ?? "layer"}
                        </span>
                        {width > lanes.grip * 2.5 && (
                          <>
                            <Grip
                              side="start"
                              width={lanes.grip}
                              title="Drag to start this layer later"
                              onPointerDown={(e) =>
                                startDrag(e, {
                                  mode: "resize",
                                  edge: "start",
                                  target: "layer",
                                  id: layer.id,
                                  origin: layer.startAt,
                                })
                              }
                            />
                            <Grip
                              side="end"
                              width={lanes.grip}
                              title="Drag to hold this layer for longer"
                              onPointerDown={(e) =>
                                startDrag(e, {
                                  mode: "resize",
                                  edge: "end",
                                  target: "layer",
                                  id: layer.id,
                                  origin: layer.duration,
                                })
                              }
                            />
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>
            ))}

            {/* The base track — a strip of shots you drag into order and trim in place */}
            <div
              onClick={seekFromEvent}
              style={{ height: lanes.base }}
              className="relative border-t border-[color:var(--hair-dark)]"
            >
              {timeline.clips.map((clip, index) => {
                const media = mediaById.get(clip.mediaItemId);
                const source = durations[clip.mediaItemId] ?? null;
                // The clip as the strip should show it *now*, trim in flight
                // included, so the numbers and the ghost agree with the drag.
                const shown = trim && trim.clip.id === clip.id ? trim.clip : clip;
                const duration = live.spans[clip.id] ?? clipDuration(shown, source);
                const active = selection.kind === "clip" && selection.id === clip.id;
                // What the auto-cut left on the cutting-room floor, drawn as a
                // ghost either side of the shot: now that the edges are
                // draggable it's the budget you're dragging into, and it
                // shrinks as you spend it.
                const headSpare = shown.kind === "video" ? shown.trimStart : 0;
                const tailSpare =
                  shown.kind === "video" && source !== null
                    ? Math.max(0, source - (shown.trimEnd ?? source))
                    : 0;
                // A shot whose length is nobody's but yours. Worth marking:
                // the auto-cut will never re-time it again, even on a re-cut.
                const handTimed =
                  !clip.auto.includes("timing") && (headSpare > 0.05 || tailSpare > 0.05);
                const left = (live.starts[clip.id] ?? 0) * scale;
                const width = Math.max(6, duration * scale - 2);
                const grippable = width > lanes.grip * 2.5;
                /*
                  A file straightened by hand keeps the single thumbnail: the
                  turn lives in a CSS transform `RotatedMedia` applies to an
                  element, and a background image can't be handed that without
                  also turning the block it fills. A sideways strip would be a
                  worse lie than a repeated frame.
                */
                const filmstrip =
                  media?.filmstripUrl &&
                  media.filmstripFrames &&
                  media.filmstripIntervalSeconds &&
                  !media.rotation
                    ? {
                        url: media.filmstripUrl,
                        frames: media.filmstripFrames,
                        interval: media.filmstripIntervalSeconds,
                      }
                    : null;
                return (
                  <Fragment key={clip.id}>
                    {(headSpare > 0.2 || tailSpare > 0.2) && (
                      <span
                        aria-hidden
                        style={{
                          left: left - Math.min(headSpare, 4) * scale,
                          width:
                            (Math.min(headSpare, 4) + duration + Math.min(tailSpare, 4)) * scale - 2,
                        }}
                        className="pointer-events-none absolute inset-y-1 border border-dashed border-ink-700/70"
                        title={`${formatDuration(source ?? 0)} recorded`}
                      />
                    )}
                  <button
                    key={clip.id}
                    onPointerDown={(e) => {
                      onSelect({ kind: "clip", id: clip.id });
                      startDrag(e, {
                        mode: "move",
                        edge: "start",
                        target: "clip",
                        id: clip.id,
                        origin: timeAt(e),
                      });
                    }}
                    onClick={(e) => {
                      // The lane under the shots seeks; a shot doesn't.
                      e.stopPropagation();
                      onSelect({ kind: "clip", id: clip.id });
                    }}
                    style={{ left, width }}
                    className={cn(
                      // `pan-y` rather than `none`: a horizontal gesture is a
                      // reorder, but a vertical one is the page scrolling and
                      // the strip has no business swallowing it.
                      "absolute inset-y-1 touch-pan-y overflow-hidden border text-left transition-colors",
                      active
                        ? "border-signal-500 ring-1 ring-signal-500"
                        : "border-ink-700 hover:border-paper-200/60",
                      moveDrag?.id === clip.id && "opacity-25",
                    )}
                  >
                    {filmstrip ? (
                      /*
                        The footage itself, across the block. The sprite is
                        `frames` frames one `interval` apart, so a tile that
                        wide is exactly the shot's own clock — and shifting it
                        by the in-point is all it takes to keep the picture
                        honest while the head is being dragged.
                      */
                      <div
                        aria-hidden
                        className="print-tone absolute inset-0 bg-ink-800"
                        style={{
                          backgroundImage: `url(${filmstrip.url})`,
                          backgroundSize: `${filmstrip.frames * filmstrip.interval * scale}px 100%`,
                          backgroundPositionX: `${-shown.trimStart * scale}px`,
                          backgroundRepeat: "repeat-x",
                        }}
                      />
                    ) : media?.thumbnailUrl ? (
                      <RotatedMedia rotation={media.rotation}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={media.thumbnailUrl}
                          alt=""
                          className="print-tone h-full w-full object-cover"
                          draggable={false}
                        />
                      </RotatedMedia>
                    ) : (
                      <div className="h-full w-full bg-ink-800 bg-hatch" />
                    )}

                    <span className="pointer-events-none absolute left-0 top-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                      {String(index + 1).padStart(2, "0")}
                    </span>

                    {/* The transition used to be a badge down here; it lives
                        on the boundary marker above now, where the cut is. */}
                    <span className="pointer-events-none absolute bottom-0 left-0 flex gap-px">
                      {handTimed && (
                        <span
                          className="bg-ink-950/80 px-1 font-mono text-2xs text-paper-200"
                          title="Trimmed by hand — the auto-cut won't re-time it"
                        >
                          ✂
                        </span>
                      )}
                      {clip.muted && (
                        <span
                          className="bg-ink-950/80 px-1 font-mono text-2xs text-ink-300"
                          title="Silent"
                        >
                          ✕♪
                        </span>
                      )}
                      {clip.titles.length > 0 && (
                        <span
                          className="bg-tape-500 px-1 font-mono text-2xs text-ink-900"
                          title="Has a title"
                        >
                          T
                        </span>
                      )}
                    </span>

                    {/*
                      Below a couple of grip widths the two handles would be the
                      whole shot and there'd be nothing left to grab for the
                      reorder. Zoom is the answer to a shot too small to trim.
                    */}
                    {grippable && (
                      <>
                        <Grip
                          side="start"
                          width={lanes.grip}
                          title={
                            clip.kind === "video"
                              ? `Drag to move the in-point${headSpare > 0.05 ? ` — ${formatFine(headSpare)} spare` : ""}`
                              : "Drag to shorten the hold"
                          }
                          onPointerDown={(e) => {
                            // Selecting on the grab rather than on the click
                            // that may follow it: the inspector should already
                            // be showing this shot by the time the edge moves.
                            onSelect({ kind: "clip", id: clip.id });
                            startDrag(e, {
                              mode: "resize",
                              edge: "start",
                              target: "clip",
                              id: clip.id,
                              origin: 0,
                            });
                          }}
                        />
                        <Grip
                          side="end"
                          width={lanes.grip}
                          title={
                            clip.kind === "video"
                              ? `Drag to move the out-point${tailSpare > 0.05 ? ` — ${formatFine(tailSpare)} spare` : ""}`
                              : "Drag to lengthen the hold"
                          }
                          onPointerDown={(e) => {
                            onSelect({ kind: "clip", id: clip.id });
                            startDrag(e, {
                              mode: "resize",
                              edge: "end",
                              target: "clip",
                              id: clip.id,
                              origin: 0,
                            });
                          }}
                        />
                      </>
                    )}
                  </button>
                  </Fragment>
                );
              })}

              {/*
                The cuts themselves, as something you can point at.
                A transition belongs *between* two shots — it was a badge
                painted inside the second one, which is where the document
                keeps it but not where anyone looks for it. The marker sits on
                the boundary and only occupies the top of the lane, so the trim
                grips underneath it keep their full hit zone.
              */}
              {!dragging &&
                timeline.clips.slice(1).map((clip, i) => {
                  const at = (live.starts[clip.id] ?? 0) * scale;
                  const over = overlapsPrevious(clip.transitionIn);
                  const open = transitionAt === clip.id;
                  // A cut belongs to the two shots either side of it, so
                  // selecting either one lights it: the shot you're working on
                  // shows you the join you can change.
                  const adjacent =
                    selection.kind === "clip" &&
                    (selection.id === clip.id || selection.id === timeline.clips[i]?.id);
                  return (
                    <button
                      key={`cut-${clip.id}`}
                      type="button"
                      aria-expanded={open}
                      aria-label={`${TRANSITION_LABELS[clip.transitionIn]} into this shot`}
                      title={`${TRANSITION_LABELS[clip.transitionIn]} — tap to change`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setTransitionAt(open ? null : clip.id);
                      }}
                      style={{
                        left: at - lanes.marker / 2,
                        top: 2,
                        width: lanes.marker,
                        height: lanes.marker,
                      }}
                      className={cn(
                        "absolute z-20 flex items-center justify-center border font-mono text-2xs leading-none transition-opacity",
                        over || open
                          ? "border-tape-500 bg-ink-950/90 text-paper-100"
                          : "border-ink-600 bg-ink-950/70 text-ink-400",
                        // A hard cut is the norm and shouldn't shout, but it
                        // was invisible until hovered and nobody finds a
                        // control they can't see. Half-lit always — on a
                        // pointer as on a phone — and full when you're either
                        // on it or on a shot it joins.
                        !over &&
                          !open &&
                          (adjacent
                            ? "opacity-100"
                            : "opacity-50 hover:opacity-100 focus-visible:opacity-100"),
                      )}
                    >
                      <span aria-hidden>{over ? TRANSITION_GLYPHS[clip.transitionIn] : "◆"}</span>
                    </button>
                  );
                })}

              {transitionClip && (
                <TransitionPopover
                  clip={transitionClip}
                  left={(live.starts[transitionClip.id] ?? 0) * scale}
                  top={lanes.marker + 4}
                  onDispatch={onDispatch}
                  onClose={() => setTransitionAt(null)}
                />
              )}

              {/*
                The readout rides with the edge being dragged. Without it the
                only place to read the new in-point is the inspector, which is
                the wrong direction to be looking while your hand is here.
              */}
              {trim && (
                <span
                  style={{
                    left: clamp(
                      ((live.starts[trim.clip.id] ?? 0) + (trim.edge === "end" ? trim.span : 0)) *
                        scale -
                        60,
                      0,
                      Math.max(0, contentWidth - 150),
                    ),
                  }}
                  className="pointer-events-none absolute top-1 z-20 whitespace-nowrap border border-[color:var(--hair-dark)] bg-ink-950/90 px-1.5 py-0.5 font-mono text-2xs tabular-nums text-paper-100"
                >
                  {trimReadout(trim.clip, trim.source, trim.span)}
                </span>
              )}

              {moveDrag && dropGap !== null && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-signal-500"
                  style={{ left: boundaryAt(dropGap, timeline, live.starts, durations) * scale }}
                >
                  <span className="absolute top-1 left-1 bg-signal-600 px-1 font-mono text-2xs tabular-nums text-paper-50">
                    {String(landingIndex(moveDrag.id, dropGap, timeline) + 1).padStart(2, "0")}
                  </span>
                </div>
              )}
            </div>

            {/* Audio lanes */}
            {timeline.audio.map((track) => {
              const span = audioTrackSpan(track, totalDuration);
              const ghosted = ghost("audio", track.id, track.startAt, span);
              const active = selection.kind === "audio" && selection.id === track.id;
              const width = Math.max(14, ghosted.span * scale);
              return (
                <div
                  key={track.id}
                  onClick={seekFromEvent}
                  style={{ height: lanes.audio }}
                  className="relative border-t border-[color:var(--hair-dark)] bg-ink-900/40"
                >
                  <div
                    onPointerDown={(e) =>
                      startDrag(e, {
                        mode: "move",
                        edge: "start",
                        target: "audio",
                        id: track.id,
                        origin: track.startAt,
                      })
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect({ kind: "audio", id: track.id });
                    }}
                    style={{ left: ghosted.start * scale, width }}
                    className={cn(
                      "absolute inset-y-[3px] flex cursor-grab touch-none items-center overflow-hidden border px-1",
                      track.muted && "opacity-40",
                      active
                        ? "border-signal-500 bg-signal-900/50 ring-1 ring-signal-500"
                        // leader-900 isn't in the palette, so the old class
                        // compiled away and the track blocks had no fill.
                        : "border-leader-500/60 bg-leader-600/25 hover:border-paper-200/70",
                    )}
                  >
                    <Waveform
                      shape={audioShape(track, mediaById, musicById)}
                      offset={track.offset}
                      span={ghosted.span}
                      scale={scale}
                      loop={track.loop}
                    />
                    {/*
                      The name sits over the wave rather than beside it: the
                      lane is 30px on a desk and splitting it would leave
                      neither legible.
                    */}
                    <span className="relative truncate bg-ink-950/45 px-0.5 font-mono text-2xs text-paper-200">
                      {audioTrackLabel(track, mediaById, musicById)}
                    </span>
                    {width > lanes.grip * 2.5 && (
                      <>
                        <Grip
                          side="start"
                          width={lanes.grip}
                          title="Drag to bring this track in later"
                          onPointerDown={(e) =>
                            startDrag(e, {
                              mode: "resize",
                              edge: "start",
                              target: "audio",
                              id: track.id,
                              origin: track.startAt,
                            })
                          }
                        />
                        <Grip
                          side="end"
                          width={lanes.grip}
                          title="Drag to run this track for longer"
                          onPointerDown={(e) =>
                            startDrag(e, {
                              mode: "resize",
                              edge: "end",
                              target: "audio",
                              id: track.id,
                              origin: span,
                            })
                          }
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Playhead, drawn over every lane so the lanes read as one clock. */}
            <div
              className="pointer-events-none absolute top-0 z-10 w-px bg-signal-500"
              style={{ left: playheadTime * scale, bottom: 0 }}
            >
              <div className="-ml-1 h-1.5 w-2 bg-signal-500" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The transition on one cut, picked where the cut is.
 *
 * Same grid, same labels and same slider as the inspector's "Comes in on" —
 * this is the short way round to it, not a second opinion about it. Both
 * dispatch `clip.update` on the shot the transition brings in, so the reducer
 * clears the auto-cut's claim on the field exactly once either way.
 */
function TransitionPopover({
  clip,
  left,
  top,
  onDispatch,
  onClose,
}: {
  clip: Clip;
  /** Where the cut is, in lane pixels; the card is centred under it. */
  left: number;
  top: number;
  onDispatch: (op: TimelineOp) => void;
  onClose: () => void;
}) {
  const ref = useDialog<HTMLDivElement>(onClose);

  // Escape and the focus dance come from the hook; a click anywhere else is
  // the other half of what a popover owes the pointer.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    // Capture, because the strip's own lanes stop pointer events on the way up.
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [ref, onClose]);

  const patch = (patch: Partial<Clip>) =>
    onDispatch({ type: "clip.update", clipId: clip.id, patch });

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Transition on this cut"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ left: Math.max(0, left - 108), top, width: 216 }}
      className="absolute z-30 border border-[color:var(--hair-dark)] bg-ink-950/95 p-2 shadow-print outline-none"
    >
      <p className="eyebrow-light mb-1.5">Comes in on</p>
      <div className="grid grid-cols-2 gap-px border border-[color:var(--hair-dark)]">
        {TRANSITIONS.map((mode) => (
          <button
            key={mode}
            type="button"
            title={TRANSITION_LABELS[mode]}
            onClick={() => {
              patch({ transitionIn: mode });
              if (!overlapsPrevious(mode)) onClose();
            }}
            className={cn(
              "flex items-center justify-center gap-1.5 py-2 font-mono text-2xs uppercase tracking-label transition-colors",
              // A cut is the norm, so it gets the full width and sits apart
              // from the eleven ways of not cutting.
              mode === "cut" && "col-span-2",
              clip.transitionIn === mode
                ? "bg-signal-600 text-paper-50"
                : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
            )}
          >
            <span aria-hidden>{TRANSITION_GLYPHS[mode]}</span>
            {TRANSITION_LABELS[mode]}
          </button>
        ))}
      </div>
      {overlapsPrevious(clip.transitionIn) && (
        <label className="mt-2 block">
          <span className="timecode text-2xs text-ink-300">
            Over {clip.transitionDuration.toFixed(1)}s
          </span>
          <input
            type="range"
            min={0.2}
            max={2}
            step={0.1}
            value={clip.transitionDuration}
            onChange={(e) => patch({ transitionDuration: Number(e.target.value) })}
            className="slider slider-dark mt-1.5"
          />
        </label>
      )}
    </div>
  );
}

/**
 * An edge you can take hold of.
 *
 * The painted hairline matches the design's language; the hit zone around it is
 * several times wider, because the thing being aimed at is a boundary with no
 * width at all. On touch that zone is wide enough for a thumb without the
 * handle looking like a button.
 */
function Grip({
  side,
  width,
  title,
  onPointerDown,
}: {
  side: "start" | "end";
  width: number;
  title: string;
  onPointerDown: (event: React.PointerEvent) => void;
}) {
  return (
    <span
      onPointerDown={onPointerDown}
      title={title}
      style={{ width }}
      className={cn(
        "group/grip absolute inset-y-0 z-10 flex cursor-ew-resize touch-none items-stretch",
        side === "start" ? "left-0 justify-start" : "right-0 justify-end",
      )}
    >
      <span className="w-[3px] bg-paper-100/30 transition-colors group-hover/grip:bg-signal-500" />
    </span>
  );
}

/**
 * The envelope behind a track's name, and how long the file it came from runs.
 *
 * The peaks are evenly spaced across the whole file, so the rate is read back
 * out of the pair rather than hard-coded to the worker's — a track measured at
 * a different density still lands in the right place.
 */
interface AudioShape {
  peaks: number[];
  /** Peaks per second. */
  rate: number;
  sourceDuration: number;
}

function audioShape(
  track: AudioTrack,
  mediaById: Map<string, MediaItemView>,
  musicById: Map<string, MusicItemView>,
): AudioShape | null {
  const source = track.mediaItemId
    ? mediaById.get(track.mediaItemId)
    : track.musicItemId
      ? musicById.get(track.musicItemId)
      : null;
  if (!source) return null;

  const peaks = source.peaks;
  if (!Array.isArray(peaks) || peaks.length === 0) return null;

  const duration =
    ("durationSeconds" in source ? source.durationSeconds : source.audioDurationSeconds) ?? null;
  if (!duration || duration <= 0) return null;

  return { peaks, rate: peaks.length / duration, sourceDuration: duration };
}

/**
 * A track drawn as its own sound.
 *
 * One bar every couple of pixels, sampled at the time each pixel stands for —
 * so the wave is anchored to the clock rather than stretched to the block, and
 * it slides correctly under the head grip and under a change of offset. A
 * looping track wraps its time back round the file, which costs one modulo and
 * is the difference between a cue that repeats and a wave that lies.
 */
function Waveform({
  shape,
  offset,
  span,
  scale,
  loop,
}: {
  shape: AudioShape | null;
  offset: number;
  span: number;
  scale: number;
  loop: boolean;
}) {
  const path = useMemo(() => {
    if (!shape) return null;
    const width = Math.max(1, Math.round(span * scale));
    const step = 2;
    let d = "";
    for (let x = 0; x < width; x += step) {
      let t = offset + x / scale;
      if (loop && shape.sourceDuration > 0) t %= shape.sourceDuration;
      const index = Math.floor(t * shape.rate);
      const value = index >= 0 && index < shape.peaks.length ? shape.peaks[index] : 0;
      // Never nothing: a silent stretch still has to read as a track.
      const half = Math.max(0.8, value * 46);
      d += `M${x} ${50 - half}V${50 + half}`;
    }
    return { d, width };
  }, [shape, offset, span, scale, loop]);

  if (!path) return null;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full text-leader-300/70"
      viewBox={`0 0 ${path.width} 100`}
      preserveAspectRatio="none"
    >
      <path d={path.d} stroke="currentColor" strokeWidth={1.2} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function audioTrackLabel(
  track: AudioTrack,
  mediaById: Map<string, MediaItemView>,
  musicById: Map<string, MusicItemView>,
): string {
  if (track.mediaItemId) return mediaById.get(track.mediaItemId)?.originalFilename ?? "Audio file";
  if (track.musicItemId) {
    const item = musicById.get(track.musicItemId);
    return item?.title ?? item?.url ?? "Track";
  }
  return "No score";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Hand edits land on the same grids the rest of the document uses — two places
 * for source time, matching the inspector, three for the film's clock,
 * matching the auto-cut. Floats that don't round-trip through jsonb churn a
 * revision every time anybody votes.
 */
function round2(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

function round3(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}


/**
 * What a trim handle commits, or null when the edge didn't actually move.
 *
 * A video's edges are points in the source file, so the spare footage either
 * side is a real budget and the constraint is the recording. A photo has no
 * source: both edges only set how long the still holds, and the head shortens
 * from the front so the strip behaves the same way under the hand. Video whose
 * length we haven't measured yet falls in with the photos — we can't claim
 * there's more footage than we can see.
 */
function trimPatch(
  clip: Clip,
  source: number | null,
  edge: "start" | "end",
  delta: number,
): Partial<Omit<Clip, "id">> | null {
  const bound = clip.kind === "video" ? source ?? clip.trimEnd : null;

  if (bound !== null) {
    const end = clip.trimEnd ?? bound;
    if (edge === "start") {
      const value = round2(clamp(quantize(clip.trimStart + delta), 0, end - MIN_CLIP_SPAN));
      return value === clip.trimStart ? null : { trimStart: value };
    }
    const value = round2(clamp(quantize(end + delta), clip.trimStart + MIN_CLIP_SPAN, bound));
    return value === end ? null : { trimEnd: value };
  }

  const held = clipDuration(clip, source);
  const value = round2(Math.max(MIN_CLIP_SPAN, quantize(edge === "start" ? held - delta : held + delta)));
  return value === clip.duration ? null : { duration: value };
}

/** Same numbers the drag is applying, said out loud. */
function trimReadout(clip: Clip, source: number | null, span: number): string {
  if (clip.kind !== "video" || source === null) return `Hold ${span.toFixed(1)}s`;
  const end = clip.trimEnd ?? source;
  return `In ${formatFine(clip.trimStart)} · Out ${formatFine(end)} — ${span.toFixed(1)}s of ${formatDuration(source)}`;
}

/**
 * Trimming a block's head on the bench moves where it lands in the film and
 * leaves its tail alone. It deliberately doesn't touch the in-point into the
 * source — where playback begins is its own control in the inspector, and a
 * nudge on the bench silently re-cueing a layer would be a nasty surprise.
 */
function headPatch(startAt: number, span: number, head: number): { startAt: number; duration: number } {
  const end = startAt + span;
  const start = Math.min(head, end - MIN_CLIP_SPAN);
  return { startAt: round3(start), duration: Math.max(MIN_CLIP_SPAN, round3(end - start)) };
}

/**
 * Clip geometry, optionally with one shot's length overridden for a drag in
 * flight. Same walk as `clipStartTimes` — the base track is a sequence, so
 * every position downstream of a trim depends on it.
 */
function layout(
  timeline: TimelineDoc,
  durations: Record<string, number | null>,
  override: { id: string; span: number } | null,
): { starts: Record<string, number>; spans: Record<string, number>; total: number } {
  const starts: Record<string, number> = {};
  const spans: Record<string, number> = {};
  let cursor = 0;
  timeline.clips.forEach((clip, index) => {
    const span =
      override && override.id === clip.id
        ? override.span
        : clipDuration(clip, durations[clip.mediaItemId]);
    if (index > 0 && overlapsPrevious(clip.transitionIn)) {
      cursor -= Math.min(clip.transitionDuration, cursor);
    }
    starts[clip.id] = cursor;
    spans[clip.id] = span;
    cursor += span;
  });
  return { starts, spans, total: Math.max(0, cursor) };
}

/**
 * The beats to draw, and which of them a cut landed on.
 *
 * Thinned out when the pulse is tighter than the eye can separate — except for
 * the beats a cut actually hit, which are the whole point of the strip and are
 * drawn at every zoom.
 */
function beatTicks(
  grid: BeatGrid,
  cuts: number[],
  total: number,
  scale: number,
): { t: number; hit: boolean }[] {
  const gap = (60 / grid.bpm) * scale;
  const stride = gap >= MIN_BEAT_GAP ? 1 : Math.ceil(MIN_BEAT_GAP / gap);
  return beatsBetween(grid, 0, total)
    .map((t, i) => ({
      t,
      i,
      hit: cuts.some((c) => Math.abs(c - t) <= BEAT_HIT_WINDOW),
    }))
    .filter(({ i, hit }) => hit || i % stride === 0);
}

/** Roughly one label per 90px, on a round number of seconds. */
function ticks(total: number, scale: number): number[] {
  const target = 90 / scale;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s >= target) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= total; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

function boundaryAt(
  index: number,
  timeline: TimelineDoc,
  starts: Record<string, number>,
  durations: Record<string, number | null>,
): number {
  const clip = timeline.clips[index];
  if (clip) return starts[clip.id] ?? 0;
  const last = timeline.clips[timeline.clips.length - 1];
  if (!last) return 0;
  return (starts[last.id] ?? 0) + clipDuration(last, durations[last.mediaItemId]);
}

/** Which gap between shots a pointer at `seconds` is closest to. */
function indexAt(
  seconds: number,
  timeline: TimelineDoc,
  starts: Record<string, number>,
  durations: Record<string, number | null>,
): number {
  for (let i = 0; i < timeline.clips.length; i++) {
    const clip = timeline.clips[i];
    const start = starts[clip.id] ?? 0;
    const mid = start + clipDuration(clip, durations[clip.mediaItemId]) / 2;
    if (seconds < mid) return i;
  }
  return timeline.clips.length;
}

/**
 * The slot a shot dropped into this gap would end up in. Pulling a shot out
 * closes the gap behind it, so every gap after its own position is one less
 * than it looks.
 */
function landingIndex(clipId: string, gap: number, timeline: TimelineDoc): number {
  const from = timeline.clips.findIndex((c) => c.id === clipId);
  return gap > from ? gap - 1 : gap;
}
