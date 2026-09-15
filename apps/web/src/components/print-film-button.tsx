"use client";

import { useEffect, useState } from "react";
import { FORMAT_LABELS, formatDuration, type VideoFormat } from "@vlogbuddy/shared";
import { renderPreflightAction, startRenderAction } from "@/lib/actions/timeline";
import { useDialog } from "@/hooks/use-dialog";
import { SlateRow } from "./brand";
import { cn } from "@/lib/cn";

interface Spec {
  format: VideoFormat;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  clips: number;
  layers: number;
  tracks: number;
  notReady: number;
}

/**
 * The way into the lab.
 *
 * It asks first, because this is the one action left in the app that takes the
 * whole vlog away from everybody: the state flips to `export` and every room
 * but the screening one is locked until FFmpeg finishes, which on a long trip
 * and a small box is a long time. It used to happen on one click of a button
 * whose label — "Print the film" — reads a lot like a preview.
 *
 * The dialog is also the only place the whole output format is ever visible.
 * The shape is the vlog's, chosen on the bench; the size and frame rate belong
 * to whoever runs the box, set on the admin page, and the person pressing the
 * button has otherwise no way to know whether they are about to make a 720p
 * file or a 4K one.
 *
 * There is deliberately no success path: on `ok` the vlog flips to `export` and
 * the shell swaps the whole view, so anything rendered here would be gone
 * before it was read. Only the failure has to be said out loud.
 */
export function PrintFilmButton({
  slug,
  disabled,
  className,
  label = "Print the film",
  onPendingChange,
}: {
  slug: string;
  /** Nothing in the cut — there'd be no film to print. */
  disabled?: boolean;
  /** Layout for the wrapper; the button itself fills it. */
  className?: string;
  /**
   * What the button says. The screening room's second attempt is the same
   * action with the same consequences, and one way of starting a render is one
   * place for the rules about who may start one.
   */
  label?: string;
  /** Lets the surrounding view lock edits while the film is on its way. */
  onPendingChange?: (sending: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (sending) return;
    setSending(true);
    onPendingChange?.(true);
    setError(null);

    const res = await startRenderAction(slug);
    if (!res.ok) {
      setError(res.error);
      setSending(false);
      setAsking(false);
      onPendingChange?.(false);
    }
  }

  return (
    <div className={cn("flex min-w-0 flex-col items-stretch gap-1", className)}>
      <button
        onClick={() => setAsking(true)}
        disabled={sending || disabled}
        className="btn-signal w-full grow"
        title={disabled ? "Nothing in the cut yet — there'd be no film" : "Send the cut to the lab"}
      >
        {sending ? "Sending to the lab…" : label}
      </button>

      {error && (
        <p
          role="alert"
          className="border border-signal-500/40 bg-signal-900/30 px-2 py-1 font-mono text-[11px] leading-snug text-signal-300"
        >
          {error}
        </p>
      )}

      {asking && (
        <PrintDialog
          slug={slug}
          sending={sending}
          onConfirm={send}
          onClose={() => !sending && setAsking(false)}
        />
      )}
    </div>
  );
}

function PrintDialog({
  slug,
  sending,
  onConfirm,
  onClose,
}: {
  slug: string;
  sending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void renderPreflightAction(slug).then((res) => {
      if (cancelled) return;
      if (res.ok) setSpec(res.spec);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="fixed inset-0 z-[100] flex animate-fade-in items-end justify-center bg-ink-950/80 p-0 sm:items-center sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="print-dialog-title"
        tabIndex={-1}
        className="pb-safe w-full max-w-md animate-slide-up border border-[color:var(--hair-dark)] bg-ink-900 shadow-deck focus:outline-none sm:pb-0"
      >
        <div className="border-b border-[color:var(--hair-dark)] px-5 py-4">
          <p className="eyebrow-light flex items-center gap-2">
            <span className="h-1 w-1 bg-signal-500" aria-hidden />
            Beat 06 · Final cut
          </p>
          <h2 id="print-dialog-title" className="headline mt-1 text-2xl text-paper-50">
            Send it to the lab?
          </h2>
        </div>

        <div className="px-5 py-4">
          {error ? (
            <p role="alert" className="text-[13px] leading-relaxed text-signal-300">
              {error}
            </p>
          ) : !spec ? (
            <p className="eyebrow-light">Reading the cut…</p>
          ) : (
            <>
              <SlateRow tone="ink" k="Running" v={formatDuration(spec.durationSeconds)} />
              <SlateRow tone="ink" k="Shots" v={String(spec.clips).padStart(2, "0")} />
              {spec.layers > 0 && (
                <SlateRow tone="ink" k="Layers" v={String(spec.layers).padStart(2, "0")} />
              )}
              <SlateRow tone="ink" k="Sound" v={spec.tracks > 0 ? `${spec.tracks} track${spec.tracks === 1 ? "" : "s"}` : "Dry"} />
              <SlateRow
                tone="ink"
                k="Format"
                v={`${spec.width}×${spec.height} · ${FORMAT_LABELS[spec.format].toLowerCase()} · ${spec.fps}fps`}
              />

              {/*
                The consequence, not the settings, is the thing worth reading —
                so it gets the weight, under the numbers rather than above them.
              */}
              <p className="mt-4 text-[13px] leading-relaxed text-ink-300">
                This locks the whole roll while it prints. Nobody can drop footage, mark
                anything or touch the cut until it&apos;s done — a long trip takes a few
                minutes. You can reopen it afterwards.
              </p>

              {spec.notReady > 0 && (
                <p className="notice-tape mt-3">
                  {spec.notReady} clip{spec.notReady === 1 ? " is" : "s are"} still developing.
                  Give it a moment — printing now would leave {spec.notReady === 1 ? "it" : "them"} out.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-[color:var(--hair-dark)] px-5 py-3 sm:flex-row sm:justify-end">
          <button onClick={onClose} disabled={sending} className="btn-outline-dark">
            Not yet
          </button>
          <button
            onClick={onConfirm}
            disabled={sending || !spec}
            className="btn-signal"
          >
            {sending ? "Sending to the lab…" : "Print it"}
          </button>
        </div>
      </div>
    </div>
  );
}
