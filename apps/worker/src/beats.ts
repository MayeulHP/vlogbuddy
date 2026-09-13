import { spawn } from "node:child_process";

/**
 * Where the beats are.
 *
 * The auto-cut wants to land its cuts on the music, and the music is a file on
 * disk we already have open. There is no beat-tracking library here on purpose
 * — a native DSP dependency would have to be built for every machine this
 * self-hosts on, and the whole of what we need fits in a page of arithmetic:
 *
 *   1. ffmpeg decodes the first couple of minutes to mono 16-bit PCM. It's a
 *      hard dependency already, and it handles every container yt-dlp or a
 *      phone can hand us.
 *   2. Frame that into an onset envelope — how much louder each 12ms window is
 *      than the one before it, in log terms, so a quiet passage's kick counts
 *      as much as a loud one's.
 *   3. Autocorrelate the envelope to find the lag the music repeats at. That
 *      lag is the beat period, and a tempo prior around 120 BPM keeps us from
 *      confidently reporting half or double it.
 *   4. Slide a pulse train over the envelope at that period to find the phase.
 *
 * Everything from step 2 on is pure and exported, so `director-check.ts` can
 * feed it a synthetic envelope without touching ffmpeg or a database.
 *
 * It is a tempo estimator, not a musicologist. It does well on anything with a
 * drum and poorly on rubato piano, which is why the result carries a
 * confidence and the auto-cut ignores a grid that doesn't clear the bar.
 */

const SAMPLE_RATE = 22050;
const HOP = 256;
const WINDOW = 1024;
export const HOP_SECONDS = HOP / SAMPLE_RATE;

/** Enough of a track to know its tempo; the rest is the same tempo. */
const ANALYSIS_SECONDS = 120;

const MIN_BPM = 60;
const MAX_BPM = 200;

/** Tempo prior: a log-normal bell on 120 BPM, which is where pop music lives. */
const PRIOR_CENTRE_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 0.9;

/** Below this the envelope had no periodicity worth calling a tempo. */
const MIN_CONFIDENCE = 0.12;

/** A grid this long already covers the opening of any film we'd cut. */
const MAX_BEAT_TIMES = 320;

/** How far a predicted beat may be nudged onto a real onset. */
const REFINE_FRAMES = 2;

export interface BeatAnalysis {
  bpm: number;
  /** Seconds from the start of the file to the first beat. */
  beatOffsetSeconds: number;
  /** Measured beat times in seconds, ascending. */
  beatTimes: number[];
  confidence: number;
}

/** Rounded where it's generated, the same rule the timeline document lives by. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Measures the beat grid of an audio (or video) file. Returns null when the
 * file has no audio, ffmpeg can't read it, or the result isn't trustworthy —
 * every caller treats that as "no beat data", which is a supported state.
 */
export async function analyzeBeats(filePath: string): Promise<BeatAnalysis | null> {
  let pcm: Int16Array;
  try {
    pcm = await decodePcm(filePath);
  } catch (err) {
    console.warn(`[beats] decode failed for ${filePath}:`, (err as Error).message.split("\n")[0]);
    return null;
  }

  if (pcm.length < SAMPLE_RATE * 5) return null; // less than five seconds of audio
  return trackBeats(onsetEnvelope(pcm));
}

/** ffmpeg → raw mono PCM. Binary, so this can't go through the string runner. */
function decodePcm(filePath: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-hide_banner", "-nostdin", "-v", "error",
        "-t", String(ANALYSIS_SECONDS),
        "-i", filePath,
        "-vn",
        "-ac", "1",
        "-ar", String(SAMPLE_RATE),
        "-f", "s16le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}\n${stderr}`));
      const buf = Buffer.concat(chunks);
      // Buffer.concat may land on an odd byte boundary if ffmpeg was cut off.
      const samples = buf.length >> 1;
      const out = new Int16Array(samples);
      for (let i = 0; i < samples; i++) out[i] = buf.readInt16LE(i * 2);
      resolve(out);
    });
  });
}

/**
 * How much each 12ms window swells over the one before it, in log terms and
 * half-wave rectified: the classic spectral-flux idea with the spectrum left
 * out, which is all a broadband percussive hit needs to show up.
 *
 * Pure — an exported seam for the checks.
 */
