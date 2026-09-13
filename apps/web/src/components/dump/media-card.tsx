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
  crew?: number;
  /** 0..1 — how highly the crew has marked this, relative to the rest. */
  prominence: number;
  fill?: boolean;
  dimmed?: boolean;
  /** Above the cut line: gets the signal edge and the SEL slug. */
  selected?: boolean;
  onOpen?: (item: MediaItemView) => void;
}

/**
 * One frame on the light table. A hairline, a slug, and the crew's marks along
 * the bottom edge — the frame itself does the talking, so the chrome stays as
 * thin as a contact-sheet border.
 */
export function MediaCard({
  slug,
  item,
  tiers,
  memberId,
  crew,
  prominence,
  fill,
  dimmed,
  selected,
  onOpen,
}: MediaCardProps) {
  const [deleting, setDeleting] = useState(false);
  const isOwn = item.uploaderId === memberId;

  // Better-marked frames get more of the table. That's the whole idea.
  const heightClass = fill
    ? "h-full"
    : prominence > 0.75
      ? "h-56"
      : prominence > 0.45
        ? "h-44"
        : prominence > 0.2
          ? "h-36"
          : "h-28";

  return (
    <div
      className={cn(
        "group relative overflow-hidden border bg-ink-900 transition-[opacity,filter,box-shadow] duration-300",
        heightClass,
        selected ? "border-signal-600 shadow-print" : "border-ink-900/70",
        dimmed && "opacity-45 saturate-[0.35]",
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
            className="print-tone h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-ink-850 bg-hatch px-2 text-center">
            {item.status === "failed" ? (
              <span className="font-mono text-2xs uppercase tracking-label text-signal-400">
                Unusable
              </span>
            ) : (
              <>
                <span className="h-3 w-3 animate-sweep border border-ink-500 border-t-signal-500" />
                <span className="font-mono text-2xs uppercase tracking-label text-ink-400">
                  Developing
                </span>
              </>
            )}
          </div>
        )}
      </button>

      {/* Slugs: media kind, and whether the crew put it in the cut. */}
      <div className="pointer-events-none absolute left-0 top-0 flex flex-col items-start gap-px">
        {item.kind === "video" && (
          <span className="bg-ink-950/80 px-1 py-px font-mono text-2xs tabular-nums text-paper-200">
            ▶ {formatDuration(item.durationSeconds)}
          </span>
        )}
        {selected && (
          <span className="bg-signal-600 px-1 py-px font-mono text-2xs uppercase tracking-label text-paper-50">
            Sel
          </span>
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
          className="touch-visible absolute right-0 top-0 flex min-h-[30px] min-w-[30px] items-center justify-center bg-ink-950/70 px-1.5 py-0.5 font-mono text-2xs text-paper-200 opacity-0 transition-opacity hover:bg-signal-600 focus:opacity-100 group-hover:opacity-100"
          title="Pull your own upload"
        >
          {deleting ? "…" : "✕"}
        </button>
      )}

      {/* Marks and attribution, on the frame's lower border. */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/95 via-ink-950/70 to-transparent px-1.5 pb-1.5 pt-7">
        <ReactionBar
          slug={slug}
          targetType="media"
          targetId={item.id}
          tiers={tiers}
          mine={item.reactions.mine}
          breakdown={item.reactions.breakdown}
          crew={crew}
          size="sm"
          quiet
        />
        {item.uploaderName && (
          <p className="mt-1 truncate font-mono text-2xs uppercase tracking-label text-paper-200/70">
            {item.uploaderName}
          </p>
        )}
      </div>
    </div>
  );
}
