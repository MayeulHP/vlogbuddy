"use client";

import { useEffect } from "react";
import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { useDialog } from "@/hooks/use-dialog";
import { ReactionBar } from "./reaction-bar";

/** One frame, enlarged, with its slate and the crew's marks. */
export function Lightbox({
  item,
  slug,
  tiers,
  crew,
  onClose,
}: {
  item: MediaItemView;
  slug: string;
  tiers: ReactionTier[];
  crew?: number;
  onClose: () => void;
}) {
  // Escape, the scroll lock, a focus trap and focus put back where it came
  // from — all of which this had none of but the first two.
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  // Photos get a proxy too now — a JPEG standing in for an iPhone's HEIC, which
  // no browser but Safari will paint, or for an original too big to be worth
  // downloading whole just to look at it.
  const src = item.proxyUrl ?? item.originalUrl;

  // The scrim is `/95`, not `/97`: 97 isn't a step on Tailwind's opacity scale,
  // so it compiled to no background at all and the lightbox was see-through.
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Full frame"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex animate-fade-in flex-col bg-ink-950/95 outline-none"
      onClick={onClose}
    >
      <header className="pt-safe px-safe border-b border-[color:var(--hair-dark)]">
        <div className="flex items-end justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="eyebrow-light">
              {item.uploaderName ? `Shot by ${item.uploaderName}` : "Unattributed"}
              {item.kind === "video" && ` · ${formatDuration(item.durationSeconds)}`}
            </p>
            <p className="timecode mt-0.5 truncate text-sm text-paper-100">
              {item.originalFilename}
            </p>
          </div>
          <button onClick={onClose} className="btn-outline-dark shrink-0" aria-label="Close">
            Close
          </button>
        </div>
      </header>

      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {src ? (
          item.kind === "video" ? (
            <video src={src} controls autoPlay playsInline className="max-h-full max-w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={item.originalFilename}
              className="print-tone max-h-full max-w-full object-contain"
            />
          )
        ) : (
          <p className="font-mono text-2xs uppercase tracking-label text-ink-500">Developing…</p>
        )}
      </div>

      <footer
        className="pb-safe px-safe border-t border-[color:var(--hair-dark)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-4">
          <span className="eyebrow-light">Your mark</span>
          <ReactionBar
            slug={slug}
            targetType="media"
            targetId={item.id}
            tiers={tiers}
            mine={item.reactions.mine}
            breakdown={item.reactions.breakdown}
            crew={crew}
            tone="dark"
          />
        </div>
      </footer>
    </div>
  );
}
