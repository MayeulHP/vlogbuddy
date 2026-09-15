"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDayLong, PASS_SCORE, type ReactionTier, type Verdict } from "@vlogbuddy/shared";
import type { MediaItemView } from "@/lib/queries";
import { reactAction } from "@/lib/actions/reactions";
import { useDialog } from "@/hooks/use-dialog";
import { previewSrc } from "@/lib/preview-src";
import { RotatedMedia } from "@/lib/rotated-media";
import { RotateButton } from "@/components/rotate-button";
import { cn } from "@/lib/cn";

/**
 * Screening the dailies: one frame at a time, full screen, marked with a flick
 * of the thumb.
 *
 * Marking up on the light table means aiming at a 100px frame among fifty. Here
 * the only things on screen are the shot and the decision, so a hundred frames
 * go by in a couple of minutes. Four directions, four outcomes, and an undo —
 * nobody should ever feel they've lost a shot to a clumsy swipe.
 *
 *        ↑  hero
 *   ←  pass      right  strong
 *        ↓  keep
 */

const SWIPE_THRESHOLD = 90;
const EXIT_MS = 240;

/** Where a frame went, and what that means. `null` only ever comes from undo. */
type Swipe = { score: Verdict | null; direction: "up" | "down" | "left" | "right" };

export function ReviewDeck({
  slug,
  items,
  tiers,
  crew,
  onClose,
}: {
  slug: string;
  items: MediaItemView[];
  tiers: ReactionTier[];
  crew?: number;
  onClose: () => void;
}) {
  /**
   * Frozen at open. Live vote updates re-render the page underneath us, and a
   * deck that reshuffles mid-review would be maddening.
   */
  const [queue] = useState(() => items);
  const [index, setIndex] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [exiting, setExiting] = useState<Swipe | null>(null);
  const [history, setHistory] = useState<{ id: string; previous: number | null }[]>([]);
  const [muted, setMuted] = useState(true);

  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * The queue is frozen, but a shot turned upright in the deck has to look
   * upright in the deck — so which way round a file is comes from the live
   * data rather than from the snapshot the review started with.
   */
  const rotations = useMemo(
    () => new Map(items.map((i) => [i.id, i.rotation])),
    [items],
  );

  const current = queue[index] ?? null;
  const upNext = queue[index + 1] ?? null;
  const done = index >= queue.length;

  const byScore = useMemo(() => {
    const map = new Map<number, ReactionTier>();
    for (const tier of tiers) map.set(tier.score, tier);
    return map;
  }, [tiers]);

  const commit = useCallback(
    (verdict: Swipe) => {
      const item = queue[index];
      if (!item || exiting) return;

      setExiting(verdict);
      setHistory((h) => [...h, { id: item.id, previous: item.reactions.mine }]);

      if (verdict.score !== item.reactions.mine) {
        void reactAction(slug, {
          targetType: "media",
          targetId: item.id,
          score: verdict.score,
        });
      }

      exitTimer.current = setTimeout(() => {
        setExiting(null);
        setDrag({ x: 0, y: 0, active: false });
        setIndex((i) => i + 1);
      }, EXIT_MS);
    },
    [queue, index, exiting, slug],
  );

  const undo = useCallback(() => {
    if (index === 0 || exiting) return;
    const last = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setIndex((i) => i - 1);
    setDrag({ x: 0, y: 0, active: false });
    if (last) {
      void reactAction(slug, {
        targetType: "media",
        targetId: last.id,
        score: last.previous as Verdict | null,
      });
    }
  }, [index, exiting, history, slug]);

  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

  // Escape, the trap and the scroll lock come from the hook. It focuses the
  // container rather than a button on purpose: the verdicts are Space and the
  // arrows, and a focused button would eat every one of them.
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      switch (e.key) {
        case "ArrowLeft":
        case " ":
          e.preventDefault();
          commit({ score: PASS_SCORE, direction: "left" });
          break;
        case "ArrowDown":
        case "1":
          e.preventDefault();
          commit({ score: 1, direction: "down" });
          break;
        case "ArrowRight":
        case "2":
          e.preventDefault();
          commit({ score: 2, direction: "right" });
          break;
        case "ArrowUp":
        case "3":
          e.preventDefault();
          commit({ score: 3, direction: "up" });
          break;
        case "Backspace":
        case "z":
          e.preventDefault();
          undo();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, undo]);

  /** Which way the current drag is leaning, if it's leaning far enough to count. */
  const leaning = useMemo<Swipe | null>(() => {
    if (!drag.active) return null;
    const { x, y } = drag;
    if (Math.abs(y) > Math.abs(x)) {
      if (y < -SWIPE_THRESHOLD) return { score: 3, direction: "up" };
      if (y > SWIPE_THRESHOLD) return { score: 1, direction: "down" };
      return null;
    }
    if (x > SWIPE_THRESHOLD) return { score: 2, direction: "right" };
    if (x < -SWIPE_THRESHOLD) return { score: PASS_SCORE, direction: "left" };
    return null;
  }, [drag]);

  const shown = exiting ?? leaning;

  const transform = (() => {
    if (exiting) {
      const dist = 900;
      const dx = exiting.direction === "left" ? -dist : exiting.direction === "right" ? dist : 0;
      const dy = exiting.direction === "up" ? -dist : exiting.direction === "down" ? dist : 0;
      return `translate(${dx}px, ${dy}px) rotate(${dx / 40}deg)`;
    }
    return `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x / 22}deg)`;
  })();

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Screening the dailies"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex animate-fade-in flex-col bg-ink-950 focus:outline-none"
    >
      <header className="pt-safe px-safe shrink-0 border-b border-[color:var(--hair-dark)]">
        <div className="flex items-center gap-2 px-4 py-2.5 sm:items-end sm:gap-4 sm:py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="eyebrow-light flex items-center gap-2">
              <span className="h-1 w-1 bg-signal-500" aria-hidden />
              Beat 03 · Vote
            </p>
            {/* The full title is a luxury a 375px header can't afford. */}
            <p className="headline mt-0.5 truncate text-lg text-paper-100 sm:mt-1 sm:text-2xl">
              <span className="sm:hidden">The dailies</span>
              <span className="hidden sm:inline">Screening the dailies</span>
            </p>
          </div>

          <p className="timecode shrink-0 text-xs text-ink-300 sm:text-sm">
            {done ? "END" : `${String(index + 1).padStart(2, "0")} / ${String(queue.length).padStart(2, "0")}`}
          </p>

          <button
            onClick={undo}
            disabled={index === 0}
            className="btn-quiet-dark shrink-0 px-2"
            title="Undo the last mark (Z)"
            aria-label="Undo the last mark"
          >
            ↩<span className="ml-1 hidden sm:inline">Undo</span>
          </button>
          <button onClick={onClose} className="btn-outline-dark shrink-0" aria-label="Leave the screening">
            Done
          </button>
        </div>
      </header>

      {/* Progress as exposed film: perforations fill up as you work through. */}
      <div className="relative h-2 shrink-0 bg-ink-900">
        <div
          className="perf h-full bg-signal-600 text-ink-950/70 transition-[width] duration-300"
          style={{ width: `${queue.length ? (index / queue.length) * 100 : 0}%` }}
        />
      </div>

      {done ? (
        <AllCaughtUp count={queue.length} onClose={onClose} onUndo={undo} />
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 py-3 sm:px-4 sm:py-5">
            {/* The next frame, peeking through — a deck should feel like a deck. */}
            {upNext && (
              <Card
                slug={slug}
                item={upNext}
                tiers={tiers}
                rotation={rotations.get(upNext.id) ?? upNext.rotation}
                muted
                crew={crew}
                className="absolute opacity-30"
                style={{ transform: "translateY(16px) scale(0.955) rotate(-1.2deg)" }}
              />
            )}

            {current && (
              <Card
                key={current.id}
                slug={slug}
                item={current}
                tiers={tiers}
                rotation={rotations.get(current.id) ?? current.rotation}
                muted={muted}
                active
                crew={crew}
                className={cn(
                  "absolute touch-none select-none",
                  drag.active ? "cursor-grabbing" : "cursor-grab",
                  !drag.active && "transition-transform duration-200 ease-out",
                  exiting && "transition-transform duration-[240ms] ease-in",
                )}
                style={{ transform }}
                overlay={shown ? <VerdictStamp verdict={shown} tiers={byScore} /> : null}
                onToggleSound={() => setMuted((m) => !m)}
                onPointerDown={(e) => {
                  if (exiting) return;
                  startRef.current = { x: e.clientX, y: e.clientY };
                  // Capture, so a swipe that runs off the frame keeps reporting.
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  setDrag({ x: 0, y: 0, active: true });
                }}
                onPointerMove={(e) => {
                  if (!startRef.current || exiting) return;
                  setDrag({
                    x: e.clientX - startRef.current.x,
                    y: e.clientY - startRef.current.y,
                    active: true,
                  });
                }}
                onPointerUp={() => {
                  if (!startRef.current) return;
                  startRef.current = null;
                  if (leaning) commit(leaning);
                  else setDrag({ x: 0, y: 0, active: false });
                }}
                onPointerCancel={() => {
                  // A system gesture took the pointer — put the frame back.
                  startRef.current = null;
                  setDrag({ x: 0, y: 0, active: false });
                }}
              />
            )}
          </div>

          <footer className="pb-safe px-safe shrink-0">
            <div className="px-4 pb-3 pt-1 sm:px-6 sm:pb-7">
            <div className="mx-auto grid max-w-lg grid-cols-4 gap-px border border-[color:var(--hair-dark)]">
              <VerdictKey
                label="Pass"
                hint="←"
                marks="—"
                active={current?.reactions.mine === PASS_SCORE}
                onClick={() => commit({ score: PASS_SCORE, direction: "left" })}
              />
              {tiers.map((tier) => (
                <VerdictKey
                  key={tier.score}
                  label={tier.label}
                  marks={tier.emoji}
                  hint={tier.score === 3 ? "↑" : tier.score === 2 ? "→" : "↓"}
                  active={current?.reactions.mine === tier.score}
                  signal
                  onClick={() =>
                    commit({
                      score: tier.score,
                      direction: tier.score === 3 ? "up" : tier.score === 2 ? "right" : "down",
                    })
                  }
                />
              ))}
            </div>
            <p className="mt-2 text-center font-mono text-2xs uppercase tracking-label text-ink-400">
              <span className="sm:hidden">Swipe the frame, or tap a verdict</span>
              <span className="hidden sm:inline">Swipe the frame, or use the arrow keys</span>
            </p>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

function Card({
  slug,
  item,
  tiers,
  rotation,
  muted,
  active,
  crew,
  className,
  style,
  overlay,
  onToggleSound,
  ...handlers
}: {
  slug: string;
  item: MediaItemView;
  tiers: ReactionTier[];
  /** Live, not from the frozen queue. */
  rotation: number;
  muted: boolean;
  /** The card being judged. The one peeking behind it shouldn't play. */
  active?: boolean;
  crew?: number;
  className?: string;
  style?: React.CSSProperties;
  overlay?: React.ReactNode;
  onToggleSound?: () => void;
} & React.HTMLAttributes<HTMLDivElement>) {
  const src = previewSrc(item);
  const mineIsMark = item.reactions.mine !== null && item.reactions.mine >= 1;
  const others = item.reactions.supporters - (mineIsMark ? 1 : 0);

  return (
    <div
      {...handlers}
      style={style}
      className={cn(
        "flex h-full max-h-[74dvh] w-full max-w-3xl flex-col border border-ink-700 bg-ink-900 p-1.5 shadow-deck sm:p-2",
        className,
      )}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-ink-950">
        {src ? (
          <RotatedMedia rotation={rotation}>
            {item.kind === "video" ? (
              <DeckVideo
                src={src}
                poster={item.thumbnailUrl}
                muted={muted}
                active={active}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={item.originalFilename}
                draggable={false}
                className="print-tone h-full w-full object-contain"
              />
            )}
          </RotatedMedia>
        ) : (
          <p className="font-mono text-2xs uppercase tracking-label text-ink-400">Developing…</p>
        )}

        {overlay}
      </div>

      {/* Slate under the frame: who shot it, when, and how the crew stands. */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-3 gap-y-1 pt-2">
        <div className="min-w-0">
          <p className="font-mono text-2xs uppercase tracking-label text-ink-400">
            {item.uploaderName ?? "Unknown"} · {captureLabel(item.capturedAt)}
          </p>
          <p className="timecode mt-0.5 truncate text-xs text-paper-200">
            {item.originalFilename}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {others > 0 && <CrewBreakdown item={item} tiers={tiers} crew={crew} />}
          {/* Sideways footage is noticed here, full screen, and nowhere else.
              Asking anybody to remember it until they reach the bench is how it
              never gets fixed. */}
          {active && (
            <RotateButton slug={slug} mediaItemId={item.id} className="btn-outline-dark px-2 py-1" />
          )}
          {item.kind === "video" && onToggleSound && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSound?.();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="btn-outline-dark px-2 py-1"
            >
              {muted ? "Sound off" : "Sound on"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The frame, playing.
 *
 * `<video autoPlay muted>` written as JSX does not reliably autoplay: React
 * assigns `muted` as a DOM property during commit, while the browser's
 * autoplay gate reads the *attribute* as the element begins loading. Chrome
 * therefore saw an unmuted video asking to play by itself and refused — and
 * since the element carried no controls, a refusal left a poster frame and no
 * way at all to watch the shot. The attribute is now hardcoded so the gate is
 * satisfied at load, and the live mute state rides the property, which
 * overrides it.
 *
 * The cover catches every other reason a browser might still say no. A deck
 * you can't play videos in is a deck that can only judge photographs.
 */
function DeckVideo({
  src,
  poster,
  muted,
  active,
}: {
  src: string;
  poster: string | null;
  muted: boolean;
  active?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = muted;

    // The card behind is a glimpse of the next shot, not a second thing
    // playing at you.
    if (!active) {
      video.pause();
      return;
    }
    void video.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
  }, [src, muted, active]);

  return (
    <>
      <video
        ref={ref}
        src={src}
        poster={poster ?? undefined}
        loop
        muted
        playsInline
        className="h-full w-full object-contain"
      />
      {blocked && active && (
        <button
          // The frame under this is a swipe target; a tap to play must not
          // read as the start of a verdict.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void ref.current?.play().then(() => setBlocked(false), () => {});
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/45"
          aria-label="Play this shot"
        >
          <span aria-hidden className="flex h-14 w-14 items-center justify-center border border-paper-100/70 font-mono text-xl text-paper-100">
            ▶
          </span>
          <span className="font-mono text-2xs uppercase tracking-label text-paper-200">
            Tap to play
          </span>
        </button>
      )}
    </>
  );
}

/**
 * How the crew already stands, full size.
 *
 * The light table only has room for a tint in the corner of a cell; here there
 * is space to say which mark it was. Bars are read against the crew, not
 * against each other, so one Hero out of five looks like one out of five
 * rather than like a landslide.
 */
function CrewBreakdown({
  item,
  tiers,
  crew,
}: {
  item: MediaItemView;
  tiers: ReactionTier[];
  crew?: number;
}) {
  const crewSize = Math.max(crew ?? 0, item.reactions.count, 1);

  return (
    <div className="flex items-center gap-2">
      {tiers.map((tier) => {
        const count = item.reactions.breakdown[tier.score] ?? 0;
        const mine = item.reactions.mine === tier.score;
        return (
          <div
            key={tier.score}
            className="flex w-9 flex-col gap-1"
            title={`${tier.label} — ${count} of ${crewSize} of the crew`}
          >
            <div className="flex items-baseline justify-between font-mono text-2xs leading-none">
              <span className={count > 0 ? "text-paper-200" : "text-ink-500"}>{tier.emoji}</span>
              <span className={count > 0 ? "text-paper-200" : "text-ink-500"}>{count}</span>
            </div>
            <div className="h-[3px] w-full bg-ink-700">
              <div
                className={cn("h-full", mine ? "bg-signal-500" : "bg-paper-200/70")}
                style={{ width: `${(Math.min(1, count / crewSize) * 100).toFixed(1)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The rubber stamp that tells you what letting go would do. */
function VerdictStamp({
  verdict,
  tiers,
}: {
  verdict: Swipe;
  tiers: Map<number, ReactionTier>;
}) {
  const tier =
    verdict.score === null || verdict.score === PASS_SCORE
      ? null
      : (tiers.get(verdict.score) ?? null);
  const position = {
    up: "top-8 left-1/2 -translate-x-1/2",
    down: "bottom-8 left-1/2 -translate-x-1/2",
    right: "top-8 right-8",
    left: "top-8 left-8",
  }[verdict.direction];

  return (
    <div
      className={cn(
        "stamp pointer-events-none absolute z-10 animate-stamp",
        position,
        tier
          ? "border-signal-500 text-signal-400"
          : "border-paper-200/60 text-paper-200/80",
      )}
    >
      <span className="font-mono text-xs tracking-label">{tier?.emoji ?? "—"}</span>
      {tier?.label ?? "Pass"}
    </div>
  );
}

function VerdictKey({
  label,
  marks,
  hint,
  active,
  signal,
  onClick,
}: {
  label: string;
  marks: string;
  hint: string;
  active?: boolean;
  signal?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${label} (${hint})`}
      className={cn(
        "flex min-h-[56px] flex-col items-center justify-center gap-1 bg-ink-900 px-1 py-3 transition-colors active:translate-y-px",
        // A pass you've already given should read as settled, not as a fourth
        // mark — so it lights up in ink rather than in the cut line's red.
        active
          ? signal
            ? "bg-signal-600 text-paper-50"
            : "bg-ink-700 text-paper-100"
          : signal
            ? "text-paper-200 hover:bg-signal-700 hover:text-paper-50"
            : "text-ink-400 hover:bg-ink-800 hover:text-paper-200",
      )}
    >
      <span className="font-mono text-[11px] leading-none tracking-tight">{marks}</span>
      <span className="display-sm text-center text-[0.95rem] leading-none sm:text-lg">{label}</span>
      {/* The keyboard hint is noise on a device with no keyboard. */}
      <span className="hidden font-mono text-2xs opacity-60 sm:inline">{hint}</span>
    </button>
  );
}

function AllCaughtUp({
  count,
  onClose,
  onUndo,
}: {
  count: number;
  onClose: () => void;
  onUndo: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="eyebrow-light">End of reel</p>
      <h2 className="headline-xl max-w-lg text-[clamp(2rem,6vw,3.5rem)] text-paper-100">
        That&apos;s the lot.
      </h2>
      <p className="max-w-sm text-[13px] leading-relaxed text-ink-400">
        You went through {count} frame{count === 1 ? "" : "s"}. The cut rebuilt itself as you
        marked — go and see what the crew ended up with.
      </p>
      <div className="flex gap-2">
        <button onClick={onUndo} className="btn-outline-dark">
          ↩ Back one
        </button>
        <button onClick={onClose} className="btn-signal">
          See the shortlist
        </button>
      </div>
    </div>
  );
}

function captureLabel(value: Date | string | null) {
  return formatDayLong(value) ?? "No date";
}
