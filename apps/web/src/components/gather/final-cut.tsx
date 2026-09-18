"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import {
  clipDuration,
  estimatedClipDuration,
  formatDuration,
  timelineDuration,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import {
  reorderCutAction,
  resetCutAction,
  setCutOverrideAction,
  setMusicBedAction,
} from "@/lib/actions/cut";
import { moveMusicAction, requestAudioExtractionAction } from "@/lib/actions/music";
import { SectionHead } from "../brand";
import { useIsTouch } from "@/hooks/use-media-query";
import { cn } from "@/lib/cn";

/**
 * The rough cut, sitting under the light table — the last lane of the same
 * page, so you never lose sight of what all the marking is *for*.
 *
 * It fills itself in from the crew's marks. Everything here is a correction:
 * drag to reorder, ✕ to drop a shot, pull one back off the floor. Each of those
 * pins that shot by hand, and Revert hands the whole thing back to the crew.
 */
export function FinalCut({
  slug,
  media,
  music,
  timeline,
  onOpenClip,
}: {
  slug: string;
  media: MediaItemView[];
  music: MusicItemView[];
  timeline: TimelineDoc;
  onOpenClip?: (item: MediaItemView) => void;
}) {
  const touch = useIsTouch();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  /** Local order while a drag settles, so the strip doesn't snap back. */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  /** Local needle while a drag settles, for the same reason. */
  const [needle, setNeedle] = useState<number | null>(null);
  const [draggingNeedle, setDraggingNeedle] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);

  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);

  const durations = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const item of media) out[item.id] = item.durationSeconds;
    return out;
  }, [media]);

  const inCut = useMemo(() => {
    const fromTimeline = timeline.clips
      .map((clip) => ({ clip, item: byId.get(clip.mediaItemId) }))
      .filter((row): row is { clip: (typeof timeline.clips)[number]; item: MediaItemView } =>
        Boolean(row.item),
      );
    if (!pendingOrder) return fromTimeline;
    const rank = new Map(pendingOrder.map((id, i) => [id, i]));
    return [...fromTimeline].sort(
      (a, b) => (rank.get(a.item.id) ?? 0) - (rank.get(b.item.id) ?? 0),
    );
  }, [timeline.clips, byId, pendingOrder]);

  /**
   * Where the trip breaks into scenes, so the strip reads as days and outings
   * rather than an undifferentiated run of thumbnails — and so the dissolves
   * the cut puts at each break have something visible to correspond to.
   *
   * Read off the document rather than worked out here: the names are the ones
   * the auto-cut chose or somebody typed on the bench, and the two rooms have
   * to be looking at the same film. A band opens wherever a shot belongs to a
   * different scene from the one before it, which stays true mid-drag while
   * the running order is still settling.
   */
  const sceneLabels = useMemo(() => {
    const names = new Map(timeline.scenes.map((s) => [s.id, s.name]));
    const out = new Map<number, string>();
    let previous: string | null = null;
    inCut.forEach(({ clip }, index) => {
      const name = clip.sceneId ? names.get(clip.sceneId) : undefined;
      if (clip.sceneId !== previous && name) out.set(index, name);
      previous = clip.sceneId;
    });
    return out;
  }, [inCut, timeline.scenes]);

  const leftOut = useMemo(() => {
    const inCutIds = new Set(timeline.clips.map((c) => c.mediaItemId));
    return media
      .filter((m) => m.kind !== "audio" && !inCutIds.has(m.id))
      .sort((a, b) => b.reactions.rank - a.reactions.rank);
  }, [media, timeline.clips]);

  const total = timelineDuration(timeline, durations);
  // The bed is the one track the crew votes on; anything else in the stack was
  // hand-placed on the bench and is only reported here, not editable.
  const bedTrack = timeline.audio.find((t) => t.role === "bed") ?? null;
  const bed = music.find((t) => bedTrack?.musicItemId === t.id) ?? null;
  const extraCues = timeline.audio.filter((t) => t.role !== "bed").length;
  /** The stored fraction while it's settling, so the needle doesn't snap back. */
  const needlePos = needle ?? bed?.timelinePosition ?? 0;
  const pinned = media.filter((m) => m.cutOverride).length;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "That didn't take");
    });
  }

  /** Commits a new running order and keeps the strip from snapping back. */
  function commitOrder(next: string[]) {
    setPendingOrder(next);
    startTransition(async () => {
      const res = await reorderCutAction(slug, next);
      if (!res.ok) setError(res.error);
      setPendingOrder(null);
    });
  }

  /**
   * Nudging a shot one place along.
   *
   * HTML5 drag-and-drop never fires on a touchscreen, so on a phone the strip
   * would be a read-only picture of the cut. Two arrows on the frame do the
   * same job with a thumb, one shot at a time.
   */
  function nudge(id: string, delta: -1 | 1) {
    const ids = inCut.map((row) => row.item.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, next.splice(from, 1)[0]);
    commitOrder(next);
  }

  /**
   * Where the music comes in, drawn on the one surface whose left-to-right is
   * running time. The soundtrack lane used to own this, against the light
   * table — but that axis is capture order, so the handle sat under a photo
   * the music didn't start at. Clip widths are clamped at both ends, so this
   * isn't proportional either; the timecode in the band is the exact reading
   * and the needle is the rough gesture that sets it.
   */
  function needleFrom(clientX: number) {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function beginNeedle(clientX: number, el: HTMLElement, pointerId: number) {
    el.setPointerCapture(pointerId);
    setDraggingNeedle(true);
    setNeedle(needleFrom(clientX));
  }

  function moveNeedle(clientX: number) {
    if (!draggingNeedle) return;
    setNeedle(needleFrom(clientX));
  }

  function endNeedle(clientX: number) {
    if (!draggingNeedle) return;
    setDraggingNeedle(false);
    commitNeedle(needleFrom(clientX));
  }

  function commitNeedle(position: number) {
    if (!bed) return;
    setNeedle(position);
    startTransition(async () => {
      const res = await moveMusicAction(slug, { musicItemId: bed.id, timelinePosition: position });
      if (!res.ok) setError(res.error);
      setNeedle(null);
    });
  }

  function drop(toIndex: number) {
    if (!draggingId) return;
    const ids = inCut.map((row) => row.item.id);
    const from = ids.indexOf(draggingId);
    setDraggingId(null);
    setDragOverIndex(null);
    if (from === -1 || from === toIndex || from + 1 === toIndex) return;

    const next = [...ids];
    next.splice(from, 1);
    next.splice(from < toIndex ? toIndex - 1 : toIndex, 0, draggingId);
    commitOrder(next);
  }

  return (
    <section>
      <SectionHead
        eyebrow="Beat 04 · Shortlist"
        title="The rough cut"
        note={
          touch
            ? "Assembled from the crew's marks, live. Use the arrows to move a shot, ✕ to drop it, or pull one back off the floor."
            : "Assembled from the crew's marks, live. Drag to reorder, ✕ to drop a shot, or pull one back off the floor."
        }
        right={
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:gap-3">
            {pinned > 0 && (
              <button
                onClick={() => run(() => resetCutAction(slug))}
                disabled={pending}
                className="btn-outline order-2 sm:order-none sm:self-end"
                title="Forget every manual change and go back to what the crew marked"
              >
                ↺ Revert to the votes
              </button>
            )}
            <div className="order-1 border border-[color:var(--hair-strong)] bg-paper-50 px-3 py-2 text-right sm:order-none">
              <p className="eyebrow">Running time</p>
              <p className="timecode mt-0.5 text-lg leading-none">{formatDuration(total)}</p>
              <p className="eyebrow mt-1">
                {inCut.length} shot{inCut.length === 1 ? "" : "s"}
                {pinned > 0 && ` · ${pinned} by hand`}
              </p>
            </div>
          </div>
        }
      />

      {error && <p className="notice mt-3">{error}</p>}

      {inCut.length === 0 ? (
        <div className="mt-4 border border-[color:var(--hair)] bg-paper-200 bg-hatch px-6 py-12 text-center">
          <p className="font-mono text-2xs uppercase tracking-label text-ink-500">
            Nothing has made the cut yet
          </p>
          <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-ink-600">
            Mark up the light table, or drag the red cut line down to let more of the trip in.
          </p>
        </div>
      ) : (
        <div className="scrollbar-thin scrollbar-dark touch-scroll-x mt-4 overflow-x-auto bg-ink-900 shadow-print">
          <div className="perf-strip px-3 py-[13px]">
            {/* w-max so the needle rail measures the strip, not the viewport. */}
            <div className="w-max">
              <div className="flex items-stretch">
                {inCut.map(({ clip, item }, index) => (
                  <div key={clip.id} className="flex shrink-0 items-stretch">
                    {sceneLabels.has(index) && (
                      <div
                        className={cn(
                          "flex shrink-0 items-end pb-1 pl-2 pr-1",
                          index > 0 && "ml-1 border-l border-dashed border-ink-600",
                        )}
                      >
                        <span className="whitespace-nowrap font-mono text-2xs uppercase tracking-label text-ink-400">
                          {sceneLabels.get(index)}
                        </span>
                      </div>
                    )}
                    <DropSlot
                      active={dragOverIndex === index && Boolean(draggingId)}
                      onOver={() => setDragOverIndex(index)}
                      onDrop={() => drop(index)}
                    />
                    <div
                      draggable
                      onDragStart={() => setDraggingId(item.id)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverIndex(null);
                      }}
                      style={{
                        width: `${Math.max(74, Math.min(184, clipDuration(clip, durations[item.id]) * 16))}px`,
                      }}
                      className={cn(
                        "group relative h-24 cursor-grab overflow-hidden border border-ink-700 bg-ink-850 transition-all hover:border-paper-200/60 active:cursor-grabbing",
                        draggingId === item.id && "opacity-25",
                      )}
                    >
                      <button
                        onClick={() => onOpenClip?.(item)}
                        className="block h-full w-full"
                        title={item.originalFilename}
                      >
                        {item.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.thumbnailUrl}
                            alt=""
                            draggable={false}
                            className="print-tone h-full w-full object-cover"
                          />
                        ) : (
                          <div className="h-full w-full bg-ink-800 bg-hatch" />
                        )}
                      </button>

                      <span className="pointer-events-none absolute left-0 top-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                        {String(index + 1).padStart(2, "0")}
                      </span>

                      {item.cutOverride === "include" && (
                        <span
                          className="pointer-events-none absolute left-0 top-4 bg-signal-600 px-1 font-mono text-2xs uppercase tracking-label text-paper-50"
                          title="Forced in by hand"
                        >
                          In
                        </span>
                      )}

                      <span
                        className={cn(
                          "pointer-events-none absolute right-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200",
                          // Clear of the nudge arrows that only exist on touch.
                          touch ? "bottom-8" : "bottom-0",
                        )}
                      >
                        {formatDuration(clipDuration(clip, durations[item.id]))}
                      </span>

                      <button
                        onClick={() =>
                          run(() =>
                            setCutOverrideAction(slug, {
                              targetType: "media",
                              targetId: item.id,
                              override: "exclude",
                            }),
                          )
                        }
                        className="touch-visible absolute right-0 top-0 flex min-h-[30px] min-w-[30px] items-center justify-center bg-ink-950/75 px-1.5 py-0.5 font-mono text-2xs text-paper-200 opacity-0 transition-opacity hover:bg-signal-600 focus:opacity-100 group-hover:opacity-100"
                        title="Drop this shot from the cut"
                      >
                        ✕
                      </button>

                      {touch && (
                        <div className="absolute inset-x-0 bottom-0 flex justify-between">
                          <button
                            onClick={() => nudge(item.id, -1)}
                            disabled={index === 0 || pending}
                            className="flex h-8 w-9 items-center justify-center bg-ink-950/75 font-mono text-sm text-paper-200 disabled:opacity-25"
                            aria-label="Move this shot earlier"
                          >
                            ◀
                          </button>
                          <button
                            onClick={() => nudge(item.id, 1)}
                            disabled={index === inCut.length - 1 || pending}
                            className="flex h-8 w-9 items-center justify-center bg-ink-950/75 font-mono text-sm text-paper-200 disabled:opacity-25"
                            aria-label="Move this shot later"
                          >
                            ▶
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                <DropSlot
                  active={dragOverIndex === inCut.length && Boolean(draggingId)}
                  onOver={() => setDragOverIndex(inCut.length)}
                  onDrop={() => drop(inCut.length)}
                  wide
                />

                {leftOut.length > 0 && (
                  <button
                    onClick={() => setTrayOpen((v) => !v)}
                    className={cn(
                      "flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 border border-dashed font-mono text-2xs uppercase tracking-label transition-colors",
                      trayOpen
                        ? "border-signal-500 bg-signal-900/40 text-signal-300"
                        : "border-ink-600 text-ink-400 hover:border-paper-200/60 hover:text-paper-200",
                    )}
                  >
                    <span className="text-sm">{trayOpen ? "▾" : "＋"}</span>
                    The floor
                    <span className="text-ink-500">{leftOut.length} left</span>
                  </button>
                )}
              </div>

              {/* Where the bed comes in. Only the bed: a hand-placed cue's
                  position lives on the bench, and drawing one here would be a
                  handle that moves nothing. */}
              {bed && (
                <div
                  ref={railRef}
                  className={cn(
                    "relative mt-1.5",
                    touch ? "h-10" : "h-6",
                    // A finger on the rail is scrolling the strip; the handle
                    // below takes the drag, as the cut line does on the plot.
                    touch ? "touch-pan-x" : "touch-none",
                  )}
                  onPointerDown={(e) => {
                    if (e.pointerType !== "mouse") return;
                    beginNeedle(e.clientX, e.currentTarget, e.pointerId);
                  }}
                  onPointerMove={(e) => moveNeedle(e.clientX)}
                  onPointerUp={(e) => endNeedle(e.clientX)}
                >
                  <div
                    aria-hidden
                    className="absolute inset-x-0 top-1/2 h-px bg-[color:var(--hair-dark)]"
                  />

                  {/* The run of the bed under the cut — dashed while there's no
                      file behind it, because that plays as silence. */}
                  <div
                    aria-hidden
                    className={cn(
                      "absolute right-0 top-1/2 h-0 border-t border-signal-600",
                      !bed.extractedAudioKey && "border-dashed",
                      draggingNeedle && "border-t-2",
                    )}
                    style={{ left: `${needlePos * 100}%` }}
                  />

                  <div
                    className={cn(
                      "absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center",
                      touch ? "h-10 w-10" : "h-6 w-6",
                    )}
                    style={{ left: `${needlePos * 100}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      beginNeedle(e.clientX, e.currentTarget, e.pointerId);
                    }}
                    onPointerMove={(e) => moveNeedle(e.clientX)}
                    onPointerUp={(e) => endNeedle(e.clientX)}
                    onPointerCancel={(e) => endNeedle(e.clientX)}
                    title="Drag to move where the music comes in"
                  >
                    <span className="h-4 w-[3px] bg-signal-600" />
                    {draggingNeedle && (
                      <span className="timecode absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap bg-signal-600 px-1 text-2xs text-paper-50">
                        {formatDuration(needlePos * total)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Sound under the cut, so the whole shape of the film is in one band. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color:var(--hair-dark)] px-3 py-2">
            <span className="eyebrow-light shrink-0">Sound</span>
            {bed ? (
              <>
                <span className="min-w-0 flex-1 basis-40 truncate text-xs text-paper-200">
                  {bed.title ?? bed.url}
                  <span className="timecode ml-2 text-2xs text-ink-400">
                    in at {formatDuration(needle !== null ? needle * total : bedTrack?.startAt ?? 0)}
                  </span>
                </span>

                {/* A bed with no file is silence, and this is where that shows
                    up on the film rather than in a list somewhere else. */}
                {!bed.extractedAudioKey && (
                  <button
                    onClick={() => run(() => requestAudioExtractionAction(slug, bed.id))}
                    disabled={pending}
                    className="shrink-0 font-mono text-2xs uppercase tracking-label text-signal-400 underline-offset-2 hover:underline"
                  >
                    Silent until the sound comes through — fetch it
                  </button>
                )}

                {/* The needle is the gesture; this is the same value for a
                    keyboard, the way the cut line pairs its drag with a slider. */}
                <label className="flex shrink-0 items-center gap-2">
                  <span className="eyebrow-light">In at</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.005}
                    value={needlePos}
                    onChange={(e) => setNeedle(Number(e.target.value))}
                    onMouseUp={(e) => commitNeedle(Number((e.target as HTMLInputElement).value))}
                    onTouchEnd={(e) => commitNeedle(Number((e.target as HTMLInputElement).value))}
                    onKeyUp={(e) => commitNeedle(Number((e.target as HTMLInputElement).value))}
                    className="slider-dark w-24"
                    aria-label="Where the music comes in"
                  />
                </label>

                <button
                  onClick={() => run(() => setMusicBedAction(slug, null))}
                  disabled={pending}
                  className="btn-quiet-dark shrink-0 px-1"
                  title="Play the cut dry"
                >
                  ✕
                </button>
              </>
            ) : bedTrack?.mediaItemId ? (
              <span className="text-xs text-ink-300">An uploaded audio file is the bed.</span>
            ) : (
              <span className="font-mono text-2xs uppercase tracking-label text-ink-500">
                {music.length > 0
                  ? "Running dry — put a track under the cut"
                  : "No sound yet"}
              </span>
            )}
            {extraCues > 0 && (
              <span className="shrink-0 font-mono text-2xs uppercase tracking-label text-ink-500">
                +{extraCues} cue{extraCues === 1 ? "" : "s"} on the bench
              </span>
            )}
          </div>

          {trayOpen && leftOut.length > 0 && (
            <div className="border-t border-[color:var(--hair-dark)] bg-ink-950 px-3 py-3">
              <p className="eyebrow-light mb-2">
                Left on the floor by the votes — tap one to force it back in
              </p>
              <div className="scrollbar-thin scrollbar-dark flex max-h-44 flex-wrap gap-1 overflow-y-auto">
                {leftOut.map((item) => (
                  <button
                    key={item.id}
                    onClick={() =>
                      run(() =>
                        setCutOverrideAction(slug, {
                          targetType: "media",
                          targetId: item.id,
                          override: "include",
                        }),
                      )
                    }
                    disabled={pending}
                    className="group relative h-16 w-[30%] max-w-[6rem] shrink-0 grow overflow-hidden border border-ink-800 transition-colors hover:border-signal-500 sm:w-24 sm:grow-0"
                    title={`Force ${item.originalFilename} back into the cut`}
                  >
                    {item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="print-tone h-full w-full object-cover opacity-60 transition-opacity group-hover:opacity-100"
                      />
                    ) : (
                      <div className="h-full w-full bg-ink-850 bg-hatch" />
                    )}
                    <span className="touch-visible absolute inset-0 flex items-center justify-center font-mono text-base text-paper-50 opacity-0 transition-opacity group-hover:opacity-100">
                      ＋
                    </span>
                    {item.cutOverride === "exclude" && (
                      <span
                        className="absolute left-0 top-0 bg-ink-950/85 px-1 font-mono text-2xs uppercase tracking-label text-ink-300"
                        title="Dropped by hand"
                      >
                        Out
                      </span>
                    )}
                    <span className="absolute bottom-0 right-0 bg-ink-950/80 px-1 font-mono text-2xs tabular-nums text-paper-200">
                      {formatDuration(
                        estimatedClipDuration(item.kind, item.durationSeconds, {
                          pace: timeline.director.pace,
                          rank: item.reactions.rank,
                          mediaItemId: item.id,
                        }),
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The insertion rule between two shots. */
function DropSlot({
  active,
  onOver,
  onDrop,
  wide,
}: {
  active: boolean;
  onOver: () => void;
  onDrop: () => void;
  wide?: boolean;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onOver();
      }}
      onDrop={onDrop}
      className={cn(
        "shrink-0 transition-colors",
        wide ? "w-7" : "w-1.5",
        active ? "bg-signal-500" : "bg-transparent",
      )}
    />
  );
}
