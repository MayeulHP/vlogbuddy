"use client";

import { useState, useTransition } from "react";
import {
  FORMAT_BLURBS,
  FORMAT_LABELS,
  FORMAT_RATIOS,
  VIDEO_FORMATS,
  frameFor,
  previewFrame,
  type ClipFit,
  type VideoFormat,
} from "@vlogbuddy/shared";
import { setVlogFormatAction } from "@/lib/actions/vlog";
import { cn } from "@/lib/cn";

/**
 * This panel used to promise black edges outright. It can't any more, and a
 * panel that describes the frame while lying about what lands in it is worse
 * than one that says nothing — so it reports the film's current answer and
 * leaves the choosing to the auto-cut panel, which everyone can reach.
 */
const FIT_POLICY_NOTE: Record<ClipFit, string> = {
  bars: "Footage that doesn't fit gets black edges rather than a crop — nothing is ever cut off.",
  fill: "Footage that doesn't fit is cropped to fill it — the edges of those shots are lost.",
  blur: "Footage that doesn't fit keeps all of itself, on a blurred copy of the same shot.",
};

/**
 * The shape of the film.
 *
 * It sits on the bench rather than on /admin because it belongs to this film,
 * not to the machine — and rather than in the print dialog because it changes
 * what the preview two panels up is showing, which is the only honest way to
 * choose it. Open to the whole crew, like the fit policy it sits under: anyone
 * here can already reframe any single shot, so gating the shape would be a lock
 * with the door open. It re-proportions everybody's layers at once, which is
 * why the panel says so out loud rather than hiding behind a permission.
 */
export function FormatPanel({
  slug,
  format,
  shortEdge,
  fitPolicy,
  layers,
  locked,
  bare = false,
}: {
  slug: string;
  format: VideoFormat;
  /** What the film does with shots of another shape; set next door. */
  fitPolicy: ClipFit;
  /** The operator's render size; the long edge follows from the shape. */
  shortEdge: number;
  /** How many layers are placed — they're what a change of shape disturbs. */
  layers: number;
  locked: boolean;
  /** Inside the bench's tab strip, the tab is the panel's header. */
  bare?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const frame = frameFor(format, shortEdge);

  function choose(next: VideoFormat) {
    if (next === format) return;
    setError(null);
    startTransition(async () => {
      const result = await setVlogFormatAction(slug, next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className={cn(!bare && "border border-[color:var(--hair-dark)] bg-ink-850")}>
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        {!bare && (
          <>
            <p className="eyebrow-light">What comes out of the lab</p>
            <h3 className="headline mt-0.5 text-xl text-paper-100">The frame</h3>
          </>
        )}
        <p className={cn("text-[13px] leading-relaxed text-ink-300", !bare && "mt-1")}>
          {frame.width}×{frame.height} · {FORMAT_LABELS[format].toLowerCase()}.{" "}
          {FIT_POLICY_NOTE[fitPolicy]}
        </p>
      </div>

      <div className="space-y-4 px-4 py-4">
        <div className="grid grid-cols-3 gap-1">
          {VIDEO_FORMATS.map((option) => {
            const chosen = option === format;
            const shape = previewFrame(option);
            return (
              <button
                key={option}
                type="button"
                disabled={locked || pending}
                onClick={() => choose(option)}
                aria-pressed={chosen}
                className={cn(
                  "flex flex-col items-center gap-1.5 border px-2 py-2.5 text-xs transition-colors disabled:opacity-50",
                  chosen
                    ? "border-paper-100 bg-paper-100 text-ink-900"
                    : "border-[color:var(--hair-dark)] text-ink-300 hover:text-paper-100",
                )}
              >
                {/* The choice drawn at the size it is — three words for three
                    shapes reads as jargon; three rectangles doesn't. */}
                <span
                  aria-hidden
                  className={cn(
                    "block w-full max-w-[34px] border",
                    chosen ? "border-ink-900/60 bg-ink-900/15" : "border-ink-400",
                  )}
                  style={{ aspectRatio: `${shape.width} / ${shape.height}` }}
                />
                <span className="leading-none">{FORMAT_LABELS[option]}</span>
                <span
                  className={cn(
                    "font-mono text-[10px] leading-none",
                    chosen ? "text-ink-900/70" : "text-ink-400",
                  )}
                >
                  {FORMAT_RATIOS[option]}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-2xs leading-relaxed text-ink-400">{FORMAT_BLURBS[format]}</p>

        {layers > 0 && (
          <p className="text-2xs leading-relaxed text-ink-400">
            Your {layers === 1 ? "layer keeps its" : `${layers} layers keep their`} place in the
            frame, but a new shape stretches {layers === 1 ? "it" : "them"} — worth a look at the
            preview afterwards. Switch back and {layers === 1 ? "it's" : "they're"} exactly as
            you left {layers === 1 ? "it" : "them"}.
          </p>
        )}

        {error && <p className="text-2xs text-rust-400">{error}</p>}
      </div>
    </section>
  );
}
