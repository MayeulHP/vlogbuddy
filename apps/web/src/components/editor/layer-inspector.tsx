"use client";

import { MAX_LAYERS, formatDuration, type LayerClip, type TimelineOp } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { Section } from "./section";
import { SliderField } from "./slider-field";
import { cn } from "@/lib/cn";

/** Fractions round-trip through jsonb at 3dp everywhere else; here too. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

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
  playheadTime,
  onDispatch,
}: {
  layer: LayerClip;
  media: MediaItemView | null;
  totalDuration: number;
  /** Where the picture is held, so "At playhead" has something to mean. */
  playheadTime: number;
  onDispatch: (op: TimelineOp) => void;
}) {
  const sourceDuration = media?.durationSeconds ?? null;

  function patch(p: Partial<Omit<LayerClip, "id">>) {
    onDispatch({ type: "layer.update", layerId: layer.id, patch: p });
  }

  /** What a folded-up section is hiding — see the clip inspector's note. */
  const frameSummary = `${Math.round(layer.width * 100)}% · layer ${layer.layer}`;
  const fadeSummary =
    [
      layer.opacity !== 1 ? `${Math.round(layer.opacity * 100)}%` : null,
      layer.fadeIn > 0 || layer.fadeOut > 0
        ? `${layer.fadeIn.toFixed(1)}s / ${layer.fadeOut.toFixed(1)}s`
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const soundSummary =
    layer.kind !== "video"
      ? null
      : layer.muted
        ? "Silent"
        : layer.volume !== 1
          ? `${Math.round(layer.volume * 100)}%`
          : null;

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
          <p
            className="timecode mt-1 truncate text-2xs text-ink-400"
            title={media.originalFilename}
          >
            {media.originalFilename}
          </p>
        )}
      </div>

      <div className="px-4 pb-4">
        <Section
          storageKey="layer.timing"
          title="Timing"
          summary={`${formatDuration(layer.startAt)} → ${formatDuration(layer.startAt + layer.duration)}`}
          defaultOpen
        >
          <div>
            <p className="eyebrow-light mb-1.5">Sits over</p>
            {/*
            A whole-film slider was a poor aim: on a ten-minute cut one pixel
            was seconds, and the one instant anybody actually wants is the one
            they're looking at. So: type the second, or take the playhead.
          */}
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <span className="timecode text-2xs text-ink-300">From (s)</span>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0.5, totalDuration)}
                  step={0.1}
                  value={round3(layer.startAt)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) {
                      patch({ startAt: round3(Math.max(0, Math.min(totalDuration, v))) });
                    }
                  }}
                  className="field-dark timecode mt-1.5 w-full py-1 text-sm"
                />
              </label>
              <button
                onClick={() =>
                  patch({ startAt: round3(Math.max(0, Math.min(totalDuration, playheadTime))) })
                }
                className="btn-quiet-dark shrink-0 pb-1.5"
                title={`Move this layer to ${formatDuration(playheadTime)}`}
              >
                At playhead
              </button>
            </div>
            <SliderField
              className="mt-2.5"
              label={
                <span className="timecode text-2xs text-ink-300">
                  For {layer.duration.toFixed(1)}s
                </span>
              }
              value={layer.duration}
              min={0.2}
              max={Math.max(2, totalDuration)}
              step={0.1}
              decimals={1}
              onChange={(v) => patch({ duration: v })}
              ariaLabel="How long the layer is on screen, in seconds"
            />
            {layer.kind === "video" && sourceDuration && (
              <SliderField
                className="mt-2.5"
                label={
                  <span className="timecode text-2xs text-ink-300">
                    Starting {formatDuration(layer.trimStart)} into the source
                  </span>
                }
                value={layer.trimStart}
                min={0}
                max={Math.max(0, sourceDuration - 0.2)}
                step={0.1}
                decimals={1}
                onChange={(v) => patch({ trimStart: v })}
                ariaLabel="Where the layer starts in its source, in seconds"
              />
            )}
          </div>
        </Section>

        <Section storageKey="layer.frame" title="Frame" summary={frameSummary}>
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
            <p className="mt-1.5 font-mono text-2xs text-ink-400">Higher numbers sit on top.</p>
          </div>

          <div>
            <p className="eyebrow-light mb-1.5">In the frame</p>
            <p className="mb-2 font-mono text-2xs text-ink-400">
              Or drag it straight around the picture.
            </p>

            {/*
            The numbers first: the frame itself is the good way to place a
            layer now, and these are what you reach for when you want it exact
            — or want two layers to agree. Percentages of the frame, which is
            what the document stores and what the renderer multiplies out.
          */}
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { key: "x", label: "X %", value: layer.x, min: 0, max: 100 },
                  { key: "y", label: "Y %", value: layer.y, min: 0, max: 100 },
                  { key: "width", label: "W %", value: layer.width, min: 5, max: 100 },
                ] as const
              ).map((field) => (
                <label key={field.key} className="block">
                  <span className="eyebrow-light">{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={1}
                    value={Math.round(field.value * 100)}
                    onChange={(e) => {
                      const pct = Number(e.target.value);
                      if (!Number.isFinite(pct)) return;
                      const clamped = Math.min(field.max, Math.max(field.min, pct));
                      patch({ [field.key]: round3(clamped / 100) } as Partial<LayerClip>);
                    }}
                    className="field-dark timecode mt-1.5 w-full py-1 text-sm"
                  />
                </label>
              ))}
            </div>

            <p className="eyebrow-light mb-1.5 mt-3 text-ink-500">Or drop it in a corner</p>
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

            <SliderField
              className="mt-2.5"
              label={
                <span className="eyebrow-light">
                  Size — {Math.round(layer.width * 100)}% of frame
                </span>
              }
              value={layer.width}
              min={0.05}
              max={1}
              step={0.01}
              onChange={(v) => patch({ width: v })}
              ariaLabel="Layer size, as a fraction of the frame"
            />

            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <SliderField
                label={<span className="eyebrow-light">Across</span>}
                value={layer.x}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => patch({ x: v })}
                ariaLabel="Layer position across the frame"
              />
              <SliderField
                label={<span className="eyebrow-light">Down</span>}
                value={layer.y}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => patch({ y: v })}
                ariaLabel="Layer position down the frame"
              />
            </div>
          </div>
        </Section>

        <Section storageKey="layer.fade" title="Fade & opacity" summary={fadeSummary}>
          <div>
            <SliderField
              label={
                <span className="eyebrow-light">Opacity — {Math.round(layer.opacity * 100)}%</span>
              }
              value={layer.opacity}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(v) => patch({ opacity: v })}
              ariaLabel="Layer opacity"
            />

            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <SliderField
                label={<span className="eyebrow-light">Fade in {layer.fadeIn.toFixed(1)}s</span>}
                value={layer.fadeIn}
                min={0}
                max={2}
                step={0.1}
                decimals={1}
                onChange={(v) => patch({ fadeIn: v })}
                ariaLabel="Layer fade in, in seconds"
              />
              <SliderField
                label={<span className="eyebrow-light">Fade out {layer.fadeOut.toFixed(1)}s</span>}
                value={layer.fadeOut}
                min={0}
                max={2}
                step={0.1}
                decimals={1}
                onChange={(v) => patch({ fadeOut: v })}
                ariaLabel="Layer fade out, in seconds"
              />
            </div>
          </div>
        </Section>

        {layer.kind === "video" && (
          <Section storageKey="layer.sound" title="Sound" summary={soundSummary}>
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
                <SliderField
                  className="mt-2.5"
                  label={
                    <span className="timecode text-2xs text-ink-300">
                      Level — {Math.round(layer.volume * 100)}%
                    </span>
                  }
                  value={layer.volume}
                  min={0}
                  max={2}
                  step={0.05}
                  onChange={(v) => patch({ volume: v })}
                  ariaLabel="Layer level"
                />
              )}
            </div>
          </Section>
        )}

        {/* The same verb as the other two inspectors: you take it out. */}
        <div className="border-t border-[color:var(--hair-dark)] pt-4">
          <button
            onClick={() => onDispatch({ type: "layer.remove", layerId: layer.id })}
            className="btn border-signal-700/50 bg-signal-900/30 w-full text-signal-300 hover:border-signal-500 hover:bg-signal-900/60"
          >
            Take this layer out
          </button>
          <p className="mt-1 text-2xs text-ink-400">
            Only the layer goes — the photo or clip stays in the pile.
          </p>
        </div>
      </div>
    </section>
  );
}
