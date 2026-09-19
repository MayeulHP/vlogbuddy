"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

export const PANEL_TABS = ["shot", "layers", "sound", "cut"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

const LABEL: Record<PanelTab, string> = {
  shot: "Shot",
  layers: "Layers",
  sound: "Sound",
  cut: "Cut",
};

/**
 * The bench's menus, stacked into one pane instead of down the page.
 *
 * Fixed order, fixed positions — a tab that appears and disappears with the
 * selection is a control you can't find when you want it, and the number keys
 * need somewhere that stays put. What moves instead is which tab is *open*:
 * picking a shot, a layer or a track opens the one that describes it, so the
 * panels follow the work without the strip moving underneath.
 */
export function PanelTabs({
  active,
  onChange,
  panels,
  cutHint,
  className,
}: {
  active: PanelTab;
  onChange: (tab: PanelTab) => void;
  panels: Record<PanelTab, React.ReactNode>;
  /**
   * Whether the vote still sets the lengths, printed on the tab. It's the one
   * setting that changes what every future vote does, so it shouldn't need
   * opening to read.
   */
  cutHint?: string;
  className?: string;
}) {
  const base = useId();

  function onKeyDown(event: React.KeyboardEvent) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = PANEL_TABS.indexOf(active);
    const next = PANEL_TABS[(index + delta + PANEL_TABS.length) % PANEL_TABS.length];
    onChange(next);
    document.getElementById(`${base}-${next}`)?.focus();
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col border border-[color:var(--hair-dark)] bg-ink-850",
        className,
      )}
    >
      <div
        role="tablist"
        aria-label="Bench panels"
        onKeyDown={onKeyDown}
        className="flex shrink-0 border-b border-[color:var(--hair-dark)]"
      >
        {PANEL_TABS.map((tab) => {
          const selected = tab === active;
          return (
            <button
              key={tab}
              id={`${base}-${tab}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              // Roving tabindex: the strip is one stop, then the arrows move
              // inside it — the ARIA tabs pattern, and the reason Tab doesn't
              // take four presses to get past four tabs.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab)}
              className={cn(
                "focus-ring-dark min-h-[38px] min-w-0 flex-1 truncate border-b-2 px-1.5 font-mono text-2xs uppercase tracking-label transition-colors",
                selected
                  ? "border-signal-600 text-paper-100"
                  : "border-transparent text-ink-400 hover:text-paper-200",
              )}
            >
              {LABEL[tab]}
              {tab === "cut" && cutHint && (
                <span className="ml-1 hidden text-ink-500 sm:inline">· {cutHint}</span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-${active}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {panels[active]}
      </div>
    </div>
  );
}

/** What a panel says when the thing it describes hasn't been picked yet. */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-5 text-center">
      <p className="text-[13px] leading-relaxed text-ink-400">{children}</p>
    </div>
  );
}
