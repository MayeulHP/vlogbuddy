"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACCEPTED_UPLOAD_TYPES, formatBytes } from "@vlogbuddy/shared";
import { completeUploadAction, presignUploadAction } from "@/lib/actions/media";
import { cn } from "@/lib/cn";

interface UploadTask {
  id: string;
  /** Which drop this file belongs to — the batch figures only count its own. */
  runId: string;
  name: string;
  size: number;
  progress: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

interface Run {
  id: string;
  startedAt: number;
}

/**
 * A file-specific problem ("that file is too big") lands on one file and the
 * next one is fine. The same sentence three times running is the vlog, the
 * session or the storage host talking, and grinding through the other 37 files
 * only buys the uploader 37 more copies of it — so the run stops and says so
 * once. Below that threshold the rows are merely collapsed, never dropped,
 * because two files that genuinely are both too big deserve two names.
 */
const STOP_AFTER_IDENTICAL_FAILURES = 3;

/**
 * Guards on the time estimate. Before this much has actually moved, the rate is
 * mostly measuring the first presign round-trip, and a wrong number is worse
 * than no number on a screen someone is deciding whether to walk away from.
 */
const ESTIMATE_MIN_ELAPSED_MS = 8_000;
const ESTIMATE_MIN_BYTES = 2 * 1024 * 1024;
/**
 * How far the last few seconds may drift from the run average before we stop
 * promising anything. A phone moving between bars swings well past this, and
 * that is exactly the case where an estimate would be a lie.
 */
const ESTIMATE_MAX_DRIFT = 2.5;

/** Deliberately coarse: we know the order of magnitude, not the minute. */
function describeRemaining(seconds: number): string {
  if (seconds < 20) return "nearly there";
  if (seconds < 90) return "about a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes >= 60) return "over an hour left";
  return `about ${minutes} minutes left`;
}

function summaryLine(added: number, failed: number): string {
  const landed = added === 0 ? "Nothing landed" : `${added} added`;
  return failed === 0 ? landed : `${landed} · ${failed} wouldn't upload`;
}

/**
 * Uploads go straight from the browser to object storage via a presigned PUT,
 * so huge phone videos never touch the Node process.
 */
export function UploadZone({ slug, onUploaded }: { slug: string; onUploaded?: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [stopped, setStopped] = useState<{ skipped: number } | null>(null);
  /**
   * What the progress bars say, for someone who can't see them. Per batch and
   * per file, never per percent — a bar that ticks is reassuring to watch and
   * unbearable to listen to.
   */
  const [announcement, setAnnouncement] = useState("");
  /** Ticked once a second while anything is in flight; drives the estimate. */
  const [now, setNow] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const runRef = useRef<Run | null>(null);
  /** Drops can overlap — a second one joins the run in progress rather than starting its own. */
  const batchesRef = useRef(0);
  const samplesRef = useRef<{ at: number; bytes: number }[]>([]);
  const bytesDoneRef = useRef(0);

  const update = useCallback((id: string, patch: Partial<UploadTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const uploadOne = useCallback(
    async (file: File, taskId: string): Promise<{ ok: boolean; error?: string }> => {
      update(taskId, { status: "uploading", progress: 0 });

      try {
        const presigned = await presignUploadAction(slug, {
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        });

        if (!presigned.ok) {
          update(taskId, { status: "error", error: presigned.error });
          return { ok: false, error: presigned.error };
        }

        // XHR rather than fetch — we want progress events.
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", presigned.uploadUrl, true);
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              update(taskId, { progress: Math.round((e.loaded / e.total) * 100) });
            }
          };
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300
              ? resolve()
              : reject(new Error(`Storage rejected the upload (${xhr.status})`));
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.send(file);
        });

        // Photos/videos carry their capture time; fall back to file mtime.
        const capturedAt = file.lastModified ? new Date(file.lastModified).toISOString() : undefined;

        const completed = await completeUploadAction(slug, {
          uploadId: presigned.uploadId,
          capturedAt,
        });

        if (!completed.ok) {
          update(taskId, { status: "error", error: completed.error });
          return { ok: false, error: completed.error };
        }

        update(taskId, { status: "done", progress: 100 });
        onUploaded?.();
        return { ok: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : "Upload failed";
        update(taskId, { status: "error", error });
        return { ok: false, error };
      }
    },
    [slug, update, onUploaded],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      // Sequential: parallel uploads of 4K video saturate typical home upstream.
      void (async () => {
        const batch = Array.from(files);

        /*
         * A fresh run resets the clock the estimate is measured against and
         * clears the last run's receipt. Failures outlive it — they are the
         * only record of what didn't land, and only the reader gets to say
         * when they've read them.
         */
        const fresh = batchesRef.current === 0 || !runRef.current;
        if (fresh) {
          const next = { id: crypto.randomUUID(), startedAt: Date.now() };
          runRef.current = next;
          samplesRef.current = [];
          bytesDoneRef.current = 0;
          setRun(next);
          setStopped(null);
          setTasks((prev) => prev.filter((t) => t.status === "error"));
        }
        const runId = runRef.current!.id;

        /*
         * Every file gets a row before the first byte moves, so the header can
         * say "3 of 40" instead of discovering the batch one file at a time.
         */
        const queued: UploadTask[] = batch.map((file) => ({
          id: crypto.randomUUID(),
          runId,
          name: file.name,
          size: file.size,
          progress: 0,
          status: "queued",
        }));
        setTasks((prev) => [...prev, ...queued]);

        setAnnouncement(
          batch.length === 1 ? `Uploading ${batch[0].name}` : `Uploading ${batch.length} files`,
        );

        batchesRef.current += 1;
        let uploaded = 0;
        let failures = 0;
        let repeats = 0;
        let halted = false;
        let lastError: string | null = null;
        try {
          for (let i = 0; i < batch.length; i++) {
            const result = await uploadOne(batch[i], queued[i].id);
            if (result.ok) {
              uploaded += 1;
              repeats = 0;
              lastError = null;
              setAnnouncement(`${uploaded} of ${batch.length} uploaded`);
              continue;
            }

            failures += 1;
            const message = result.error ?? "Upload failed";
            repeats = message === lastError ? repeats + 1 : 1;
            lastError = message;
            setAnnouncement(`${batch[i].name} didn't upload. ${message}`);

            if (repeats >= STOP_AFTER_IDENTICAL_FAILURES) {
              const skipped = queued.slice(i + 1);
              if (skipped.length > 0) {
                const skippedIds = new Set(skipped.map((t) => t.id));
                setTasks((prev) => prev.filter((t) => !skippedIds.has(t.id)));
                setStopped({ skipped: skipped.length });
                setAnnouncement(
                  `Stopped after the same trouble ${STOP_AFTER_IDENTICAL_FAILURES} times. ` +
                    `${message}. ${skipped.length} files not sent.`,
                );
                halted = true;
              }
              break;
            }
          }
        } finally {
          batchesRef.current -= 1;
        }

        if (batchesRef.current === 0) {
          runRef.current = null;
          if (!halted) setAnnouncement(summaryLine(uploaded, failures));
        }
      })();
    },
    [uploadOne],
  );

