"use server";

import { revalidatePath } from "next/cache";
import { and, db, desc, eq, inArray, immichConnections, immichTransfers } from "@vlogbuddy/db";
import {
  ImmichError,
  connectImmichSchema,
  getImmichUser,
  immichImportSchema,
  isWorkingState,
  listAlbums,
  listAlbumAssets,
  mediaKindForImmichAsset,
  normalizeImmichUrl,
  pingImmich,
  type ImmichAlbum,
} from "@vlogbuddy/shared";
import { sealSecret, secretHint } from "@vlogbuddy/shared/secrets";
import { requireMemberBySlug, type VlogSession } from "../session";
import { env } from "../env";
import {
  connectionForMember,
  publicConnection,
  requireCredentials,
  touchConnection,
  type PublicImmichConnection,
} from "../immich";
import { enqueueImmichExport, enqueueImmichImport } from "../queue";

/**
 * Immich lives behind the member who connected it. There are no accounts here,
 * so a member *is* a person, and one person's API key must never be usable by
 * anyone else in the vlog — every action below reads the caller's own
 * connection and nobody else's.
 */

function requireWorking(session: VlogSession) {
  if (!isWorkingState(session.vlog.state)) {
    throw new Error("This vlog is rendering — importing has to wait until it finishes");
  }
}

/** Turns an Immich client error into copy we're happy to show. */
function message(err: unknown, fallback: string): string {
  if (err instanceof ImmichError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

// --- connection -------------------------------------------------------------

export async function connectImmichAction(
  slug: string,
  input: { baseUrl: string; apiKey: string },
): Promise<
  { ok: true; connection: PublicImmichConnection } | { ok: false; error: string }
> {
  try {
    const session = await requireMemberBySlug(slug);

    const parsed = connectImmichSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0].message };
    }

    const baseUrl = normalizeImmichUrl(parsed.data.baseUrl);
    const apiKey = parsed.data.apiKey;

    // Prove it's Immich before the key is stored, and separate "wrong address"
    // from "wrong key" so the error actually helps.
    await pingImmich(baseUrl);
    const user = await getImmichUser({ baseUrl, apiKey });

    const values = {
      vlogId: session.vlog.id,
      memberId: session.member.id,
      baseUrl,
      apiKeyCipher: sealSecret(apiKey, env().SESSION_SECRET),
      immichUserId: user.id,
      immichUserName: user.name || user.email || null,
      keyHint: secretHint(apiKey),
    };

    const [conn] = await db
      .insert(immichConnections)
      .values(values)
      .onConflictDoUpdate({
        target: immichConnections.memberId,
        set: {
          baseUrl: values.baseUrl,
          apiKeyCipher: values.apiKeyCipher,
          immichUserId: values.immichUserId,
          immichUserName: values.immichUserName,
          keyHint: values.keyHint,
        },
      })
      .returning();

    revalidatePath(`/v/${slug}`);
    return { ok: true, connection: publicConnection(conn) };
  } catch (err) {
    return { ok: false, error: message(err, "Couldn't connect to Immich") };
  }
}

