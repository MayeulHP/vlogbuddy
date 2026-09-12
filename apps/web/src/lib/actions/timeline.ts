"use server";

import { revalidatePath } from "next/cache";
import { and, asc, db, eq, mediaItems, musicItems, renderJobs, selections, timelines, vlogs } from "@vlogbuddy/db";
import {
  DEFAULT_PHOTO_DURATION,
  applyTimelineOp,
  emptyTimeline,
  timelineOpSchema,
  type Clip,
  type TimelineDoc,
} from "@vlogbuddy/shared";
import crypto from "node:crypto";
import { requireCreator, requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";
import { enqueueRender } from "../queue";

/**
 * Builds the first draft of the timeline from the curated selection, in the
 * order people agreed on. This is what makes the final cut low-effort: by the
 * time you open the editor, the vlog is already assembled.
 */
export async function buildTimelineFromSelectionAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    requireCreator(session);

    const selected = await db
      .select({ selection: selections, media: mediaItems })
      .from(selections)
      .innerJoin(mediaItems, eq(selections.targetId, mediaItems.id))
      .where(and(eq(selections.vlogId, session.vlog.id), eq(selections.targetType, "media")))
      .orderBy(asc(selections.orderIndex));

    if (selected.length === 0) {
      return { ok: false as const, error: "Select some photos and videos first" };
    }

    const clips: Clip[] = selected.map(({ media }) => ({
      id: crypto.randomUUID(),
      mediaItemId: media.id,
      kind: media.kind === "video" ? "video" : "photo",
      trimStart: 0,
      trimEnd: media.kind === "video" ? media.durationSeconds ?? null : null,
      duration: media.kind === "video" ? media.durationSeconds ?? 5 : DEFAULT_PHOTO_DURATION,
      transitionIn: "cut",
      transitionDuration: 0.5,
      volume: 1,
      muted: false,
      titles: [],
    }));

    // Highest-voted selected track becomes the default music bed.
    const [topMusic] = await db
      .select({ music: musicItems })
      .from(selections)
      .innerJoin(musicItems, eq(selections.targetId, musicItems.id))
      .where(and(eq(selections.vlogId, session.vlog.id), eq(selections.targetType, "music")))
      .orderBy(asc(selections.orderIndex))
      .limit(1);

    const doc: TimelineDoc = {
      version: 1,
      clips,
      audio: topMusic
        ? [
            {
              musicItemId: topMusic.music.id,
              mediaItemId: null,
              offset: 0,
              startAt: 0,
              volume: 0.8,
              fadeIn: 1,
              fadeOut: 2,
            },
          ]
        : [],
      duckClipAudio: true,
      updatedAt: new Date().toISOString(),
    };

    const [row] = await db
      .insert(timelines)
      .values({ vlogId: session.vlog.id, doc, revision: 1, updatedById: session.member.id })
      .onConflictDoUpdate({
        target: timelines.vlogId,
        set: { doc, revision: 1, updatedAt: new Date(), updatedById: session.member.id },
      })
      .returning();

    emitToVlog(session.vlog.id, "timeline:sync", { timeline: row.doc, revision: row.revision });
    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true as const, clips: clips.length };
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

    if (!["edit", "curate"].includes(session.vlog.state)) {
      return { ok: false as const, error: "The timeline is locked in this phase" };
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

    const [timeline] = await db
      .select()
      .from(timelines)
      .where(eq(timelines.vlogId, session.vlog.id))
      .limit(1);

    if (!timeline || timeline.doc.clips.length === 0) {
      return { ok: false as const, error: "There's nothing on the timeline yet" };
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
