"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_LAYERS,
  TRANSITION_GLYPHS,
  TRANSITION_LABELS,
  audioTrackSpan,
  clipDuration,
  clipStartTimes,
  formatDuration,
  overlapsPrevious,
  type AudioTrack,
  type LayerClip,
  type Scene,
  type TimelineDoc,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { useIsTouch } from "@/hooks/use-media-query";
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
 */

/**
 * Lane heights, twice.
 *
 * A 30px audio block is a comfortable target for a pointer and a miserable one
 * for a thumb, and the lane names can't take a fifth of a 375px screen. So the
 * bench has a touch set of numbers as well as a desk set.
 */
const LANES = {
  desk: { scene: 21, ruler: 22, layer: 34, base: 78, audio: 30, gutter: "w-[74px]" },
  touch: { scene: 28, ruler: 26, layer: 44, base: 88, audio: 40, gutter: "w-[52px]" },
} as const;

const MIN_SCALE = 6;
const MAX_SCALE = 140;

export function TimelineTracks({
  timeline,
  mediaById,
  music,
  durations,
  totalDuration,
  selection,
  onSelect,
  onDispatch,
  playheadTime,
  onSeek,
  onBackToGather,
}: {
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  music: MusicItemView[];
  durations: Record<string, number | null>;
  totalDuration: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onDispatch: (op: TimelineOp) => void;
  playheadTime: number;
  onSeek: (t: number) => void;
  onBackToGather?: () => void;
}) {
  const touch = useIsTouch();
  const lanes = touch ? LANES.touch : LANES.desk;
  const [scale, setScale] = useState(28);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);

  const starts = useMemo(() => clipStartTimes(timeline, durations), [timeline, durations]);
  const musicById = useMemo(() => new Map(music.map((m) => [m.id, m])), [music]);

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
    const marks = timeline.scenes.flatMap((scene) => {
      const clip = firstClip.get(scene.id);
      return clip ? [{ scene, clip, at: starts[clip.id] ?? 0 }] : [];
    });
    return marks.sort((a, b) => a.at - b.at);
  }, [timeline.clips, timeline.scenes, starts]);

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
    for (const clip of timeline.clips) points.add(starts[clip.id] ?? 0);
    return [...points].sort((a, b) => a - b);
  }, [timeline.clips, starts, totalDuration]);

  const snap = useCallback(
    (seconds: number) => {
      const tolerance = 8 / scale;
      for (const point of snapPoints) {
        if (Math.abs(point - seconds) <= tolerance) return point;
      }
      return Math.round(seconds * 20) / 20;
    },
    [snapPoints, scale],
  );

  // --- dragging blocks along the clock ------------------------------------
  type Drag = {
    mode: "move" | "resize";
    target: "layer" | "audio";
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

    const up = () => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current) return;

      const value = current.origin + current.delta;
      const start = clamp(snap(value), 0, Math.max(0, totalDuration - 0.2));

      if (current.target === "layer") {
        const layer = timeline.layers.find((l) => l.id === current.id);
        if (!layer) return;
        onDispatch({
          type: "layer.update",
          layerId: current.id,
          patch:
            current.mode === "move"
              ? { startAt: start }
              : { duration: Math.max(0.2, snap(layer.startAt + value) - layer.startAt) },
        });
      } else {
        const track = timeline.audio.find((t) => t.id === current.id);
        if (!track) return;
        onDispatch({
          type: "audio.update",
          trackId: current.id,
          patch:
            current.mode === "move"
              ? { startAt: start }
              : { duration: Math.max(0.2, snap(track.startAt + value) - track.startAt) },
        });
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, scale, snap, timeline.layers, timeline.audio, totalDuration, onDispatch]);

  function startDrag(
    event: React.PointerEvent,
    mode: Drag["mode"],
    target: Drag["target"],
    id: string,
    origin: number,
  ) {
    event.stopPropagation();
    event.preventDefault();
    const next = { mode, target, id, pointerX: event.clientX, origin, delta: 0 };
    dragRef.current = next;
    setDrag(next);
  }

  /** Where a block sits right now, including any drag in flight. */
  function ghost(target: "layer" | "audio", id: string, start: number, span: number) {
    if (!drag || drag.id !== id || drag.target !== target) return { start, span };
    if (drag.mode === "move") {
      return { start: clamp(drag.origin + drag.delta, 0, totalDuration), span };
    }
    return { start, span: Math.max(0.2, drag.origin + drag.delta) };
  }

  const contentWidth = Math.max(320, totalDuration * scale);

  function seekFromEvent(event: React.MouseEvent) {
    const box = laneRef.current?.getBoundingClientRect();
    if (!box) return;
    onSeek(clamp((event.clientX - box.left) / scale, 0, totalDuration));
  }

  if (timeline.clips.length === 0) {
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
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--hair-dark)] px-2 py-1.5 sm:px-3 sm:py-2">
        <p className="eyebrow-light">Reel 02 · Strip</p>
        <div className="flex items-center gap-2">
          <p className="eyebrow-light hidden lg:block">
            {touch ? "Drag layers to retime · tap a shot to trim it" : "Drag shots to reorder · layers to retime"}
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

      <div className="flex">
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

        <div className="scrollbar-thin scrollbar-dark touch-scroll-x min-w-0 flex-1 overflow-x-auto">
          <div ref={laneRef} className="relative" style={{ width: contentWidth }}>
            {/*
              Scene markers, sitting above the ruler because a scene is a fact
              about the clock rather than about any one lane. Each one is a
              button until you click it, and a text box after — the derived
              name is only ever a first guess.
            */}
            {sceneMarks.length > 0 && (
              <div style={{ height: lanes.scene }} className="relative select-none">
                {sceneMarks.map(({ scene, clip, at }, i) => {
                  const next = sceneMarks[i + 1];
                  // Never wider than the scene itself, so a run of short scenes
                  // reads as several marks rather than one long smear.
                  const room = ((next ? next.at : totalDuration) - at) * scale - 4;
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
                    return (
                      <div
                        key={layer.id}
                        onPointerDown={(e) => startDrag(e, "move", "layer", layer.id, layer.startAt)}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect({ kind: "layer", id: layer.id });
                        }}
                        style={{
                          left: start * scale,
                          width: Math.max(14, span * scale),
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
                        <span
                          onPointerDown={(e) =>
                            startDrag(e, "resize", "layer", layer.id, layer.duration)
                          }
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-paper-100/0 transition-colors hover:bg-paper-100/40"
                        />
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
                setDropIndex(indexAt((e.clientX - box.left) / scale, timeline, starts, durations));
              }}
              onDrop={() => {
                if (draggingClipId && dropIndex !== null) {
                  const from = timeline.clips.findIndex((c) => c.id === draggingClipId);
                  const to = dropIndex > from ? dropIndex - 1 : dropIndex;
                  if (from !== -1 && to !== from) {
                    onDispatch({ type: "clip.move", clipId: draggingClipId, toIndex: to });
                  }
                }
                setDraggingClipId(null);
                setDropIndex(null);
              }}
            >
              {timeline.clips.map((clip, index) => {
                const media = mediaById.get(clip.mediaItemId);
                const duration = clipDuration(clip, durations[clip.mediaItemId]);
                const active = selection.kind === "clip" && selection.id === clip.id;
                const source = durations[clip.mediaItemId] ?? null;
                // What the auto-cut left on the cutting-room floor, drawn as a
                // ghost either side of the shot so there's something visible to
                // reach for when a moment deserved more room.
                const headSpare = clip.kind === "video" ? clip.trimStart : 0;
                const tailSpare =
                  clip.kind === "video" && source !== null
                    ? Math.max(0, source - (clip.trimEnd ?? source))
                    : 0;
                const left = (starts[clip.id] ?? 0) * scale;
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
                    onDragStart={() => setDraggingClipId(clip.id)}
                    onDragEnd={() => {
                      setDraggingClipId(null);
                      setDropIndex(null);
                    }}
                    onClick={() => onSelect({ kind: "clip", id: clip.id })}
                    style={{
                      left: (starts[clip.id] ?? 0) * scale,
                      width: Math.max(6, duration * scale - 2),
                    }}
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

                    <span className="absolute left-0 top-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                      {String(index + 1).padStart(2, "0")}
                    </span>

                    <span className="absolute bottom-0 left-0 flex gap-px">
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
                  </button>
                  </Fragment>
                );
              })}

              {draggingClipId && dropIndex !== null && (
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-signal-500"
                  style={{ left: boundaryAt(dropIndex, timeline, starts, durations) * scale }}
                />
              )}
            </div>

            {/* Audio lanes */}
            {timeline.audio.map((track) => {
              const span = audioTrackSpan(track, totalDuration);
              const ghosted = ghost("audio", track.id, track.startAt, span);
              const active = selection.kind === "audio" && selection.id === track.id;
              return (
                <div
                  key={track.id}
                  onClick={seekFromEvent}
                  style={{ height: lanes.audio }}
                  className="relative border-t border-[color:var(--hair-dark)] bg-ink-900/40"
                >
                  <div
                    onPointerDown={(e) => startDrag(e, "move", "audio", track.id, track.startAt)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect({ kind: "audio", id: track.id });
                    }}
                    style={{
                      left: ghosted.start * scale,
                      width: Math.max(14, ghosted.span * scale),
                    }}
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
                    <span
                      onPointerDown={(e) => startDrag(e, "resize", "audio", track.id, span)}
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize transition-colors hover:bg-paper-100/40"
                    />
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