export function onsetEnvelope(pcm: Int16Array | Float64Array): Float64Array {
  const frames = Math.max(0, Math.floor((pcm.length - WINDOW) / HOP) + 1);
  if (frames <= 0) return new Float64Array(0);

  const logEnergy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    let sum = 0;
    for (let i = start; i < start + WINDOW; i++) {
      const s = pcm[i] / 32768;
      sum += s * s;
    }
    logEnergy[f] = Math.log(sum / WINDOW + 1e-9);
  }

  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, logEnergy[f] - logEnergy[f - 1]);

  // Subtract a half-second moving average: what matters is a hit standing out
  // from its neighbourhood, not from the track's overall level.
  const half = Math.round(0.25 / HOP_SECONDS);
  const onset = new Float64Array(frames);
  let running = 0;
  for (let f = 0; f < frames; f++) {
    running += flux[f];
    if (f > 2 * half) running -= flux[f - 2 * half - 1];
    const window = Math.min(f, 2 * half) + 1;
    onset[f] = Math.max(0, flux[f] - running / window);
  }

  return onset;
}

/**
 * Tempo and phase from an onset envelope. Pure, and exported so the checks can
 * hand it a pulse train of known tempo and hold it to the answer.
 */
export function trackBeats(onset: Float64Array): BeatAnalysis | null {
  const frames = onset.length;
  const minLag = Math.floor(60 / MAX_BPM / HOP_SECONDS);
  const maxLag = Math.ceil(60 / MIN_BPM / HOP_SECONDS);
  if (frames < maxLag * 4) return null;

  let energy = 0;
  for (let f = 0; f < frames; f++) energy += onset[f] * onset[f];
  if (energy <= 0) return null;

  const centreLag = 60 / PRIOR_CENTRE_BPM / HOP_SECONDS;
  let bestLag = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    for (let f = lag; f < frames; f++) acf += onset[f] * onset[f - lag];
    // Longer lags overlap less of the envelope; normalise so they compete fairly.
    const normalized = acf / (frames - lag);
    const octaves = Math.log2(lag / centreLag);
    const score = normalized * Math.exp(-0.5 * (octaves / PRIOR_WIDTH_OCTAVES) ** 2);
    scoreSum += score;
    scoreCount++;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === 0) return null;

  const mean = scoreSum / scoreCount;
  // How far the winner stands above the average lag — 0 for noise, high for a
  // metronome. Squashed into 0..1 so it reads as a confidence.
  const confidence = mean > 0 ? Math.min(1, Math.max(0, (bestScore / mean - 1) / 3)) : 0;
  if (confidence < MIN_CONFIDENCE) return null;

  // Interpolate the autocorrelation peak, so the tempo isn't quantised to the
  // 12ms hop — over a two-minute track that error would drift a whole beat.
  const period = refinePeak(onset, bestLag, frames);

  const phase = bestPhase(onset, period, frames);
  const bpm = 60 / (period * HOP_SECONDS);
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return null;

  const beatTimes: number[] = [];
  for (let k = 0; k < MAX_BEAT_TIMES; k++) {
    const frame = phase + k * period;
    if (frame >= frames) break;
    beatTimes.push(round(refineBeat(onset, frame, frames) * HOP_SECONDS));
  }
  if (beatTimes.length < 4) return null;

  return {
    bpm: Math.round(bpm * 100) / 100,
    beatOffsetSeconds: beatTimes[0],
    beatTimes,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

/** Parabolic interpolation through the autocorrelation peak at `lag`. */
function refinePeak(onset: Float64Array, lag: number, frames: number): number {
  const at = (l: number) => {
    if (l < 1 || l >= frames) return 0;
    let acf = 0;
    for (let f = l; f < frames; f++) acf += onset[f] * onset[f - l];
    return acf / (frames - l);
  };
  const y0 = at(lag - 1);
  const y1 = at(lag);
  const y2 = at(lag + 1);
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0) return lag;
  const shift = (0.5 * (y0 - y2)) / denom;
  return Math.abs(shift) < 1 ? lag + shift : lag;
}

/** Which offset within one period the pulse train should sit at. */
function bestPhase(onset: Float64Array, period: number, frames: number): number {
  const steps = Math.max(1, Math.round(period));
  let best = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phi = (s * period) / steps;
    let score = 0;
    for (let frame = phi; frame < frames; frame += period) score += onset[Math.round(frame)];
    if (score > bestScore) {
      bestScore = score;
      best = phi;
    }
  }
  return best;
}

/** Nudge a predicted beat onto the loudest onset within a couple of frames. */
function refineBeat(onset: Float64Array, frame: number, frames: number): number {
  const centre = Math.round(frame);
  let best = centre;
  let bestValue = -Infinity;
  for (let f = centre - REFINE_FRAMES; f <= centre + REFINE_FRAMES; f++) {
    if (f < 0 || f >= frames) continue;
    if (onset[f] > bestValue) {
      bestValue = onset[f];
      best = f;
    }
  }
  return bestValue <= 0 ? frame : best;
}
