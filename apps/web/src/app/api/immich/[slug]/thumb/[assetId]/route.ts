import { NextResponse } from "next/server";
import { downloadThumbnail, ImmichError } from "@vlogbuddy/shared";
import { requireMemberBySlug } from "@/lib/session";
import { requireCredentials } from "@/lib/immich";

export const dynamic = "force-dynamic";

/**
 * Streams an Immich thumbnail through the app.
 *
 * The browser can't call Immich directly — that would mean handing it the API
 * key, and the server is often the only thing that can reach a LAN instance
 * anyway. Auth is the caller's own vlog cookie, and the credentials used are
 * always the caller's own, so this can't be pointed at somebody else's library.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; assetId: string }> },
) {
  const { slug, assetId } = await params;

  try {
    const session = await requireMemberBySlug(slug);
    const creds = await requireCredentials(session.member.id);

    const res = await downloadThumbnail(creds, assetId, "thumbnail");
    if (!res.body) return new NextResponse(null, { status: 502 });

    return new NextResponse(res.body, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        // Private: these are somebody's personal photos behind a session cookie.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const status = err instanceof ImmichError ? (err.status ?? 502) : 403;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Thumbnail unavailable" },
      { status },
    );
  }
}
