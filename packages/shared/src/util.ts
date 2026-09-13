import type { Pace } from "./constants";
import { holdFor, jitterFor, rankTier, trimWindow } from "./director";

/** URL-safe, unambiguous alphabet (no 0/O/1/l) for share slugs. */
const SLUG_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export function generateSlug(length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * How long a dumped item would occupy in the assembled cut.
 *
 * Runs the same budget the auto-cut uses, so the running time promised on the
 * floor is the one the bench actually builds. Before the auto-cut existed this
 * returned the full source length, which would now overstate a twenty-minute
 * pile by a factor of five.
 */
export function estimatedClipDuration(
  kind: string,
  durationSeconds: number | null | undefined,
  opts: { pace?: Pace; rank?: number; threshold?: number; mediaItemId?: string } = {},
): number {
  if (kind !== "video" && kind !== "photo") return 0;

  const pace = opts.pace ?? "standard";
  const hold = holdFor({
    kind,
    tier: rankTier(opts.rank ?? 0, opts.threshold ?? 0),
    pace,
    isLast: false,
    jitter: opts.mediaItemId ? jitterFor(opts.mediaItemId) : 0,
  });

  if (kind === "photo") return hold;
  return trimWindow(durationSeconds ?? null, hold).duration;
}

/**
 * Ranking score for the dump view. Sum rewards broad approval, average rewards
 * enthusiasm; blending them stops a single 🤩 from outranking five 🔥. Uses a
 * Bayesian-ish prior so items with few votes settle near the middle.
 */
export function rankScore(sum: number, count: number, priorWeight = 2, priorMean = 1.6): number {
  if (count === 0) return 0;
  const bayesAverage = (sum + priorWeight * priorMean) / (count + priorWeight);
  return bayesAverage * Math.log2(count + 1);
}

export function slugifyFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(-120);
}

/** Distributes items into `bucketCount` chronological buckets. */
export function chronoBucket(
  capturedAt: Date | string | null,
  min: number,
  max: number,
  bucketCount: number,
): number {
  if (!capturedAt || max <= min) return 0;
  const t = typeof capturedAt === "string" ? Date.parse(capturedAt) : capturedAt.getTime();
  if (!Number.isFinite(t)) return 0;
  const ratio = (t - min) / (max - min);
  return Math.max(0, Math.min(bucketCount - 1, Math.floor(ratio * bucketCount)));
}

/**
 * Calendar labels, fixed to one locale and one timezone.
 *
 * These labels are drawn by client components, which React renders twice: once
 * in Node and once in the browser. `toLocaleDateString(undefined, ...)` reads a
 * different default in each — the container's ICU locale and UTC on one side,
 * the visitor's language and timezone on the other — so the same node came back
 * with different text and hydration failed. Pinning both makes the two passes
 * agree; UTC also means everyone in the crew sees a shot filed under the same
 * day, wherever they're reading from.
 */
const DATE_LOCALE = "en-GB";

function calendarLabel(
  value: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions,
): string | null {
  if (value == null) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString(DATE_LOCALE, { timeZone: "UTC", ...options });
}

/** "Sat 13 Sep" */
export function formatDayShort(value: Date | string | null | undefined): string | null {
  return calendarLabel(value, { weekday: "short", day: "numeric", month: "short" });
}

/** "Saturday 13 September" */
export function formatDayLong(value: Date | string | null | undefined): string | null {
  return calendarLabel(value, { weekday: "long", day: "numeric", month: "long" });
}

/** "13 Sep 2026" */
export function formatDate(value: Date | string | null | undefined): string | null {
  return calendarLabel(value, { day: "numeric", month: "short", year: "numeric" });
}

/** "Sep 2026" */
export function formatMonthYear(value: Date | string | null | undefined): string | null {
  return calendarLabel(value, { month: "short", year: "numeric" });
}
