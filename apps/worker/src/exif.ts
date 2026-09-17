import { readFile, stat } from "node:fs/promises";
import exifr from "exifr";

/**
 * Reading a photo's own metadata, which FFmpeg won't do.
 *
 * ffprobe surfaces container tags, and a JPEG or a HEIC has none worth having —
 * everything a camera records about a photograph lives in its EXIF block. That
 * leaves the pile taking the browser's `File.lastModified` as the capture time,
 * which is very often the date the file was *copied*, and the auto-cut builds
 * its scenes out of gaps between capture times.
 */

export interface PhotoExif {
  capturedAt: Date | null;
  /** Decimal degrees, WGS 84. */
  latitude: number | null;
  longitude: number | null;
}

/**
 * exifr's own file reader can't be used: it reads in chunks through
 * `FileHandle.stat(path)`, which modern Node rejects outright. Handing it the
 * whole file sidesteps that, at the cost of holding the photo in memory — hence
 * the ceiling, which sits well above any phone camera and below anything that
 * would trouble a small server.
 */
const MAX_BYTES_TO_READ = 128 * 1024 * 1024;

export async function readPhotoExif(filePath: string): Promise<PhotoExif | null> {
  try {
    const { size } = await stat(filePath);
    if (size > MAX_BYTES_TO_READ) return null;

    const buf = await readFile(filePath);
    const tags = (await parseTags(buf)) as Record<string, unknown> | undefined;
    if (!tags) return null;

    const capturedAt = pickCaptureTime(tags);
    const lat = finiteOrNull(tags.latitude);
    const lon = finiteOrNull(tags.longitude);
    // Half a fix is no fix; exifr only fills both when the GPS block parsed.
    const located = lat !== null && lon !== null;

    if (!capturedAt && !located) return null;
    return {
      capturedAt,
      latitude: located ? lat : null,
      longitude: located ? lon : null,
    };
  } catch (err) {
    // Corrupt or truncated EXIF is a photo we know less about, not a failure.
    console.warn(`[exif] could not read ${filePath}:`, (err as Error).message);
    return null;
  }
}

async function parseTags(buf: Buffer): Promise<unknown> {
  const options = { tiff: true, exif: true, gps: true } as const;

  const direct = await exifr.parse(buf, options).catch(() => undefined);
  if (hasAnything(direct)) return direct;

  /**
   * exifr locates a HEIC's EXIF item through the `iloc` box but ignores its
   * `base_offset` field, so it reads from the wrong place — and reports
   * "Malformed EXIF data" — on any HEIF that uses one. iPhones don't, but
   * libheif does, which covers anything that has been through a converter.
   * Finding the block ourselves and handing exifr just that costs a few lines
   * and makes both layouts work.
   */
  if (!looksLikeIsoBmff(buf)) return direct;
  const block = heifExifBlock(buf);
  if (!block) return direct;
  return exifr.parse(block, options).catch(() => undefined);
}

function hasAnything(tags: unknown): boolean {
  if (!tags || typeof tags !== "object") return false;
  const t = tags as Record<string, unknown>;
  return Boolean(t.DateTimeOriginal ?? t.CreateDate ?? t.ModifyDate ?? t.latitude);
}

/**
 * The shutter time in preference to the times a file manager can move.
 *
 * EXIF dates have no timezone of their own, so exifr reads them as the
 * *worker's* local time. That is the right guess for a self-hosted box in its
 * owner's living room, but a phone that recorded `OffsetTimeOriginal` is
 * telling us exactly where it was, and a holiday's worth of photos would
 * otherwise sit hours away from the videos taken beside them.
 */
function pickCaptureTime(tags: Record<string, unknown>): Date | null {
  const candidates: [unknown, unknown][] = [
    [tags.DateTimeOriginal, tags.OffsetTimeOriginal],
    [tags.CreateDate, tags.OffsetTimeDigitized],
    [tags.ModifyDate, tags.OffsetTime],
  ];

  for (const [value, offset] of candidates) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) continue;
    return applyExifOffset(value, offset);
  }
  return null;
}

