import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, ADMIN_LOGIN_PATH, verifyAdminSession } from "@/lib/admin-session";

/**
 * The gate on the operator's own pages.
 *
 * Everything a *guest* touches — the share link, the cutting room, the finished
 * film — stays open, because that's the whole point of the app. What's behind
 * this is the instance itself: making vlogs, changing the export format, and
 * deleting other people's media off the disk.
 *
 * This used to be HTTP Basic Auth, which was tidy right up until the app got a
 * service worker: a navigation served through `sw.js` can't carry an auth
 * challenge to completion, so the browser prompted, got nowhere, and prompted
 * again forever. A signed cookie and a real form have no such problem — and a
 * form is something a password manager can actually fill.
 *
 * The pages re-check with `requireAdmin()` regardless — a matcher typo
 * shouldn't be the only thing standing between a guest and the delete button.
 */
export const config = {
  matcher: ["/admin/:path*"],
};

export async function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  // Unset password means the admin area is sealed, not wide open.
  if (!password || !secret) {
    return new NextResponse(
      "The admin area is disabled because ADMIN_PASSWORD isn't set. Add it to .env and restart.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const { pathname, search } = request.nextUrl;
  const signedIn = await verifyAdminSession(request.cookies.get(ADMIN_COOKIE)?.value, {
    secret,
    password,
  });

  // The sign-in page is the one door that has to stay unlocked.
  if (pathname === ADMIN_LOGIN_PATH) {
    if (signedIn) return NextResponse.redirect(new URL("/admin", request.url));
    return NextResponse.next();
  }

  if (signedIn) return NextResponse.next();

  const login = new URL(ADMIN_LOGIN_PATH, request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}
