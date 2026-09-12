/**
 * Immich API client.
 *
 * Deliberately plain `fetch` with no SDK: Immich is self-hosted and its
 * generated client is a heavy dependency that pins you to one server version.
 * We touch a handful of stable endpoints, and everything we read is narrowed to
 * the fields we actually use, so a server a few releases ahead or behind still
 * works.
 *
 * Written against the Immich OpenAPI spec v3.2.0. Where a field was renamed
 * across versions we accept both spellings rather than demanding an upgrade.
 *
 * No Node built-ins here — this module is safe to pull into a browser bundle
 * for its types. The actual calls only ever happen server-side.
 */

export interface ImmichCredentials {
  /** Origin of the Immich server, e.g. https://photos.example.com */
  baseUrl: string;
  apiKey: string;
}

export interface ImmichAlbum {
  id: string;
  albumName: string;
  description: string;
  assetCount: number;
  albumThumbnailAssetId: string | null;
  startDate: string | null;
  endDate: string | null;
  shared: boolean;
  updatedAt: string;
}

export interface ImmichAsset {
  id: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "OTHER";
  originalFileName: string;
  originalMimeType: string | null;
  /** Base64 SHA-1 of the file — the same asset has the same checksum anywhere. */
  checksum: string;
  /** Milliseconds for video/gif, null for stills. */
  duration: number | null;
  fileCreatedAt: string;
  fileModifiedAt: string;
  localDateTime: string;
  width: number | null;
  height: number | null;
  isTrashed: boolean;
}

export interface ImmichUser {
  id: string;
  name: string;
  email: string;
}

export class ImmichError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImmichError";
  }
}

/** How long any single Immich call may take before we give up on it. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Downloading a 4K video is slow; give transfers their own budget. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/**
 * People paste whatever is in their address bar — the web UI root, a URL with a
 * trailing slash, or the `/api` base from the docs. Normalise all of them to a
 * bare origin so we can append `/api` ourselves exactly once.
 */
export function normalizeImmichUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new ImmichError("Enter the address of your Immich server");

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ImmichError("That doesn't look like a web address");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImmichError("Immich has to be reachable over http or https");
  }

  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return `${url.origin}${path}`;
}

function apiUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const url = new URL(`${normalizeImmichUrl(baseUrl)}/api${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function request(
  creds: ImmichCredentials,
  path: string,
  init: RequestInit & { query?: Record<string, unknown>; timeoutMs?: number } = {},
): Promise<Response> {
  const { query, timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...rest } = init;

  let res: Response;
  try {
    res = await fetch(apiUrl(creds.baseUrl, path, query), {
      ...rest,
      headers: {
        "x-api-key": creds.apiKey,
        Accept: "application/json",
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/timed? ?out|abort/i.test(reason)) {
      throw new ImmichError("Your Immich server didn't answer in time");
    }
    throw new ImmichError(`Couldn't reach your Immich server (${reason})`);
  }

  if (!res.ok) throw new ImmichError(await describeFailure(res), res.status);
  return res;
}

async function describeFailure(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) {
    return "Immich rejected that API key";
  }
  if (res.status === 404) return "Immich didn't recognise that address — check the URL";

  // Immich errors are `{ message, error, statusCode }`; fall back to the status.
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { message?: string | string[] };
    const message = Array.isArray(parsed.message) ? parsed.message.join(", ") : parsed.message;
    if (message) return `Immich said: ${message}`;
  } catch {
    // Not JSON — fall through.
  }
  return `Immich returned ${res.status}`;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// --- connecting -------------------------------------------------------------

/**
 * Confirms a URL really is an Immich server before we store anything for it.
 * `/server/ping` needs no credentials, which separates "wrong address" from
 * "wrong key" in the error we show.
 */
export async function pingImmich(baseUrl: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl(baseUrl, "/server/ping"), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ImmichError(
      /timed? ?out|abort/i.test(reason)
        ? "That address didn't answer — is the server reachable from this machine?"
        : `Couldn't reach that address (${reason})`,
    );
  }

  if (!res.ok) throw new ImmichError(await describeFailure(res), res.status);

  const body = await json<{ res?: string }>(res).catch(() => ({}) as { res?: string });
  if (body.res !== "pong") {
    throw new ImmichError("Something answered, but it isn't an Immich server");
  }
}

export async function getImmichUser(creds: ImmichCredentials): Promise<ImmichUser> {
  const res = await request(creds, "/users/me");
  const user = await json<{ id: string; name?: string; email?: string }>(res);
  return { id: user.id, name: user.name ?? "Immich user", email: user.email ?? "" };
}

