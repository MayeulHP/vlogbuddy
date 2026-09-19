import type { CutOverride } from "@vlogbuddy/shared";

/** How the crew stands on one item, as far as inclusion is concerned. */
export interface Standing {
  /** Blended ranking score. */
  rank: number;
  /** How many people have given a verdict at all — passes included. */
  seen: number;
  /** How many of those actually marked it. */
  supporters: number;
}

/**
 * Is this item in the final cut? The vote line decides, unless somebody
 * already overruled it. Mirrors the server-side rule in `lib/cut.ts` so the
 * pile, the cut strip and the render never disagree.
 *
 * A unanimous pass is out no matter where the line sits. It has to be, because
 * a passed shot and an unseen one both rank zero and every vlog starts with
 * its line at zero — so without this rule the crew could turn a shot down
 * flat and watch it stay in the film until somebody thought to drag the line
 * off the floor. Anyone can still put it back by hand; that's what the
 * override is for.
 */
export function isInCut(
  override: CutOverride | null,
  standing: Standing,
  threshold: number,
): boolean {
  if (override === "include") return true;
  if (override === "exclude") return false;
  if (standing.seen > 0 && standing.supporters === 0) return false;
  return standing.rank >= threshold;
}
