import "server-only";
import crypto from "node:crypto";
import { headers } from "next/headers";

/**
 * The operator's own guard, re-checked inside every admin page and action.
 *
 * The middleware already challenges for Basic Auth on `/admin`, but server
 * actions are just POSTs — a matcher that stops covering them one day
 * shouldn't quietly turn "delete every original in this vlog" into something
 * a guest can call. This is the check that actually protects the data.
 */

export function adminEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export async function isAdmin(): Promise<boolean> {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword) return false;

  const header = (await headers()).get("authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  const userOk = timingSafeEqual(decoded.slice(0, separator), process.env.ADMIN_USER || "admin");
  const passwordOk = timingSafeEqual(decoded.slice(separator + 1), expectedPassword);
  return userOk && passwordOk;
}

export async function requireAdmin(): Promise<void> {
  if (!adminEnabled()) {
    throw new Error("The admin area is disabled — set ADMIN_PASSWORD in .env and restart");
  }
  if (!(await isAdmin())) {
    throw new Error("Only the instance admin can do that");
  }
}

/** Hashes both sides first so the compare is length-independent. */
function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