// --- browsing ---------------------------------------------------------------

export async function listAlbums(creds: ImmichCredentials): Promise<ImmichAlbum[]> {
  const res = await request(creds, "/albums");
  const albums = await json<Record<string, unknown>[]>(res);
  return albums.map((a) => ({
    id: String(a.id),
    albumName: String(a.albumName ?? "Untitled album"),
    description: String(a.description ?? ""),
    assetCount: Number(a.assetCount ?? 0),
    albumThumbnailAssetId: (a.albumThumbnailAssetId as string | null) ?? null,
    startDate: (a.startDate as string | null) ?? null,
    endDate: (a.endDate as string | null) ?? null,
    shared: Boolean(a.shared),
    updatedAt: String(a.updatedAt ?? new Date().toISOString()),
  }));
}

/** Guard against a runaway album pulling the server into an endless loop. */
const MAX_ASSET_PAGES = 200;
const ASSET_PAGE_SIZE = 250;

/**
 * Every asset in an album, oldest first.
 *
 * `GET /albums/{id}` stopped returning assets inline, so this goes through
 * metadata search — which also gives us proper pagination for the 5,000-photo
 * holiday album.
 */
export async function listAlbumAssets(
  creds: ImmichCredentials,
  albumId: string,
): Promise<ImmichAsset[]> {
  const assets: ImmichAsset[] = [];
  let page = 1;

  for (let i = 0; i < MAX_ASSET_PAGES; i++) {
    const res = await request(creds, "/search/metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        albumIds: [albumId],
        size: ASSET_PAGE_SIZE,
        page,
        order: "asc",
        withExif: true,
      }),
    });

    const body = await json<{
      assets?: { items?: Record<string, unknown>[]; nextPage?: string | null };
    }>(res);

    const items = body.assets?.items ?? [];
    for (const item of items) assets.push(toAsset(item));

    const next = body.assets?.nextPage;
    if (!next || items.length === 0) break;
    page = Number(next);
    if (!Number.isFinite(page)) break;
  }

  return assets;
}

export async function getAlbum(
  creds: ImmichCredentials,
  albumId: string,
): Promise<ImmichAlbum> {
  const res = await request(creds, `/albums/${albumId}`);
  const a = await json<Record<string, unknown>>(res);
  return {
    id: String(a.id),
    albumName: String(a.albumName ?? "Untitled album"),
    description: String(a.description ?? ""),
    assetCount: Number(a.assetCount ?? 0),
    albumThumbnailAssetId: (a.albumThumbnailAssetId as string | null) ?? null,
    startDate: (a.startDate as string | null) ?? null,
    endDate: (a.endDate as string | null) ?? null,
    shared: Boolean(a.shared),
    updatedAt: String(a.updatedAt ?? new Date().toISOString()),
  };
}

function toAsset(raw: Record<string, unknown>): ImmichAsset {
  const exif = (raw.exifInfo ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    type: (raw.type as ImmichAsset["type"]) ?? "OTHER",
    originalFileName: String(raw.originalFileName ?? "immich-asset"),
    originalMimeType: (raw.originalMimeType as string | null) ?? null,
    checksum: String(raw.checksum ?? ""),
    duration: parseDuration(raw.duration),
    fileCreatedAt: String(raw.fileCreatedAt ?? raw.localDateTime ?? new Date().toISOString()),
    fileModifiedAt: String(raw.fileModifiedAt ?? raw.fileCreatedAt ?? new Date().toISOString()),
    localDateTime: String(raw.localDateTime ?? raw.fileCreatedAt ?? new Date().toISOString()),
    width: numberOrNull(exif.exifImageWidth ?? raw.width),
    height: numberOrNull(exif.exifImageHeight ?? raw.height),
    isTrashed: Boolean(raw.isTrashed),
  };
}

/**
 * `duration` is milliseconds on current servers but was an `HH:MM:SS.mmm`
 * string for years. Accept both so an older instance still imports.
 */
