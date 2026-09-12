"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ReactionTier, ServerToClientEvents } from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "@/lib/queries";
import { MediaCard } from "./media-card";
import { UploadZone } from "./upload-zone";
import { MusicStrip } from "./music-strip";
import { Lightbox } from "./lightbox";
import { cn } from "@/lib/cn";

interface DumpViewProps {
  slug: string;
  vlogId: string;
  media: MediaItemView[];
  music: MusicItemView[];
  reactionTiers: ReactionTier[];
  memberId: string;
  socket: React.MutableRefObject<Socket<ServerToClientEvents, ClientToServerEvents> | null>;
  ytAudioEnabled: boolean;
}

type SortMode = "chrono" | "ranked";

/**
 * The dump view. Items flow left-to-right in rough chronological order, grouped
 * into time buckets; within each bucket the best-voted float to the front and
 * render larger. Chronology is preserved so music pins line up with where a
 * track will actually sit in the final cut.
 */
export function DumpView({
  slug,
  media,
  music,
  reactionTiers,
  memberId,
  ytAudioEnabled,
}: DumpViewProps) {
  const router = useRouter();
  const [sortMode, setSortMode] = useState<SortMode>("chrono");
  const [lightboxItem, setLightboxItem] = useState<MediaItemView | null>(null);

  const maxRank = useMemo(
    () => Math.max(0.001, ...media.map((m) => m.reactions.rank)),
    [media],
  );

  /** Group into chronological buckets (by day when we know the capture time). */
  const buckets = useMemo(() => {
    if (media.length === 0) return [];

    if (sortMode === "ranked") {
      return [
        {
          key: "all",
          label: "Best first",
          items: [...media].sort((a, b) => b.reactions.rank - a.reactions.rank),
        },
      ];
    }

    const groups = new Map<string, { key: string; label: string; items: MediaItemView[] }>();

    for (const item of media) {
      const when = item.capturedAt ? new Date(item.capturedAt) : null;
      const key = when ? when.toISOString().slice(0, 10) : "unknown";
      const label = when
        ? when.toLocaleDateString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
          })
        : "No date";

      if (!groups.has(key)) groups.set(key, { key, label, items: [] });
      groups.get(key)!.items.push(item);
    }

    // Chronological buckets; undated items trail at the end.
    const ordered = Array.from(groups.values()).sort((a, b) => {
      if (a.key === "unknown") return 1;
      if (b.key === "unknown") return -1;
      return a.key.localeCompare(b.key);
    });

    // Inside a bucket, the crowd's favourites lead.
    for (const bucket of ordered) {
      bucket.items.sort((a, b) => {
        const diff = b.reactions.rank - a.reactions.rank;
        if (Math.abs(diff) > 0.001) return diff;
        return a.uploadIndex - b.uploadIndex;
      });
    }

    return ordered;
  }, [media, sortMode]);

  const processing = media.filter((m) => m.status === "pending" || m.status === "processing").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        <UploadZone slug={slug} onUploaded={() => router.refresh()} />

        {media.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">The pile</h2>
                <p className="text-xs text-ink-500">
                  React to what should make the cut — the best rise to the top.
                  {processing > 0 && ` · ${processing} still processing`}
                </p>
              </div>

              <div className="flex gap-1 rounded-lg border border-ink-800 bg-ink-900 p-0.5">
                {(
                  [
                    { mode: "chrono" as const, label: "Chronological" },
                    { mode: "ranked" as const, label: "Best first" },
                  ]
                ).map(({ mode, label }) => (
                  <button
                    key={mode}
                    onClick={() => setSortMode(mode)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs transition-colors",
                      sortMode === mode
                        ? "bg-ink-700 text-white"
                        : "text-ink-400 hover:text-ink-200",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-5">
              {buckets.map((bucket) => (
                <section key={bucket.key}>
                  <div className="mb-2 flex items-center gap-3">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-ink-500">
                      {bucket.label}
                    </h3>
                    <div className="h-px flex-1 bg-ink-800" />
                    <span className="text-xs text-ink-600">{bucket.items.length}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                    {bucket.items.map((item) => (
                      <MediaCard
                        key={item.id}
                        slug={slug}
                        item={item}
                        tiers={reactionTiers}
                        memberId={memberId}
                        prominence={item.reactions.rank / maxRank}
                        onOpen={setLightboxItem}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {media.length === 0 && (
          <div className="card px-6 py-12 text-center">
            <div className="text-3xl">🫙</div>
            <h3 className="mt-3 font-semibold text-white">The pile is empty</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-ink-400">
              Drop in the photos and videos from the trip. Everyone with the link
              can add theirs too.
            </p>
          </div>
        )}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-36 lg:self-start">
        <MusicStrip
          slug={slug}
          music={music}
          tiers={reactionTiers}
          memberId={memberId}
          canEdit
        />

        {!ytAudioEnabled && music.length > 0 && (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            Music links are for picking and placing the vibe. For the final render,
            upload an audio file — streaming tracks can&apos;t be baked into the video.
          </p>
        )}
      </aside>

      {lightboxItem && (
        <Lightbox
          item={lightboxItem}
          slug={slug}
          tiers={reactionTiers}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </div>
  );
}
