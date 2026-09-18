import type { MusicSource } from "./constants";

export interface ParsedMusicLink {
  source: MusicSource;
  externalId: string;
  /** Normalised canonical URL. */
  url: string;
  /** Embeddable player URL for the voting UI. */
  embedUrl: string;
}

/**
 * Recognises the shapes of links people actually paste (share links, mobile
 * links, with tracking params). Spotify and Deezer are still recognised even
 * though only YouTube is accepted, so someone who pastes one gets told why
 * rather than being told their link is unreadable.
 */
export function parseMusicLink(raw: string): ParsedMusicLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  // --- YouTube -------------------------------------------------------------
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    if (id) return youtube(id);
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const v = url.searchParams.get("v");
    if (v) return youtube(v);
    const shorts = url.pathname.match(/^\/(?:shorts|embed|v)\/([\w-]{6,})/);
    if (shorts) return youtube(shorts[1]);
  }

  // --- Spotify -------------------------------------------------------------
  if (host === "open.spotify.com" || host === "spotify.com") {
    const m = url.pathname.match(/\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (m) {
      const [, type, id] = m;
      return {
        source: "spotify",
        externalId: `${type}:${id}`,
        url: `https://open.spotify.com/${type}/${id}`,
        embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
      };
    }
  }
  if (url.protocol === "spotify:") {
    const m = raw.match(/spotify:(track|album|playlist):([A-Za-z0-9]+)/);
    if (m) {
      const [, type, id] = m;
      return {
        source: "spotify",
        externalId: `${type}:${id}`,
        url: `https://open.spotify.com/${type}/${id}`,
        embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
      };
    }
  }

  // --- Deezer --------------------------------------------------------------
  if (host === "deezer.com" || host === "deezer.page.link") {
    const m = url.pathname.match(/\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/);
    if (m) {
      const [, type, id] = m;
      return {
        source: "deezer",
        externalId: `${type}:${id}`,
        url: `https://www.deezer.com/${type}/${id}`,
        embedUrl: `https://widget.deezer.com/widget/dark/${type}/${id}`,
      };
    }
  }

  return null;
}

function youtube(id: string): ParsedMusicLink {
  return {
    source: "youtube",
    externalId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
  };
}

/** oEmbed endpoint for fetching title/artist/thumbnail without an API key. */
export function oembedEndpoint(parsed: ParsedMusicLink): string | null {
  switch (parsed.source) {
    case "youtube":
      return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`;
    case "spotify":
      return `https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.url)}`;
    case "deezer":
      return `https://api.deezer.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`;
    default:
      return null;
  }
}

/** Only YouTube audio can be extracted — the rest is DRM-protected. */
export function canExtractAudio(source: MusicSource): boolean {
  return source === "youtube";
}
