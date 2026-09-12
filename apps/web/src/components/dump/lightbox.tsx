"use client";

import { useEffect } from "react";
import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const src = item.kind === "video" ? item.proxyUrl ?? item.originalUrl : item.originalUrl;

  return (
    <div className="fixed inset-0 z-[100] flex animate-fade-in flex-col bg-ink-950/97" onClick={onClose}>
      <header className="flex items-end justify-between gap-4 border-b border-[color:var(--hair-dark)] px-4 py-3 sm:px-6">
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
        className="flex justify-center border-t border-[color:var(--hair-dark)] px-4 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
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
