"use client";

import { formatDuration, clipDuration, type Clip, type TimelineOp } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/** Trim, title and transition controls for the selected shot. */
export function ClipInspector({
  clip,
  media,
  index,
  total,
  onDispatch,
}: {
  clip: Clip;
  media: MediaItemView | null;
  index: number;
  total: number;
  onDispatch: (op: TimelineOp) => void;
}) {
  const sourceDuration = media?.durationSeconds ?? null;
  const effective = clipDuration(clip, sourceDuration);

  function patch(p: Partial<Omit<Clip, "id">>) {
    onDispatch({ type: "clip.update", clipId: clip.id, patch: p });
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow-light">
            Shot {String(index + 1).padStart(2, "0")} of {String(total).padStart(2, "0")}
          </p>
          <p className="timecode text-sm text-paper-100">{formatDuration(effective)}</p>
        </div>
        {media && (
          <p
            className="timecode mt-1 truncate text-2xs text-ink-400"
            title={media.originalFilename}
          >
            {media.originalFilename}
          </p>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        {/* Trim (video) or hold time (photo) */}
        {clip.kind === "video" && sourceDuration ? (
          <div>
            <p className="eyebrow-light mb-2">Trim</p>
            <div className="space-y-3">
              <label className="block">
                <span className="timecode text-2xs text-ink-300">
                  In — {formatDuration(clip.trimStart)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={sourceDuration}
                  step={0.1}
                  value={clip.trimStart}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    const end = clip.trimEnd ?? sourceDuration;
                    // Always leave at least a slice of shot.
                    patch({ trimStart: Math.min(value, end - 0.2) });
                  }}
                  className="slider slider-dark mt-1.5"
                />
              </label>

              <label className="block">
                <span className="timecode text-2xs text-ink-300">
                  Out — {formatDuration(clip.trimEnd ?? sourceDuration)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={sourceDuration}
                  step={0.1}
                  value={clip.trimEnd ?? sourceDuration}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    patch({ trimEnd: Math.max(value, clip.trimStart + 0.2) });
                  }}
                  className="slider slider-dark mt-1.5"
                />
              </label>

              <button
                onClick={() => patch({ trimStart: 0, trimEnd: sourceDuration })}
                className="btn-quiet-dark px-0"
              >
                Reset trim
              </button>
            </div>
          </div>
        ) : (
          <label className="block">
            <p className="eyebrow-light mb-1.5">Hold for {clip.duration.toFixed(1)}s</p>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={clip.duration}
              onChange={(e) => patch({ duration: Number(e.target.value) })}
              className="slider slider-dark"
            />
          </label>
        )}

        {/* Transition */}
        <div>
          <p className="eyebrow-light mb-1.5">Comes in on</p>
          <div className="grid grid-cols-2 gap-px border border-[color:var(--hair-dark)]">
            {(["cut", "crossfade"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => patch({ transitionIn: mode })}
                disabled={index === 0}
                className={cn(
                  "py-2 font-mono text-2xs uppercase tracking-label transition-colors disabled:opacity-30",
                  clip.transitionIn === mode
                    ? "bg-signal-600 text-paper-50"
                    : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                )}
              >
                {mode === "cut" ? "A cut" : "⇄ Dissolve"}
              </button>
            ))}
          </div>
          {index === 0 && (
            <p className="mt-1.5 font-mono text-2xs text-ink-500">
              The first shot has nothing to come in from.
            </p>
          )}
          {clip.transitionIn === "crossfade" && index > 0 && (
            <label className="mt-2.5 block">
              <span className="timecode text-2xs text-ink-300">
                Over {clip.transitionDuration.toFixed(1)}s
              </span>
              <input
                type="range"
                min={0.2}
                max={2}
                step={0.1}
                value={clip.transitionDuration}
                onChange={(e) => patch({ transitionDuration: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
          )}
        </div>

        {/* Audio */}
        {clip.kind === "video" && (
          <div>
            <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
              <input
                type="checkbox"
                checked={!clip.muted}
                onChange={(e) => patch({ muted: !e.target.checked })}
                className="check check-dark"
              />
              Keep this shot&apos;s sound
            </label>
            {!clip.muted && (
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={clip.volume}
                onChange={(e) => patch({ volume: Number(e.target.value) })}
                className="slider slider-dark mt-2.5"
                aria-label="Shot level"
              />
            )}
          </div>
        )}

        {/* Titles */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="eyebrow-light">Titles</p>
            <button
              onClick={() =>
                onDispatch({
                  type: "title.add",
                  clipId: clip.id,
                  title: {
                    id: globalThis.crypto.randomUUID(),
                    text: "Say something",
                    start: 0,
                    duration: Math.min(2, effective),
                    position: "bottom",
                    fontSize: 48,
                    color: "#ffffff",
                  },
                })
              }
              className="btn-quiet-dark px-0"
            >
              + Add
            </button>
          </div>

          {clip.titles.length === 0 ? (
            <p className="font-mono text-2xs text-ink-500">Nothing written over this shot.</p>
          ) : (
            <div className="space-y-2">
              {clip.titles.map((title) => (
                <div key={title.id} className="border border-[color:var(--hair-dark)] bg-ink-900 p-2">
                  <div className="flex items-end gap-2">
                    <input
                      value={title.text}
                      onChange={(e) =>
                        onDispatch({
                          type: "title.update",
                          clipId: clip.id,
                          titleId: title.id,
                          patch: { text: e.target.value },
                        })
                      }
                      className="field-dark display-sm flex-1 py-1 text-base"
                      maxLength={200}
                      placeholder="Title text"
                    />
                    <button
                      onClick={() =>
                        onDispatch({ type: "title.remove", clipId: clip.id, titleId: title.id })
                      }
                      className="shrink-0 px-1 pb-1 font-mono text-2xs text-ink-400 hover:text-signal-400"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-px border border-[color:var(--hair-dark)]">
                    {(["top", "center", "bottom"] as const).map((pos) => (
                      <button
                        key={pos}
                        onClick={() =>
                          onDispatch({
                            type: "title.update",
                            clipId: clip.id,
                            titleId: title.id,
                            patch: { position: pos },
                          })
                        }
                        className={cn(
                          "py-1 font-mono text-2xs uppercase tracking-label transition-colors",
                          title.position === pos
                            ? "bg-paper-100 text-ink-900"
                            : "bg-ink-850 text-ink-400 hover:text-paper-100",
                        )}
                      >
                        {pos}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => onDispatch({ type: "clip.remove", clipId: clip.id })}
          className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
        >
          Lift this shot out
        </button>
      </div>
    </section>
  );
}
