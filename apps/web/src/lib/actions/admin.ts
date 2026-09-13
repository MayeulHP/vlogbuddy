"use server";

import { revalidatePath } from "next/cache";
import { and, db, eq, isNull, mediaItems, renderJobs, saveRenderSettings, vlogs } from "@vlogbuddy/db";
import { renderSettingsSchema, type RenderSettings } from "@vlogbuddy/shared";
import { requireAdmin } from "../admin";
import { deleteObject } from "../storage";
import { sourceKeysForVlog, supersededRenderKeys } from "../admin-queries";
import { emitToVlog } from "../realtime";

/**
 * Housekeeping, all of it destructive and all of it admin-only.
 *
 * The rule these follow: never delete something the app can't rebuild *and*
 * still needs. Sweeping sources after a render is fine because the film is the
 * artefact people wanted; sweeping them before one would lose the trip.
 */

function fail(err: unknown, fallback: string) {
  return { ok: false as const, error: err instanceof Error ? err.message : fallback };
}

/** Best-effort object deletion — a stray file is better than a stuck action. */
async function sweep(keys: (string | null)[]): Promise<number> {
  const present = keys.filter((k): k is string => Boolean(k));
  const results = await Promise.allSettled(present.map((k) => deleteObject(k)));
  return results.filter((r) => r.status === "fulfilled").length;
}

export async function saveRenderSettingsAction(input: unknown) {
  try {
    await requireAdmin();
    const parsed = renderSettingsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: parsed.error.issues[0].message };
    }
    const saved: RenderSettings = await saveRenderSettings(parsed.data);
    revalidatePath("/admin");
    return { ok: true as const, settings: saved };
  } catch (err) {
    return fail(err, "Couldn't save the export format");
  }
}

/**
 * Deletes the originals, proxies and thumbnails for a vlog that has already
 * been rendered, and keeps the film.
 *
 * This is the one that actually frees the disk: source footage is almost all of
 * it. The rows stay so the vlog still reads as a record of the trip — who was
 * there, what got voted in, how it was cut — it just can't be re-edited or
 * re-rendered afterwards, which the page says plainly before you press it.
 */
export async function pruneVlogSourcesAction(vlogId: string) {
  try {
    await requireAdmin();

    const [vlog] = await db.select().from(vlogs).where(eq(vlogs.id, vlogId)).limit(1);
    if (!vlog) return { ok: false as const, error: "That vlog is already gone" };

    const [finished] = await db
      .select({ id: renderJobs.id })
      .from(renderJobs)
      .where(and(eq(renderJobs.vlogId, vlogId), eq(renderJobs.status, "done")))
      .limit(1);

    if (!finished) {
      return {
        ok: false as const,
        error: "Nothing has been rendered yet — sweeping now would lose the footage for good",
      };
    }

    const items = await sourceKeysForVlog(vlogId);
    if (items.length === 0) {
      return { ok: false as const, error: "The sources for this one are already swept" };
    }

    const freed = await sweep(items.flatMap((i) => [i.storageKey, i.proxyKey, i.thumbnailKey]));

    await db
      .update(mediaItems)
      .set({ prunedAt: new Date(), proxyKey: null, thumbnailKey: null })
      .where(and(eq(mediaItems.vlogId, vlogId), isNull(mediaItems.prunedAt)));

    // Anyone with the page open is now looking at dead thumbnails.
    emitToVlog(vlogId, "vlog:state", { state: vlog.state });

    revalidatePath("/admin");
    revalidatePath(`/v/${vlog.shareSlug}`, "layout");
    return { ok: true as const, items: items.length, objects: freed };
  } catch (err) {
    return fail(err, "Couldn't sweep the sources");
  }
}

/** Drops every render output except the one currently on show. */
export async function pruneOldRendersAction(vlogId: string) {
  try {
    await requireAdmin();

    const superseded = await supersededRenderKeys(vlogId);
    if (superseded.length === 0) {
      return { ok: false as const, error: "There are no leftover renders here" };
    }

    await sweep(superseded.map((r) => r.outputKey));

    // One at a time on purpose: a blanket update would also clear the keeper.
    for (const row of superseded) {
      await db
        .update(renderJobs)
        .set({ outputKey: null, sizeBytes: null })
        .where(eq(renderJobs.id, row.id));
    }

    revalidatePath("/admin");
    return { ok: true as const, count: superseded.length };
  } catch (err) {
    return fail(err, "Couldn't clear the old renders");
  }
}

/** The whole thing: every object, then the row and everything cascading off it. */
export async function deleteVlogAction(vlogId: string) {
  try {
    await requireAdmin();

    const [vlog] = await db.select().from(vlogs).where(eq(vlogs.id, vlogId)).limit(1);
    if (!vlog) return { ok: false as const, error: "That vlog is already gone" };

    const [media, renders] = await Promise.all([
      db
        .select({
          storageKey: mediaItems.storageKey,
          proxyKey: mediaItems.proxyKey,
          thumbnailKey: mediaItems.thumbnailKey,
        })
        .from(mediaItems)
        .where(eq(mediaItems.vlogId, vlogId)),
      db
        .select({ outputKey: renderJobs.outputKey })
        .from(renderJobs)
        .where(eq(renderJobs.vlogId, vlogId)),
    ]);

    await sweep([
      ...media.flatMap((m) => [m.storageKey, m.proxyKey, m.thumbnailKey]),
      ...renders.map((r) => r.outputKey),
    ]);

    // Members, media, reactions, selections, timelines and renders all cascade.
    await db.delete(vlogs).where(eq(vlogs.id, vlogId));

    revalidatePath("/admin");
    return { ok: true as const, title: vlog.title };
  } catch (err) {
    return fail(err, "Couldn't delete that vlog");
  }
}
