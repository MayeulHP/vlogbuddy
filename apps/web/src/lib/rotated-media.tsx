import type { CSSProperties, ReactNode } from "react";
import { normalizeRotation } from "@vlogbuddy/shared";
import { cn } from "./cn";

/**
 * A file shown the right way up.
 *
 * Sibling to `preview-src.ts`, and the same kind of answer: there is one place
 * that decides *which* bytes to show, and this is the one place that decides
 * which way round to show them. Every display site asks here, so straightening
 * a shot once straightens it on the light table, in the deck, in the lightbox
 * and in the preview at once.
 *
 * Nothing is re-processed for this — no new thumbnail, no new proxy. A
 * correction like this wants to feel like nudging a photo straight on a table,
 * and a worker round-trip would put a visible wait in the middle of it.
 *
 * The whole difficulty is that a quarter turn swaps the picture's bounding
 * box, so a plain `rotate()` leaves the shot spilling out of its slot and
 * `object-cover` cropping against the wrong edges. Solved once, here: the
 * inner box is sized in the *container's* units with the axes swapped, so it
 * lands back on the container exactly after the turn, and the media inside it
 * carries the ordinary `h-full w-full object-cover|contain` it always did.
 */
export function RotatedMedia({
  rotation,
  className,
  style,
  children,
}: {
  rotation: number | null | undefined;
  /** Classes for the box that takes the media's place in the layout. */
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const turn = normalizeRotation(rotation);
  const quarter = turn % 180 !== 0;

  return (
    <div
      className={cn("relative h-full w-full overflow-hidden", className)}
      style={
        // Containment costs nothing here but isn't free of consequences
        // elsewhere, so it's only imposed on the rare box that needs it.
        turn === 0 ? style : { ...style, containerType: "size" }
      }
    >
      {turn === 0 ? (
        children
      ) : (
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: quarter ? "100cqh" : "100cqw",
            height: quarter ? "100cqw" : "100cqh",
            transform: `translate(-50%, -50%) rotate(${turn}deg)`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
