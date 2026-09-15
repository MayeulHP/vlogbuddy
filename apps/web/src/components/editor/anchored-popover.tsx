"use client";

import { useEffect } from "react";
import { useDialog } from "@/hooks/use-dialog";
import { cn } from "@/lib/cn";

/**
 * A card that hangs off the control that opened it.
 *
 * The transition marker already worked this way and the add-pickers want the
 * same manners, so the pair of them — Escape and the focus dance from
 * `useDialog`, plus a capture-phase outside press — live here once. Capture,
 * because the strip's lanes stop pointer events on the way up and a bubbling
 * listener would never hear the click that should close this.
 *
 * Positioning is the caller's: on the strip toolbar that's `absolute` under a
 * `relative` button wrapper. Below `md` these same pickers are a bottom sheet
 * instead — nothing 216px wide is usable at 375.
 */
export function AnchoredPopover({
  label,
  onClose,
  className,
  style,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useDialog<HTMLDivElement>(onClose);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [ref, onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={style}
      className={cn(
        "absolute z-40 border border-[color:var(--hair-dark)] bg-ink-950/95 shadow-print outline-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
