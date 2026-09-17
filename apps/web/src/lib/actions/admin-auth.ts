"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "../env";
import { adminEnabled, credentialsMatch } from "../admin";
import {
  ADMIN_COOKIE,
  ADMIN_LOGIN_PATH,
  adminCookieMaxAge,
  mintAdminSession,
  safeAdminRedirect,
} from "../admin-session";

/**
 * Signing in and out of the projection booth.
 *
 * A form rather than the browser's Basic Auth prompt: the prompt can't be
 * filled by a password manager, and a service-worker-controlled navigation
 * can't complete an auth challenge at all — which is what made /admin ask
 * for the password over and over once the app became installable.
 */

/**
 * One operator, one process, so a counter in memory is the whole rate limiter.
 * It exists to make scripted guessing tedious, not to survive a restart.
 */
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
let failures: number[] = [];

function throttled(): boolean {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  failures = failures.filter((at) => at > cutoff);
  return failures.length >= MAX_FAILURES;
}

export async function adminLoginAction(formData: FormData) {
  if (!adminEnabled()) {
    return {
      ok: false as const,
      error: "The admin area is disabled — set ADMIN_PASSWORD in .env and restart",
    };
  }

  if (throttled()) {
    return { ok: false as const, error: "Too many tries. Give it a minute and try again." };
  }

  const user = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeAdminRedirect(
    typeof formData.get("next") === "string" ? String(formData.get("next")) : null,
  );

  if (!credentialsMatch(user, password)) {
    failures.push(Date.now());
    return { ok: false as const, error: "That name and password don't match." };
  }

  failures = [];

  const token = await mintAdminSession({
    secret: env().SESSION_SECRET,
    password: process.env.ADMIN_PASSWORD!,
  });

  (await cookies()).set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: adminCookieMaxAge,
  });

  redirect(next);
}

export async function adminLogoutAction(_formData?: FormData) {
  (await cookies()).delete(ADMIN_COOKIE);
  redirect(ADMIN_LOGIN_PATH);
}

/** LAN / IP access is http; a Secure cookie would never be stored. */
function secureCookies(): boolean {
  if (process.env.CORS_ALLOW_ORIGIN === "*") return false;
  return env().PUBLIC_BASE_URL.startsWith("https://");
}
