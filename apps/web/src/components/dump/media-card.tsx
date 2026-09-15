"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration, type ReactionTier } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { deleteMediaAction } from "@/lib/actions/media";
import { ReactionBar } from "./reaction-bar";
import { cn } from "@/lib/cn";
import { RotatedMedia } from "@/lib/rotated-media";

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
  /**
   * Pulling a frame can't be undone and the ✕ is a 30px target on a thumbnail,
   * so it arms first. The confirm takes the whole frame rather than sitting
   * beside the ✕ — at ~100px wide there is no beside.
   */
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwn = item.uploaderId === memberId;
  const rootRef = useRef<HTMLDivElement>(null);

  // A card left half-armed would be a trap the next time someone's thumb landed
  // on it, so anything that takes attention elsewhere stands it back down.
  useEffect(() => {
    if (!armed) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setArmed(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setArmed(false);
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [armed]);

  async function pull() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    const res = await deleteMediaAction(slug, item.id);
    if (!res.ok) {
      // The row is still there; say why, or the ✕ reads as a dud.
      setError(res.error);
      setDeleting(false);
      setArmed(false);
    }
  }

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
      ref={rootRef}
      onBlur={(e) => {
        // Only when focus actually landed somewhere else: a null relatedTarget
        // is also what you get when the ✕ unmounts under its own click.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setArmed(false);
      }}
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
          <RotatedMedia rotation={item.rotation}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.thumbnailUrl}
              alt={item.originalFilename}
              loading="lazy"
              className="print-tone h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
            />
          </RotatedMedia>
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

      {isOwn && !armed && (
        <button
          onClick={() => setArmed(true)}
          disabled={deleting}
          className="touch-visible absolute right-0 top-0 flex min-h-[30px] min-w-[30px] items-center justify-center bg-ink-950/70 px-1.5 py-0.5 font-mono text-2xs text-paper-200 opacity-0 transition-opacity hover:bg-signal-600 focus:opacity-100 group-hover:opacity-100"
          title="Pull your own upload"
        >
          {deleting ? "…" : "✕"}
        </button>
      )}

      {isOwn && armed && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 overflow-hidden bg-ink-950/92 p-1 text-center">
          {/*
            The least-marked frames on the light table are also the smallest —
            58px tall on a phone — and that is not enough room for a question
            and two buttons. So the question is the part allowed to shrink away:
            the buttons say "Pull" and "Keep" on their own.
          */}
          <p className="min-h-0 shrink overflow-hidden font-mono text-2xs uppercase leading-tight tracking-label text-paper-200">
            Pull this frame?
          </p>
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1">
            <button
              onClick={pull}
              disabled={deleting}
              className="flex min-h-[32px] min-w-[44px] items-center justify-center bg-signal-600 px-2 font-mono text-2xs uppercase tracking-label text-paper-50 transition-colors hover:bg-signal-700 disabled:opacity-60"
              autoFocus
            >
              {deleting ? "…" : "Pull"}
            </button>
            <button
              onClick={() => setArmed(false)}
              disabled={deleting}
              className="flex min-h-[32px] min-w-[44px] items-center justify-center border border-ink-600 px-2 font-mono text-2xs uppercase tracking-label text-paper-200 transition-colors hover:border-paper-200"
            >
              Keep
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-x-0 top-0 z-20 bg-ink-950/92 p-1.5">
          <p role="alert" className="text-[11px] leading-tight text-signal-300">
            {error}
          </p>
          <button
            onClick={() => setError(null)}
            className="mt-1 flex min-h-[30px] items-center font-mono text-2xs uppercase tracking-label text-ink-300 hover:text-paper-100"
          >
            Dismiss
          </button>
        </div>
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
          pass={false}
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
