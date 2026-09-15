"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  clipStartTimes,
  formatDuration,
  formatFine,
  timelineDuration,
  type ReactionTier,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MusicItemView } from "@/lib/queries";
import {
  addMusicAction,
  deleteMusicAction,
  moveMusicAction,
  requestAudioExtractionAction,
} from "@/lib/actions/music";
import { setMusicBedAction } from "@/lib/actions/cut";
import {
  getMusicTrimAction,
  setMusicTrimAction,
  type AudioTrimState,
} from "@/lib/actions/audio-trim";
import { AudioTrim, type AudioTrimPatch } from "../editor/audio-trim";
import { SectionHead } from "../brand";
import { ReactionBar } from "./reaction-bar";
import { makeSnap } from "@/lib/snap";
import { cn } from "@/lib/cn";

const SOURCE_LABEL: Record<string, string> = {
  youtube: "YT",
  spotify: "SPFY",
  deezer: "DZR",
};

const SLOT = 116;
const CHIP_W = 176;

/** Arrow keys move a chip by a tenth; with shift, by a second. */
const NUDGE = 0.1;
const NUDGE_COARSE = 1;

/** Label spacing on the ruler — the coarsest step that still reads as a clock. */
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const MIN_LABEL_PX = 56;

/**
 * The sound lane, sharing the light table's left-to-right axis. Drag a track to
 * sketch roughly where it should come in under the footage; the best-marked one
 * plays under the cut unless someone picks another.
 */
