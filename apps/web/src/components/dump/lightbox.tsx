"use client";

import { useEffect } from "react";
import type { ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { ReactionBar } from "./reaction-bar";

export function Lightbox({
  item,
  slug,
  tiers,
  onClose,
}: {
  item: MediaItemView;
  slug: string;
  tiers: ReactionTier[];
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
    <div
      className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-black/92 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-white">{item.originalFilename}</p>
          {item.uploaderName && (
            <p className="text-xs text-ink-500">Added by {item.uploaderName}</p>
          )}
        </div>
        <button onClick={onClose} className="btn-ghost text-lg" aria-label="Close">
          ✕
        </button>
      </div>

      <div
        className="flex flex-1 items-center justify-center px-4 pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        {src ? (
          item.kind === "video" ? (
            <video
              src={src}
              controls
              autoPlay
              playsInline
              className="max-h-full max-w-full rounded-lg"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={item.originalFilename} className="max-h-full max-w-full rounded-lg object-contain" />
          )
        ) : (
          <p className="text-sm text-ink-500">Still processing…</p>
        )}
      </div>

      <div className="flex justify-center pb-6" onClick={(e) => e.stopPropagation()}>
        <div className="rounded-full border border-white/10 bg-black/60 px-3 py-2">
          <ReactionBar
            slug={slug}
            targetType="media"
            targetId={item.id}
            tiers={tiers}
            mine={item.reactions.mine}
            breakdown={item.reactions.breakdown}
          />
        </div>
      </div>
    </div>
  );
}
