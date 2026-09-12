import "server-only";
import { db, eq, immichConnections, type ImmichConnection } from "@vlogbuddy/db";
import { openSecret } from "@vlogbuddy/shared/secrets";
import type { ImmichCredentials } from "@vlogbuddy/shared";
import { env } from "./env";

/**
 * Reading a member's Immich connection back out of the database.
 *
 * The decrypted key never leaves the server and never goes into a server
 * action's return value — `publicConnection` is the only shape the browser is
 * allowed to see.
 */

export async function connectionForMember(
  memberId: string,
): Promise<ImmichConnection | null> {
  const [conn] = await db
    .select()
    .from(immichConnections)
    .where(eq(immichConnections.memberId, memberId))
    .limit(1);
  return conn ?? null;
}

export async function credentialsForMember(
  memberId: string,
): Promise<ImmichCredentials | null> {
  const conn = await connectionForMember(memberId);
  if (!conn) return null;
  return {
    baseUrl: conn.baseUrl,
    apiKey: openSecret(conn.apiKeyCipher, env().SESSION_SECRET),
  };
}

export async function requireCredentials(memberId: string): Promise<ImmichCredentials> {
  const creds = await credentialsForMember(memberId);
  if (!creds) throw new Error("Connect your Immich server first");
  return creds;
}

/** What a browser is allowed to know about a stored connection. */
export interface PublicImmichConnection {
  baseUrl: string;
  userName: string | null;
  keyHint: string | null;
  connectedAt: string;
}

export function publicConnection(conn: ImmichConnection): PublicImmichConnection {
  return {
    baseUrl: conn.baseUrl,
    userName: conn.immichUserName,
    keyHint: conn.keyHint,
    connectedAt: conn.createdAt.toISOString(),
  };
}

export async function touchConnection(memberId: string): Promise<void> {
  await db
    .update(immichConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(immichConnections.memberId, memberId))
    .catch(() => {});
}
