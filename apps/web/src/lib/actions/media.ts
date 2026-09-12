"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, mediaItems, pendingUploads, sql } from "@vlogbuddy/db";
import {
  completeUploadSchema,
  kindForMimeType,
  presignUploadSchema,
  slugifyFilename,
} from "@vlogbuddy/shared";
import { requireMemberBySlug } from "../session";
import { buildStorageKey, deleteObject, headObject, presignUpload } from "../storage";
import { enqueueProcessMedia } from "../queue";
import { emitToVlog } from "../realtime";
import { maxUploadBytes } from "../env";
import crypto from "node:crypto";

/**
 * Uploads never pass through the app: the browser PUTs straight to object
 * storage with a presigned URL, then tells us it's done. Keeps big 4K videos
 * off the Node process and out of the reverse proxy's body limits.
 */
export async function presignUploadAction(
  slug: string,
  input: { filename: string; contentType: string; size: number },
) {
  try {
    const session = await requireMemberBySlug(slug);

    if (session.vlog.state !== "open") {
      return { ok: false as const, error: "This vlog is no longer accepting uploads" };
    }

    const parsed = presignUploadSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: parsed.error.issues[0].message };
    }

    if (parsed.data.size > maxUploadBytes()) {
      return {
        ok: false as const,
        error: `That file is too big (limit ${Math.round(maxUploadBytes() / 1024 / 1024)} MB)`,
      };
    }

    const uploadId = crypto.randomUUID();
    const safeName = slugifyFilename(parsed.data.filename);
    const storageKey = buildStorageKey(session.vlog.id, "original", uploadId, safeName);

    const url = await presignUpload(storageKey, parsed.data.contentType);

    await db.insert(pendingUploads).values({
      id: uploadId,
      vlogId: session.vlog.id,
      memberId: session.member.id,
      storageKey,
      originalFilename: parsed.data.filename.slice(0, 400),
      contentType: parsed.data.contentType,
      sizeBytes: parsed.data.size,
    });

    return { ok: true as const, uploadId, uploadUrl: url, storageKey };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Upload failed" };
  }
}

/** Called after the PUT succeeds: verifies the object, then queues processing. */
export async function completeUploadAction(
  slug: string,
  input: { uploadId: string; capturedAt?: string },
) {
  try {
    const session = await requireMemberBySlug(slug);

    const parsed = completeUploadSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0].message };

    const [pending] = await db
      .select()
      .from(pendingUploads)
      .where(
        and(
          eq(pendingUploads.id, parsed.data.uploadId),
          eq(pendingUploads.vlogId, session.vlog.id),
          eq(pendingUploads.memberId, session.member.id),
        ),
      )
      .limit(1);

    if (!pending) return { ok: false as const, error: "Unknown upload" };

    // Trust but verify — make sure the object actually landed.
    const head = await headObject(pending.storageKey);
    if (!head) {
      return { ok: false as const, error: "The file didn't finish uploading — try again" };
    }

    const kind = kindForMimeType(pending.contentType);
    if (!kind) return { ok: false as const, error: "Unsupported file type" };

    const [{ nextIndex }] = await db
      .select({ nextIndex: sql<number>`coalesce(max(${mediaItems.uploadIndex}), 0) + 1` })
      .from(mediaItems)
      .where(eq(mediaItems.vlogId, session.vlog.id));

    const [item] = await db
      .insert(mediaItems)
      .values({
        vlogId: session.vlog.id,
        uploaderId: session.member.id,
        kind,
        originalFilename: pending.originalFilename,
        contentType: pending.contentType,
        sizeBytes: head.size || pending.sizeBytes,
        storageKey: pending.storageKey,
        capturedAt: parsed.data.capturedAt ? new Date(parsed.data.capturedAt) : null,
        uploadIndex: nextIndex,
        status: "pending",
      })
      .returning();

    await db.delete(pendingUploads).where(eq(pendingUploads.id, pending.id));

    // The worker fills in thumbnail, proxy, dimensions and real capture time.
    await enqueueProcessMedia({ mediaItemId: item.id, vlogId: session.vlog.id });

    emitToVlog(session.vlog.id, "media:added", { mediaItemId: item.id });
    revalidatePath(`/v/${slug}`);

    return { ok: true as const, mediaItemId: item.id };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Upload failed" };
  }
}

export async function deleteMediaAction(slug: string, mediaItemId: string) {
  try {
    const session = await requireMemberBySlug(slug);

    const [item] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, mediaItemId), eq(mediaItems.vlogId, session.vlog.id)))
      .limit(1);

    if (!item) return { ok: false as const, error: "Item not found" };

    // Your own stuff, or the creator's call.
    const canDelete = item.uploaderId === session.member.id || session.member.role === "creator";
    if (!canDelete) return { ok: false as const, error: "You can only remove your own uploads" };

    await db.delete(mediaItems).where(eq(mediaItems.id, mediaItemId));

    // Storage cleanup is best-effort; a stray object is harmless.
    void Promise.all(
      [item.storageKey, item.proxyKey, item.thumbnailKey]
        .filter((k): k is string => Boolean(k))
        .map((k) => deleteObject(k).catch(() => {})),
    );

    emitToVlog(session.vlog.id, "media:removed", { mediaItemId });
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Delete failed" };
  }
}
