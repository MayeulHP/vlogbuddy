"use client";

import { useMemo, useState } from "react";
import { formatDuration } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { RotatedMedia } from "@/lib/rotated-media";
import { cn } from "@/lib/cn";

/**
 * The pile, on the bench.
 *
 * A shot normally reaches the film through the vote or through Gather's pin,
 * which means noticing mid-edit that something is missing used to mean leaving
 * the bench. This is the same pile, filtered to what *isn't* in the cut, with
 * one tap to drop it in beside the shot you're looking at.
 *
 * Adding goes through the cut engine (`addToCutAction`), never through a
 * document op: membership lives in `media_items.cutOverride` and the running
 * order in `selections`, so an insert written only to the doc is undone by the
 * next vote.
 */

type KindFilter = "all" | "photo" | "video";

/** Ready, unswept footage that hasn't made it into the base track. */
export function pileCandidates(
  media: MediaItemView[],
  clipMediaIds: Set<string>,
): MediaItemView[] {
  return media.filter(
    (m) =>
      m.kind !== "audio" &&
      m.status === "ready" &&
      m.prunedAt === null &&
      !clipMediaIds.has(m.id),
  );
}

export function PileDrawer({
  media,
  clipMediaIds,
  currentMediaItemId,
  currentLabel,
  busy = false,
  onAdd,
}: {
  media: MediaItemView[];
  /** Every media id the base track is currently showing. */
  clipMediaIds: Set<string>;
  /** The selected shot — what "after the current shot" means right now. */
  currentMediaItemId: string | null;
  /** How to name that shot in the button, e.g. "shot 4". */
  currentLabel: string | null;
  busy?: boolean;
  onAdd: (mediaItemId: string, afterMediaItemId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");

  const available = useMemo(
    () => pileCandidates(media, clipMediaIds),
    [media, clipMediaIds],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return available
      .filter((m) => (kind === "all" ? true : m.kind === kind))
      .filter((m) =>
        needle === ""
          ? true
          : (m.originalFilename ?? "").toLowerCase().includes(needle) ||
            (m.uploaderName ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const at = a.capturedAt ? new Date(a.capturedAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bt = b.capturedAt ? new Date(b.capturedAt).getTime() : Number.MAX_SAFE_INTEGER;
        if (at !== bt) return at - bt;
        return a.uploadIndex - b.uploadIndex;
      });
  }, [available, kind, query]);

  return (
    <section>
      <div className="flex items-center gap-2 border-b border-[color:var(--hair-dark)] px-4 py-2">
        <p className="min-w-0 flex-1 truncate font-mono text-2xs uppercase tracking-label text-ink-400">
          {/* "Here" is the shot under the playhead; the row is too narrow to
              say so twice, so the buttons' tooltips carry the detail. */}
          {currentLabel ? `Here = after ${currentLabel}` : "Left out of the cut"}
        </p>
        <div className="flex shrink-0 items-stretch border border-[color:var(--hair-dark)]">
          {(["all", "photo", "video"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={cn(
                "px-2 py-1 font-mono text-2xs uppercase tracking-label transition-colors",
                kind === k
                  ? "bg-paper-100 text-ink-900"
                  : "text-ink-400 hover:bg-ink-800 hover:text-paper-100",
              )}
            >
              {k === "all" ? "All" : k === "photo" ? "Photos" : "Video"}
            </button>
          ))}
        </div>
      </div>

      {available.length > 0 && (
        <div className="border-b border-[color:var(--hair-dark)] px-3 py-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the pile"
            aria-label="Search the pile"
            className="w-full border border-[color:var(--hair-dark)] bg-ink-900 px-2 py-1.5 text-xs text-paper-100 placeholder:text-ink-500 focus:outline-none focus:ring-1 focus:ring-paper-100/40"
          />
        </div>
      )}

      {available.length === 0 ? (
        <p className="px-4 py-4 text-[13px] leading-relaxed text-ink-400">
          Everything that&apos;s ready is already in the film. Add more to the pile on the floor
          and it&apos;ll show up here.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-4 text-[13px] leading-relaxed text-ink-400">
          Nothing in the pile matches that. Try a shorter search.
        </p>
      ) : (
        <div className="divide-y divide-[color:var(--hair-dark)]">
          {rows.map((item) => (
            <div key={item.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                {item.thumbnailUrl ? (
                  <RotatedMedia rotation={item.rotation} className="h-10 w-14 shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                  </RotatedMedia>
                ) : (
                  <span className="h-10 w-14 shrink-0 bg-ink-800 bg-hatch" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-ink-200">{item.originalFilename}</p>
                  <p className="mt-0.5 font-mono text-2xs uppercase tracking-label text-ink-400">
                    {item.kind === "video" && item.durationSeconds
                      ? formatDuration(item.durationSeconds)
                      : "Still"}
                    {" · "}
                    {item.reactions.count > 0
                      ? `rank ${item.reactions.rank.toFixed(1)}`
                      : "no reactions yet"}
                  </p>
                </div>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || !currentMediaItemId}
                  onClick={() => onAdd(item.id, currentMediaItemId)}
                  className="btn-outline-dark flex-1 px-2 py-1 text-2xs disabled:opacity-40"
                  title={
                    currentMediaItemId
                      ? `Add after ${currentLabel ?? "the current shot"}`
                      : "Pick a shot on the strip first"
                  }
                >
                  {/* Where you're looking is where you meant it to go: the
                      button names the place, not the operation. */}
                  Add here
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAdd(item.id, null)}
                  className="btn-quiet-dark shrink-0 px-2 py-1 text-2xs disabled:opacity-40"
                >
                  At the end
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
