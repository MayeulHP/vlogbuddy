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
  type CutEntry, type TimelineDoc,
} from "@vlogbuddy/shared";

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

const input = { cut, threshold: 0, settings: { enabled: true, pace: "standard" as const, sceneText: true } };

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

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
