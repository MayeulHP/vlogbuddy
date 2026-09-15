"use client";

import type { PresenceMember } from "@vlogbuddy/shared";
import { cn } from "@/lib/cn";

/**
 * Who's on set. Monogram slugs rather than avatar bubbles — each one carries
 * its owner's colour as a strip along the bottom, like tape on a flight case.
 */
export function PresenceBar({
  presence,
  connected,
  selfId,
}: {
  presence: PresenceMember[];
  connected: boolean;
  selfId: string;
}) {
  if (!connected || presence.length === 0) return null;

  const shown = presence.slice(0, 5);
  const overflow = presence.length - shown.length;

  return (
    <div className="flex items-center gap-2" title={`${presence.length} on set now`}>
      <span className="eyebrow hidden sm:block">On set</span>
      <div className="flex items-stretch gap-px">
        {shown.map((m) => (
          <div
            key={m.memberId}
            className={cn(
              "relative flex h-6 w-6 items-center justify-center border bg-paper-50 font-mono text-2xs font-medium uppercase",
              m.memberId === selfId
                ? "border-ink-900 text-ink-900"
                : "border-[color:var(--hair)] text-ink-600",
            )}
            title={m.memberId === selfId ? `${m.displayName} (you)` : m.displayName}
          >
            {m.displayName.slice(0, 2)}
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-[3px]"
              style={{ backgroundColor: m.color }}
            />
          </div>
        ))}
        {overflow > 0 && (
          <div className="flex h-6 items-center border border-[color:var(--hair)] bg-paper-200 px-1 font-mono text-2xs text-ink-600">
            +{overflow}
          </div>
        )}
      </div>
    </div>
  );
}