export function MusicLane({
  slug,
  music,
  tiers,
  memberId,
  crew,
  mediaCount,
  timeline,
  durations,
  bedMusicId,
  canEdit,
}: {
  slug: string;
  music: MusicItemView[];
  tiers: ReactionTier[];
  memberId: string;
  crew?: number;
  mediaCount: number;
  /**
   * The cut as it stands, and the source lengths it is measured against — the
   * lane draws its ruler and its magnets from the film's running time, so a
   * track parks against the shots rather than against the scroll width.
   */
  timeline: TimelineDoc;
  durations: Record<string, number | null>;
  /** The track currently playing under the cut, if any. */
  bedMusicId: string | null;
  canEdit: boolean;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [playing, setPlaying] = useState<string | null>(null);
  /**
   * The track someone is about to pull. Removing it takes it out of everyone's
   * film — and off the cut, if it was the bed — so the ✕ asks first, over the
   * chip rather than beside it: the chip is already three controls wide.
   */
  const [armedId, setArmedId] = useState<string | null>(null);
  /**
   * The track open for trimming, and where its needle sits.
   *
   * The window lives on the timeline document, not on `music_items`, and the
   * floor doesn't hold the document — so it's read when the panel opens rather
   * than passed down. One at a time: this is a lane of chips 176px wide, and
   * the bar wants the full width of the page.
   */
  const [trimmingId, setTrimmingId] = useState<string | null>(null);
  const [trim, setTrim] = useState<AudioTrimState | null>(null);
  const [trimLoading, setTrimLoading] = useState(false);
  /**
   * Trims go out one at a time. A handle dragged and then nudged twice fires
   * three writes in a second, and the document is last-writer-wins — unordered,
   * the earliest answer could land last and undo the other two.
   */
  const trimQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!trimmingId) {
      setTrim(null);
      return;
    }
    let live = true;
    setTrimLoading(true);
    void getMusicTrimAction(slug, trimmingId).then((res) => {
      if (!live) return;
      setTrimLoading(false);
      if (res.ok) setTrim(res.state);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
    // Putting a track on or off the cut is what creates and drops its track.
  }, [slug, trimmingId, bedMusicId]);

  function commitTrim(musicItemId: string, patch: AudioTrimPatch) {
    setTrim((prev) => (prev ? { ...prev, ...patch } : prev));
    setError(null);
    trimQueue.current = trimQueue.current
      .then(() => setMusicTrimAction(slug, { musicItemId, ...patch }))
      .then((res) => {
        if (!res.ok) setError(res.error);
        // The server clamps against the real file, so its answer wins.
        else setTrim((prev) => (prev?.trackId === res.state.trackId ? res.state : prev));
      });
  }

  // Stand a half-armed chip back down as soon as attention goes anywhere else.
  useEffect(() => {
    if (!armedId) return;
    function onPointerDown(event: PointerEvent) {
      const chip = (event.target as HTMLElement | null)?.closest?.("[data-music-chip]");
      if ((chip as HTMLElement | null)?.dataset.musicChip !== armedId) setArmedId(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setArmedId(null);
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [armedId]);

  /** Every action in this lane reports back through the one notice up top. */
  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "That didn't take");
    });
  }

  const innerWidth = Math.max(mediaCount * SLOT, 640);
  const rankedMax = Math.max(0.001, ...music.map((t) => t.reactions.rank));

  /**
   * The film's clock. `timelinePosition` is stored as a fraction of the lane —
   * that's the column and it stays that way — but a fraction is not something
   * anyone can aim with, so everything on screen is seconds, converted at the
   * edges. With no cut yet there is no clock: the lane still takes a rough
   * position, it just can't say what it means.
   */
  const totalDuration = useMemo(
    () => timelineDuration(timeline, durations),
    [timeline, durations],
  );
  const clock = totalDuration > 0;
  const pxPerSecond = clock ? innerWidth / totalDuration : 0;

  /** Shot boundaries, in seconds — the ruler's second row and the magnets. */
  const cuts = useMemo(() => {
    if (!clock) return [] as number[];
    const starts = clipStartTimes(timeline, durations);
    const points = new Set<number>([0, totalDuration]);
    for (const clip of timeline.clips) points.add(starts[clip.id] ?? 0);
    return [...points].sort((a, b) => a - b);
  }, [clock, timeline, durations, totalDuration]);

  const snap = useMemo(() => makeSnap(cuts, pxPerSecond), [cuts, pxPerSecond]);

  /** Ruler labels, thinned out until they stop colliding. */
  const ticks = useMemo(() => {
    if (!clock) return [] as number[];
    const step =
      RULER_STEPS.find((s) => s * pxPerSecond >= MIN_LABEL_PX) ??
      RULER_STEPS[RULER_STEPS.length - 1];
    const out: number[] = [];
    for (let t = 0; t <= totalDuration + 0.001; t += step) out.push(Math.round(t * 100) / 100);
    return out;
  }, [clock, pxPerSecond, totalDuration]);

  /**
   * Where a chip is while a move is in flight. A drag or a nudge has to show on
   * the lane before the round trip, and arrows fire faster than the server
   * answers — so the pointer's idea of the position wins until the server's
   * catches up with it.
   */
  const [localPos, setLocalPos] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<{ id: string; pos: number } | null>(null);
  const draggingId = drag?.id ?? null;
  /** Moves go out one at a time, for the same reason trims do. */
  const moveQueue = useRef<Promise<unknown>>(Promise.resolve());

  // Hand a chip back to the server's number once that number is the same one.
  useEffect(() => {
    setLocalPos((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(prev)) {
        const track = music.find((t) => t.id === id);
        if (!track || Math.abs(track.timelinePosition - prev[id]) < 1e-4) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [music]);

  const positionOf = (track: MusicItemView) =>
    drag?.id === track.id ? drag.pos : (localPos[track.id] ?? track.timelinePosition);

  function commitPosition(id: string, pos: number) {
    const next = Math.max(0, Math.min(1, pos));
    setLocalPos((prev) => ({ ...prev, [id]: next }));
    setError(null);
    // Not through `run`: a transition here would disable the add field
    // mid-drag, and the chip has already moved under the finger.
    moveQueue.current = moveQueue.current
      .then(() => moveMusicAction(slug, { musicItemId: id, timelinePosition: next }))
      .then((res) => {
        if (!res.ok) setError(res.error);
      });
  }

  /** Arrow keys move the focused chip along the clock, not along the lane. */
  function nudge(track: MusicItemView, seconds: number) {
    if (!clock) return;
    const at = Math.round((positionOf(track) * totalDuration + seconds) * 1000) / 1000;
    commitPosition(track.id, Math.max(0, Math.min(totalDuration, at)) / totalDuration);
  }

  const ordered = useMemo(
    () => [...music].sort((a, b) => a.timelinePosition - b.timelinePosition),
    [music],
  );

  /**
   * The chip whose controls are open. A chip is 176px of a lane you drag along;
   * three buttons and a vote bar inside that is a target for everything except
   * the drag, so the buttons wait until it's the one being worked on.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A track pulled while its panel is open takes the panel with it.
  const trimTrack = trimmingId ? (ordered.find((t) => t.id === trimmingId) ?? null) : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await addMusicAction(slug, { url: url.trim(), timelinePosition: 0.5 });
      if (result.ok) setUrl("");
      else setError(result.error);
    });
  }

  function positionFromEvent(el: HTMLElement, clientX: number) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0.5;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  return (
    <section>
      <SectionHead
        eyebrow="Sound"
        title="What it sounds like"
        size="sm"
        note="Same axis as the footage. Park a track where it should kick in — the crew's favourite ends up under the cut."
        right={<span className="eyebrow">{music.length} tracks</span>}
      />

      {canEdit && (
        <form onSubmit={submit} className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-end sm:gap-3">
          <label className="min-w-0 flex-1">
            <span className="field-label">Add a track</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="YouTube, Spotify or Deezer link…"
              className="field timecode text-xs"
              disabled={pending}
            />
          </label>
          <button type="submit" className="btn-outline shrink-0" disabled={pending || !url.trim()}>
            {pending ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      {error && <p className="notice mt-3">{error}</p>}

      <div className="scrollbar-thin scrollbar-dark touch-scroll-x mt-3 overflow-x-auto bg-ink-900 shadow-print">
        <div className="my-4 mx-3" style={{ minWidth: innerWidth }}>
          {/* The clock the lane is read against, and the cuts under it. */}
          <div className="relative h-4 border-b border-[color:var(--hair-dark)]">
            {clock ? (
              ticks.map((t) => (
                <span
                  key={t}
                  className="absolute bottom-0 -translate-x-1/2 font-mono text-2xs text-ink-400"
                  style={{ left: `${(t / totalDuration) * 100}%` }}
                >
                  {formatDuration(t)}
                </span>
              ))
            ) : (
              <span className="absolute bottom-0 left-0 font-mono text-2xs uppercase tracking-label text-ink-500">
                No cut yet — park it roughly
              </span>
            )}
          </div>
          <div aria-hidden className="relative h-3">
            {cuts.map((t) => (
              <span
                key={t}
                className="absolute top-0 h-2 w-px bg-ink-700"
                style={{ left: `${(t / totalDuration) * 100}%` }}
              />
            ))}
          </div>

          <div
            className="relative h-32 touch-none"
            onPointerDown={(e) => {
              if (!canEdit) return;
              const chip = (e.target as HTMLElement).closest("[data-music-chip]");
              if (!chip) return;
              const id = (chip as HTMLElement).dataset.musicChip;
              if (!id) return;
              setDrag({ id, pos: positionFromEvent(e.currentTarget, e.clientX) });
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const pos = positionFromEvent(e.currentTarget, e.clientX);
              setDrag((prev) => (prev ? { ...prev, pos } : prev));
            }}
            onPointerUp={(e) => {
              if (!drag) return;
              const raw = positionFromEvent(e.currentTarget, e.clientX);
              const id = drag.id;
              setDrag(null);
              setSelectedId(id);
              // Land on a cut if the drop was within a magnet of one.
              const pos = clock ? snap(raw * totalDuration) / totalDuration : raw;
              commitPosition(id, pos);
            }}
          >
            {/* The track's centre line, like an audio bed on a timeline. */}
            <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-[color:var(--hair-dark)]" />

            {/* The cuts again, full height — what the magnets are pulling to. */}
            {cuts.map((t) => (
              <div
                key={t}
                aria-hidden
                className="absolute inset-y-0 w-px bg-ink-800"
                style={{ left: `${(t / totalDuration) * 100}%` }}
              />
            ))}

            {ordered.length === 0 && (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-2xs uppercase tracking-label text-ink-400">
                Silent. What should this film sound like?
              </p>
            )}

            {ordered.map((track) => {
              const isOwn = track.addedById === memberId;
              const lift = track.reactions.rank / rankedMax;
              const isBed = track.id === bedMusicId;
              const pos = positionOf(track);
              const isDragging = draggingId === track.id;
              const isOpen = selectedId === track.id;

              return (
                <div
                  key={track.id}
                  data-music-chip={track.id}
                  tabIndex={canEdit ? 0 : -1}
                  onFocus={() => setSelectedId(track.id)}
                  onKeyDown={(e) => {
                    if (!canEdit) return;
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const step = e.shiftKey ? NUDGE_COARSE : NUDGE;
                    nudge(track, e.key === "ArrowLeft" ? -step : step);
                  }}
                  className={cn(
                    "absolute top-1/2 w-[176px] -translate-y-1/2 cursor-grab touch-none border bg-ink-850 p-2 shadow-deck outline-none active:cursor-grabbing",
                    isDragging
                      ? "z-30 border-signal-500"
                      : isOpen
                        ? "z-20 border-paper-200"
                        : isBed
                          ? "z-10 border-signal-600"
                          : "z-10 border-ink-700",
                  )}
                  style={{
                    left: `calc(${pos * 100}% - ${CHIP_W / 2}px)`,
                    marginTop: `${(0.5 - lift) * 26}px`,
                  }}
                >
                  <div className="flex items-start gap-2">
                    {track.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={track.thumbnailUrl}
                        alt=""
                        className="print-tone h-9 w-9 shrink-0 object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-ink-800 font-mono text-2xs text-ink-400">
                        ♪
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] leading-tight text-paper-100">
                        {track.title ?? track.url}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1">
                        {/* Where it comes in, while it's being placed — the
                            whole point of the drag, and unreadable as a
                            fraction of a lane. */}
                        {clock && (isDragging || isOpen) ? (
                          <span
                            className={cn(
                              "timecode text-2xs",
                              isDragging ? "text-signal-400" : "text-ink-300",
                            )}
                          >
                            in at {formatFine(pos * totalDuration)}
                          </span>
                        ) : (
                          <span className="font-mono text-2xs uppercase tracking-label text-ink-400">
                            {SOURCE_LABEL[track.source] ?? track.source}
                          </span>
                        )}
                        {isBed && (
                          <span className="bg-signal-600 px-1 font-mono text-2xs uppercase tracking-label text-paper-50">
                            On the cut
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Whether there's a file behind the link yet — a bed with no
                      sound is otherwise just unexplained silence in the editor. */}
                  {!track.extractedAudioKey && (
                    <p
                      className="mt-1.5 font-mono text-2xs text-ink-400"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {track.status === "pending" || track.status === "processing" ? (
                        "Getting the sound…"
                      ) : track.status === "failed" ? (
                        <button
                          onClick={() => run(() => requestAudioExtractionAction(slug, track.id))}
                          className="text-signal-400 underline-offset-2 hover:underline"
                          title={track.error ?? undefined}
                        >
                          Sound didn&apos;t come through — try again
                        </button>
                      ) : (
                        "Plays here, silent in the film"
                      )}
                    </p>
                  )}

                  <div
                    className="mt-2 flex items-end justify-between gap-1"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <ReactionBar
                      slug={slug}
                      targetType="music"
                      targetId={track.id}
                      tiers={tiers}
                      mine={track.reactions.mine}
                      breakdown={track.reactions.breakdown}
                      crew={crew}
                      size="sm"
                      tone="dark"
                      quiet
                    />
                    {!isOpen && (
                      <button
                        onClick={() => setSelectedId(track.id)}
                        className="shrink-0 px-1 font-mono text-2xs uppercase tracking-label text-ink-400 transition-colors hover:text-paper-100"
                      >
                        ⋯
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <div
                      className="mt-2 border-t border-[color:var(--hair-dark)] pt-2"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between gap-px">
                        <button
                          onClick={() => run(() => setMusicBedAction(slug, isBed ? null : track.id))}
                          className={cn(
                            "flex min-h-[30px] items-center px-1 font-mono text-2xs uppercase tracking-label transition-colors",
                            isBed ? "text-signal-400" : "text-ink-400 hover:text-paper-100",
                          )}
                          title={isBed ? "Take it off the cut" : "Play this one under the cut"}
                        >
                          {isBed ? "✓ on the cut" : "＋ on the cut"}
                        </button>
                        <div className="flex shrink-0 items-center gap-px">
                          <button
                            onClick={() => setPlaying(playing === track.id ? null : track.id)}
                            className="flex min-h-[30px] min-w-[28px] items-center justify-center px-1 font-mono text-2xs text-ink-400 transition-colors hover:text-paper-100"
                            title="Preview"
                          >
                            {playing === track.id ? "▲" : "▶"}
                          </button>
                          {isOwn && (
                            <button
                              onClick={() => setArmedId(track.id)}
                              disabled={pending}
                              className="flex min-h-[30px] min-w-[28px] items-center justify-center px-1 font-mono text-2xs text-ink-400 transition-colors hover:text-signal-400"
                              title="Remove your track"
                            >
                              ✕
                            </button>
                          )}
                          <button
                            onClick={() => setSelectedId(null)}
                            className="flex min-h-[30px] min-w-[28px] items-center justify-center px-1 font-mono text-2xs text-ink-400 transition-colors hover:text-paper-100"
                            title="Close"
                          >
                            ▾
                          </button>
                        </div>
                      </div>

                      {/* The track under the cut is the one worth choosing a bit
                          of, and nobody should have to find the bench to do it. */}
                      {track.extractedAudioKey && isBed && canEdit && (
                        <button
                          onClick={() => setTrimmingId(trimmingId === track.id ? null : track.id)}
                          aria-expanded={trimmingId === track.id}
                          className={cn(
                            "flex min-h-[26px] w-full items-center font-mono text-2xs uppercase tracking-label transition-colors",
                            trimmingId === track.id
                              ? "text-signal-400"
                              : "text-ink-400 hover:text-paper-100",
                          )}
                        >
                          {trimmingId === track.id ? "▾ Trimming" : "▸ Trim the sound"}
                        </button>
                      )}
                    </div>
                  )}

                  {armedId === track.id && (
                    <div
                      // The lane turns any pointerdown on a chip into a drag, so
                      // the confirm has to keep its own presses to itself.
                      onPointerDown={(e) => e.stopPropagation()}
                      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-ink-950/92 px-2 text-center"
                    >
                      <p className="font-mono text-2xs uppercase tracking-label text-paper-200">
                        Take this out?
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        <button
                          onClick={() => {
                            setArmedId(null);
                            run(() => deleteMusicAction(slug, track.id));
                          }}
                          disabled={pending}
                          autoFocus
                          className="flex min-h-[32px] min-w-[44px] items-center justify-center bg-signal-600 px-2 font-mono text-2xs uppercase tracking-label text-paper-50 transition-colors hover:bg-signal-700 disabled:opacity-60"
                        >
                          Take out
                        </button>
                        <button
                          onClick={() => setArmedId(null)}
                          className="flex min-h-[32px] min-w-[44px] items-center justify-center border border-ink-600 px-2 font-mono text-2xs uppercase tracking-label text-paper-200 transition-colors hover:border-paper-200"
                        >
                          Keep
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {playing && (
          <div className="border-t border-[color:var(--hair-dark)] p-3">
            {ordered
              .filter((t) => t.id === playing)
              .map((track) => (
                <iframe
                  key={track.id}
                  src={track.embedUrl}
                  className="h-[152px] w-full border-0"
                  allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
                  loading="lazy"
                  title={track.title ?? "Music preview"}
                />
              ))}
          </div>
        )}
      </div>

      {canEdit && ordered.length > 0 && (
        <p className="mt-2 font-mono text-2xs uppercase tracking-label text-ink-400">
          Drag to place · ← → nudge a tenth · ⇧ ← → a second · drops land on the nearest cut
        </p>
      )}

      {/*
        The bar lives under the lane rather than on the chip: a chip is 176px
        of a sideways-scrolling strip, and a window you're choosing by eye needs
        the width of the page and something a thumb can land on.
      */}
      {trimTrack && (
        <div className="mt-3 border border-[color:var(--hair-dark)] bg-ink-900 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow-light">Trim the music</p>
            <button onClick={() => setTrimmingId(null)} className="btn-quiet-dark px-0">
              Done
            </button>
          </div>
          <p
            className="timecode mt-1 truncate text-2xs text-ink-400"
            title={trimTrack.title ?? trimTrack.url}
          >
            {trimTrack.title ?? trimTrack.url}
          </p>

          <div className="mt-3">
            {trimLoading && !trim ? (
              <p className="font-mono text-2xs text-ink-400">Reading the track…</p>
            ) : trim ? (
              <AudioTrim
                tall
                offset={trim.offset}
                duration={trim.duration}
                sourceDuration={trim.sourceDuration}
                onChange={(patch) => commitTrim(trimTrack.id, patch)}
              />
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-300">
                This one isn&apos;t under the cut, so there&apos;s nothing of it in the film to
                trim. Put it on the cut with ＋ and come back.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
