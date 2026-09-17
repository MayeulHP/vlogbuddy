/**
 * The admin session cookie, signed and verified with Web Crypto only.
 *
 * Deliberately free of `node:crypto` and of `server-only`: the middleware runs
 * in the edge runtime and has neither, and it has to reach the same verdict as
 * the pages do. Everything here works unchanged in both places.
 *
 * The cookie carries no identity — there is one operator — only an expiry and
 * a fingerprint of the password it was minted against, so changing
 * ADMIN_PASSWORD signs out every browser that was holding an old one.
 */

export const ADMIN_COOKIE = "vb_admin";
export const ADMIN_LOGIN_PATH = "/admin/login";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export interface AdminSecrets {
  /** SESSION_SECRET — the key the cookie is signed with. */
  secret: string;
  /** ADMIN_PASSWORD — fingerprinted into the cookie, never stored in it. */
  password: string;
}

export const adminCookieMaxAge = MAX_AGE_SECONDS;

const encoder = new TextEncoder();

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): ArrayBuffer | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    // Allocated as an ArrayBuffer rather than sliced out of a view, so the
    // result is a BufferSource `subtle.verify` accepts without a cast.
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buffer;
  } catch {
    return null;
  }
}

async function passwordFingerprint(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return toBase64Url(digest).slice(0, 16);
}

/** Length-independent compare, so a near-miss doesn't answer faster. */
function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

export async function mintAdminSession(secrets: AdminSecrets): Promise<string> {
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  const value = `${expiresAt}.${await passwordFingerprint(secrets.password)}`;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secrets.secret),
    encoder.encode(value),
  );
  return `${value}.${toBase64Url(mac)}`;
}

export async function verifyAdminSession(
  raw: string | undefined | null,
  secrets: AdminSecrets,
): Promise<boolean> {
  if (!raw) return false;

  const idx = raw.lastIndexOf(".");
  if (idx === -1) return false;

  const value = raw.slice(0, idx);
  const mac = fromBase64Url(raw.slice(idx + 1));
  if (!mac) return false;

  const signed = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secrets.secret),
    mac,
    encoder.encode(value),
  );
  if (!signed) return false;

  const [expiresAt, fingerprint] = value.split(".");
  if (!expiresAt || !fingerprint) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;

  return constantTimeEqual(fingerprint, await passwordFingerprint(secrets.password));
}

/**
 * Where to send someone after they sign in. Anything that isn't a plain path
 * inside /admin — an absolute URL, a protocol-relative one — is discarded
 * rather than followed, because `?next=` is attacker-supplied by definition.
 */
export function safeAdminRedirect(next: string | null | undefined): string {
  if (!next) return "/admin";
  if (!next.startsWith("/admin")) return "/admin";
  if (next.startsWith("//")) return "/admin";
  if (next.startsWith(ADMIN_LOGIN_PATH)) return "/admin";
  return next;
}
