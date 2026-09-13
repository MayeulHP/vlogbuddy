import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, eq, musicItems } from "@vlogbuddy/db";
import { env } from "../env";
import { buildStorageKey, uploadFile } from "../storage";
import { probe } from "../ffmpeg";
import { notifyMusicUpdated } from "../notify";

export interface ExtractAudioJob {
  musicItemId: string;
  vlogId: string;
}

/**
 * Pulls the audio for a YouTube link with yt-dlp so it can be muxed into the
 * final render.
 *
 * ⚠️  Downloading from YouTube violates their Terms of Service and the result
 * isn't redistributable. This exists for private, self-hosted, personal use and
 * is off unless ENABLE_YT_AUDIO=true. Spotify and Deezer are DRM-protected and
 * are never attempted — upload an audio file for those.
 */
export async function extractAudio(job: ExtractAudioJob): Promise<void> {
  const { musicItemId } = job;

  if (!env().ENABLE_YT_AUDIO) {
    console.log(`[extract-audio] skipped ${musicItemId} — ENABLE_YT_AUDIO is false`);
    await db
      .update(musicItems)
      .set({ status: "ready", error: "Audio extraction is disabled on this instance" })
      .where(eq(musicItems.id, musicItemId));
    return;
  }

  const [item] = await db.select().from(musicItems).where(eq(musicItems.id, musicItemId)).limit(1);
  if (!item) return;

  if (item.source !== "youtube") {
    await db
      .update(musicItems)
      .set({
        status: "ready",
        error: `${item.source} is DRM-protected — upload an audio file to use it in the render`,
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

    const key = buildStorageKey(item.vlogId, "audio", item.id, audioFile);
    await uploadFile(key, localPath, "audio/mp4");

    await db
      .update(musicItems)
      .set({
        status: "ready",
        extractedAudioKey: key,
        audioDurationSeconds: info?.durationSeconds ?? null,
        error: null,
      })
      .where(eq(musicItems.id, item.id));

    // The editor holds a presigned URL that didn't exist a moment ago, so tell
    // the room to re-read the track rather than making someone reload.
    await notifyMusicUpdated(item.vlogId, item.id);

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
