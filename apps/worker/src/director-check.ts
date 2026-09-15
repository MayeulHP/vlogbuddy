/**
 * Checks for the auto-cut. Pure functions only — no ffmpeg, no database, so
 * this runs anywhere in a second:
 *   pnpm --filter @vlogbuddy/worker exec tsx src/director-check.ts
 *
 * Most of what's here guards `syncCut`'s identity contract rather than the
 * film-making. The director runs after every single vote, and `syncCut` only
 * skips its write when the document comes back referentially identical — so a
 * stray allocation or an unrounded float in `director.ts` would silently churn
 * a timeline revision on every reaction and yank the document out from under
 * whoever is editing. That failure is invisible in the UI, which is why it's
 * worth a check.
 */
import {
  applyTimelineOp, detectScenes, emptyTimeline, reconcileClips, runDirector,
  timelineDuration, clipDuration, sceneLabel, TRANSITION_LABELS,
  beatGridInFilmTime, clipStartTimes, nearestBeat, beatsBetween, BEAT_HIT_WINDOW,
  type BeatGrid, type CutEntry, type TimelineDoc,
} from "@vlogbuddy/shared";
import { HOP_SECONDS, onsetEnvelope, trackBeats } from "./beats";

let failed = 0;
const ok = (pass: boolean, label: string, extra = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${extra ? "  — " + extra : ""}`);
  if (!pass) failed++;
};

const T0 = Date.UTC(2026, 5, 13, 9, 30); // Saturday 13 June 2026, 09:30 UTC
const H = 3600_000;

// A weekend: 4 shots over breakfast, 3 in the afternoon, 3 the next morning.
const offsets = [0, 2, 5, 9, 5*60, 5*60+3, 5*60+11, 26*60, 26*60+4, 26*60+30];
const cut: CutEntry[] = offsets.map((m, i) => ({
  mediaItemId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  kind: i % 4 === 3 ? "photo" : "video",
  durationSeconds: i % 4 === 3 ? null : [8, 47, 3.1, 120, 22][i % 5],
  capturedAt: T0 + m * 60_000,
  rank: [0, 0, 1.2, 2.4, 0.9, 3.8, 0, 1.6, 0, 2.1][i],
}));

const input = {
  cut,
  threshold: 0,
  settings: {
    enabled: true,
    pace: "standard" as const,
    sceneText: true,
    beatSnap: false,
    // The director neither reads nor writes this; it is here because the
    // settings object is the whole schema.
    fitPolicy: "blur" as const,
  },
};

// --- scenes -----------------------------------------------------------------
const scenes = detectScenes(cut);
ok(scenes.length === 4, "four scenes detected", `got ${scenes.length}`);
ok(scenes.map((x) => x.startIndex).join() === "0,4,7,9",
   "scene boundaries at the right shots", scenes.map(s => s.startIndex).join(","));
ok(scenes[2].newDay === true, "the third scene knows it's a new day");
console.log("   labels:", scenes.map((s, i) => sceneLabel(s, i)).join(" / "));

// --- the pass ---------------------------------------------------------------
let doc = reconcileClips(emptyTimeline(), cut);
const first = runDirector(doc, input);
ok(first !== doc, "the director changed the reconciled doc");

// (a) idempotent
const second = runDirector(first, input);
ok(second === first, "running twice returns the IDENTICAL object");

// (b) a vote that doesn't cross a tier band changes nothing
const nudged = { ...input, cut: cut.map((e, i) => i === 2 ? { ...e, rank: e.rank + 0.05 } : e) };
ok(runDirector(first, nudged) === first, "a vote inside a tier bumps no revision");

// (c) a vote that DOES cross a band re-times exactly one clip
const promoted = { ...input, cut: cut.map((e, i) => i === 0 ? { ...e, rank: 3.0 } : e) };
const after = runDirector(first, promoted);
const moved = after.clips.filter((c, i) => c !== first.clips[i]);
ok(after !== first && moved.length === 1, "crossing a band re-times exactly one clip", `${moved.length} moved`);

// (d) hand edits are untouchable
const edited = applyTimelineOp(first, { type: "clip.update", clipId: first.clips[1].id, patch: { trimEnd: 40 } });
ok(edited.clips[1].auto.includes("timing") === false, "a hand trim drops the timing flag");
ok(edited.clips[1].auto.includes("transition") === true, "...but keeps the transition flag");
const reRun = runDirector(edited, input);
ok(reRun.clips[1].trimEnd === 40, "the director leaves the hand-trimmed out-point alone");
ok(reRun.clips[1].trimStart === edited.clips[1].trimStart, "and its in-point too");

// (e) legacy docs (auto: []) are never touched
const legacy: TimelineDoc = { ...first, clips: first.clips.map(c => ({ ...c, auto: [] })) };
ok(runDirector(legacy, input) === legacy, "a pre-auto-cut document is left entirely alone");

// --- what it actually produced ---------------------------------------------
const durations = Object.fromEntries(cut.map(e => [e.mediaItemId, e.durationSeconds]));
const raw = cut.reduce((a, e) => a + (e.kind === "photo" ? 3 : (e.durationSeconds ?? 5)), 0);
const cutLen = timelineDuration(first, durations);
console.log(`\n   before: ${raw.toFixed(1)}s concatenated   →   after: ${cutLen.toFixed(1)}s cut\n`);
first.clips.forEach((c, i) => {
  const d = clipDuration(c, durations[c.mediaItemId]);
  const src = cut[i].durationSeconds;
  console.log(
    `   ${String(i + 1).padStart(2)}  ${c.kind.padEnd(5)} ` +
    `${d.toFixed(2).padStart(5)}s of ${(src ? src.toFixed(1) + "s" : "still").padStart(6)}  ` +
    `${TRANSITION_LABELS[c.transitionIn].padEnd(12)} ` +
    `${c.muted ? "muted " : "      "}${c.titles[0]?.text ?? ""}`,
  );
});

// hold floor must stay clear of the renderer's transition clamp
const floor = Math.min(...first.clips.map((c, i) => clipDuration(c, durations[c.mediaItemId])));
ok(floor >= 0.7, "shortest hold stays above the renderer's transition clamp", `${floor.toFixed(2)}s`);

// --- splitting a shot -------------------------------------------------------
// A split puts two clips on the base track for one media item. The cut is still
// a list of media, so reconciliation has to keep both halves — key one clip per
// item and the second half vanishes on the next vote, which is a lost edit
// nobody would think to report.
{
  const target = first.clips[1];
  const before = clipDuration(target, durations[target.mediaItemId]);
  const at = 1.0;
  const split = applyTimelineOp(first, {
    type: "clip.split", clipId: target.id, at, newClipId: "split-half-2",
  });
  ok(split.clips.length === first.clips.length + 1, "splitting adds a clip");
  const [head, tail] = [split.clips[1], split.clips[2]];
  ok(head.mediaItemId === tail.mediaItemId && tail.id === "split-half-2",
     "both halves point at the same shot, under the caller's id");
  // Source times land on the 2dp grid the trim handles use, so the cut point is
  // near enough the asked-for moment and *exactly* shared by the two halves.
  ok(Math.abs(head.trimEnd! - (target.trimStart + at)) < 0.01 && tail.trimStart === head.trimEnd,
     "the halves meet exactly at the cut", `${head.trimEnd} / ${tail.trimStart}`);
  ok(Math.abs(clipDuration(head, durations[head.mediaItemId])
      + clipDuration(tail, durations[tail.mediaItemId]) - before) < 0.02,
     "and together still play for as long as the shot did");
  ok(!head.auto.includes("timing") && !tail.auto.includes("timing"),
     "a split is a hand edit, so neither half is the auto-cut's to re-time");
  ok(tail.transitionIn === "cut", "the second half comes in on a cut");

  // The whole point: a vote after a split must not swallow the second half.
  const reconciled = reconcileClips(split, cut);
  ok(reconciled.clips.length === split.clips.length &&
     reconciled.clips.every((c, i) => c === split.clips[i]),
     "reconciling after a split returns the IDENTICAL clips",
     `${reconciled.clips.length} clips`);
  ok(reconciled === split, "...and the identical document, so no revision churns");
  const afterVote = runDirector(reconciled, input);
  ok(afterVote.clips.length === split.clips.length, "and the director leaves both halves standing");
  ok(afterVote.clips[1].trimEnd === head.trimEnd && afterVote.clips[2].trimStart === tail.trimStart,
     "with the cut point exactly where it was put");
  ok(runDirector(afterVote, input) === afterVote, "the identity contract survives a split");

  // Edges: a split that would leave a flash frame is simply not made.
  for (const bad of [0.05, before - 0.05, before + 3]) {
    ok(applyTimelineOp(first, { type: "clip.split", clipId: target.id, at: bad, newClipId: "x" }) === first,
       `a split ${bad.toFixed(2)}s in is refused rather than trimmed to nothing`);
  }
}


// --- the beat ---------------------------------------------------------------
// Two halves: the estimator can find a tempo in a signal, and the director
// snaps to a grid without breaking either of its promises.

console.log("\n   beat detection");

/** A click track: a short burst every `period` seconds, deterministic. */
function clickTrack(bpm: number, phase: number, seconds: number): Int16Array {
  const rate = 22050;
  const pcm = new Int16Array(rate * seconds);
  let seed = 12345;
  const noise = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x7fffffff - 1;
  };
  // A quiet floor, so the envelope isn't measuring silence between hits.
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(noise() * 300);

  const period = 60 / bpm;
  for (let t = phase; t < seconds; t += period) {
    const start = Math.round(t * rate);
    for (let i = 0; i < 900 && start + i < pcm.length; i++) {
      const decay = Math.exp(-i / 220);
      pcm[start + i] = Math.round(noise() * 22000 * decay);
    }
  }
  return pcm;
}

const measured = trackBeats(onsetEnvelope(clickTrack(100, 0.25, 30)));
ok(measured !== null, "a 100 BPM click track yields a grid");
if (measured) {
  ok(Math.abs(measured.bpm - 100) < 2, "...at the right tempo", `${measured.bpm} BPM`);
  ok(Math.abs(measured.beatOffsetSeconds - 0.25) < 0.05, "...and the right phase",
     `${measured.beatOffsetSeconds}s`);
  ok(measured.confidence > 0.2, "...with confidence to spare", measured.confidence.toFixed(2));
  const spacing = measured.beatTimes.slice(1).map((t, i) => t - measured.beatTimes[i]);
  const worst = Math.max(...spacing.map((s) => Math.abs(s - 0.6)));
  ok(worst < HOP_SECONDS * 3, "...and evenly spaced beats", `worst ${worst.toFixed(3)}s`);
}
ok(trackBeats(new Float64Array(4000)) === null, "silence yields no tempo at all");

// A bed 12s into the film, played from 4s into the track: the track's 4s beat
// is the film's 12s.
const grid = beatGridInFilmTime(
  { bpm: 120, beatOffsetSeconds: 0, beatTimes: [0, 0.5, 1, 4] },
  { startAt: 12, offset: 4 },
);
ok(grid?.firstBeat === 8, "a bed's placement moves its grid onto the film's clock",
   `${grid?.firstBeat}`);

// 120 BPM from the first frame, no measured beats — the periodic grid alone.
const onTheBeat: BeatGrid = { bpm: 120, firstBeat: 0 };
const beatInput = { ...input, settings: { ...input.settings, beatSnap: true }, beats: onTheBeat };

const snapped = runDirector(doc, beatInput);
const plain = runDirector(doc, input);

// (f) every boundary either lands on a beat or was too far to reach one
const starts = clipStartTimes(snapped, durations);
let onBeat = 0;
let overBudget = 0;
snapped.clips.forEach((c, i) => {
  const end = starts[c.id] + clipDuration(c, durations[c.mediaItemId]);
  if (Math.abs(end - nearestBeat(end, onTheBeat)) < 0.002) onBeat++;
  const was = clipDuration(plain.clips[i], durations[c.mediaItemId]);
  const now = clipDuration(c, durations[c.mediaItemId]);
  if (Math.abs(now - was) > was * 0.25 + 0.002) overBudget++;
});
ok(onBeat >= snapped.clips.length - 2, "cuts land on the beat",
   `${onBeat}/${snapped.clips.length}`);
ok(overBudget === 0, "and no shot was stretched past its budget to get there");
ok(snapped !== plain, "beat-snapping actually retimed the cut");

/*
 * The bench draws the grid the cut was snapped against, and highlights the
 * beats a cut hit. `beatsBetween` fills in the periodic grid either side of
 * the measured stretch exactly as `nearestBeat` falls back to it — if the two
 * ever drift, the ruler starts lighting beats the cut never touched.
 */
const withMeasured: BeatGrid = { bpm: 120, firstBeat: 0, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3] };
for (const g of [onTheBeat, withMeasured]) {
  const drawn = beatsBetween(g, 0, 30);
  const strays = drawn.filter((b) => Math.abs(nearestBeat(b, g) - b) > BEAT_HIT_WINDOW);
  ok(strays.length === 0, "every beat the ruler draws is a beat the cut would snap to",
     `${drawn.length} beats`);
}

// (g) the identity contract, with a grid in play
const snappedAgain = runDirector(snapped, beatInput);
ok(snappedAgain === snapped, "running twice with beats returns the IDENTICAL object");
/** Same film, ignoring the timestamp and the object identity. */
const sameCut = (a: TimelineDoc, b: TimelineDoc) =>
  JSON.stringify(a.clips) === JSON.stringify(b.clips);
ok(sameCut(runDirector(doc, beatInput), snapped), "a second run from scratch produces the same film");
// Every generated number must survive the trip through jsonb unchanged, or the
// comparison above would flip on the *next* sync instead of this one.
const roundTripped = JSON.parse(JSON.stringify(snapped)) as TimelineDoc;
ok(runDirector(roundTripped, beatInput) === roundTripped, "and survives a jsonb round-trip");

// (h) a hand-trimmed shot is still untouchable, and still anchors what follows
const handEdited = applyTimelineOp(snapped, {
  type: "clip.update", clipId: snapped.clips[2].id, patch: { trimEnd: 9.75 },
});
const afterHand = runDirector(handEdited, beatInput);
ok(afterHand.clips[2].trimEnd === 9.75, "beat-snapping leaves a hand-trimmed shot alone");
ok(afterHand.clips[2].auto.includes("timing") === false, "...because its timing flag is gone");
const handStarts = clipStartTimes(afterHand, durations);
const nextClip = afterHand.clips[3];
const nextEnd = handStarts[nextClip.id] + clipDuration(nextClip, durations[nextClip.mediaItemId]);
// Either the next cut still lands on a beat from its new anchor, or no beat was
// close enough and it kept the length the marks bought it.
const unsnappedNext = clipDuration(
  runDirector(handEdited, input).clips[3], durations[nextClip.mediaItemId],
);
ok(Math.abs(nextEnd - nearestBeat(nextEnd, onTheBeat)) < 0.002 ||
   clipDuration(nextClip, durations[nextClip.mediaItemId]) === unsnappedNext,
   "and snaps what follows against where that really leaves the film",
   `ends at ${nextEnd.toFixed(3)}s`);

const legacyBeat: TimelineDoc = { ...snapped, clips: snapped.clips.map((c) => ({ ...c, auto: [] })) };
ok(runDirector(legacyBeat, beatInput) === legacyBeat, "a fully hand-cut film ignores the beat entirely");

// (i) the switch, and a grid we don't believe, both mean today's behaviour
ok(sameCut(runDirector(doc, { ...input, beats: onTheBeat }), plain),
   "beats with the switch off change nothing");
ok(sameCut(runDirector(doc, { ...beatInput, beats: { bpm: 9, firstBeat: 0 } }), plain),
   "an impossible tempo is ignored");
ok(sameCut(runDirector(doc, { ...beatInput, beats: null }), plain), "no bed, no change");
ok(runDirector(plain, { ...beatInput, beats: null }) === plain,
   "...and a beatless re-run of a beatless cut writes nothing");

console.log(
  "\n   with beats: " +
    snapped.clips
      .map((c) => clipDuration(c, durations[c.mediaItemId]).toFixed(2))
      .join("  ") +
    "\n   without:    " +
    plain.clips.map((c) => clipDuration(c, durations[c.mediaItemId]).toFixed(2)).join("  "),
);

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