  const busy = tasks.some((t) => t.status === "uploading" || t.status === "queued");
  const runTasks = run ? tasks.filter((t) => t.runId === run.id) : [];
  const runActive = runTasks.some((t) => t.status === "uploading" || t.status === "queued");
  const runDone = runTasks.filter((t) => t.status === "done").length;
  const runFailed = runTasks.filter((t) => t.status === "error").length;
  const uploadingTasks = tasks.filter((t) => t.status === "uploading");

  /* A file that errored will never finish, so it leaves the byte maths entirely. */
  const live = runTasks.filter((t) => t.status !== "error");
  const bytesTotal = live.reduce((n, t) => n + t.size, 0);
  const bytesDone = live.reduce(
    (n, t) => n + (t.status === "done" ? t.size : (t.size * t.progress) / 100),
    0,
  );

  useEffect(() => {
    bytesDoneRef.current = bytesDone;
  }, [bytesDone]);

  /*
   * Closing the tab kills every upload still in flight, and a 40-file drop from
   * a phone runs for minutes. Browsers ignore whatever text we pass, so the
   * handler's only job is to exist — and to stop existing the moment the queue
   * drains, which is what the cleanup on `busy` buys us as well as unmount.
   */
  useEffect(() => {
    if (!busy) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Safari still wants the legacy property set before it shows the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);

  /*
   * Progress events re-render often enough on their own, but they stop between
   * files while a server action is in flight — and the estimate needs a clock
   * that keeps running through those gaps.
   */
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      const at = Date.now();
      samplesRef.current = [...samplesRef.current, { at, bytes: bytesDoneRef.current }].slice(-10);
      setNow(at);
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  /*
   * The number comes from the run average, which is stable enough not to jitter
   * the label; the last ten seconds are used only to decide whether to show it
   * at all. Disagree by more than the drift and we show nothing.
   */
  const remainingLabel = (): string | null => {
    if (!run || !runActive) return null;
    const elapsed = now - run.startedAt;
    if (elapsed < ESTIMATE_MIN_ELAPSED_MS || bytesDone < ESTIMATE_MIN_BYTES) return null;
    const average = bytesDone / (elapsed / 1000);
    if (average <= 0) return null;

    const samples = samplesRef.current;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || last.at - first.at < 3000) return null;
    const recent = (last.bytes - first.bytes) / ((last.at - first.at) / 1000);
    if (recent <= 0) return null;
    if (recent > average * ESTIMATE_MAX_DRIFT || recent * ESTIMATE_MAX_DRIFT < average) return null;

    return describeRemaining(Math.max(0, bytesTotal - bytesDone) / average);
  };

