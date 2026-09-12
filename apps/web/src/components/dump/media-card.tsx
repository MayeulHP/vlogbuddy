"use client";

import { useState } from "react";
import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { deleteMediaAction } from "@/lib/actions/media";
import { ReactionBar } from "./reaction-bar";
import { cn } from "@/lib/cn";

interface MediaCardProps {
  slug: string;
  item: MediaItemView;
  tiers: ReactionTier[];
  memberId: string;
  /** 0..1 — how highly ranked this item is relative to the rest. */
  prominence: number;
  onOpen?: (item: MediaItemView) => void;
}

export function MediaCard({ slug, item, tiers, memberId, prominence, onOpen }: MediaCardProps) {
  const [deleting, setDeleting] = useState(false);
  const isOwn = item.uploaderId === memberId;

  // Winners get bigger. This is the whole point of the dump view.
  const heightClass =
    prominence > 0.75 ? "h-56" : prominence > 0.45 ? "h-44" : prominence > 0.2 ? "h-36" : "h-28";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-ink-900 transition-all",
        heightClass,
        prominence > 0.75
          ? "border-brand-500/40 shadow-lg shadow-brand-500/10"
          : "border-ink-800 hover:border-ink-600",
      )}
    >
      <button
        onClick={() => onOpen?.(item)}
        className="block h-full w-full text-left"
        disabled={item.status !== "ready"}
      >
        {item.status === "ready" && item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt={item.originalFilename}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-ink-850 px-2 text-center">
            {item.status === "failed" ? (
              <>
                <span className="text-xl">⚠️</span>
                <span className="text-[11px] text-red-400">Couldn&apos;t process</span>
              </>
            ) : (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-600 border-t-brand-400" />
                <span className="text-[11px] text-ink-500">Processing…</span>
              </>
            )}
          </div>
        )}
      </button>

      {/* Badges */}
      <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
        {item.kind === "video" && (
          <span className="chip bg-black/70 text-[10px] text-white backdrop-blur-sm">
            ▶ {formatDuration(item.durationSeconds)}
          </span>
        )}
        {prominence > 0.75 && item.reactions.count > 0 && (
          <span className="chip bg-brand-500/90 text-[10px] text-white">★ Top</span>
        )}
      </div>

      {isOwn && (
        <button
          onClick={async () => {
            if (deleting) return;
            setDeleting(true);
            const res = await deleteMediaAction(slug, item.id);
            if (!res.ok) setDeleting(false);
          }}
          className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-red-500/80 group-hover:opacity-100"
          title="Remove your upload"
        >
          {deleting ? "…" : "✕"}
        </button>
      )}

      {/* Reactions + attribution */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-1.5 pt-6">
        <ReactionBar
          slug={slug}
          targetType="media"
          targetId={item.id}
          tiers={tiers}
          mine={item.reactions.mine}
          breakdown={item.reactions.breakdown}
          size="sm"
        />
        {item.uploaderName && (
          <p className="mt-1 truncate text-[10px] text-ink-400">{item.uploaderName}</p>
        )}
      </div>
    </div>
  );
}
