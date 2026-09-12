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
