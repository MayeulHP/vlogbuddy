/**
 * The key that does the same thing as the button, printed on the button.
 *
 * The shortcut card is the index; this is how anyone finds a key without
 * going to look for it. Quiet enough to ignore — it is a hint, not a label —
 * and hidden from screen readers, where the button's own title already says it.
 *
 * Below `md` there is no keyboard to press it with, so the hint is simply not
 * there — a phone shouldn't spend its scarce width naming keys it hasn't got.
 */
export const KBD_HINT =
  "ml-2 hidden border md:inline-block border-[color:var(--hair-dark)] px-1 font-mono text-[10px] leading-[1.6] text-ink-400";
