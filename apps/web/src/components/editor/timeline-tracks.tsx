"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_LAYERS,
  MIN_CLIP_SPAN,
  TRANSITION_GLYPHS,
  TRANSITION_LABELS,
  audioTrackSpan,
  clipDuration,
  clipStartTimes,
  formatDuration,
  formatFine,
  overlapsPrevious,
  type AudioTrack,
  type Clip,
  type Scene,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { useIsTouch } from "@/hooks/use-media-query";
import { makeSnap, quantize } from "@/lib/snap";
import { cn } from "@/lib/cn";
import { AnchoredPopover } from "./anchored-popover";
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
  desk: { scene: 21, ruler: 22, layer: 34, base: 78, audio: 30, gutter: "w-[74px]", grip: 14 },
  touch: { scene: 28, ruler: 26, layer: 44, base: 88, audio: 40, gutter: "w-[52px]", grip: 26 },
} as const;

const MIN_SCALE = 6;
const MAX_SCALE = 140;

/**
 * Where the playhead lands when the strip turns the page, as a fraction of the
 * visible width. Left of centre because the interesting part of a film is the
 * part that hasn't played yet: a centred playhead spends half the strip on
 * footage you've just watched.
 */
const PAGE_INSET = 0.15;

/** A shot with the run of its file to itself — everything but a split half. */
const FULL_SOURCE = { lo: 0, hi: Infinity };

/**
 * What the strip toolbar can add. One order, one set of words, used by the
 * buttons here and by the sheet the bench puts up on a phone — so the two
 * can't drift apart.
 */
export type AddKind = "layer" | "sound";

export const ADD_KINDS: { kind: AddKind; label: string }[] = [
  { kind: "layer", label: "+ Layer" },
  { kind: "sound", label: "+ Sound" },
];