export async function disconnectImmichAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    await db
      .delete(immichConnections)
      .where(eq(immichConnections.memberId, session.member.id));
    revalidatePath(`/v/${slug}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't disconnect") };
  }
}

// --- browsing ---------------------------------------------------------------

export async function listImmichAlbumsAction(
  slug: string,
): Promise<{ ok: true; albums: ImmichAlbum[] } | { ok: false; error: string }> {
  try {
    const session = await requireMemberBySlug(slug);
    const creds = await requireCredentials(session.member.id);
    const albums = await listAlbums(creds);
    await touchConnection(session.member.id);

    // Most recently touched first — that's the trip you just got back from.
    albums.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { ok: true, albums };
  } catch (err) {
    return { ok: false, error: message(err, "Couldn't read your albums") };
  }
}

export interface ImmichAssetPreview {
  id: string;
  filename: string;
  kind: "photo" | "video";
  /** Milliseconds; null for stills. */
  duration: number | null;
  takenAt: string;
  /** True when this exact file is already in the vlog. */
  alreadyHere: boolean;
}

export async function listImmichAlbumAssetsAction(
  slug: string,
  albumId: string,
): Promise<
  { ok: true; assets: ImmichAssetPreview[] } | { ok: false; error: string }
> {
  try {
    const session = await requireMemberBySlug(slug);
    const creds = await requireCredentials(session.member.id);

    const [assets, seen] = await Promise.all([
      listAlbumAssets(creds, albumId),
      existingChecksums(session.vlog.id),
    ]);

    const previews = assets.flatMap<ImmichAssetPreview>((asset) => {
      const kind = mediaKindForImmichAsset(asset);
      if (!kind || asset.isTrashed) return [];
      return [
        {
          id: asset.id,
          filename: asset.originalFileName,
          kind,
          duration: asset.duration,
          takenAt: asset.localDateTime,
          alreadyHere: Boolean(asset.checksum) && seen.has(asset.checksum),
        },
      ];
    });

    return { ok: true, assets: previews };
  } catch (err) {
    return { ok: false, error: message(err, "Couldn't read that album") };
  }
}

async function existingChecksums(vlogId: string): Promise<Set<string>> {
  const { mediaItems, isNotNull } = await import("@vlogbuddy/db");
  const rows = await db
    .select({ checksum: mediaItems.checksumSha1 })
    .from(mediaItems)
    .where(and(eq(mediaItems.vlogId, vlogId), isNotNull(mediaItems.checksumSha1)));
  return new Set(rows.map((r) => r.checksum).filter((c): c is string => Boolean(c)));
}

// --- transfers --------------------------------------------------------------

/**
 * Retires a transfer row whose job the queue turned away.
 *
 * `assertNoTransferRunning` can still lose a race between two presses; the
 * queue is what finally decides, and it says so by returning null from `send`.
 * The row is already inserted by then, so it has to be marked rather than left
 * waiting on a job that will never exist.
 */
async function rejectTransfer(transferId: string, direction: "import" | "export") {
  const error =
    direction === "import"
      ? "You're already importing something — let that finish first"
      : "You're already sending something over — let that finish first";
  await db
    .update(immichTransfers)
    .set({ status: "failed", message: error, finishedAt: new Date() })
    .where(eq(immichTransfers.id, transferId));
  return { ok: false as const, error };
}

/** Only one copy at a time per person, in either direction. */
async function assertNoTransferRunning(memberId: string) {
  // "queued" counts: the queue allows one running and one waiting per member,
  // so a second press while one is still waiting would be rejected there and
  // leave a transfer row showing a progress bar that never moves.
  const [running] = await db
    .select()
    .from(immichTransfers)
    .where(
      and(
        eq(immichTransfers.memberId, memberId),
        inArray(immichTransfers.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (running) {
    throw new Error(
      running.direction === "import"
        ? "You're already importing something — let that finish first"
        : "You're already copying to Immich — let that finish first",
    );
  }
}

export async function startImmichImportAction(
  slug: string,
  input: { albumId: string; albumName: string; assetIds?: string[] },
) {
  try {
    const session = await requireMemberBySlug(slug);
    requireWorking(session);

    const parsed = immichImportSchema.safeParse({
      albumId: input.albumId,
      assetIds: input.assetIds ?? [],
    });
    if (!parsed.success) return { ok: false as const, error: "Pick an album first" };

    // Fails early with a clear message if the key was revoked on their side.
    await requireCredentials(session.member.id);
    await assertNoTransferRunning(session.member.id);

    const label = input.albumName?.trim() || "Immich album";

    const [transfer] = await db
      .insert(immichTransfers)
      .values({
        vlogId: session.vlog.id,
        memberId: session.member.id,
        direction: "import",
        label,
        status: "queued",
        message: "Waiting to start…",
      })
      .returning();

    const queued = await enqueueImmichImport({
      transferId: transfer.id,
      vlogId: session.vlog.id,
      memberId: session.member.id,
      albumId: parsed.data.albumId,
      albumName: label,
      assetIds: parsed.data.assetIds,
    });
    if (!queued) return await rejectTransfer(transfer.id, "import");

    revalidatePath(`/v/${slug}`);
    return { ok: true as const, transferId: transfer.id };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't start the import") };
  }
}

/**
 * Pushes every original in this vlog, plus the finished film, into the caller's
 * own Immich.
 *
 * This is the bit Immich can't do for you: two friends with two servers have no
 * way to merge libraries, so whoever brought the photos, everyone ends up with
 * the full set — and with the film itself, which is the part they'll actually
 * go looking for later. The worker picks the latest finished render; if nothing
 * has been rendered yet the copy just carries the media and says so.
 */
export async function startImmichExportAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    await requireCredentials(session.member.id);
    await assertNoTransferRunning(session.member.id);

    const label = session.vlog.title.trim() || "VlogBuddy import";

    const [transfer] = await db
      .insert(immichTransfers)
      .values({
        vlogId: session.vlog.id,
        memberId: session.member.id,
        direction: "export",
        label,
        status: "queued",
        message: "Waiting to start…",
      })
      .returning();

    const queued = await enqueueImmichExport({
      transferId: transfer.id,
      vlogId: session.vlog.id,
      memberId: session.member.id,
      albumName: label,
    });
    if (!queued) return await rejectTransfer(transfer.id, "export");

    revalidatePath(`/v/${slug}`);
    return { ok: true as const, transferId: transfer.id };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't start the copy") };
  }
}

/** The caller's most recent transfer, for rehydrating the progress bar. */
export async function latestTransferAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    const [row] = await db
      .select()
      .from(immichTransfers)
      .where(eq(immichTransfers.memberId, session.member.id))
      .orderBy(desc(immichTransfers.createdAt))
      .limit(1);
    if (!row) return { ok: true as const, transfer: null };

    return {
      ok: true as const,
      transfer: {
        transferId: row.id,
        memberId: row.memberId,
        direction: row.direction,
        label: row.label,
        status: row.status,
        total: row.total,
        done: row.done,
        skipped: row.skipped,
        failed: row.failed,
        message: row.message,
        error: row.error,
      },
    };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't check progress") };
  }
}

export async function getImmichConnectionAction(slug: string) {
  try {
    const session = await requireMemberBySlug(slug);
    const conn = await connectionForMember(session.member.id);
    return { ok: true as const, connection: conn ? publicConnection(conn) : null };
  } catch (err) {
    return { ok: false as const, error: message(err, "Couldn't load your connection") };
  }
}
