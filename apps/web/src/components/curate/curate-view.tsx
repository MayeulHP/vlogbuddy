"use client";

import { useMemo, useState, useTransition } from "react";
import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import {
  autoSelectTopAction,
  toggleSelectionAction,
  reorderSelectionAction,
} from "@/lib/actions/reactions";
import { cn } from "@/lib/cn";

/**
 * Curate phase: turn the voted pile into a shortlist in running order.
 * Sorted by vote rank so the obvious keepers are already at the top — pick from
 * the left, arrange on the right.
 */
export function CurateView({
  slug,
  media,
  music,
  reactionTiers,
  isCreator,
}: {
  slug: string;
  media: MediaItemView[];
  music: MusicItemView[];
  reactionTiers: ReactionTier[];
  isCreator: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const ranked = useMemo(
    () => [...media].sort((a, b) => b.reactions.rank - a.reactions.rank),
    [media],
  );

  const selected = useMemo(
    () =>
      media
        .filter((m) => m.selected)
        .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)),
    [media],
  );

  const selectedMusic = useMemo(() => music.filter((m) => m.selected), [music]);

  function toggle(item: MediaItemView) {
    startTransition(async () => {
      const res = await toggleSelectionAction(slug, {
        targetType: "media",
        targetId: item.id,
        selected: !item.selected,
      });
      if (!res.ok) setError(res.error);
    });
  }

  function toggleMusic(track: MusicItemView) {
    startTransition(async () => {
      const res = await toggleSelectionAction(slug, {
        targetType: "music",
        targetId: track.id,
        selected: !track.selected,
      });
      if (!res.ok) setError(res.error);
    });
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...selected];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    startTransition(async () => {
      const res = await reorderSelectionAction(slug, next.map((i) => i.id));
      if (!res.ok) setError(res.error);
    });
  }

  const totalDuration = selected.reduce(
    (acc, item) => acc + (item.kind === "video" ? item.durationSeconds ?? 5 : 3),
    0,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Pick the keepers</h2>
          <p className="text-xs text-ink-500">
            Sorted by how everyone voted. Tap to add to the cut — order it on the right.
          </p>
        </div>

        {isCreator && (
          <button
            onClick={() =>
              startTransition(async () => {
                const res = await autoSelectTopAction(slug, 20);
                if (!res.ok) setError(res.error);
              })
            }
            disabled={pending}
            className="btn-secondary text-xs"
          >
            ✨ Auto-pick top 20
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        {/* Candidates */}
        <div className="min-w-0">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {ranked.map((item) => (
              <button
                key={item.id}
                onClick={() => toggle(item)}
                className={cn(
                  "group relative h-32 overflow-hidden rounded-lg border transition-all",
                  item.selected
                    ? "border-brand-500 ring-2 ring-brand-500/40"
                    : "border-ink-800 hover:border-ink-600",
                )}
              >
                {item.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.thumbnailUrl}
                    alt={item.originalFilename}
                    loading="lazy"
                    className={cn(
                      "h-full w-full object-cover transition-all",
                      !item.selected && "opacity-70 group-hover:opacity-100",
                    )}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-ink-850 text-xs text-ink-600">
                    processing…
                  </div>
                )}

                <div className="absolute left-1.5 top-1.5 flex gap-1">
                  {item.reactions.count > 0 && (
                    <span className="chip bg-black/70 text-[10px] text-white backdrop-blur-sm">
                      {reactionTiers
                        .filter((t) => (item.reactions.breakdown[t.score] ?? 0) > 0)
                        .map((t) => `${t.emoji}${item.reactions.breakdown[t.score]}`)
                        .join(" ")}
                    </span>
                  )}
                </div>

                {item.selected && (
                  <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[11px] font-bold text-white">
                    ✓
                  </div>
                )}

                {item.kind === "video" && (
                  <span className="absolute bottom-1.5 left-1.5 chip bg-black/70 text-[10px] text-white">
                    ▶ {formatDuration(item.durationSeconds)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* The cut */}
        <aside className="space-y-4 lg:sticky lg:top-36 lg:self-start">
          <section className="card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-white">The cut</h3>
              <span className="text-xs text-ink-500">
                {selected.length} clips · ~{formatDuration(totalDuration)}
              </span>
            </div>

            {selected.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-600">
                Nothing picked yet. Tap the best bits on the left.
              </p>
            ) : (
              <ol className="max-h-[420px] space-y-1.5 overflow-y-auto scrollbar-thin pr-1">
                {selected.map((item, index) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-850/60 p-1.5"
                  >
                    <span className="w-5 shrink-0 text-center text-[11px] font-mono text-ink-600">
                      {index + 1}
                    </span>

                    {item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.thumbnailUrl} alt="" className="h-9 w-12 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-9 w-12 shrink-0 rounded bg-ink-800" />
                    )}

                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-300">
                      {item.originalFilename}
                    </span>

                    <div className="flex shrink-0 flex-col">
                      <button
                        onClick={() => move(index, -1)}
                        disabled={index === 0 || pending}
                        className="px-1 text-[9px] leading-tight text-ink-500 hover:text-white disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => move(index, 1)}
                        disabled={index === selected.length - 1 || pending}
                        className="px-1 text-[9px] leading-tight text-ink-500 hover:text-white disabled:opacity-30"
                      >
                        ▼
                      </button>
                    </div>

                    <button
                      onClick={() => toggle(item)}
                      className="shrink-0 px-1 text-xs text-ink-600 hover:text-red-300"
                      title="Remove from the cut"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card p-4">
            <h3 className="mb-1 text-sm font-semibold text-white">Soundtrack</h3>
            <p className="mb-3 text-xs text-ink-500">
              Pick the track for the final cut.
            </p>

            {music.length === 0 ? (
              <p className="py-3 text-center text-xs text-ink-600">No music was added.</p>
            ) : (
              <div className="space-y-1.5">
                {[...music]
                  .sort((a, b) => b.reactions.rank - a.reactions.rank)
                  .map((track) => (
                    <button
                      key={track.id}
                      onClick={() => toggleMusic(track)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border p-1.5 text-left transition-colors",
                        track.selected
                          ? "border-brand-500/60 bg-brand-500/10"
                          : "border-ink-800 bg-ink-850/60 hover:border-ink-700",
                      )}
                    >
                      {track.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={track.thumbnailUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-ink-800 text-xs">
                          🎵
                        </div>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-200">
                        {track.title ?? track.url}
                      </span>
                      {track.selected && <span className="shrink-0 text-xs text-brand-400">✓</span>}
                    </button>
                  ))}
              </div>
            )}

            {selectedMusic.length > 1 && (
              <p className="mt-2 text-[11px] text-amber-300/80">
                The top-voted pick becomes the music bed; the rest stay available in the editor.
              </p>
            )}
          </section>

          {isCreator && selected.length > 0 && (
            <p className="px-1 text-[11px] leading-relaxed text-ink-500">
              Happy with this? Hit <strong className="text-ink-300">Start editing</strong> up top —
              your vlog gets assembled in this order, ready to trim.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
