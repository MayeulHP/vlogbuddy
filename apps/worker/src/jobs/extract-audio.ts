import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, eq, musicItems } from "@vlogbuddy/db";
import { env } from "../env";
import { buildStorageKey, uploadFile } from "../storage";
import { audioPeaks, probe } from "../ffmpeg";
import { analyzeBeats } from "../beats";
import { notifyMusicUpdated, requestCutResync } from "../notify";

export interface ExtractAudioJob {
  musicItemId: string;
  vlogId: string;
}

/**
 * Pulls the audio for a YouTube link with yt-dlp so it can be muxed into the
 * final render.
 *
 * ⚠️  Downloading from YouTube violates their Terms of Service and the result
 * isn't redistributable. This exists for private, self-hosted, personal use.
 * The source guard below is for tracks added back when DRM-protected links were
 * still accepted; nothing but YouTube gets in now.
 */
export async function extractAudio(job: ExtractAudioJob): Promise<void> {
  const { musicItemId } = job;

  const [item] = await db.select().from(musicItems).where(eq(musicItems.id, musicItemId)).limit(1);
  if (!item) return;

  if (item.source !== "youtube") {
    await db
      .update(musicItems)
      .set({
        status: "ready",
        error: "That track is locked down — upload an audio file to use it in the film instead",
      })
      .where(eq(musicItems.id, item.id));
    await notifyMusicUpdated(item.vlogId, item.id);
    return;
  }

  await db.update(musicItems).set({ status: "processing" }).where(eq(musicItems.id, item.id));
  await notifyMusicUpdated(item.vlogId, item.id);

  const workDir = await mkdtemp(path.join(env().TMP_DIR ?? tmpdir(), "audio-"));

  try {
    await runYtDlp(item.url, workDir);

    const files = await readdir(workDir);
    const audioFile = files.find((f) => f.endsWith(".m4a") || f.endsWith(".mp3") || f.endsWith(".opus"));
    if (!audioFile) throw new Error("yt-dlp produced no audio file");

    const localPath = path.join(workDir, audioFile);
    const info = await probe(localPath).catch(() => null);

    // While the file is on disk: where the beats are, so the auto-cut can put
    // its cuts on them. Best-effort — no tempo just means no beat-snapping.
    const beats = await analyzeBeats(localPath);

    // And its shape, for the audio lane on the bench — same pass, same file.
    const peaks = await audioPeaks(localPath);

    const key = buildStorageKey(item.vlogId, "audio", item.id, audioFile);
    await uploadFile(key, localPath, "audio/mp4");

    await db
      .update(musicItems)
      .set({
        status: "ready",
        extractedAudioKey: key,
        audioDurationSeconds: info?.durationSeconds ?? null,
        bpm: beats?.bpm ?? null,
        beatOffsetSeconds: beats?.beatOffsetSeconds ?? null,
        beatTimes: beats?.beatTimes ?? null,
        beatConfidence: beats?.confidence ?? null,
        peaks,
        error: null,
      })
      .where(eq(musicItems.id, item.id));

    // The editor holds a presigned URL that didn't exist a moment ago, so tell
    // the room to re-read the track rather than making someone reload.
    await notifyMusicUpdated(item.vlogId, item.id);

    /**
     * The beats landed with it, and they're no use sitting in the row: the
     * auto-cut snaps its cuts to them, and the document it snapped was built
     * before this track had a pulse. Same coalescing as a processed upload.
     */
    if (item.addedById) requestCutResync(item.vlogId, item.addedById);

    console.log(`[extract-audio] ${item.id} ready`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[extract-audio] ${item.id} failed:`, message);
    await db
      .update(musicItems)
      .set({ status: "failed", error: message.slice(0, 1000) })
      .where(eq(musicItems.id, item.id));
    await notifyMusicUpdated(item.vlogId, item.id);
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runYtDlp(url: string, workDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env().YTDLP_PATH,
      [
        "--no-playlist",
        "-f", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "m4a",
        "--audio-quality", "0",
        "--no-progress",
        "--max-filesize", "80m",
        "-o", path.join(workDir, "audio.%(ext)s"),
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) =>
      reject(
        new Error(
          err.message.includes("ENOENT")
            ? "yt-dlp isn't installed in the worker image"
            : err.message,
        ),
      ),
    );

    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`yt-dlp failed: ${stderr.slice(-800)}`)),
    );
  });
}
