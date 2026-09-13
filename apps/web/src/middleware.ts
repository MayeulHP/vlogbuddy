import { NextResponse, type NextRequest } from "next/server";

/**
 * HTTP Basic Auth on the operator's own pages.
 *
 * Everything a *guest* touches — the share link, the cutting room, the finished
 * film — stays open, because that's the whole point of the app. What's behind
 * this is the instance itself: making vlogs, changing the export format, and
 * deleting other people's media off the disk.
 *
 * Basic Auth rather than a login screen is deliberate. There's one operator,
 * they already keep secrets in .env, and the browser's own prompt means no
 * session table, no cookie, and nothing to get subtly wrong. Serve the instance
 * over HTTPS: Basic credentials are base64, not encrypted.
 *
 * The pages re-check with `requireAdmin()` regardless — a matcher typo
 * shouldn't be the only thing standing between a guest and the delete button.
 */
export const config = {
  matcher: ["/admin/:path*"],
};

export function middleware(request: NextRequest) {
  const expectedPassword = process.env.ADMIN_PASSWORD;

  // Unset password means the admin area is sealed, not wide open.
  if (!expectedPassword) {
    return new NextResponse(
      "The admin area is disabled because ADMIN_PASSWORD isn't set. Add it to .env and restart.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const expectedUser = process.env.ADMIN_USER || "admin";
  const header = request.headers.get("authorization");

  if (header?.startsWith("Basic ")) {
    const decoded = safeDecode(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator !== -1) {
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      // Both compared in constant time, and always both, so the response time
      // doesn't leak whether the username happened to be right.
      const userOk = constantTimeEqual(user, expectedUser);
      const passwordOk = constantTimeEqual(password, expectedPassword);
      if (userOk && passwordOk) return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="ROLLCALL admin", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function safeDecode(value: string): string {
  try {
    return atob(value);
  } catch {
    return "";
  }
}

/**
 * Length-independent constant-time compare. `node:crypto` isn't available in
 * the middleware runtime, so this is hand-rolled: hash-free, but it always
 * walks the same number of iterations for a given input length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
