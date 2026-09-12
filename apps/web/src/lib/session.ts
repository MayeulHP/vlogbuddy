import "server-only";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { and, db, eq, members, vlogs, type Member, type Vlog } from "@vlogbuddy/db";
import { env } from "./env";

/**
 * Identity is intentionally lightweight: no accounts, no passwords. A friend
 * opens the share link, picks a display name, and gets a signed cookie holding
 * an opaque session token scoped to that one vlog.
 */

const COOKIE_PREFIX = "vb_session_";
const MAX_AGE = 60 * 60 * 24 * 365;

function sign(value: string): string {
  const mac = crypto
    .createHmac("sha256", env().SESSION_SECRET)
    .update(value)
    .digest("base64url");
  return `${value}.${mac}`;
}

function unsign(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto
    .createHmac("sha256", env().SESSION_SECRET)
    .update(value)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

const cookieName = (vlogId: string) => `${COOKIE_PREFIX}${vlogId.replace(/-/g, "")}`;

export async function setSessionCookie(vlogId: string, sessionToken: string) {
  const store = await cookies();
  // LAN / IP access is http; a Secure cookie would never be stored.
  const secure =
    process.env.CORS_ALLOW_ORIGIN === "*"
      ? false
      : env().PUBLIC_BASE_URL.startsWith("https://");
  store.set(cookieName(vlogId), sign(sessionToken), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSessionCookie(vlogId: string) {
  const store = await cookies();
  store.delete(cookieName(vlogId));
}

export async function readSessionToken(vlogId: string): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(cookieName(vlogId))?.value;
  if (!raw) return null;
  return unsign(raw);
}

/** Resolves the current member for a vlog, or null if they haven't joined. */
export async function getCurrentMember(vlogId: string): Promise<Member | null> {
  const token = await readSessionToken(vlogId);
  if (!token) return null;

  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.vlogId, vlogId), eq(members.sessionToken, token)))
    .limit(1);

  if (!member) return null;

  // Best-effort presence bookkeeping; never block the request on it.
  void db
    .update(members)
    .set({ lastSeenAt: new Date() })
    .where(eq(members.id, member.id))
    .catch(() => {});

  return member;
}

export async function getVlogBySlug(slug: string): Promise<Vlog | null> {
  const [vlog] = await db.select().from(vlogs).where(eq(vlogs.shareSlug, slug)).limit(1);
  return vlog ?? null;
}

export async function getVlogById(id: string): Promise<Vlog | null> {
  const [vlog] = await db.select().from(vlogs).where(eq(vlogs.id, id)).limit(1);
  return vlog ?? null;
}

export interface VlogSession {
  vlog: Vlog;
  member: Member;
}

/** Throws if the caller isn't a joined member — use in actions/route handlers. */
export async function requireMemberBySlug(slug: string): Promise<VlogSession> {
  const vlog = await getVlogBySlug(slug);
  if (!vlog) throw new Error("This vlog doesn't exist");
  const member = await getCurrentMember(vlog.id);
  if (!member) throw new Error("Join this vlog first");
  return { vlog, member };
}

export async function requireMemberByVlogId(vlogId: string): Promise<VlogSession> {
  const vlog = await getVlogById(vlogId);
  if (!vlog) throw new Error("This vlog doesn't exist");
  const member = await getCurrentMember(vlog.id);
  if (!member) throw new Error("Join this vlog first");
  return { vlog, member };
}

export function requireCreator(session: VlogSession) {
  if (session.member.role !== "creator") {
    throw new Error("Only the vlog creator can do that");
  }
}

export function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(passcode, salt, 32);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const derived = crypto.scryptSync(passcode, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