function applyExifOffset(date: Date, offset: unknown): Date {
  const match = typeof offset === "string" ? offset.match(/^([+-])(\d{2}):?(\d{2})$/) : null;
  if (!match) return date;

  const minutes = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  // Undo the local-time reading exifr did, then re-read against the camera's.
  const wallClock = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(wallClock - minutes * 60_000);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- minimal ISO base media box walking -------------------------------------

interface Box {
  kind: string;
  /** First byte of the payload. */
  start: number;
  /** One past the last byte of the box. */
  end: number;
}

function looksLikeIsoBmff(buf: Buffer): boolean {
  return buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp";
}

/**
 * The TIFF block of a HEIF file's Exif item, or null if it hasn't got one.
 *
 * Bounds are not checked field by field: a malformed box reads past the end and
 * throws, and the caller treats that the same as "no EXIF here".
 */
function heifExifBlock(buf: Buffer): Buffer | null {
  try {
    const meta = findBox(buf, 0, buf.length, "meta");
    if (!meta) return null;

    // `meta`, `iinf` and `iloc` are full boxes: a version byte and three flag
    // bytes sit in front of the payload proper.
    const metaStart = meta.start + 4;
    const iinf = findBox(buf, metaStart, meta.end, "iinf");
    const iloc = findBox(buf, metaStart, meta.end, "iloc");
    if (!iinf || !iloc) return null;

    const itemId = findExifItemId(buf, iinf);
    if (itemId === null) return null;

    const extent = findExtent(buf, iloc, itemId);
    if (!extent) return null;

    const [offset, length] = extent;
    if (length < 8 || offset + length > buf.length) return null;

    // The item leads with the distance from there to the TIFF header: 6 when
    // the "Exif\0\0" marker is present, 0 when the header follows directly.
    const shift = 4 + buf.readUInt32BE(offset);
    if (shift >= length) return null;

    return buf.subarray(offset + shift, offset + length);
  } catch {
    return null;
  }
}

function* boxesIn(buf: Buffer, from: number, to: number): Generator<Box> {
  let offset = from;
  while (offset + 8 <= to) {
    let size = buf.readUInt32BE(offset);
    const kind = buf.toString("latin1", offset + 4, offset + 8);
    let start = offset + 8;

    if (size === 1) {
      const large = buf.readBigUInt64BE(start);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(large);
      start += 8;
    } else if (size === 0) {
      size = to - offset;
    }

    if (size < 8 || offset + size > to) return;
    yield { kind, start, end: offset + size };
    offset += size;
  }
}

function findBox(buf: Buffer, from: number, to: number, kind: string): Box | null {
  for (const box of boxesIn(buf, from, to)) {
    if (box.kind === kind) return box;
  }
  return null;
}

function findExifItemId(buf: Buffer, iinf: Box): number | null {
  const version = buf.readUInt8(iinf.start);
  let offset = iinf.start + 4;
  offset += version === 0 ? 2 : 4; // entry_count, widened in later versions

  for (const infe of boxesIn(buf, offset, iinf.end)) {
    if (infe.kind !== "infe") continue;
    const infeVersion = buf.readUInt8(infe.start);
    if (infeVersion < 2) continue; // no item_type before v2, so nothing to match

    const idSize = infeVersion === 2 ? 2 : 4;
    const body = infe.start + 4;
    const type = buf.toString("latin1", body + idSize + 2, body + idSize + 6);
    if (type === "Exif") return readUint(buf, body, idSize);
  }
  return null;
}

function findExtent(buf: Buffer, iloc: Box, wantedItemId: number): [number, number] | null {
  const version = buf.readUInt8(iloc.start);
  let offset = iloc.start + 4;

  const sizes = buf.readUInt8(offset++);
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0xf;
  const rest = buf.readUInt8(offset++);
  const baseOffsetSize = rest >> 4;
  const indexSize = version === 1 || version === 2 ? rest & 0xf : 0;

  const itemIdSize = version === 2 ? 4 : 2;
  let count = readUint(buf, offset, itemIdSize);
  offset += itemIdSize;

  while (count-- > 0) {
    const itemId = readUint(buf, offset, itemIdSize);
    offset += itemIdSize;

    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = buf.readUInt16BE(offset) & 0xf;
      offset += 2;
    }
    offset += 2; // data_reference_index

    const baseOffset = readUint(buf, offset, baseOffsetSize);
    offset += baseOffsetSize;

    const extentCount = buf.readUInt16BE(offset);
    offset += 2;

    // Method 1 keeps the bytes in an `idat` box rather than the file itself;
    // no camera writes EXIF that way, so it isn't worth chasing.
    if (itemId === wantedItemId && extentCount > 0 && constructionMethod === 0) {
      const extent = offset + indexSize;
      return [
        baseOffset + readUint(buf, extent, offsetSize),
        readUint(buf, extent + offsetSize, lengthSize),
      ];
    }

    offset += extentCount * (indexSize + offsetSize + lengthSize);
  }
  return null;
}

function readUint(buf: Buffer, offset: number, size: number): number {
  if (size === 0) return 0;
  if (size === 8) {
    const large = buf.readBigUInt64BE(offset);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("offset too large");
    return Number(large);
  }
  return buf.readUIntBE(offset, size);
}