function parseDuration(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- downloading ------------------------------------------------------------

/** The full-size original. Returns the raw response so callers can stream it. */
export async function downloadAsset(
  creds: ImmichCredentials,
  assetId: string,
): Promise<Response> {
  return request(creds, `/assets/${assetId}/original`, {
    headers: { Accept: "application/octet-stream" },
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
}

export async function downloadThumbnail(
  creds: ImmichCredentials,
  assetId: string,
  size: "thumbnail" | "preview" = "thumbnail",
): Promise<Response> {
  return request(creds, `/assets/${assetId}/thumbnail`, {
    query: { size },
    headers: { Accept: "application/octet-stream" },
  });
}

// --- pushing back -----------------------------------------------------------

export interface BulkCheckResult {
  /** Checksums Immich already has, mapped to the asset id it has them under. */
  existing: Map<string, string>;
  /** Checksums it would accept. */
  missing: Set<string>;
}

/**
 * Asks an instance which of these files it already holds, by content hash.
 *
 * This is what makes "copy everyone's photos into my Immich" safe to press
 * twice: your own originals come back as duplicates and are never re-uploaded.
 */
export async function bulkUploadCheck(
  creds: ImmichCredentials,
  checksums: string[],
): Promise<BulkCheckResult> {
  const existing = new Map<string, string>();
  const missing = new Set<string>();

  // The endpoint takes the whole list, but a 5,000-asset body is impolite.
  const BATCH = 500;
  for (let i = 0; i < checksums.length; i += BATCH) {
    const batch = checksums.slice(i, i + BATCH);
    const res = await request(creds, "/assets/bulk-upload-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assets: batch.map((checksum) => ({ id: checksum, checksum })),
      }),
    });

    const body = await json<{
      results?: { id: string; action: string; assetId?: string; reason?: string }[];
    }>(res);

    for (const result of body.results ?? []) {
      if (result.action === "reject" && result.assetId) existing.set(result.id, result.assetId);
      else if (result.action === "accept") missing.add(result.id);
      // A reject with no assetId is an unsupported format — skip it silently;
      // the upload would fail anyway.
    }
  }

  return { existing, missing };
}

export interface UploadResult {
  id: string;
  status: "created" | "duplicate";
}

export async function uploadAsset(
  creds: ImmichCredentials,
  file: {
    data: Blob;
    filename: string;
    fileCreatedAt: Date;
    fileModifiedAt?: Date;
    durationMs?: number | null;
  },
): Promise<UploadResult> {
  const form = new FormData();
  form.append("assetData", file.data, file.filename);
  form.append("filename", file.filename);
  form.append("fileCreatedAt", file.fileCreatedAt.toISOString());
  form.append("fileModifiedAt", (file.fileModifiedAt ?? file.fileCreatedAt).toISOString());
  if (file.durationMs != null) form.append("duration", String(Math.round(file.durationMs)));

  const res = await request(creds, "/assets", {
    method: "POST",
    body: form,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });

  const body = await json<{ id: string; status: string }>(res);
  return { id: body.id, status: body.status === "duplicate" ? "duplicate" : "created" };
}

export async function createAlbum(
  creds: ImmichCredentials,
  input: { albumName: string; description?: string; assetIds?: string[] },
): Promise<ImmichAlbum> {
  const res = await request(creds, "/albums", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      albumName: input.albumName,
      description: input.description ?? "",
      assetIds: input.assetIds ?? [],
    }),
  });
  const a = await json<Record<string, unknown>>(res);
  return {
    id: String(a.id),
    albumName: String(a.albumName),
    description: String(a.description ?? ""),
    assetCount: Number(a.assetCount ?? 0),
    albumThumbnailAssetId: (a.albumThumbnailAssetId as string | null) ?? null,
    startDate: null,
    endDate: null,
    shared: false,
    updatedAt: String(a.updatedAt ?? new Date().toISOString()),
  };
}

/** Adding an asset that's already in the album is a no-op on Immich's side. */
export async function addAssetsToAlbum(
  creds: ImmichCredentials,
  albumId: string,
  assetIds: string[],
): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < assetIds.length; i += BATCH) {
    await request(creds, `/albums/${albumId}/assets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: assetIds.slice(i, i + BATCH) }),
    });
  }
}

// --- mapping into our own model --------------------------------------------

/** Immich's asset type, in our vocabulary. `null` means we can't use it. */
export function mediaKindForImmichAsset(asset: ImmichAsset): "photo" | "video" | null {
  if (asset.type === "IMAGE") return "photo";
  if (asset.type === "VIDEO") return "video";
  return null;
}

/**
 * Immich doesn't always report a mime type. Guessing from the extension is
 * enough for storage metadata; the worker probes the real file anyway.
 */
export function mimeForImmichAsset(asset: ImmichAsset): string {
  if (asset.originalMimeType) return asset.originalMimeType;
  const ext = asset.originalFileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    avif: "image/avif",
    dng: "image/x-adobe-dng",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    m4v: "video/mp4",
  };
  return map[ext] ?? (asset.type === "VIDEO" ? "video/mp4" : "image/jpeg");
}
