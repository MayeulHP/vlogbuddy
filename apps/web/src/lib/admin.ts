import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminSession } from "./admin-session";

/**
 * The operator's own guard, re-checked inside every admin page and action.
 *
 * The middleware already turns anonymous traffic on `/admin` away, but server
 * actions are just POSTs — a matcher that stops covering them one day
 * shouldn't quietly turn "delete every original in this vlog" into something
 * a guest can call. This is the check that actually protects the data.
 */

export function adminEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function secrets(): { secret: string; password: string } | null {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!password || !secret) return null;
  return { secret, password };
}

export async function isAdmin(): Promise<boolean> {
  const config = secrets();
  if (!config) return false;
  const raw = (await cookies()).get(ADMIN_COOKIE)?.value;
  return verifyAdminSession(raw, config);
}

export async function requireAdmin(): Promise<void> {
  if (!adminEnabled()) {
    throw new Error("The admin area is disabled — set ADMIN_PASSWORD in .env and restart");
  }
  if (!(await isAdmin())) {
    throw new Error("Sign in as the instance admin to do that");
  }
}

/** True when these are the operator's credentials. Constant time in both. */
export function credentialsMatch(user: string, password: string): boolean {
  const config = secrets();
  if (!config) return false;
  // Both compared, always, so the response time doesn't leak whether the
  // username happened to be right.
  const userOk = timingSafeEqual(user, process.env.ADMIN_USER || "admin");
  const passwordOk = timingSafeEqual(password, config.password);
  return userOk && passwordOk;
}

/** Hashes both sides first so the compare is length-independent. */
function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
