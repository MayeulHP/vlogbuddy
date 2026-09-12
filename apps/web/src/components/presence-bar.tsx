"use client";

import type { PresenceMember } from "@vlogbuddy/shared";
import { cn } from "@/lib/cn";

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
    <div className="flex items-center -space-x-1.5" title={`${presence.length} here now`}>
      {shown.map((m) => (
        <div
          key={m.memberId}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full border-2 border-ink-950",
            "text-[11px] font-semibold text-white",
            m.memberId === selfId && "ring-1 ring-white/40",
          )}
          style={{ backgroundColor: m.color }}
          title={m.memberId === selfId ? `${m.displayName} (you)` : m.displayName}
        >
          {m.displayName.slice(0, 1).toUpperCase()}
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-ink-950 bg-ink-700 text-[10px] font-semibold text-ink-200">
          +{overflow}
        </div>
      )}
    </div>
  );
}
