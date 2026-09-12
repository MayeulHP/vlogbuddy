import { db, eq, immichConnections, immichTransfers } from "@vlogbuddy/db";
import { openSecret } from "@vlogbuddy/shared/secrets";
import type { ImmichCredentials, ImmichTransferPayload } from "@vlogbuddy/shared";
import { env } from "./env";
import { notifyImmichTransfer } from "./notify";

/** Loads a member's stored Immich credentials and unseals the API key. */
export async function credentialsForMember(memberId: string): Promise<ImmichCredentials> {
  const [conn] = await db
    .select()
    .from(immichConnections)
    .where(eq(immichConnections.memberId, memberId))
    .limit(1);

  if (!conn) throw new Error("No Immich server is connected any more");

  return {
    baseUrl: conn.baseUrl,
    apiKey: openSecret(conn.apiKeyCipher, env().SESSION_SECRET),
  };
}

export interface TransferProgress {
  total?: number;
  done?: number;
  skipped?: number;
  failed?: number;
  message?: string | null;
}

/**
 * Writes progress to the transfer row and pushes it to everyone watching.
 *
 * Persisted as well as broadcast so a reload mid-copy still shows the bar —
 * a 400-photo album takes long enough that people will wander off.
 */
export async function reportTransfer(
  transferId: string,
  patch: TransferProgress & {
    status?: "queued" | "running" | "done" | "failed";
    error?: string | null;
    remoteAlbumId?: string | null;
    startedAt?: Date;
    finishedAt?: Date;
  },
): Promise<void> {
  const [row] = await db
    .update(immichTransfers)
    .set(patch)
    .where(eq(immichTransfers.id, transferId))
    .returning();

  if (!row) return;

  const payload: ImmichTransferPayload = {
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
  };

  await notifyImmichTransfer(row.vlogId, payload);
}
