import { needsDisplayCopy } from "@vlogbuddy/shared";
import type { MediaItemView } from "./queries";

/**
 * The URL to actually put in front of a person.
 *
 * Not the same question as "where is the original", which is what the viewers
 * used to ask. A video wants its proxy so a phone isn't streaming a 4K
 * original to draw one frame, and a HEIC photo — which is most photos, since
 * it is what every recent iPhone shoots — wants the JPEG stand-in the worker
 * makes for it, because outside Safari nothing can decode the original at all.
 *
 * The thumbnail is the last resort rather than a real answer: it is 640px and
 * will look soft full-screen. It's here for the back catalogue, uploaded
 * before the worker made stand-ins, where the alternative is a broken image.
 */
export function previewSrc(item: MediaItemView): string | null {
  if (item.kind === "video") return item.proxyUrl ?? item.originalUrl;
  if (needsDisplayCopy(item.contentType)) {
    return item.proxyUrl ?? item.thumbnailUrl ?? null;
  }
  return item.originalUrl ?? item.proxyUrl ?? item.thumbnailUrl ?? null;
}

/** True when all we could find is the thumbnail, so the view is soft. */
export function isFallbackSrc(item: MediaItemView, src: string | null): boolean {
  return src !== null && src === item.thumbnailUrl && item.kind !== "video";
}
