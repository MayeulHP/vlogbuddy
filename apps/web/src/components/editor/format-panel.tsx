"use client";

import { useState, useTransition } from "react";
import {
  FORMAT_BLURBS,
  FORMAT_LABELS,
  FORMAT_RATIOS,
  VIDEO_FORMATS,
  frameFor,
  previewFrame,
  type VideoFormat,
} from "@vlogbuddy/shared";
import { setVlogFormatAction } from "@/lib/actions/vlog";
import { Blurb } from "./director-panel";
import { cn } from "@/lib/cn";

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
  layers,
  locked,
}: {
  slug: string;
  format: VideoFormat;
  /** The operator's render size; the long edge follows from the shape. */
  shortEdge: number;
  /** How many layers are placed — they're what a change of shape disturbs. */
  layers: number;
  locked: boolean;
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
    <section>
      <div className="px-4 pt-4">
        {/* What shots of another shape do here is the auto-cut's setting, and
            it's explained where it's set — saying it again in different words
            was the panel's own footnote contradicting itself. */}
        <p className="eyebrow-light">
          Shape
          <span className="ml-2 normal-case tracking-normal text-ink-400">
            {frame.width}×{frame.height}
          </span>
        </p>
      </div>

      <div className="space-y-4 px-4 py-3">
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

        {/* Both of these run to a paragraph, and neither is news until you're
            about to change the shape — so they wait behind the mark. */}
        <p className="eyebrow-light">
          About this shape
          <Blurb label="the shape">
            {FORMAT_BLURBS[format]}
            {layers > 0 && (
              <>
                {" "}
                Your {layers === 1 ? "layer keeps its" : `${layers} layers keep their`} place in
                the frame, but a new shape stretches {layers === 1 ? "it" : "them"} — worth a look
                at the preview afterwards. Switch back and{" "}
                {layers === 1 ? "it's" : "they're"} exactly as you left{" "}
                {layers === 1 ? "it" : "them"}.
              </>
            )}
          </Blurb>
        </p>

        {error && <p className="text-2xs text-rust-400">{error}</p>}
      </div>
    </section>
  );
}
