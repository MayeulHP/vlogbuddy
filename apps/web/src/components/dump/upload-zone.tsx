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
    <div className="space-y-3">
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
          "cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-all",
          dragging
            ? "border-brand-400 bg-brand-500/10"
            : "border-ink-700 bg-ink-900/40 hover:border-ink-600 hover:bg-ink-900/70",
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
        <div className="text-2xl">{dragging ? "📥" : "📸"}</div>
        <p className="mt-2 text-sm font-medium text-white">
          {dragging ? "Drop them here" : "Drop photos & videos, or click to pick"}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          They go straight into the shared pile. Audio files work too.
        </p>
      </div>

      {(active.length > 0 || failed.length > 0) && (
        <div className="space-y-1.5">
          {active.map((task) => (
            <div key={task.id} className="card px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-ink-200">{task.name}</span>
                <span className="shrink-0 tabular-nums text-ink-500">
                  {task.progress}% · {formatBytes(task.size)}
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all duration-200"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
            </div>
          ))}

          {failed.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs"
            >
              <span className="truncate text-red-300">
                {task.name} — {task.error}
              </span>
              <button
                onClick={() => setTasks((prev) => prev.filter((t) => t.id !== task.id))}
                className="shrink-0 text-red-400 hover:text-red-200"
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
