"use client";

import { useState, useTransition } from "react";
import type { ReactionTier } from "@vlogbuddy/shared";
import type { MusicItemView } from "@/lib/queries";
import { addMusicAction, deleteMusicAction, moveMusicAction } from "@/lib/actions/music";
import { ReactionBar } from "./reaction-bar";
import { cn } from "@/lib/cn";

const SOURCE_STYLE: Record<string, { label: string; className: string }> = {
  youtube: { label: "YouTube", className: "bg-red-500/15 text-red-300 border-red-500/30" },
  spotify: { label: "Spotify", className: "bg-green-500/15 text-green-300 border-green-500/30" },
  deezer: { label: "Deezer", className: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
};

/**
 * Music pins sit on the same left-to-right timeline as the media, so a track
 * can be parked roughly where it should land in the final cut.
 */
export function MusicStrip({
  slug,
  music,
  tiers,
  memberId,
  canEdit,
}: {
  slug: string;
  music: MusicItemView[];
  tiers: ReactionTier[];
  memberId: string;
  canEdit: boolean;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [playing, setPlaying] = useState<string | null>(null);

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

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <span>🎵</span> Soundtrack
          </h2>
          <p className="text-xs text-ink-500">
            Paste a link, vote, and drag it to roughly where it belongs.
          </p>
        </div>
        <span className="text-xs text-ink-600">{music.length} tracks</span>
      </div>

      {canEdit && (
        <form onSubmit={submit} className="mb-3 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="YouTube, Spotify or Deezer link…"
            className="input flex-1"
            disabled={pending}
          />
          <button type="submit" className="btn-primary shrink-0 text-xs" disabled={pending || !url.trim()}>
            {pending ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}

      {music.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-600">
          No music yet. What should this vlog sound like?
        </p>
      ) : (
        <div className="space-y-2">
          {music.map((track) => {
            const style = SOURCE_STYLE[track.source] ?? {
              label: track.source,
              className: "bg-ink-800 text-ink-300 border-ink-700",
            };
            const isOwn = track.addedById === memberId;

            return (
              <div
                key={track.id}
                className="rounded-lg border border-ink-800 bg-ink-850/60 p-2.5 transition-colors hover:border-ink-700"
              >
                <div className="flex items-center gap-3">
                  {track.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={track.thumbnailUrl}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-ink-800 text-lg">
                      🎵
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {track.title ?? track.url}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className={cn("chip border text-[10px]", style.className)}>
                        {style.label}
                      </span>
                      {track.artist && (
                        <span className="truncate text-[11px] text-ink-500">{track.artist}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <ReactionBar
                      slug={slug}
                      targetType="music"
                      targetId={track.id}
                      tiers={tiers}
                      mine={track.reactions.mine}
                      breakdown={track.reactions.breakdown}
                      size="sm"
                    />
                    <button
                      onClick={() => setPlaying(playing === track.id ? null : track.id)}
                      className="btn-ghost px-2 py-1 text-xs"
                      title="Preview"
                    >
                      {playing === track.id ? "▲" : "▶"}
                    </button>
                    {isOwn && (
                      <button
                        onClick={() => startTransition(() => deleteMusicAction(slug, track.id).then(() => {}))}
                        className="btn-ghost px-2 py-1 text-xs hover:text-red-300"
                        title="Remove"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {playing === track.id && (
                  <div className="mt-2 overflow-hidden rounded-lg">
                    <iframe
                      src={track.embedUrl}
                      className="h-[152px] w-full border-0"
                      allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
                      loading="lazy"
                      title={track.title ?? "Music preview"}
                    />
                  </div>
                )}

                {canEdit && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10px] text-ink-600">Start</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      defaultValue={track.timelinePosition}
                      onMouseUp={(e) => {
                        const value = Number((e.target as HTMLInputElement).value);
                        void moveMusicAction(slug, {
                          musicItemId: track.id,
                          timelinePosition: value,
                        });
                      }}
                      onTouchEnd={(e) => {
                        const value = Number((e.target as HTMLInputElement).value);
                        void moveMusicAction(slug, {
                          musicItemId: track.id,
                          timelinePosition: value,
                        });
                      }}
                      className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
                    />
                    <span className="text-[10px] text-ink-600">End</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
