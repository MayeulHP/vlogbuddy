"use client";

import { formatDuration, clipDuration, type Clip, type TimelineOp } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/** Trim, title and transition controls for the selected clip. */
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
    <section className="card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">
          Clip {index + 1}
          <span className="ml-1 font-normal text-ink-600">of {total}</span>
        </h3>
        <span className="text-xs tabular-nums text-ink-500">{formatDuration(effective)}</span>
      </div>

      {media && (
        <p className="mb-3 truncate text-[11px] text-ink-500" title={media.originalFilename}>
          {media.originalFilename}
        </p>
      )}

      <div className="space-y-4">
        {/* Trim (video) or hold time (photo) */}
        {clip.kind === "video" && sourceDuration ? (
          <div>
            <span className="label mb-2">Trim</span>
            <div className="space-y-2">
              <label className="block">
                <span className="text-[11px] text-ink-500">
                  Start — {formatDuration(clip.trimStart)}
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
                    // Always leave at least a slice of clip.
                    patch({ trimStart: Math.min(value, end - 0.2) });
                  }}
                  className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
                />
              </label>

              <label className="block">
                <span className="text-[11px] text-ink-500">
                  End — {formatDuration(clip.trimEnd ?? sourceDuration)}
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
                  className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
                />
              </label>

              <button
                onClick={() => patch({ trimStart: 0, trimEnd: sourceDuration })}
                className="text-[11px] text-ink-500 hover:text-ink-300"
              >
                Reset trim
              </button>
            </div>
          </div>
        ) : (
          <label className="block">
            <span className="label">Hold for {clip.duration.toFixed(1)}s</span>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={clip.duration}
              onChange={(e) => patch({ duration: Number(e.target.value) })}
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
            />
          </label>
        )}

        {/* Transition */}
        <div>
          <span className="label">Transition in</span>
          <div className="flex gap-1.5">
            {(["cut", "crossfade"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => patch({ transitionIn: mode })}
                disabled={index === 0}
                className={cn(
                  "flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors disabled:opacity-40",
                  clip.transitionIn === mode
                    ? "border-brand-500/60 bg-brand-500/15 text-white"
                    : "border-ink-800 text-ink-400 hover:border-ink-700",
                )}
              >
                {mode === "cut" ? "Cut" : "⇄ Crossfade"}
              </button>
            ))}
          </div>
          {index === 0 && (
            <p className="mt-1 text-[10px] text-ink-600">
              The first clip has nothing to transition from.
            </p>
          )}
          {clip.transitionIn === "crossfade" && index > 0 && (
            <label className="mt-2 block">
              <span className="text-[11px] text-ink-500">
                Length — {clip.transitionDuration.toFixed(1)}s
              </span>
              <input
                type="range"
                min={0.2}
                max={2}
                step={0.1}
                value={clip.transitionDuration}
                onChange={(e) => patch({ transitionDuration: Number(e.target.value) })}
                className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
              />
            </label>
          )}
        </div>

        {/* Audio */}
        {clip.kind === "video" && (
          <div>
            <label className="flex items-center gap-2 text-xs text-ink-300">
              <input
                type="checkbox"
                checked={!clip.muted}
                onChange={(e) => patch({ muted: !e.target.checked })}
                className="accent-brand-500"
              />
              Keep this clip&apos;s sound
            </label>
            {!clip.muted && (
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={clip.volume}
                onChange={(e) => patch({ volume: Number(e.target.value) })}
                className="mt-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-700 accent-brand-500"
              />
            )}
          </div>
        )}

        {/* Titles */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label mb-0">Titles</span>
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
              className="text-[11px] text-brand-400 hover:text-brand-300"
            >
              + Add
            </button>
          </div>

          {clip.titles.length === 0 ? (
            <p className="text-[11px] text-ink-600">No text on this clip.</p>
          ) : (
            <div className="space-y-2">
              {clip.titles.map((title) => (
                <div key={title.id} className="rounded-lg border border-ink-800 bg-ink-850/60 p-2">
                  <div className="flex gap-1.5">
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
                      className="input flex-1 px-2 py-1 text-xs"
                      maxLength={200}
                      placeholder="Title text"
                    />
                    <button
                      onClick={() =>
                        onDispatch({ type: "title.remove", clipId: clip.id, titleId: title.id })
                      }
                      className="px-1 text-xs text-ink-600 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="mt-1.5 flex gap-1">
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
                          "flex-1 rounded px-1 py-0.5 text-[10px] transition-colors",
                          title.position === pos
                            ? "bg-ink-700 text-white"
                            : "text-ink-500 hover:text-ink-300",
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
          className="btn-danger w-full text-xs"
        >
          Remove clip from the cut
        </button>
      </div>
    </section>
  );
}
