"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, mediaItems, renderJobs, timelines, vlogs } from "@vlogbuddy/db";
import {
  applyTimelineOp,
  emptyTimeline,
  isWorkingState,
  timelineOpSchema,
} from "@vlogbuddy/shared";
import { requireCreator, requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";
import { syncCut } from "../cut";
import { enqueueRender } from "../queue";

/**
 * Rebuilds the timeline from the current cut. The cut engine keeps these in
 * step automatically, so this is only a manual "put it back the way the votes
 * want it" — handy after a lot of hand-editing.
 */
export async function buildTimelineFromSelectionAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    const result = await syncCut(session.vlog.id, session.member.id);
    if (result.clips === 0) {
      return { ok: false as const, error: "Nothing is in the cut yet" };
    }
    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true as const, clips: result.clips };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Couldn't build timeline" };
  }
}

/**
 * Applies one editor operation. The server owns the document and rebroadcasts,
 * so concurrent editors converge (last-writer-wins per element in v1).
 */
export async function applyTimelineOpAction(slug: string, op: unknown) {
  try {
    const session = await requireMemberBySlug(slug);

    if (!isWorkingState(session.vlog.state)) {
      return { ok: false as const, error: "This vlog is rendering — the timeline is locked" };
    }

    const parsed = timelineOpSchema.safeParse(op);
    if (!parsed.success) return { ok: false as const, error: "Invalid edit" };

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(timelines)
        .where(eq(timelines.vlogId, session.vlog.id))
        .for("update")
        .limit(1);

      const doc = current?.doc ?? emptyTimeline();
      const nextDoc = applyTimelineOp(doc, parsed.data);
      const nextRevision = (current?.revision ?? 0) + 1;

      const [saved] = await tx
        .insert(timelines)
        .values({
          vlogId: session.vlog.id,
          doc: nextDoc,
          revision: nextRevision,
          updatedById: session.member.id,
        })
        .onConflictDoUpdate({
          target: timelines.vlogId,
          set: {
            doc: nextDoc,
            revision: nextRevision,
            updatedAt: new Date(),
            updatedById: session.member.id,
          },
        })
        .returning();

      return saved;
    });

    emitToVlog(session.vlog.id, "timeline:op", {
      op: parsed.data,
      revision: result.revision,
      byMemberId: session.member.id,
    });

    return { ok: true as const, revision: result.revision, timeline: result.doc };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Edit failed" };
  }
}

export async function startRenderAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    requireCreator(session);

    // Prune anything stale (deleted or unprocessable media) before snapshotting.
    await syncCut(session.vlog.id, session.member.id);

    const [timeline] = await db
      .select()
      .from(timelines)
      .where(eq(timelines.vlogId, session.vlog.id))
      .limit(1);

    if (!timeline || timeline.doc.clips.length === 0) {
      return { ok: false as const, error: "There's nothing on the timeline yet" };
    }

    /**
     * Rendering a clip whose source hasn't been processed yet produces a
     * mystifying ffmpeg failure ten minutes in. Catch it here instead.
     */
    const sources = await db
      .select({ id: mediaItems.id, status: mediaItems.status })
      .from(mediaItems)
      .where(eq(mediaItems.vlogId, session.vlog.id));
    const readyIds = new Set(sources.filter((m) => m.status === "ready").map((m) => m.id));
    const notReady = timeline.doc.clips.filter((c) => !readyIds.has(c.mediaItemId)).length;

    if (notReady > 0) {
      return {
        ok: false as const,
        error: `${notReady} clip${notReady === 1 ? " is" : "s are"} still processing — give it a moment and try again`,
      };
    }

    const [existing] = await db
      .select()
      .from(renderJobs)
      .where(and(eq(renderJobs.vlogId, session.vlog.id), eq(renderJobs.status, "rendering")))
      .limit(1);

    if (existing) return { ok: false as const, error: "A render is already in progress" };

    const [job] = await db
      .insert(renderJobs)
      .values({
        vlogId: session.vlog.id,
        requestedById: session.member.id,
        status: "queued",
        progress: 0,
        // Snapshot so later edits don't change what's being rendered.
        timelineSnapshot: timeline.doc,
      })
      .returning();

    await db.update(vlogs).set({ state: "export" }).where(eq(vlogs.id, session.vlog.id));
    await enqueueRender({ renderJobId: job.id, vlogId: session.vlog.id });

    emitToVlog(session.vlog.id, "vlog:state", { state: "export" });
    emitToVlog(session.vlog.id, "render:progress", {
      renderJobId: job.id,
      status: "queued",
      progress: 0,
      message: "Queued",
    });

    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true as const, renderJobId: job.id };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Render failed" };
  }
}
