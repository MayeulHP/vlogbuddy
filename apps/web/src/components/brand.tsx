import { cn } from "@/lib/cn";

/**
 * The shared marks of the ROLLCALL identity: the wordmark, the section head,
 * the perforated strip and the empty-frame filler. Everything visual that
 * repeats lives here so the whole app speaks with one accent.
 */

/** ROLLCALL, with the reel counting as the O's. */
export function Wordmark({
  size = "md",
  className,
  tone = "ink",
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
  tone?: "ink" | "paper";
}) {
  const scale = {
    sm: "text-lg",
    md: "text-2xl",
    lg: "text-5xl sm:text-6xl",
  }[size];

  return (
    <span
      className={cn(
        "wordmark inline-flex items-baseline gap-[0.12em] uppercase leading-none",
        tone === "ink" ? "text-ink-900" : "text-paper-50",
        scale,
        className,
      )}
    >
      <span>Roll</span>
      <span className="relative inline-flex items-baseline text-signal-600">
        Call
        <span
          aria-hidden
          className="absolute -right-[0.42em] top-[0.06em] h-[0.22em] w-[0.22em] rounded-full bg-signal-600"
        />
      </span>
    </span>
  );
}

/**
 * Standard block head: mono eyebrow, serif title, an optional right-hand slot
 * for readings, and the rule that separates head from content.
 */
export function SectionHead({
  eyebrow,
  title,
  note,
  right,
  tone = "paper",
  size = "lg",
  className,
}: {
  eyebrow: string;
  title: string;
  note?: React.ReactNode;
  right?: React.ReactNode;
  tone?: "paper" | "ink";
  /**
   * Only the first block on a page earns a Bodoni head. Below it, `sm` keeps
   * the mono eyebrow and drops the title to the same 13px as the note — four
   * 32px heads down one page read as four chapters of vocabulary to learn
   * before you can vote.
   */
  size?: "lg" | "sm";
  className?: string;
}) {
  const dark = tone === "ink";
  const small = size === "sm";
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b pb-2",
        dark ? "border-[color:var(--hair-dark)]" : "border-[color:var(--hair-strong)]",
        className,
      )}
    >
      <div className="min-w-0">
        <p className={cn("flex items-center gap-2", dark ? "eyebrow-light" : "eyebrow")}>
          <span className="h-1 w-1 bg-signal-500" aria-hidden />
          {eyebrow}
        </p>
        {small ? (
          <p className="mt-1 max-w-2xl text-[13px] leading-snug">
            <span className={dark ? "text-paper-100" : "text-ink-900"}>{title}</span>
            {note && (
              <>
                {" "}
                <span className={dark ? "text-ink-400" : "text-ink-600"}>{note}</span>
              </>
            )}
          </p>
        ) : (
          <>
            <h2
              className={cn(
                "headline mt-1 text-[1.7rem] sm:text-[2rem]",
                dark ? "text-paper-100" : "text-ink-900",
              )}
            >
              {title}
            </h2>
            {note && (
              <p
                className={cn(
                  "mt-1 max-w-2xl text-[13px] leading-snug",
                  dark ? "text-ink-400" : "text-ink-600",
                )}
              >
                {note}
              </p>
            )}
          </>
        )}
      </div>
      {/*
        On a phone the right-hand readings sit under the title on their own
        line rather than being squeezed beside it — there is no beside.
      */}
      {right && <div className="w-full shrink-0 sm:w-auto">{right}</div>}
    </div>
  );
}

/** A perforated film edge. Decorative, and the reason strips read as film. */
export function Perfs({
  tone = "dark",
  className,
}: {
  tone?: "dark" | "light";
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "perf h-[7px] w-full",
        tone === "dark" ? "text-ink-900/25" : "text-paper-100/30",
        className,
      )}
    />
  );
}

/**
 * Empty frames — the app before anyone has dropped anything in. Slugged with
 * timecodes so an empty state still looks like footage waiting to happen.
 */
export function EmptyFrames({
  count = 6,
  className,
  tone = "paper",
}: {
  count?: number;
  className?: string;
  tone?: "paper" | "ink";
}) {
  const dark = tone === "ink";
  return (
    <div className={cn("flex gap-px", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cn(
            "relative flex-1 bg-hatch",
            dark ? "bg-ink-850" : "bg-paper-300",
          )}
          style={{ aspectRatio: "4 / 3" }}
        >
          <span
            className={cn(
              "absolute bottom-1 left-1 font-mono text-2xs tabular-nums",
              dark ? "text-ink-400" : "text-ink-600",
            )}
          >
            {String(i + 1).padStart(2, "0")}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Mono key/value line, as on a camera slate. */
export function SlateRow({
  k,
  v,
  tone = "paper",
}: {
  k: string;
  v: React.ReactNode;
  tone?: "paper" | "ink";
}) {
  const dark = tone === "ink";
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 border-b py-1.5 last:border-b-0",
        dark ? "border-[color:var(--hair-dark)]" : "border-[color:var(--hair)]",
      )}
    >
      <span className={cn(dark ? "eyebrow-light" : "eyebrow")}>{k}</span>
      <span
        className={cn(
          "timecode text-xs",
          dark ? "text-paper-200" : "text-ink-900",
        )}
      >
        {v}
      </span>
    </div>
  );
}
