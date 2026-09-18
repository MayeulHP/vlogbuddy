"use client";

import { useMemo, useState, useTransition } from "react";
import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MusicItemView } from "@/lib/queries";
import {
  addMusicAction,
  deleteMusicAction,
  requestAudioExtractionAction,
} from "@/lib/actions/music";
import { setMusicInCutAction } from "@/lib/actions/cut";
import { SectionHead } from "../brand";
import { ReactionBar } from "./reaction-bar";
import { cn } from "@/lib/cn";

// Only YouTube can be added now; the other two are here for tracks pasted back
// when they were still accepted.
const SOURCE_LABEL: Record<string, string> = {
  youtube: "YT",
  spotify: "SPFY",
  deezer: "DZR",
};

/**
 * The sound, as a cue sheet rather than a lane.
 *
 * The lane this replaces drew every track at a point along the footage, which
 * read as "the music starts here" and wasn't: the light table is ordered by
 * capture and a track's position is a fraction of the finished film's running
 * time. The placing now lives on the rough cut, where left-to-right really is
 * time, and this is the list: what's in the film, in the order it plays, and
 * what the crew made of each track.
 */
export function CueSheet({
  slug,
  music,
  tiers,
  memberId,
  crew,
  startsAt,
  canEdit,
}: {
  slug: string;
  music: MusicItemView[];
  tiers: ReactionTier[];
  memberId: string;
  crew?: number;
  /** Where each track in the film comes in, in seconds of finished film. */
  startsAt: Record<string, number>;
  canEdit: boolean;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [playing, setPlaying] = useState<string | null>(null);

  /**
   * What's in the film first, in the order it plays, then everything else by
   * what the crew made of it. A track sitting near the top of the second group
   * is the useful thing to be able to see: the queue only changes when someone
   * says so, so that's the argument for changing it.
   */
  const ordered = useMemo(() => {
    const queued = music
      .filter((t) => t.selected)
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
    const rest = music
      .filter((t) => !t.selected)
      .sort((a, b) => b.reactions.rank - a.reactions.rank);
    return [...queued, ...rest];
  }, [music]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await addMusicAction(slug, { url: url.trim() });
      if (result.ok) setUrl("");
      else setError(result.error);
    });
  }

  return (
    <section>
      <SectionHead
        eyebrow="Sound"
        title="What it sounds like"
        note="Mark the tracks like you mark the footage. What's in the film plays in the order it was added, each track picking up where the last one ends."
        right={<span className="eyebrow">{music.length} tracks</span>}
      />

      {canEdit && (
        <form
          onSubmit={submit}
          className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-end sm:gap-3"
        >
          <label className="min-w-0 flex-1">
            <span className="field-label">Add a track</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="YouTube link…"
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

      <div className="sheet mt-3">
        {ordered.length === 0 && (
          <p className="px-3 py-8 text-center font-mono text-2xs uppercase tracking-label text-ink-500">
            Silent. What should this film sound like?
          </p>
        )}

        {ordered.map((track) => {
          const isOwn = track.addedById === memberId;
          const inFilm = track.selected;
          const place = inFilm ? (track.orderIndex ?? 0) + 1 : null;
          const comesIn = startsAt[track.id];
          const isPlaying = playing === track.id;

          return (
            <div
              key={track.id}
              className={cn(
                "border-b border-[color:var(--hair)] last:border-b-0",
                // What's in the film wears the signal edge, so the queue can
                // be read off the sheet without a legend.
                inFilm && "border-l-2 border-l-signal-600 bg-paper-100",
              )}
            >
              <div className="flex items-start gap-3 px-3 py-2.5">
                {track.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={track.thumbnailUrl}
                    alt=""
                    className="print-tone mt-0.5 h-10 w-10 shrink-0 object-cover"
                  />
                ) : (
                  <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center bg-paper-200 font-mono text-xs text-ink-400">
                    ♪
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <p className="min-w-0 flex-1 basis-40 truncate text-sm text-ink-900">
                      {track.title ?? track.url}
                    </p>
                    <span className="eyebrow shrink-0">
                      {SOURCE_LABEL[track.source] ?? track.source}
                    </span>
                    {place !== null && (
                      <span className="tag-signal shrink-0">
                        {place === 1 ? "Opens the film" : `${place}${ordinal(place)} up`}
                      </span>
                    )}
                  </div>

                  <p className="mt-1 font-mono text-2xs text-ink-500">
                    {track.status === "pending" || track.status === "processing" ? (
                      "Getting the sound…"
                    ) : !track.extractedAudioKey ? (
                      /* Fetching starts on its own, so anything still without a
                         file has already had its turn and missed. The button is
                         the way to send it round again. */
                      <button
                        onClick={() =>
                          startTransition(() =>
                            requestAudioExtractionAction(slug, track.id).then(() => {}),
                          )
                        }
                        className="text-signal-600 underline-offset-2 hover:underline"
                        title={track.error ?? undefined}
                      >
                        {track.status === "failed"
                          ? "Sound didn't come through — try again"
                          : "Silent in the film — get the sound"}
                      </button>
                    ) : inFilm && comesIn !== undefined ? (
                      <>
                        Sound ready
                        <span className="timecode ml-2">in at {formatDuration(comesIn)}</span>
                      </>
                    ) : (
                      "Sound ready"
                    )}
                    {track.addedByName && (
                      <span className="ml-2 text-ink-400">· {track.addedByName}</span>
                    )}
                  </p>

                  <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
                    <ReactionBar
                      slug={slug}
                      targetType="music"
                      targetId={track.id}
                      tiers={tiers}
                      mine={track.reactions.mine}
                      breakdown={track.reactions.breakdown}
                      crew={crew}
                      size="md"
                      tone="paper"
                    />

                    <div className="flex shrink-0 items-center gap-1">
                      {canEdit && (
                        <button
                          onClick={() =>
                            startTransition(() =>
                              setMusicInCutAction(slug, track.id, !inFilm).then(() => {}),
                            )
                          }
                          className={cn("shrink-0", inFilm ? "btn-quiet" : "btn-outline")}
                        >
                          {inFilm ? "Take it out" : "Add to the film"}
                        </button>
                      )}
                      <button
                        onClick={() => setPlaying(isPlaying ? null : track.id)}
                        className="btn-quiet shrink-0"
                        title="Listen to it"
                      >
                        {isPlaying ? "▲" : "▶"}
                      </button>
                      {isOwn && canEdit && (
                        <button
                          onClick={() =>
                            startTransition(() => deleteMusicAction(slug, track.id).then(() => {}))
                          }
                          className="btn-quiet shrink-0 hover:text-signal-600"
                          title="Remove your track"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {isPlaying && (
                <div className="border-t border-[color:var(--hair)] px-3 py-3">
                  <iframe
                    src={track.embedUrl}
                    className="h-[152px] w-full border-0"
                    allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
                    loading="lazy"
                    title={track.title ?? "Music preview"}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 2nd, 3rd, 4th — the queue reads as places, not indices. */
function ordinal(place: number): string {
  if (place % 100 >= 11 && place % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][place % 10] ?? "th";
}
