import {
  MIN_BEAT_CONFIDENCE,
  beatGridForBed,
  bedBeatSource,
  type BeatGrid,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import type { MediaItemView, MusicItemView } from "./queries";

/**
 * Whether the bench has a pulse to work with, and if not, why — in words.
 *
 * "Cut on the beat" is a switch that does nothing at all when the bed has no
 * measurable tempo, and a switch that silently does nothing is worse than one
 * that isn't offered. So the reason travels with the answer: the panel greys
 * the box out and says which of the four things went wrong, and the ruler knows
 * to draw no ticks.
 */
export type BeatStatus =
  | { grid: BeatGrid; reason: null }
  | { grid: null; reason: string };

export function beatStatus(
  timeline: TimelineDoc,
  media: MediaItemView[],
  music: MusicItemView[],
): BeatStatus {
  const grid = beatGridForBed(timeline, media, music);
  if (grid) return { grid, reason: null };

  const bed = timeline.audio.find((t) => t.role === "bed");
  if (!bed) {
    return { grid: null, reason: "Nothing is playing under the film yet — pick a bed first." };
  }

  const source = bedBeatSource(timeline, media, music);
  if (!source) {
    return { grid: null, reason: "The track under the film has gone — pick another bed." };
  }

  const name = sourceName(source);
  if (source.status === "pending" || source.status === "processing") {
    return { grid: null, reason: `Still listening to ${name} for a pulse. Give it a moment.` };
  }
  if (source.status === "failed") {
    return { grid: null, reason: `We never got through ${name}, so there's no pulse to cut to.` };
  }
  if (source.bpm === null || (source.beatConfidence ?? 0) < MIN_BEAT_CONFIDENCE) {
    return { grid: null, reason: `No steady pulse in ${name} — there's nothing to cut to.` };
  }
  // Every reason above is accounted for, so a grid we still couldn't build means
  // a tempo outside the range we'd believe.
  return { grid: null, reason: `${name} keeps a beat we don't trust enough to cut to.` };
}

function sourceName(source: MediaItemView | MusicItemView): string {
  const label =
    "originalFilename" in source ? source.originalFilename : source.title ?? source.artist;
  return label ? `“${label}”` : "the bed";
}
