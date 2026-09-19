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
  DEFAULT_FIT_POLICY,
  applyTimelineOp, detectScenes, emptyTimeline, reconcileClips, runDirector,
  timelineDuration, clipDuration, sceneLabel, TRANSITION_LABELS,
  beatGridInFilmTime, clipStartTimes, nearestBeat,
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

/** No GPS block, which is the common case and must never break a scene. */
const UNLOCATED = { latitude: null, longitude: null };

// A weekend: 4 shots over breakfast, 3 in the afternoon, 3 the next morning.
const offsets = [0, 2, 5, 9, 5*60, 5*60+3, 5*60+11, 26*60, 26*60+4, 26*60+30];
const cut: CutEntry[] = offsets.map((m, i) => ({
  mediaItemId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  kind: i % 4 === 3 ? "photo" : "video",
  durationSeconds: i % 4 === 3 ? null : [8, 47, 3.1, 120, 22][i % 5],
  capturedAt: T0 + m * 60_000,
  ...UNLOCATED,
  rank: [0, 0, 1.2, 2.4, 0.9, 3.8, 0, 1.6, 0, 2.1][i],
}));

const input = {
  cut,
  threshold: 0,
  settings: { enabled: true, pace: "standard" as const, sceneText: true, beatSnap: false,
             fitPolicy: DEFAULT_FIT_POLICY },
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

// --- scenes, as a stored thing ----------------------------------------------
// Detection is positional and re-run after every vote; the document's scenes
// are the durable thing. What has to hold is that a name somebody typed
// outlives the cut moving underneath it — and that nothing here churns a
// revision, since the whole pass runs on every single reaction.

console.log("\n   scenes");

ok(first.scenes.length === 4, "the pass stores one scene per break", `${first.scenes.length}`);
ok(first.scenes.every((s, i) => s.name === (sceneLabel(scenes[i], i) ?? "")),
   "each is named from when it was shot", first.scenes.map((s) => s.name).join(" / "));
ok(first.scenes.every((s) => s.auto.includes("name")), "and the names are still the auto-cut's");
ok(first.clips.every((c) => first.scenes.some((s) => s.id === c.sceneId)),
   "every shot points at a scene that exists");
const sceneStarts = first.scenes.map((s) => first.clips.findIndex((c) => c.sceneId === s.id));
ok(sceneStarts.join() === "0,4,7,9", "the scenes open where the breaks are", sceneStarts.join(","));
ok(first.scenes.every((s) => s.id !== first.scenes[0].id || s === first.scenes[0]),
   "the ids are distinct");

// A rename, and the promise that outlives everything else here.
const RENAMED = "Breakfast, eventually";
const renamed = applyTimelineOp(first, {
  type: "scene.rename", sceneId: first.scenes[1].id, name: RENAMED,
});
ok(renamed.scenes[1].name === RENAMED, "renaming a scene takes");
ok(renamed.scenes[1].auto.length === 0, "...and takes the name off the auto-cut");
ok(renamed.scenes[0].name === first.scenes[0].name, "...and leaves the other scenes alone");

const afterRename = runDirector(renamed, input);
ok(afterRename.scenes[1].name === RENAMED, "the director doesn't put the date back");
ok(runDirector(afterRename, input) === afterRename, "...and settles in one pass");
ok(afterRename.clips[4].titles[0]?.text === RENAMED,
   "the name burnt over the scene follows the rename",
   afterRename.clips[4].titles[0]?.text ?? "no title");
const renameTrip = JSON.parse(JSON.stringify(afterRename)) as TimelineDoc;
ok(runDirector(renameTrip, input) === renameTrip, "...and survives a jsonb round-trip settled");

// A shot leaving the cut from inside a renamed scene. The rest of its footage
// is still there, so it is still the same scene.
const shorter = cut.filter((_, i) => i !== 4);
const shorterDoc = runDirector(reconcileClips(afterRename, shorter), { ...input, cut: shorter });
ok(shorterDoc.scenes.find((s) => s.id === first.scenes[1].id)?.name === RENAMED,
   "a rename survives a shot dropping out of the scene");

// ...and the running order being rearranged. Nothing here compares positions.
const shuffled: CutEntry[] = [cut[9], ...cut.slice(0, 9)];
const movedDoc = runDirector(reconcileClips(afterRename, shuffled), { ...input, cut: shuffled });
ok(movedDoc.scenes.find((s) => s.id === first.scenes[1].id)?.name === RENAMED,
   "and survives the cut being reordered around it");

// "Start again" is the only thing that takes a name back.
const rearmed = runDirector(applyTimelineOp(afterRename, { type: "director.recut" }), input);
ok(rearmed.scenes[1].name === first.scenes[1].name, "a re-cut puts the date back",
   rearmed.scenes[1].name);
ok(rearmed.scenes[1].auto.includes("name"), "...and hands the name back to the auto-cut");
ok(rearmed.scenes[1].id === first.scenes[1].id, "...without it becoming a different scene");

// A document from before any of this: no flags, no scenes, and no opinions
// about either. Deriving scenes for it would be the auto-cut letting itself
// back into a film that told it to stay out.
const preScenes: TimelineDoc = {
  ...first,
  clips: first.clips.map((c) => ({ ...c, auto: [], sceneId: null })),
  scenes: [],
};
ok(runDirector(preScenes, input) === preScenes, "a hand-cut film is given no scenes at all");

// A scene splitting: the name stays with the footage it was mostly about.
const trio: CutEntry[] = [0, 40, 45].map((m, i) => ({
  mediaItemId: `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
  kind: "photo" as const,
  durationSeconds: null,
  capturedAt: T0 + m * 60_000,
  ...UNLOCATED,
  rank: 1,
}));
const together: CutEntry[] = trio.map((e, i) => ({ ...e, capturedAt: T0 + i * 5 * 60_000 }));
const oneScene = runDirector(reconcileClips(emptyTimeline(), together), { ...input, cut: together });
ok(oneScene.scenes.length === 1, "three shots in one sitting are one scene");
const namedTrio = applyTimelineOp(oneScene, {
  type: "scene.rename", sceneId: oneScene.scenes[0].id, name: "The hut",
});
const split = runDirector(reconcileClips(namedTrio, trio), { ...input, cut: trio });
ok(split.scenes.length === 2, "a gap opening up inside it splits it in two", `${split.scenes.length}`);
ok(split.scenes[1].name === "The hut", "the half with most of the footage keeps the name",
   split.scenes.map((s) => s.name || "—").join(" / "));
ok(split.scenes[0].id !== split.scenes[1].id, "the other half is a different scene");
ok(split.scenes[0].auto.includes("name"), "...and is the auto-cut's to name");
ok(runDirector(split, { ...input, cut: trio }) === split, "and the split settles in one pass");

// --- scenes by place --------------------------------------------------------
// The other half of a scene break. Distance is measured against an anchor —
// the first located shot of the scene in progress — and both the breaking and
// the *not* breaking below would come out wrong if it were measured against
// the previous shot instead.

console.log("\n   places");

/** Somewhere to be. Only the offsets matter; the origin is arbitrary. */
const ORIGIN = { latitude: 48.8584, longitude: 2.2945 };
/** A fix `metres` due north of the origin. A degree of latitude is 111.2km. */
const north = (metres: number) => ({
  latitude: ORIGIN.latitude + metres / 111_195,
  longitude: ORIGIN.longitude,
});

type Fix = { latitude: number; longitude: number } | null;
/** A cut a minute apart, so nothing here can break on time. */
const placed = (fixes: Fix[], tag = "b"): CutEntry[] =>
  fixes.map((fix, i) => ({
    mediaItemId: `00000000-0000-4000-${tag}000-${String(i).padStart(12, "0")}`,
    kind: "photo" as const,
    durationSeconds: null,
    capturedAt: T0 + i * 60_000,
    latitude: fix?.latitude ?? null,
    longitude: fix?.longitude ?? null,
    rank: 1,
  }));

const breaksOf = (fixes: Fix[], tag = "b") =>
  detectScenes(placed(fixes, tag)).map((s) => s.startIndex);

// The crew gets in the car.
const relocated = breaksOf([north(0), north(40), north(90), north(3000), north(3060)]);
ok(relocated.join() === "0,3", "moving three kilometres starts a new scene", relocated.join(","));

// ...and the move reads as a dissolve, not the end of a day.
const movedCut = placed([north(0), north(40), north(90), north(3000), north(3060)]);
const movedDoc2 = runDirector(reconcileClips(emptyTimeline(), movedCut), { ...input, cut: movedCut });
ok(movedDoc2.scenes.length === 2, "the document gets both scenes", `${movedDoc2.scenes.length}`);
ok(movedDoc2.clips[3].transitionIn === "crossfade",
   "a change of place dissolves rather than dipping to black", movedDoc2.clips[3].transitionIn);
ok(runDirector(movedDoc2, { ...input, cut: movedCut }) === movedDoc2,
   "and a place-driven split settles in one pass");

// Wandering about one place. Four hundred metres apart at the extremes, which
// is a big park, and nothing about that is a second scene.
ok(breaksOf([north(0), north(150), north(380), north(60), north(410)]).join() === "0",
   "moving about inside one place stays one scene");

// GPS drift, which is tens of metres on a phone that hasn't moved at all.
ok(breaksOf([north(0), north(35), north(-20), north(48), north(-12)]).join() === "0",
   "a stationary phone's jitter never breaks a scene");

// The common case: no GPS block at all.
ok(breaksOf([null, null, null, null]).join() === "0", "a pile with no fixes at all is one scene");
ok(breaksOf([north(0), null, north(80), null, north(160)]).join() === "0",
   "shots with no fix don't break the scene they sit in");
// The anchor is carried across them rather than reset, so the shot that *does*
// know where it is is still compared with where the scene started.
ok(breaksOf([north(0), null, null, north(4000)]).join() === "0,3",
   "...and the anchor survives them to catch the shot that did move");
// A camera that never got a lock writes the middle of the Atlantic.
ok(breaksOf([north(0), { latitude: 0, longitude: 0 }, north(90)]).join() === "0",
   "a null-island fix is read as no fix");

// The case that decides the whole design: a long walk, eighty metres at a
// time. Compared shot to shot no step is ever close to the threshold, so a
// neighbour rule would never break at all; compared against a *moving* anchor
// it would break on every step past the first one. Against the scene's own
// anchor it breaks once per five hundred metres covered.
const walk = Array.from({ length: 24 }, (_, i) => north(i * 80));
const walkBreaks = breaksOf(walk, "c");
ok(walkBreaks.join() === "0,7,14,21", "a walk across a wide area breaks once per 500m",
   walkBreaks.join(","));
ok(walkBreaks.length <= 5, "...rather than fragmenting into a scene per shot",
   `${walkBreaks.length} scenes for ${walk.length} shots`);

// A rename outliving a place-driven split, the same way it outlives a gap.
const oneStop = placed([north(0), north(60), north(140), north(200), north(90)], "d");
const stopDoc = runDirector(reconcileClips(emptyTimeline(), oneStop), { ...input, cut: oneStop });
ok(stopDoc.scenes.length === 1, "five shots around one spot are one scene");
const namedStop = applyTimelineOp(stopDoc, {
  type: "scene.rename", sceneId: stopDoc.scenes[0].id, name: "The lake",
});
// The last two turn out to have been taken five kilometres up the road.
const twoStops = oneStop.map((e, i) => (i >= 3 ? { ...e, ...north(5000) } : e));
const stopSplit = runDirector(reconcileClips(namedStop, twoStops), { ...input, cut: twoStops });
ok(stopSplit.scenes.length === 2, "a place break splits it in two", `${stopSplit.scenes.length}`);
ok(stopSplit.scenes[0].name === "The lake", "the half with most of the footage keeps the name",
   stopSplit.scenes.map((s) => s.name || "—").join(" / "));
ok(stopSplit.scenes[1].auto.includes("name"), "the new half is the auto-cut's to name");
ok(runDirector(stopSplit, { ...input, cut: twoStops }) === stopSplit,
   "and that split settles in one pass too");
const stopTrip = JSON.parse(JSON.stringify(stopSplit)) as TimelineDoc;
ok(runDirector(stopTrip, { ...input, cut: twoStops }) === stopTrip,
   "...and survives a jsonb round-trip settled");

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

// (g) the identity contract, with a grid in play
const snappedAgain = runDirector(snapped, beatInput);
ok(snappedAgain === snapped, "running twice with beats returns the IDENTICAL object");
/** Same film, ignoring the timestamp and the object identity. */
const sameCut = (a: TimelineDoc, b: TimelineDoc) =>
  JSON.stringify([a.clips, a.scenes]) === JSON.stringify([b.clips, b.scenes]);
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

// --- the move on stills -----------------------------------------------------
// The auto-cut gives every photograph a slow push or pull, and that move is
// what pays for the extra screen time — so the two have to be checked
// together. A still told to hold still has to give the time back.

const photoCut: CutEntry[] = Array.from({ length: 8 }, (_, i) => ({
  mediaItemId: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
  kind: "photo" as const,
  durationSeconds: null,
  capturedAt: T0 + i * 60_000,
  ...UNLOCATED,
  rank: 4, // hero, against a threshold of 0
}));
const photoInput = {
  cut: photoCut,
  threshold: 0,
  settings: { enabled: true, pace: "relaxed" as const, sceneText: false, beatSnap: false,
             fitPolicy: DEFAULT_FIT_POLICY },
};
const stills = runDirector(reconcileClips(emptyTimeline(), photoCut), photoInput);

console.log("\n   stills");
ok(stills.clips.every((c) => c.motion !== "none"), "every still is given a move");
ok(
  new Set(stills.clips.map((c) => c.motion)).size > 1,
  "a run of stills doesn't all move the same way",
  stills.clips.map((c) => c.motion).join(" "),
);
ok(first.clips.every((c) => c.kind === "video" ? c.motion === "none" : true),
   "footage is left alone — the move is for photographs");
const longest = Math.max(...stills.clips.map((c) => c.duration));
ok(longest > 4, "a moving still can hold past the four-second cap", `${longest.toFixed(2)}s`);
ok(runDirector(stills, photoInput) === stills, "and the pass is still idempotent");

// Reordering restages nothing: the move comes from the item's own id.
const reversed = [...photoCut].reverse();
const reversedDoc = runDirector(
  reconcileClips(emptyTimeline(), reversed),
  { ...photoInput, cut: reversed },
);
const motionById = new Map(stills.clips.map((c) => [c.mediaItemId, c.motion]));
ok(
  reversedDoc.clips.every((c) => motionById.get(c.mediaItemId) === c.motion),
  "reordering the cut doesn't restage the photographs",
);

// Hand-picking "hold still" is a person overruling the director, and the
// shorter budget follows from it without anyone asking.
const held = applyTimelineOp(stills, {
  type: "clip.update",
  clipId: stills.clips[0].id,
  patch: { motion: "none" },
});
ok(held.clips[0].auto.includes("motion") === false, "choosing a move by hand drops the motion flag");
ok(held.clips[0].auto.includes("timing") === true, "...and leaves the timing to the auto-cut");
const backToStill = runDirector(held, photoInput);
ok(backToStill.clips[0].motion === "none", "the director doesn't put the move back");
ok(backToStill.clips[0].duration <= 4, "a still told to hold still goes back to the still budget",
   `${backToStill.clips[0].duration.toFixed(2)}s`);
ok(runDirector(backToStill, photoInput) === backToStill, "...and settles there");

// A document written before the move existed has no motion flag, so it stays
// exactly as it was — same contract as every other auto field.
const preMotion: TimelineDoc = {
  ...stills,
  clips: stills.clips.map((c) => ({ ...c, motion: "none" as const, auto: c.auto.filter((f) => f !== "motion") })),
};
ok(runDirector(preMotion, photoInput).clips.every((c) => c.motion === "none"),
   "a document from before the move is left still");

// --- speed ------------------------------------------------------------------
// Speed divides the time on screen, and the budget is paid in screen seconds.

console.log("\n   speed");
const SP = 1; // a video shot with 47s of source behind it
const plainLen = clipDuration(first.clips[SP], durations[first.clips[SP].mediaItemId]);
const fast = applyTimelineOp(first, {
  type: "clip.update",
  clipId: first.clips[SP].id,
  patch: { speed: 2 },
});
ok(fast.clips[SP].auto.includes("timing") === false,
   "retiming a shot takes the timing decision off the auto-cut");
const fastLen = clipDuration(fast.clips[SP], durations[fast.clips[SP].mediaItemId]);
ok(Math.abs(fastLen - plainLen / 2) < 0.002, "double speed halves the time on screen",
   `${plainLen.toFixed(2)}s → ${fastLen.toFixed(2)}s`);
ok(runDirector(fast, input) === fast, "and the director writes nothing in response");

// After a re-cut the director owns the timing again — but the shot is still
// running at 2×, so it has to take twice as much footage to fill the same
// slot. Budgeting in source seconds here would halve the shot.
const recut = runDirector(applyTimelineOp(fast, { type: "director.recut" }), input);
const recutLen = clipDuration(recut.clips[SP], durations[recut.clips[SP].mediaItemId]);
ok(Math.abs(recutLen - plainLen) < 0.05,
   "a re-cut budgets a retimed shot in screen seconds, not source seconds",
   `${recutLen.toFixed(2)}s vs ${plainLen.toFixed(2)}s`);
ok(recut.clips[SP].speed === 2, "...and the re-cut leaves the speed itself alone");

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
