import type { CutOverride } from "@vlogbuddy/shared";

/**
 * Is this item in the final cut? The vote line decides, unless somebody
 * already overruled it. Mirrors the server-side rule in `lib/cut.ts` so the
 * pile, the cut strip and the render never disagree.
 */
export function isInCut(
  override: CutOverride | null,
  rank: number,
  threshold: number,
): boolean {
  if (override === "include") return true;
  if (override === "exclude") return false;
  return rank >= threshold;
}
