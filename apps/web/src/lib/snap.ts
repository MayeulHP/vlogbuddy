/**
 * Magnets, shared by every lane that drags something along the film's clock.
 *
 * The bench and the sound lane draw at wildly different scales — one zooms,
 * the other is however wide the pile made it — so the tolerance is stated in
 * pixels and converted, which is what makes a magnet feel the same size to the
 * hand on both.
 */

/** How close to a boundary the pointer has to get, in pixels on screen. */
export const SNAP_TOLERANCE_PX = 8;

/** Twentieths of a second: fine enough to feel free, coarse enough to land. */
export function quantize(seconds: number): number {
  return Math.round(seconds * 20) / 20;
}

/**
 * A snapper for one lane. `points` are the magnets in seconds — clip
 * boundaries, usually — and `pxPerSecond` how wide a second is drawn there.
 * Away from a magnet it falls back to the grid, so a drag always commits a
 * number the document can round-trip.
 */
export function makeSnap(points: number[], pxPerSecond: number) {
  const tolerance = SNAP_TOLERANCE_PX / Math.max(pxPerSecond, 0.001);
  return (seconds: number): number => {
    for (const point of points) {
      if (Math.abs(point - seconds) <= tolerance) return point;
    }
    return quantize(seconds);
  };
}
