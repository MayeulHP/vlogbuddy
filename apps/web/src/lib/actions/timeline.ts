"use server";

import { revalidatePath } from "next/cache";
import {
  and,
  db,
  eq,
  getRenderSettings,
  mediaItems,
  renderJobs,
  timelines,
  vlogs,
} from "@vlogbuddy/db";
import {
  applyTimelineOp,
  emptyTimeline,
  frameFor,
  isWorkingState,
  normalizeTimeline,
  timelineDuration,
  timelineOpSchema,
  type TimelineOp,
} from "@vlogbuddy/shared";
import { directorSettingsSchema } from "@vlogbuddy/shared";
import { z } from "zod";
import { requireCreator, requireMemberBySlug } from "../session";
import { emitToVlog } from "../realtime";
import { syncCut } from "../cut";
import { enqueueRender } from "../queue";

const directorInputSchema = z.object({
  settings: directorSettingsSchema.partial().optional(),
  /** Hand every shot back to the auto-cut, hand-made trims and all. */
  recut: z.boolean().optional(),
});

/**
 * Changes how the auto-cut paces the film, and optionally starts it over.
 *
 * One action rather than an op emitted over the socket followed by a sync:
 * `syncCut` reads the stored document, and a socket handler's transaction may
 * not have committed by the time it looks — the re-cut would be silently lost.
 * Applying the ops here, in order, and syncing afterwards keeps it honest.
 */
export async function runDirectorAction(slug: string, input: unknown = {}) {
  try {
    const session = await requireMemberBySlug(slug);

    if (!isWorkingState(session.vlog.state)) {
      return { ok: false as const, error: "This vlog is rendering — the timeline is locked" };
    }

    const parsed = directorInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: "Invalid auto-cut settings" };

    const ops: TimelineOp[] = [];
    if (parsed.data.settings) {
      ops.push({ type: "settings.update", patch: { director: parsed.data.settings } });
    }
    if (parsed.data.recut) ops.push({ type: "director.recut" });

    if (ops.length > 0) {
      const saved = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(timelines)
          .where(eq(timelines.vlogId, session.vlog.id))
          .for("update")
          .limit(1);

        let doc = current ? normalizeTimeline(current.doc) : emptyTimeline();
        for (const op of ops) doc = applyTimelineOp(doc, op);
        const revision = (current?.revision ?? 0) + 1;

        const [row] = await tx
          .insert(timelines)
          .values({ vlogId: session.vlog.id, doc, revision, updatedById: session.member.id })
          .onConflictDoUpdate({
            target: timelines.vlogId,
            set: { doc, revision, updatedAt: new Date(), updatedById: session.member.id },
          })
          .returning();
        return row;
      });

      // Every open bench replays the same ops, so they converge before the
      // sync below lands on top with the auto-cut's answer.
      for (const op of ops) {
        emitToVlog(session.vlog.id, "timeline:op", {
          op,
          revision: saved.revision,
          byMemberId: session.member.id,
        });
      }
    }

    const result = await syncCut(session.vlog.id, session.member.id);
    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true as const, clips: result.clips };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Couldn't re-cut — give it a moment and try again",
    };
  }
}

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

      const doc = current ? normalizeTimeline(current.doc) : emptyTimeline();
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

/**
 * What sending this to the lab would actually produce, and what it would cost
 * everyone else.
 *
 * A render is the one action left that takes the whole vlog away from the
 * crew — it flips the state to `export` and locks every room but the screening
 * one until FFmpeg is done. That deserves to be read before it's done rather
 * than discovered afterwards, and the format is the operator's setting, not
 * something the person pressing the button chose or can see anywhere else.
 *
 * Not creator-gated: anyone may look at what a render would make. Only
 * `startRenderAction` decides who may cause one.
 */
export async function renderPreflightAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);

    const [settings, [row], sources] = await Promise.all([
      getRenderSettings(),
      db.select().from(timelines).where(eq(timelines.vlogId, session.vlog.id)).limit(1),
      db
        .select({
          id: mediaItems.id,
          status: mediaItems.status,
          durationSeconds: mediaItems.durationSeconds,
        })
        .from(mediaItems)
        .where(eq(mediaItems.vlogId, session.vlog.id)),
    ]);

    const doc = row ? normalizeTimeline(row.doc) : null;
    if (!doc || doc.clips.length === 0) {
      return { ok: false as const, error: "There's nothing on the timeline yet" };
    }

    const durations: Record<string, number | null> = {};
    for (const item of sources) durations[item.id] = item.durationSeconds;

    // The same readiness question the render asks, so the dialog can warn
    // before the click rather than rejecting after it.
    const ready = new Set(sources.filter((m) => m.status === "ready").map((m) => m.id));
    const notReady = new Set(
      [
        ...doc.clips.map((c) => c.mediaItemId),
        ...doc.layers.map((l) => l.mediaItemId),
        ...doc.audio.flatMap((t) => (t.mediaItemId ? [t.mediaItemId] : [])),
      ].filter((id) => !ready.has(id)),
    ).size;

    // The shape is the vlog's, the size is the operator's — the person about to
    // press print has no other way to see either.
    const { width, height } = frameFor(session.vlog.format, settings.renderHeight);

    return {
      ok: true as const,
      spec: {
        format: session.vlog.format,
        width,
        height,
        fps: settings.renderFps,
        durationSeconds: timelineDuration(doc, durations),
        clips: doc.clips.length,
        layers: doc.layers.length,
        tracks: doc.audio.filter((t) => !t.muted).length,
        notReady,
      },
    };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Couldn't read the cut",
    };
  }
}

export async function startRenderAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    requireCreator(session);

    // Prune anything stale (deleted or unprocessable media) before snapshotting.
    await syncCut(session.vlog.id, session.member.id);

    const [row] = await db
      .select()
      .from(timelines)
      .where(eq(timelines.vlogId, session.vlog.id))
      .limit(1);

    const doc = row ? normalizeTimeline(row.doc) : null;
    if (!doc || doc.clips.length === 0) {
      return { ok: false as const, error: "There's nothing on the timeline yet" };
    }

    /**
     * Rendering a clip whose source hasn't been processed yet produces a
     * mystifying ffmpeg failure ten minutes in. Catch it here instead — for
     * anything the render will open, layers and audio uploads included.
     */
    const sources = await db
      .select({ id: mediaItems.id, status: mediaItems.status })
      .from(mediaItems)
      .where(eq(mediaItems.vlogId, session.vlog.id));
    const readyIds = new Set(sources.filter((m) => m.status === "ready").map((m) => m.id));

    const referenced = [
      ...doc.clips.map((c) => c.mediaItemId),
      ...doc.layers.map((l) => l.mediaItemId),
      ...doc.audio.flatMap((t) => (t.mediaItemId ? [t.mediaItemId] : [])),
    ];
    const notReady = new Set(referenced.filter((id) => !readyIds.has(id))).size;

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
        timelineSnapshot: doc,
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
