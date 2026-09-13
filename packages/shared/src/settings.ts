import { z } from "zod";

/**
 * Export format, owned by the operator rather than the environment.
 *
 * These used to be env vars, which meant editing .env and restarting the whole
 * stack to find out that 1080p60 is too much for the box you're running on.
 * They live in the database now; env still seeds the defaults on first boot.
 */

/** Heights we offer. Anything taller is a bad idea on a single-board machine. */
export const RENDER_HEIGHTS = [480, 720, 1080, 1440, 2160] as const;
export type RenderHeight = (typeof RENDER_HEIGHTS)[number];

export const RENDER_FPS_CHOICES = [24, 25, 30, 50, 60] as const;

/** x264 speed/size trade-off, slowest-to-fastest as the list runs down. */
export const RENDER_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
] as const;
export type RenderPreset = (typeof RENDER_PRESETS)[number];

export const renderSettingsSchema = z.object({
  renderHeight: z.coerce.number().int().refine(
    (v) => (RENDER_HEIGHTS as readonly number[]).includes(v),
    "Pick one of the offered sizes",
  ),
  renderFps: z.coerce.number().int().refine(
    (v) => (RENDER_FPS_CHOICES as readonly number[]).includes(v),
    "Pick one of the offered frame rates",
  ),
  /** Lower is better quality and a bigger file. */
  renderCrf: z.coerce.number().int().min(14, "Below 14 is wasted bytes").max(32, "Above 32 looks rough"),
  renderPreset: z.enum(RENDER_PRESETS),
});
export type RenderSettings = z.infer<typeof renderSettingsSchema>;

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  renderHeight: 1080,
  renderFps: 30,
  renderCrf: 20,
  renderPreset: "veryfast",
};

export function renderHeightLabel(height: number): string {
  const names: Record<number, string> = {
    480: "480p — small and quick",
    720: "720p — fine on a phone",
    1080: "1080p — the usual",
    1440: "1440p — sharp, slower",
    2160: "4K — only with a fast machine",
  };
  return names[height] ?? `${height}p`;
}

/** Rough guide shown next to the quality slider. */
export function crfLabel(crf: number): string {
  if (crf <= 17) return "near-lossless, very large";
  if (crf <= 20) return "high quality";
  if (crf <= 24) return "good — a sensible default";
  if (crf <= 28) return "smaller, softer";
  return "small and rough";
}
