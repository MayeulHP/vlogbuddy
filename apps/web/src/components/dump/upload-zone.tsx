"use client";

import { useCallback, useRef, useState } from "react";
import { ACCEPTED_UPLOAD_TYPES, formatBytes } from "@vlogbuddy/shared";
import { completeUploadAction, presignUploadAction } from "@/lib/actions/media";
import { cn } from "@/lib/cn";

interface UploadTask {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

/**
 * Uploads go straight from the browser to object storage via a presigned PUT,
 * so huge phone videos never touch the Node process.
 */
export function UploadZone({ slug, onUploaded }: { slug: string; onUploaded?: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = useCallback((id: string, patch: Partial<UploadTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const uploadOne = useCallback(
    async (file: File) => {
      const taskId = crypto.randomUUID();
      setTasks((prev) => [
        ...prev,
        { id: taskId, name: file.name, size: file.size, progress: 0, status: "uploading" },
      ]);

      try {
        const presigned = await presignUploadAction(slug, {
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        });

        if (!presigned.ok) {
          update(taskId, { status: "error", error: presigned.error });
          return;
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
          return;
        }

        update(taskId, { status: "done", progress: 100 });
        onUploaded?.();

        // Clear finished rows so the list doesn't grow forever.
        setTimeout(() => setTasks((prev) => prev.filter((t) => t.id !== taskId)), 2500);
      } catch (err) {
        update(taskId, {
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
    [slug, update, onUploaded],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      // Sequential: parallel uploads of 4K video saturate typical home upstream.
      void (async () => {
        for (const file of Array.from(files)) await uploadOne(file);
      })();
    },
    [uploadOne],
  );

  const active = tasks.filter((t) => t.status === "uploading");
  const failed = tasks.filter((t) => t.status === "error");

  return (
    <div className="space-y-2">
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
        className={cn(
          "relative flex min-h-[124px] cursor-pointer flex-col items-center justify-center border border-dashed px-6 py-8 text-center transition-colors",
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
            "headline text-[1.9rem]",
            dragging ? "text-signal-700" : "text-ink-900",
          )}
        >
          {dragging ? "Let go." : "Drop the footage here"}
        </p>
        <p className="mt-1.5 font-mono text-2xs uppercase tracking-label text-ink-500">
          Photos · Video · Audio &nbsp;·&nbsp; or click to pick
        </p>
      </div>

      {(active.length > 0 || failed.length > 0) && (
        <div className="divide-y divide-[color:var(--hair)] border border-[color:var(--hair)] bg-paper-50">
          {active.map((task) => (
            <div key={task.id} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="timecode truncate text-xs text-ink-800">{task.name}</span>
                <span className="timecode shrink-0 text-2xs text-ink-500">
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

          {failed.map((task) => (
            <div
              key={task.id}
              className="flex items-baseline justify-between gap-3 bg-signal-100 px-3 py-2"
            >
              <span className="truncate font-mono text-2xs text-signal-800">
                {task.name} — {task.error}
              </span>
              <button
                onClick={() => setTasks((prev) => prev.filter((t) => t.id !== task.id))}
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
