"use client";

import { useMemo, useState, useTransition } from "react";
import type { ReactionTier } from "@vlogbuddy/shared";
import type { MusicItemView } from "@/lib/queries";
import { addMusicAction, deleteMusicAction, moveMusicAction } from "@/lib/actions/music";
import { setMusicBedAction } from "@/lib/actions/cut";
import { SectionHead } from "../brand";
import { ReactionBar } from "./reaction-bar";
import { cn } from "@/lib/cn";

const SOURCE_LABEL: Record<string, string> = {
  youtube: "YT",
  spotify: "SPFY",
  deezer: "DZR",
};

const SLOT = 116;
const CHIP_W = 176;

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
  bedMusicId,
  canEdit,
}: {
  slug: string;
  music: MusicItemView[];
  tiers: ReactionTier[];
  memberId: string;
  crew?: number;
  mediaCount: number;
  /** The track currently playing under the cut, if any. */
  bedMusicId: string | null;
  canEdit: boolean;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [playing, setPlaying] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const innerWidth = Math.max(mediaCount * SLOT, 640);
  const rankedMax = Math.max(0.001, ...music.map((t) => t.reactions.rank));

  const ordered = useMemo(
    () => [...music].sort((a, b) => a.timelinePosition - b.timelinePosition),
    [music],
  );

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
        note="Same axis as the footage. Park a track where it should kick in — the crew's favourite ends up under the cut."
        right={<span className="eyebrow">{music.length} tracks</span>}
      />

      {canEdit && (
        <form onSubmit={submit} className="mt-3 flex items-end gap-3">
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

      <div className="scrollbar-thin scrollbar-dark mt-3 overflow-x-auto bg-ink-900 shadow-print">
        <div
          className="relative my-4 mx-3 h-32"
          style={{ minWidth: innerWidth }}
          onPointerDown={(e) => {
            if (!canEdit) return;
            const chip = (e.target as HTMLElement).closest("[data-music-chip]");
            if (!chip) return;
            const id = (chip as HTMLElement).dataset.musicChip;
            if (!id) return;
            setDraggingId(id);
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!draggingId) return;
            const pos = positionFromEvent(e.currentTarget, e.clientX);
            const chip = e.currentTarget.querySelector(
              `[data-music-chip="${draggingId}"]`,
            ) as HTMLElement | null;
            if (chip) chip.style.left = `calc(${pos * 100}% - ${CHIP_W / 2}px)`;
          }}
          onPointerUp={(e) => {
            if (!draggingId) return;
            const pos = positionFromEvent(e.currentTarget, e.clientX);
            const id = draggingId;
            setDraggingId(null);
            void moveMusicAction(slug, { musicItemId: id, timelinePosition: pos });
          }}
        >
          {/* The track's centre line, like an audio bed on a timeline. */}
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-[color:var(--hair-dark)]" />

          {ordered.length === 0 && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-2xs uppercase tracking-label text-ink-500">
              Silent. What should this film sound like?
            </p>
          )}

          {ordered.map((track) => {
            const isOwn = track.addedById === memberId;
            const lift = track.reactions.rank / rankedMax;
            const isBed = track.id === bedMusicId;

            return (
              <div
                key={track.id}
                data-music-chip={track.id}
                className={cn(
                  "absolute top-1/2 w-[176px] -translate-y-1/2 cursor-grab border bg-ink-850 p-2 shadow-deck active:cursor-grabbing",
                  draggingId === track.id
                    ? "z-20 border-signal-500"
                    : isBed
                      ? "z-10 border-signal-600"
                      : "z-10 border-ink-700",
                )}
                style={{
                  left: `calc(${track.timelinePosition * 100}% - ${CHIP_W / 2}px)`,
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
                      <span className="font-mono text-2xs uppercase tracking-label text-ink-400">
                        {SOURCE_LABEL[track.source] ?? track.source}
                      </span>
                      {isBed && (
                        <span className="bg-signal-600 px-1 font-mono text-2xs uppercase tracking-label text-paper-50">
                          On the cut
                        </span>
                      )}
                    </div>
                  </div>
                </div>

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
                  <div className="flex shrink-0 items-center gap-px">
                    <button
                      onClick={() =>
                        startTransition(() =>
                          setMusicBedAction(slug, isBed ? null : track.id).then(() => {}),
                        )
                      }
                      className={cn(
                        "px-1 py-0.5 font-mono text-2xs uppercase tracking-label transition-colors",
                        isBed ? "text-signal-400" : "text-ink-400 hover:text-paper-100",
                      )}
                      title={isBed ? "Take it off the cut" : "Play this one under the cut"}
                    >
                      {isBed ? "✓" : "＋"}
                    </button>
                    <button
                      onClick={() => setPlaying(playing === track.id ? null : track.id)}
                      className="px-1 py-0.5 font-mono text-2xs text-ink-400 transition-colors hover:text-paper-100"
                      title="Preview"
                    >
                      {playing === track.id ? "▲" : "▶"}
                    </button>
                    {isOwn && (
                      <button
                        onClick={() =>
                          startTransition(() => deleteMusicAction(slug, track.id).then(() => {}))
                        }
                        className="px-1 py-0.5 font-mono text-2xs text-ink-400 transition-colors hover:text-signal-400"
                        title="Remove your track"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
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
    </section>
  );
}
