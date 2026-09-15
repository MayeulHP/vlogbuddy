"use client";

import { useState, useTransition } from "react";
import {
  RENDER_FPS_CHOICES,
  RENDER_HEIGHTS,
  RENDER_PRESETS,
  crfLabel,
  frameFor,
  renderHeightLabel,
  type RenderSettings,
} from "@vlogbuddy/shared";
import { saveRenderSettingsAction } from "@/lib/actions/admin";
import { cn } from "@/lib/cn";

/** The export format, with the cost of each choice said out loud. */
export function RenderSettingsForm({ settings }: { settings: RenderSettings }) {
  const [draft, setDraft] = useState<RenderSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    draft.renderHeight !== settings.renderHeight ||
    draft.renderFps !== settings.renderFps ||
    draft.renderCrf !== settings.renderCrf ||
    draft.renderPreset !== settings.renderPreset;

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveRenderSettingsAction(draft);
      if (res.ok) setSaved(true);
      else setError(res.error);
    });
  }

  return (
    <div className="border border-[color:var(--hair)] bg-paper-50 p-5">
      <div className="grid gap-6 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Frame size</span>
          <select
            value={draft.renderHeight}
            onChange={(e) => setDraft({ ...draft, renderHeight: Number(e.target.value) })}
            className="field"
          >
            {RENDER_HEIGHTS.map((h) => (
              <option key={h} value={h}>
                {renderHeightLabel(h)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-2xs leading-relaxed text-ink-500">
            The film&rsquo;s shorter edge. Each vlog picks its own shape on the bench — an
            upright film comes out {frameFor("portrait", draft.renderHeight).width}×
            {frameFor("portrait", draft.renderHeight).height}.
          </span>
        </label>

        <label className="block">
          <span className="field-label">Frame rate</span>
          <select
            value={draft.renderFps}
            onChange={(e) => setDraft({ ...draft, renderFps: Number(e.target.value) })}
            className="field"
          >
            {RENDER_FPS_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="field-label">
            Quality — crf {draft.renderCrf}, {crfLabel(draft.renderCrf)}
          </span>
          <input
            type="range"
            min={14}
            max={32}
            step={1}
            value={draft.renderCrf}
            onChange={(e) => setDraft({ ...draft, renderCrf: Number(e.target.value) })}
            className="slider mt-3"
          />
          <span className="mt-1 flex justify-between font-mono text-2xs text-ink-400">
            <span>larger file</span>
            <span>smaller file</span>
          </span>
        </label>

        <label className="block">
          <span className="field-label">Encoder speed</span>
          <select
            value={draft.renderPreset}
            onChange={(e) =>
              setDraft({ ...draft, renderPreset: e.target.value as RenderSettings["renderPreset"] })
            }
            className="field"
          >
            {RENDER_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
                {p === "veryfast" ? " — good on a Pi" : ""}
                {p === "slow" ? " — smallest file, slowest" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="notice mt-4">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={pending || !dirty} className="btn-signal">
          {pending ? "Saving…" : "Save format"}
        </button>
        {dirty && !pending && (
          <button onClick={() => setDraft(settings)} className="btn-quiet">
            Reset
          </button>
        )}
        <span
          className={cn(
            "font-mono text-2xs uppercase tracking-label transition-opacity",
            saved && !dirty ? "text-leader-600 opacity-100" : "opacity-0",
          )}
        >
          Saved — applies to the next render
        </span>
      </div>
    </div>
  );
}
