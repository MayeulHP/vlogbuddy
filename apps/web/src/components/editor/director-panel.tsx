"use client";

import { useState, useTransition } from "react";
import {
  PACE_BLURBS,
  PACE_LABELS,
  PACE_PRESETS,
  detectScenes,
  type CutEntry,
  type Pace,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { runDirectorAction } from "@/lib/actions/timeline";
import { cn } from "@/lib/cn";

/**
 * The auto-cut's controls.
 *
 * Deliberately not in `stack-panels.tsx`: that file exists to draw a line
 * around the two hand-built stacks the vote has no opinion about, and this is
 * precisely the vote's opinion about the base track.
 *
 * Everything here goes through a server action rather than the socket, because
 * changing the pace has to be followed by a re-sync and the two can't race.
 */
export function DirectorPanel({
  slug,
  timeline,
  mediaById,
  locked,
}: {
  slug: string;
  timeline: TimelineDoc;
  mediaById: Map<string, MediaItemView>;
  locked: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const director = timeline.director;

  // The same scene detection the floor shows, so both rooms agree on where the
  // days break.
  const cut: CutEntry[] = timeline.clips.map((c) => {
    const media = mediaById.get(c.mediaItemId);
    return {
      mediaItemId: c.mediaItemId,
      kind: c.kind,
      durationSeconds: media?.durationSeconds ?? null,
      capturedAt: media?.capturedAt ? new Date(media.capturedAt).getTime() : null,
      rank: media?.reactions.rank ?? 0,
    };
  });
  const scenes = detectScenes(cut);
  const handCut = timeline.clips.filter((c) => c.auto.length === 0).length;

  function run(input: Parameters<typeof runDirectorAction>[1]) {
    setError(null);
    startTransition(async () => {
      const result = await runDirectorAction(slug, input);
      if (!result.ok) setError(result.error);
      else setConfirming(false);
    });
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <p className="eyebrow-light">Straight from the vote</p>
        <h3 className="headline mt-0.5 text-xl text-paper-100">Auto-cut</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-300">
          {scenes.length > 1
            ? `${timeline.clips.length} shots across ${scenes.length} scenes, timed by the crew's marks.`
            : "Every shot timed by the crew's marks."}
        </p>
      </div>

      <div className="space-y-5 px-4 py-4">
        <div>
          <p className="eyebrow-light mb-2">Pace</p>
          <div className="grid grid-cols-3 gap-1">
            {PACE_PRESETS.map((pace: Pace) => (
              <button
                key={pace}
                type="button"
                disabled={locked || pending}
                onClick={() => run({ settings: { pace } })}
                className={cn(
                  "border px-2 py-2 text-xs transition-colors disabled:opacity-50",
                  director.pace === pace
                    ? "border-paper-100 bg-paper-100 text-ink-900"
                    : "border-[color:var(--hair-dark)] text-ink-300 hover:text-paper-100",
                )}
              >
                {PACE_LABELS[pace]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-ink-400">
            {PACE_BLURBS[director.pace]}
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={director.sceneText}
            disabled={locked || pending}
            onChange={(e) => run({ settings: { sceneText: e.target.checked } })}
            className="mt-0.5 accent-paper-100"
          />
          <span>
            <span className="block text-[13px] text-paper-100">Name the scenes on screen</span>
            <span className="block text-2xs leading-relaxed text-ink-400">
              Burns the day and time over the first shot of each scene — &ldquo;Saturday
              morning&rdquo;.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={director.enabled}
            disabled={locked || pending}
            onChange={(e) => run({ settings: { enabled: e.target.checked } })}
            className="mt-0.5 accent-paper-100"
          />
          <span>
            <span className="block text-[13px] text-paper-100">Let the vote set the lengths</span>
            <span className="block text-2xs leading-relaxed text-ink-400">
              Turn this off and new shots arrive at their full recorded length.
            </span>
          </span>
        </label>

        <div className="border-t border-[color:var(--hair-dark)] pt-4">
          {confirming ? (
            <div className="space-y-2">
              <p className="text-[13px] leading-relaxed text-paper-100">
                {handCut > 0
                  ? `This puts all ${timeline.clips.length} shots back to the length the crew's marks suggest — including the ${handCut} ${handCut === 1 ? "you've" : "you've"} trimmed by hand. There's no undo.`
                  : "This puts every shot back to the length the crew's marks suggest. There's no undo."}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run({ recut: true })}
                  className="flex-1 border border-rust-400 bg-rust-400 px-3 py-2 text-xs text-ink-900 disabled:opacity-50"
                >
                  {pending ? "Re-cutting…" : "Yes, start again"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                  className="border border-[color:var(--hair-dark)] px-3 py-2 text-xs text-ink-300 hover:text-paper-100"
                >
                  Keep my cut
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={locked || pending || timeline.clips.length === 0}
                onClick={() => setConfirming(true)}
                className="w-full border border-[color:var(--hair-dark)] px-3 py-2 text-xs text-ink-300 transition-colors hover:text-paper-100 disabled:opacity-50"
              >
                Re-cut from scratch
              </button>
              {handCut > 0 && (
                <p className="mt-2 text-2xs leading-relaxed text-ink-400">
                  {handCut} {handCut === 1 ? "shot is" : "shots are"} cut by hand — the auto-cut
                  leaves {handCut === 1 ? "it" : "them"} alone.
                </p>
              )}
            </>
          )}
        </div>

        {error && <p className="text-2xs text-rust-400">{error}</p>}
      </div>
    </section>
  );
}