export function TimelineTracks({
  timeline,
  mediaById,
  music,
  durations,
  totalDuration,
  selection,
  onSelect,
  onDispatch,
  onReorderClip,
  playheadTime,
  onSeek,
  onBackToGather,
  addOpen,
  onAddOpenChange,
  renderAddPicker,
  anchoredPickers,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  music: MusicItemView[];
  durations: Record<string, number | null>;
  totalDuration: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onDispatch: (op: TimelineOp) => void;
  /**
   * Dropping a shot somewhere else in the order is the floor's business, not
   * the document's: `syncCut` rebuilds the order from the `selections` table,
   * so a `clip.move` here survived exactly until the next vote.
   */
  onReorderClip: (clipId: string, toIndex: number) => void;
  playheadTime: number;
  onSeek: (t: number) => void;
  onBackToGather?: () => void;
  /**
   * The add-verbs live on the strip toolbar because what they add lands on the
   * strip, but the bench owns the state: below `md` the same pickers come up as
   * a sheet instead of a popover, and only the bench knows which it is.
   */
  addOpen: AddKind | null;
  onAddOpenChange: (kind: AddKind | null) => void;
  renderAddPicker: (kind: AddKind, done: () => void) => React.ReactNode;
  /** md and up: hang the picker off its button. Below, the bench sheets it. */
  anchoredPickers: boolean;
}) {
  const touch = useIsTouch();
  const lanes = touch ? LANES.touch : LANES.desk;
  const [scale, setScale] = useState(28);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Where the shots sit as stored. The magnets snap to these rather than to the
   * live layout below: a trim in flight moves every later cut, and magnets that
   * slide around under the pointer are worse than no magnets.
   */
  const committed = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);
  const musicById = useMemo(() => new Map(music.map((m) => [m.id, m])), [music]);

  /**
   * How far into its source each shot is allowed to reach.
   *
   * A file usually has exactly one shot in the cut and the answer is "all of
   * it". A shot that has been split shares its file with its other half, and
   * the footage on the far side of that boundary belongs to the sibling: drawn
   * as spare it would read as "there's more where that came from", and dragged
   * into it the two halves would play the same seconds twice.
   *
   * Siblings are ordered by where they sit in the *file*, never in the strip —
   * a half moved somewhere else in the running order still owns its own
   * seconds.
   */
  const sourceWindows = useMemo(() => {
    const shots = new Map<string, number>();
    for (const clip of timeline.clips) {
      shots.set(clip.mediaItemId, (shots.get(clip.mediaItemId) ?? 0) + 1);
    }

    const windows = new Map<string, { lo: number; hi: number }>();
    timeline.clips.forEach((clip, index) => {
      const source = durations[clip.mediaItemId] ?? null;
      const full = { lo: 0, hi: source ?? Infinity };
      if (clip.kind !== "video" || (shots.get(clip.mediaItemId) ?? 0) < 2) {
        windows.set(clip.id, full);
        return;
      }
      const end = clip.trimEnd ?? full.hi;
      let { lo, hi } = full;
      timeline.clips.forEach((other, i) => {
        if (i === index || other.mediaItemId !== clip.mediaItemId) return;
        const otherEnd = other.trimEnd ?? full.hi;
        if (otherEnd <= clip.trimStart) lo = Math.max(lo, otherEnd);
        else if (other.trimStart >= end) hi = Math.min(hi, other.trimStart);
      });
      windows.set(clip.id, { lo, hi });
    });
    return windows;
  }, [timeline.clips, durations]);

  /** Everything, for a shot whose file is nobody else's. */
  const windowFor = (clipId: string) => sourceWindows.get(clipId) ?? FULL_SOURCE;

  /** The scene being renamed, and the words so far. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  /**
   * Where each scene opens, on the clock.
   *
   * A scene starts at its first shot, and the transition *into* that shot is
   * the dissolve the break caused — so a marker parked here lands against the
   * dissolve it explains, which is the only place on the strip where the day
   * changing is otherwise visible at all.
   */
  const sceneMarks = useMemo(() => {
    const firstClip = new Map<string, (typeof timeline.clips)[number]>();
    for (const clip of timeline.clips) {
      if (clip.sceneId && !firstClip.has(clip.sceneId)) firstClip.set(clip.sceneId, clip);
    }
    // Ordered by where the shots sit as stored; *drawn* against the live
    // layout below, so a trim in flight carries the markers with it.
    const marks = timeline.scenes.flatMap((scene) => {
      const clip = firstClip.get(scene.id);
      return clip ? [{ scene, clip }] : [];
    });
    return marks.sort((a, b) => (committed[a.clip.id] ?? 0) - (committed[b.clip.id] ?? 0));
  }, [timeline.clips, timeline.scenes, committed]);

  function commitRename(scene: Scene) {
    // Enter commits and closes the box, which then blurs — so the guard is what
    // stops one rename going out twice, and what makes Escape mean Escape.
    if (renaming !== scene.id) return;
    const name = draftName.trim();
    setRenaming(null);
    if (!name || name === scene.name) return;
    onDispatch({ type: "scene.rename", sceneId: scene.id, name });
  }

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
  };
  // The drag lives in a ref as well as in state: state so the ghost follows the
  // pointer, the ref so the pointerup handler can commit it without reading
  // state from inside an updater — which would dispatch mid-render.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const next = { ...current, delta: (event.clientX - current.pointerX) / scale };
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
        // A trim that rounds to nothing dispatches nothing: `clip.update`
        // hands the shot's timing away from the auto-cut for good, and a
        // fumbled grab shouldn't be able to do that silently.
        const patch = trimPatch(
          clip,
          durations[clip.mediaItemId] ?? null,
          current.edge,
          current.delta,
          windowFor(clip.id),
        );
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
                ? {
                    duration: Math.max(
                      MIN_CLIP_SPAN,
                      round3(snap(layer.startAt + value) - layer.startAt),
                    ),
                  }
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
                ? {
                    duration: Math.max(
                      MIN_CLIP_SPAN,
                      round3(snap(track.startAt + value) - track.startAt),
                    ),
                  }
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
  }, [dragging, scale, snap, timeline, durations, totalDuration, onDispatch]);

  function startDrag(event: React.PointerEvent, spec: Omit<Drag, "pointerX" | "delta">) {
    event.stopPropagation();
    // Also what stops the native drag-and-drop reorder starting from a grip:
    // the shot's block is `draggable`, and a suppressed `mousedown` never
    // becomes a `dragstart`.
    event.preventDefault();
    const next = { ...spec, pointerX: event.clientX, delta: 0 };
    dragRef.current = next;
    setDrag(next);
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
    const patch = trimPatch(clip, source, drag.edge, drag.delta, windowFor(clip.id));
    const shown = patch ? { ...clip, ...patch } : clip;
    return { clip: shown, edge: drag.edge, source, span: clipDuration(shown, source) };
  })();

  /**
   * Positions including that trim. The base track is a sequence, so shortening
   * one shot pulls every shot after it earlier — a ghost floating over its
   * neighbours would be lying about what letting go does.
   */
  const live = layout(timeline, durations, trim && { id: trim.clip.id, span: trim.span });

  const empty = timeline.clips.length === 0;

  const contentWidth = Math.max(320, Math.max(totalDuration, live.total) * scale);

  // --- following the playhead ----------------------------------------------
  /*
   * The strip turns the page rather than panning under the playhead: a strip
   * that scrolls continuously is a strip whose footage never stops moving, and
   * a shot you can't read is a shot you can't decide about. So the view holds
   * still until the playhead walks off the end of it, then turns the page.
   *
   * Following goes off the moment the strip is scrolled by hand — someone
   * looking at a shot elsewhere while the film plays is exactly the person a
   * strip that yanks itself back would ruin. It comes back at the next seek or
   * selection, or when the playhead they went to look at leaves the view again
   * under its own steam.
   */
  const follow = useRef(true);
  const sawPlayhead = useRef(true);
  /** Set across a scroll we caused, so it doesn't read as the person's. */
  const selfScroll = useRef(false);

  /*
   * Where the strip is scrolled to, cached rather than measured.
   *
   * The clock publishes thirty times a second and the whole bench re-renders
   * with it; asking the node for its scroll offset on each of those is a
   * layout read in the middle of playback, and the answer is one we already
   * know. Only two things move this box — a hand, which fires `scroll`, and
   * the page turn below — so the cache stays exact as long as both write it.
   */
  const view = useRef({ left: 0, width: 0 });

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const measure = () => {
      view.current = { left: box.scrollLeft, width: box.clientWidth };
    };
    measure();
    // Fires once on observe, which is also how the cache gets its first width.
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
    // The strip only has a node once something has made the cut.
  }, [empty]);

  function playheadVisible(): boolean {
    const x = playheadTime * scale;
    return x >= view.current.left && x <= view.current.left + view.current.width;
  }

  /** Turn the page, putting the playhead an inset in from the left edge. */
  function turnPageTo(time: number) {
    const box = scrollRef.current;
    if (!box) return;
    const left = clamp(
      time * scale - view.current.width * PAGE_INSET,
      0,
      Math.max(0, contentWidth - view.current.width),
    );
    // A turn that lands where we already are — the last page of a short film —
    // never fires `scroll`, and the flag left standing would swallow the
    // person's next one.
    if (Math.abs(left - view.current.left) < 1) return;
    selfScroll.current = true;
    view.current.left = left;
    box.scrollLeft = left;
  }

  function keepPlayheadInView() {
    // A drag in flight owns the pointer and the view alike; moving the ground
    // under it would send the block somewhere nobody asked for.
    if (!scrollRef.current || dragRef.current) return;
    const visible = playheadVisible();
    if (follow.current) {
      if (!visible) turnPageTo(playheadTime);
      return;
    }
    // Following is off. Coming back to the playhead is how it's re-armed
    // without a click: once it's in view again, its next exit is the film
    // leaving *you* behind rather than the strip dragging you away.
    if (visible) {
      sawPlayhead.current = true;
      return;
    }
    if (sawPlayhead.current) {
      follow.current = true;
      turnPageTo(playheadTime);
    }
  }

  /** A seek or a selection is the person pointing at a moment: go there. */
  function resumeFollow() {
    follow.current = true;
    sawPlayhead.current = true;
  }

  useEffect(keepPlayheadInView, [playheadTime, scale]);

  // Picking a shot is asking to be shown it, whether it was picked here or
  // from the keyboard.
  const selectionKey = selection.kind === "none" ? "none" : `${selection.kind}:${selection.id}`;
  useEffect(() => {
    resumeFollow();
    keepPlayheadInView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  function onScroll() {
    const box = scrollRef.current;
    if (!box) return;
    view.current.left = box.scrollLeft;
    if (selfScroll.current) {
      selfScroll.current = false;
      return;
    }
    /*
     * Everything else is a hand on the strip, including the scroll the browser
     * makes for itself when zooming out shortens the strip under an
     * over-scrolled box. That one needs no special case: it pulls the view
     * towards the end the playhead is already near, so it leaves the playhead
     * in sight, and a playhead in sight re-arms the following the moment the
     * film walks off the edge again.
     */
    follow.current = false;
    sawPlayhead.current = playheadVisible();
  }

  function seekFromEvent(event: React.MouseEvent) {
    const box = laneRef.current?.getBoundingClientRect();
    if (!box) return;
    resumeFollow();
    onSeek(clamp((event.clientX - box.left) / scale, 0, totalDuration));
  }

  if (empty) {
    return (
      <div className="border border-[color:var(--hair-dark)] bg-ink-850 bg-hatch px-6 py-12 text-center">
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
    /*
      Capped rather than sized by its lanes: four layers and three cues would
      otherwise push the picture off the bottom of the window. Past the cap the
      lanes scroll against themselves — the page never does.
    */
    <section className="flex min-h-0 flex-col border border-[color:var(--hair-dark)] bg-ink-850 xl:max-h-[42dvh]">
      {/*
        The toolbar sits outside the scroll, so the pickers that hang off it
        aren't clipped by the cap below — and so the zoom stays reachable
        however far down the lanes you've scrolled.
      */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--hair-dark)] px-2 py-1.5 sm:px-3 sm:py-2">
        {/*
          The verbs sit on the thing they act on. "Reel 02 · Strip" was
          decoration in the one place a friend looks for "how do I add
          something?", and the answer used to be a tab away in a side column
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
          <p className="eyebrow-light hidden lg:block">
            Drag shots to reorder · drag their edges to trim
          </p>
          <div className="flex items-stretch border border-[color:var(--hair-dark)]">
            <button
              onClick={() => setScale((s) => clamp(s / 1.5, MIN_SCALE, MAX_SCALE))}
              className="flex min-h-[34px] min-w-[34px] items-center justify-center px-2 font-mono text-[13px] text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper-100"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              onClick={() => setScale((s) => clamp(s * 1.5, MIN_SCALE, MAX_SCALE))}
              className="flex min-h-[34px] min-w-[34px] items-center justify-center border-l border-[color:var(--hair-dark)] px-2 font-mono text-[13px] text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper-100"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 xl:overflow-y-auto">
        {/* Lane names, parked outside the scroll so they're always readable. */}
        <div className={cn(lanes.gutter, "shrink-0 border-r border-[color:var(--hair-dark)]")}>
          {sceneMarks.length > 0 && (
            <div style={{ height: lanes.scene }} className="flex items-center px-2">
              <span className="eyebrow-light truncate">Scenes</span>
            </div>
          )}
          <div style={{ height: lanes.ruler }} />
          {layerLanes.map((n) => (
            <div
              key={n}
              style={{ height: lanes.layer }}
              className="flex items-center border-t border-[color:var(--hair-dark)] px-2"
            >
              <span className="eyebrow-light truncate">Layer {n}</span>
            </div>
          ))}
          <div
            style={{ height: lanes.base }}
            className="flex items-center border-t border-[color:var(--hair-dark)] px-2"
          >
            <span className="eyebrow-light">Picture</span>
          </div>
          {timeline.audio.map((track, i) => (
            <div
              key={track.id}
              style={{ height: lanes.audio }}
              className="flex items-center border-t border-[color:var(--hair-dark)] px-2"
            >
              <span className="eyebrow-light truncate">
                {track.role === "bed" ? "Bed" : `Snd ${i + 1}`}
              </span>
            </div>
          ))}
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scrollbar-thin scrollbar-dark touch-scroll-x min-w-0 flex-1 overflow-x-auto"
        >
          <div ref={laneRef} className="relative" style={{ width: contentWidth }}>
            {/*
              Scene markers, sitting above the ruler because a scene is a fact
              about the clock rather than about any one lane. Each one is a
              button until you click it, and a text box after — the derived
              name is only ever a first guess.
            */}
            {sceneMarks.length > 0 && (
              <div style={{ height: lanes.scene }} className="relative select-none">
                {sceneMarks.map(({ scene, clip }, i) => {
                  const at = live.starts[clip.id] ?? 0;
                  const next = sceneMarks[i + 1];
                  const nextAt = next ? live.starts[next.clip.id] ?? 0 : live.total;
                  // Never wider than the scene itself, so a run of short scenes
                  // reads as several marks rather than one long smear.
                  const room = (nextAt - at) * scale - 4;
                  return (
                    <div
                      key={scene.id}
                      style={{
                        left: at * scale,
                        // The box being typed into ignores the scene's width
                        // and rides over its neighbours: a two-second scene is
                        // still a scene you can name.
                        maxWidth: renaming === scene.id ? 220 : Math.max(40, room),
                        zIndex: renaming === scene.id ? 20 : undefined,
                      }}
                      className="absolute inset-y-0 flex items-center gap-1 pl-1"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-y-0 left-0 w-px",
                          scene.newDay ? "bg-tape-500" : "bg-ink-600",
                        )}
                      />
                      {overlapsPrevious(clip.transitionIn) && (
                        <span
                          className="shrink-0 font-mono text-2xs text-ink-500"
                          title={`${TRANSITION_LABELS[clip.transitionIn]} into this scene`}
                        >
                          {TRANSITION_GLYPHS[clip.transitionIn]}
                        </span>
                      )}
                      {renaming === scene.id ? (
                        <input
                          autoFocus
                          value={draftName}
                          maxLength={80}
                          onChange={(e) => setDraftName(e.target.value)}
                          onBlur={() => commitRename(scene)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(scene);
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          className="min-w-0 flex-1 border border-signal-500 bg-ink-950 px-1 font-mono text-2xs uppercase tracking-label text-paper-100 outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => {
                            setDraftName(scene.name);
                            setRenaming(scene.id);
                          }}
                          title={
                            scene.auto.includes("name")
                              ? "Named from when it was shot — click to call it something else"
                              : "Click to rename this scene"
                          }
                          className={cn(
                            "min-w-0 truncate font-mono text-2xs uppercase tracking-label transition-colors hover:text-paper-100",
                            scene.auto.includes("name")
                              ? "text-ink-400"
                              : "text-tape-500",
                          )}
                        >
                          {scene.name || "Name this scene"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Ruler */}
            <div
              onClick={seekFromEvent}
              style={{ height: lanes.ruler }}
              className="relative cursor-pointer select-none"
            >
              {ticks(totalDuration, scale).map((t) => (
                <div key={t} className="absolute top-0 h-full" style={{ left: t * scale }}>
                  <div className="h-1.5 w-px bg-ink-600" />
                  <span className="ml-1 font-mono text-2xs tabular-nums text-ink-500">
                    {formatDuration(t)}
                  </span>
                </div>
              ))}
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
                        {/*
                          Below a couple of grip widths the two handles would be
                          the whole block and there'd be nothing left to grab to
                          move it. Zoom is the answer to a block too small.
                        */}
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

            {/* The base track — still a strip of shots, still drag-to-reorder */}
            <div
              style={{ height: lanes.base }}
              className="relative border-t border-[color:var(--hair-dark)]"
              onDragOver={(e) => {
                e.preventDefault();
                const box = laneRef.current?.getBoundingClientRect();
                if (!box) return;
                setDropIndex(
                  indexAt((e.clientX - box.left) / scale, timeline, live.starts, durations),
                );
              }}
              onDrop={() => {
                if (draggingClipId && dropIndex !== null) {
                  const from = timeline.clips.findIndex((c) => c.id === draggingClipId);
                  const to = dropIndex > from ? dropIndex - 1 : dropIndex;
                  if (from !== -1 && to !== from) {
                    onReorderClip(draggingClipId, to);
                  }
                }
                setDraggingClipId(null);
                setDropIndex(null);
              }}
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
                const reach = windowFor(clip.id);
                const headSpare =
                  shown.kind === "video" ? Math.max(0, shown.trimStart - reach.lo) : 0;
                const tailSpare =
                  shown.kind === "video" && source !== null
                    ? Math.max(0, Math.min(source, reach.hi) - (shown.trimEnd ?? source))
                    : 0;
                // A shot whose length is nobody's but yours. Worth marking:
                // the auto-cut will never re-time it again, even on a re-cut.
                const handTimed =
                  !clip.auto.includes("timing") && (headSpare > 0.05 || tailSpare > 0.05);
                const left = (live.starts[clip.id] ?? 0) * scale;
                const width = Math.max(6, duration * scale - 2);
                const grippable = width > lanes.grip * 2.5;
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
                    draggable
                    onDragStart={(e) => {
                      // A grip already owns the pointer: the browser is being
                      // asked to start a reorder the hand never meant.
                      if (dragRef.current) {
                        e.preventDefault();
                        return;
                      }
                      setDraggingClipId(clip.id);
                    }}
                    onDragEnd={() => {
                      setDraggingClipId(null);
                      setDropIndex(null);
                    }}
                    onClick={() => onSelect({ kind: "clip", id: clip.id })}
                    style={{ left, width }}
                    className={cn(
                      "absolute inset-y-1 overflow-hidden border text-left transition-colors",
                      active
                        ? "border-signal-500 ring-1 ring-signal-500"
                        : "border-ink-700 hover:border-paper-200/60",
                      draggingClipId === clip.id && "opacity-25",
                    )}
                  >
                    {media?.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={media.thumbnailUrl}
                        alt=""
                        className="print-tone h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <div className="h-full w-full bg-ink-800 bg-hatch" />
                    )}

                    <span className="pointer-events-none absolute left-0 top-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                      {String(index + 1).padStart(2, "0")}
                    </span>

                    <span className="pointer-events-none absolute bottom-0 left-0 flex gap-px">
                      {handTimed && (
                        <span
                          className="bg-ink-950/80 px-1 font-mono text-2xs text-paper-200"
                          title="Trimmed by hand — the auto-cut won't re-time it"
                        >
                          ✂
                        </span>
                      )}
                      {overlapsPrevious(clip.transitionIn) && index > 0 && (
                        <span
                          className="bg-ink-950/80 px-1 font-mono text-2xs text-paper-200"
                          title={`${TRANSITION_LABELS[clip.transitionIn]} in`}
                        >
                          {TRANSITION_GLYPHS[clip.transitionIn]}
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

              {draggingClipId && dropIndex !== null && (
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-signal-500"
                  style={{ left: boundaryAt(dropIndex, timeline, live.starts, durations) * scale }}
                />
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
                    <span className="truncate font-mono text-2xs text-paper-200">
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
                          title="Drag to play this track for longer"
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
  /** The stretch of source this shot owns; everything, unless it was split. */
  reach: { lo: number; hi: number } = FULL_SOURCE,
): Partial<Omit<Clip, "id">> | null {
  const bound = clip.kind === "video" ? source ?? clip.trimEnd : null;

  if (bound !== null) {
    const end = clip.trimEnd ?? bound;
    if (edge === "start") {
      const value = round2(clamp(quantize(clip.trimStart + delta), reach.lo, end - MIN_CLIP_SPAN));
      return value === clip.trimStart ? null : { trimStart: value };
    }
    const value = round2(
      clamp(quantize(end + delta), clip.trimStart + MIN_CLIP_SPAN, Math.min(bound, reach.hi)),
    );
    return value === end ? null : { trimEnd: value };
  }

  const held = clipDuration(clip, source);
  const value = round2(
    Math.max(MIN_CLIP_SPAN, quantize(edge === "start" ? held - delta : held + delta)),
  );
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
function headPatch(
  startAt: number,
  span: number,
  head: number,
): { startAt: number; duration: number } {
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
