"use client";

import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { useDialog } from "@/hooks/use-dialog";
import { previewSrc } from "@/lib/preview-src";
import { RotatedMedia } from "@/lib/rotated-media";
import { RotateButton } from "@/components/rotate-button";
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
  // Escape, the focus trap, the scroll lock and putting focus back on the frame
  // you opened from all live in the hook — this only has to be a dialog.
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const src = previewSrc(item);

  // The scrim is `/95`, not `/97`: 97 isn't a step on Tailwind's opacity scale,
  // so it compiled to no background at all and the lightbox was see-through.
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lightbox-title"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex animate-fade-in flex-col bg-ink-950/95 focus:outline-none"
      onClick={onClose}
    >
      <header className="pt-safe px-safe border-b border-[color:var(--hair-dark)]">
        <div className="flex items-end justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="eyebrow-light">
              {item.uploaderName ? `Shot by ${item.uploaderName}` : "Unattributed"}
              {item.kind === "video" && ` · ${formatDuration(item.durationSeconds)}`}
            </p>
            <p id="lightbox-title" className="timecode mt-0.5 truncate text-sm text-paper-100">
              {item.originalFilename}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {/* Beside Close because that is where the hand already is once a
                sideways shot is filling the screen. */}
            <RotateButton slug={slug} mediaItemId={item.id} className="btn-outline-dark" />
            <button onClick={onClose} className="btn-outline-dark" aria-label="Close">
              Close
            </button>
          </div>
        </div>
      </header>

      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {src ? (
          <RotatedMedia rotation={item.rotation}>
            {item.kind === "video" ? (
              <video
                src={src}
                controls
                autoPlay
                playsInline
                className="h-full w-full object-contain"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={item.originalFilename}
                className="print-tone h-full w-full object-contain"
              />
            )}
          </RotatedMedia>
        ) : (
          <p className="font-mono text-2xs uppercase tracking-label text-ink-400">Developing…</p>
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