  const eta = remainingLabel();
  const batchPercent = bytesTotal > 0 ? Math.round((bytesDone / bytesTotal) * 100) : 0;
  const showHeader = runActive && runTasks.length > 1;
  const showSummary = run != null && !runActive && runDone + runFailed > 0;

  /*
   * One bad answer from the server hits every file the same way. Collapsing a
   * run of identical messages turns forty red rows back into one sentence
   * without hiding a failure that is genuinely about one file.
   */
  const failureGroups = tasks
    .filter((t) => t.status === "error")
    .reduce<{ error: string; ids: string[]; name: string }[]>((groups, task) => {
      const message = task.error ?? "Upload failed";
      const last = groups[groups.length - 1];
      if (last && last.error === message) last.ids.push(task.id);
      else groups.push({ error: message, ids: [task.id], name: task.name });
      return groups;
    }, []);

  const clearRun = () => {
    setTasks((prev) => (run ? prev.filter((t) => t.runId !== run.id) : prev));
    setStopped(null);
    setRun(null);
  };

  const showPanel =
    showHeader || showSummary || uploadingTasks.length > 0 || failureGroups.length > 0;

  return (
    <div className="space-y-2">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        /*
         * A div with an onClick was reachable with a pointer and nothing else,
         * which made dropping footage — the first thing anyone does here —
         * impossible without a mouse. It stays a div because the drop target is
         * the whole frame, so it borrows a button's manners instead.
         */
        role="button"
        tabIndex={0}
        aria-label="Add photos, video or audio"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={cn(
          "relative flex min-h-[124px] cursor-pointer flex-col items-center justify-center border border-dashed px-4 py-7 text-center transition-colors sm:px-6 sm:py-8",
          dragging
            ? "border-signal-600 bg-signal-100"
            : "border-[color:var(--hair-strong)] bg-paper-200 bg-hatch hover:border-ink-900 hover:bg-paper-300",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_UPLOAD_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* Corner ticks, so the drop target reads as a frame to fill. */}
        <span aria-hidden className="pointer-events-none absolute inset-2 crop-marks" />

        <p
          className={cn(
            "headline text-[1.5rem] sm:text-[1.9rem]",
            dragging ? "text-signal-700" : "text-ink-900",
          )}
        >
          {dragging ? "Let go." : "Drop the footage here"}
        </p>
        {/* On a phone there is nothing to drag from — say what the tap does. */}
        <p className="mt-1.5 font-mono text-2xs uppercase tracking-label text-ink-600 sm:hidden">
          Tap to pick from your camera roll
        </p>
        <p className="mt-1.5 hidden font-mono text-2xs uppercase tracking-label text-ink-600 sm:block">
          Photos · Video · Audio &nbsp;·&nbsp; or click to pick
        </p>
      </div>

      {showPanel && (
        <div className="divide-y divide-[color:var(--hair)] border border-[color:var(--hair)] bg-paper-50">
          {showHeader && (
            <div className="bg-paper-100 px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="eyebrow">Going into the pile</span>
                <span className="timecode shrink-0 text-2xs text-ink-800">
                  {runDone} of {runTasks.length}
                </span>
              </div>
              <div className="mt-1.5 h-[3px] bg-paper-300">
                <div
                  className="h-full bg-ink-900 transition-all duration-200"
                  style={{ width: `${batchPercent}%` }}
                />
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <span className="timecode text-2xs text-ink-600">
                  {formatBytes(Math.round(bytesDone))} of {formatBytes(bytesTotal)}
                </span>
                {/* Nothing rather than a number we don't believe. */}
                {eta && <span className="eyebrow shrink-0 normal-case">{eta}</span>}
              </div>
            </div>
          )}

          {showSummary && (
            <div className="flex items-baseline justify-between gap-3 bg-paper-100 px-3 py-2">
              <span className="timecode text-xs text-ink-800">
                {summaryLine(runDone, runFailed)}
              </span>
              <button
                onClick={clearRun}
                aria-label="Clear the upload list"
                className="shrink-0 font-mono text-2xs text-ink-600 hover:text-ink-900"
              >
                ✕
              </button>
            </div>
          )}

          {stopped && (
            <div className="notice">
              Same trouble {STOP_AFTER_IDENTICAL_FAILURES} times running, so we stopped there.{" "}
              {stopped.skipped} {stopped.skipped === 1 ? "file" : "files"} never left your device —
              drop them again once that's sorted.
            </div>
          )}

          {uploadingTasks.map((task) => (
            <div key={task.id} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="timecode truncate text-xs text-ink-800">{task.name}</span>
                <span className="timecode shrink-0 text-2xs text-ink-600">
                  {task.progress}% · {formatBytes(task.size)}
                </span>
              </div>
              <div className="mt-1.5 h-[3px] bg-paper-300">
                <div
                  className="h-full bg-signal-600 transition-all duration-200"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
            </div>
          ))}

          {failureGroups.map((group) => (
            <div
              key={group.ids[0]}
              className="flex items-baseline justify-between gap-3 bg-signal-100 px-3 py-2"
            >
              <span className="truncate font-mono text-2xs text-signal-800">
                {group.ids.length > 1 ? `${group.ids.length} files` : group.name} — {group.error}
              </span>
              <button
                onClick={() => {
                  const ids = new Set(group.ids);
                  setTasks((prev) => prev.filter((t) => !ids.has(t.id)));
                }}
                aria-label={
                  group.ids.length > 1
                    ? `Dismiss ${group.ids.length} upload errors`
                    : `Dismiss the ${group.name} upload error`
                }
                className="shrink-0 font-mono text-2xs text-signal-700 hover:text-signal-900"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
