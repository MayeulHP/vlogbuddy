"use client";

import { useState, useTransition } from "react";
import {
  CLIP_FITS,
  FIT_BLURBS,
  FIT_LABELS,
  FORMAT_BLURBS,
  FORMAT_LABELS,
  FORMAT_RATIOS,
  VIDEO_FORMATS,
  frameFor,
  previewFrame,
  type ClipFit,
  type TimelineDoc,
  type TimelineOp,
  type VideoFormat,
} from "@vlogbuddy/shared";
import { setVlogFormatAction } from "@/lib/actions/vlog";
import { cn } from "@/lib/cn";

/**
 * The shape of the film, and what fills the frame when a shot isn't it.
 *
 * Two controls rather than one, because they belong to different people. The
 * shape binds everyone's footage at once and re-proportions every layer, so
 * it's the creator's and goes through a server action. What happens in the
 * margins is a look, so it rides the document like any other edit and anybody
 * cutting can change it.
 *
 * They sit together anyway: choosing a tall film is choosing what happens to
 * every wide shot in it, and the second question is only ever asked because of
 * the first.
 */
export function FormatPanel({
  slug,
  format,
  shortEdge,
  timeline,
  isCreator,
  locked,
  onDispatch,
}: {
  slug: string;
  format: VideoFormat;
  /** The operator's render size; the long edge follows from the shape. */
  shortEdge: number;
  timeline: TimelineDoc;
  isCreator: boolean;
  locked: boolean;
  onDispatch: (op: TimelineOp) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const frame = frameFor(format, shortEdge);
  const layers = timeline.layers.length;
  const policy = timeline.director.fitPolicy;

  function choose(next: VideoFormat) {
    if (next === format) return;
    setError(null);
    startTransition(async () => {
      const result = await setVlogFormatAction(slug, next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <p className="eyebrow-light">What it prints as</p>
        <h3 className="headline mt-0.5 text-xl text-paper-100">Shape</h3>
        <p className="timecode mt-1 text-2xs text-ink-400">
          {frame.width}×{frame.height}
        </p>
      </div>

      <div className="space-y-5 px-4 py-4">
        <div>
          <div className="grid grid-cols-3 gap-1">
            {VIDEO_FORMATS.map((option) => {
              const chosen = option === format;
              const shape = previewFrame(option);
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!isCreator || locked || pending}
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

          <p className="mt-2 text-2xs leading-relaxed text-ink-400">
            {FORMAT_BLURBS[format]}
            {layers > 0 && (
              <>
                {" "}
                Your {layers === 1 ? "layer keeps its" : `${layers} layers keep their`} place in
                the frame, but a new shape stretches {layers === 1 ? "it" : "them"} — worth a
                look at the picture afterwards.
              </>
            )}
          </p>

          {!isCreator && (
            <p className="mt-2 text-2xs leading-relaxed text-ink-500">
              Whoever started this film picks its shape. Everything below is yours.
            </p>
          )}
          {error && <p className="mt-2 text-2xs text-signal-400">{error}</p>}
        </div>

        {/*
          The consequence of the shape above, and the only reason anybody needs
          to know the word for it. Shots already the right way round are left
          exactly alone whatever this says — `resolveFit` only asks the question
          where there's a genuine mismatch.
        */}
        <div className="border-t border-[color:var(--hair-dark)] pt-4">
          <p className="eyebrow-light mb-2">Shots of another shape</p>
          <div className="grid grid-cols-3 gap-1">
            {CLIP_FITS.map((option: ClipFit) => (
              <button
                key={option}
                type="button"
                disabled={locked}
                aria-pressed={policy === option}
                onClick={() =>
                  onDispatch({ type: "settings.update", patch: { director: { fitPolicy: option } } })
                }
                className={cn(
                  "border px-2 py-2 text-xs transition-colors disabled:opacity-50",
                  policy === option
                    ? "border-paper-100 bg-paper-100 text-ink-900"
                    : "border-[color:var(--hair-dark)] text-ink-300 hover:text-paper-100",
                )}
              >
                {FIT_LABELS[option]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-ink-400">
            {FIT_BLURBS[policy]}{" "}
            {format === "landscape"
              ? "Upright phone footage is what this happens to most."
              : format === "portrait"
                ? "Anything filmed sideways is what this happens to most."
                : "Both the wide shots and the upright ones land here."}{" "}
            Any single shot can be told to do something else.
          </p>
        </div>
      </div>
    </section>
  );
}
