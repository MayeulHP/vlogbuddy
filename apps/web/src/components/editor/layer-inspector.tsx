"use client";

import {
  MAX_LAYERS,
  formatDuration,
  type LayerClip,
  type TimelineOp,
} from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { cn } from "@/lib/cn";

/** Nine places a layer usually wants to be, as fractions of the frame. */
const CORNERS: { label: string; x: number; y: number }[] = [
  { label: "↖", x: 0.05, y: 0.06 },
  { label: "↑", x: 0.5, y: 0.06 },
  { label: "↗", x: 0.95, y: 0.06 },
  { label: "←", x: 0.05, y: 0.5 },
  { label: "◎", x: 0.5, y: 0.5 },
  { label: "→", x: 0.95, y: 0.5 },
  { label: "↙", x: 0.05, y: 0.94 },
  { label: "↓", x: 0.5, y: 0.94 },
  { label: "↘", x: 0.95, y: 0.94 },
];

/**
 * Everything about one layer: when it appears, where it sits in the frame, how
 * hard it lands. Geometry is edited as fractions, because the render happens at
 * whatever height the admin page is set to and a layer pinned in pixels would
 * jump when that changes.
 */
export function LayerInspector({
  layer,
  media,
  totalDuration,
  onDispatch,
}: {
  layer: LayerClip;
  media: MediaItemView | null;
  totalDuration: number;
  onDispatch: (op: TimelineOp) => void;
}) {
  const sourceDuration = media?.durationSeconds ?? null;

  function patch(p: Partial<Omit<LayerClip, "id">>) {
    onDispatch({ type: "layer.update", layerId: layer.id, patch: p });
  }

  /** Presets place the layer by its centre; the model stores its corner. */
  function placeAt(x: number, y: number) {
    patch({
      x: Math.min(1, Math.max(0, x - layer.width / 2)),
      y: Math.min(1, Math.max(0, y - layer.width / 2)),
    });
  }

  return (
    <section className="border border-[color:var(--hair-dark)] bg-ink-850">
      <div className="border-b border-[color:var(--hair-dark)] px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow-light">Layer {layer.layer}</p>
          <p className="timecode text-sm text-paper-100">{formatDuration(layer.duration)}</p>
        </div>
        {media && (
          <p className="timecode mt-1 truncate text-2xs text-ink-400" title={media.originalFilename}>
            {media.originalFilename}
          </p>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        <div>
          <p className="eyebrow-light mb-1.5">Sits over</p>
          <label className="block">
            <span className="timecode text-2xs text-ink-300">
              From {formatDuration(layer.startAt)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0.5, totalDuration)}
              step={0.05}
              value={Math.min(layer.startAt, totalDuration)}
              onChange={(e) => patch({ startAt: Number(e.target.value) })}
              className="slider slider-dark mt-1.5"
            />
          </label>
          <label className="mt-2.5 block">
            <span className="timecode text-2xs text-ink-300">
              For {layer.duration.toFixed(1)}s
            </span>
            <input
              type="range"
              min={0.2}
              max={Math.max(2, totalDuration)}
              step={0.1}
              value={layer.duration}
              onChange={(e) => patch({ duration: Number(e.target.value) })}
              className="slider slider-dark mt-1.5"
            />
          </label>
          {layer.kind === "video" && sourceDuration && (
            <label className="mt-2.5 block">
              <span className="timecode text-2xs text-ink-300">
                Starting {formatDuration(layer.trimStart)} into the source
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0, sourceDuration - 0.2)}
                step={0.1}
                value={layer.trimStart}
                onChange={(e) => patch({ trimStart: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
          )}
        </div>

        <div>
          <p className="eyebrow-light mb-1.5">Stacking</p>
          <div
            className="grid gap-px border border-[color:var(--hair-dark)]"
            style={{ gridTemplateColumns: `repeat(${MAX_LAYERS}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: MAX_LAYERS }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => patch({ layer: n })}
                className={cn(
                  "py-2 font-mono text-2xs uppercase tracking-label transition-colors",
                  layer.layer === n
                    ? "bg-signal-600 text-paper-50"
                    : "bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-paper-100",
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-1.5 font-mono text-2xs text-ink-500">Higher numbers sit on top.</p>
        </div>

        <div>
          <p className="eyebrow-light mb-1.5">In the frame</p>
          <div className="grid grid-cols-3 gap-px border border-[color:var(--hair-dark)]">
            {CORNERS.map((corner) => (
              <button
                key={corner.label}
                onClick={() => placeAt(corner.x, corner.y)}
                className="bg-ink-900 py-1.5 font-mono text-[13px] leading-none text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper-100"
                aria-label={`Move layer ${corner.label}`}
              >
                {corner.label}
              </button>
            ))}
          </div>

          <label className="mt-2.5 block">
            <span className="eyebrow-light">Size — {Math.round(layer.width * 100)}% of frame</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.01}
              value={layer.width}
              onChange={(e) => patch({ width: Number(e.target.value) })}
              className="slider slider-dark mt-1.5"
            />
          </label>

          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="eyebrow-light">Across</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={layer.x}
                onChange={(e) => patch({ x: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
            <label className="block">
              <span className="eyebrow-light">Down</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={layer.y}
                onChange={(e) => patch({ y: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
          </div>
        </div>

        <div>
          <label className="block">
            <span className="eyebrow-light">Opacity — {Math.round(layer.opacity * 100)}%</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={layer.opacity}
              onChange={(e) => patch({ opacity: Number(e.target.value) })}
              className="slider slider-dark mt-1.5"
            />
          </label>

          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="eyebrow-light">Fade in {layer.fadeIn.toFixed(1)}s</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={layer.fadeIn}
                onChange={(e) => patch({ fadeIn: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
            <label className="block">
              <span className="eyebrow-light">Fade out {layer.fadeOut.toFixed(1)}s</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={layer.fadeOut}
                onChange={(e) => patch({ fadeOut: Number(e.target.value) })}
                className="slider slider-dark mt-1.5"
              />
            </label>
          </div>
        </div>

        {layer.kind === "video" && (
          <div>
            <label className="flex items-center gap-2 font-mono text-2xs uppercase tracking-label text-ink-300">
              <input
                type="checkbox"
                checked={!layer.muted}
                onChange={(e) => patch({ muted: !e.target.checked })}
                className="check check-dark"
              />
              Let this layer be heard
            </label>
            {!layer.muted && (
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={layer.volume}
                onChange={(e) => patch({ volume: Number(e.target.value) })}
                className="slider slider-dark mt-2.5"
                aria-label="Layer level"
              />
            )}
          </div>
        )}

        <button
          onClick={() => onDispatch({ type: "layer.remove", layerId: layer.id })}
          className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
        >
          Peel this layer off
        </button>
      </div>
    </section>
  );
}
