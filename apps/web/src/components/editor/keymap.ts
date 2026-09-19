/**
 * The bench's keys, as data.
 *
 * One list, read by the handler that runs them and by the sheet that prints
 * them — a help screen kept in a second place is a help screen that lies
 * within a month.
 *
 * The grammar, which is the thing worth learning once: **arrows move time,
 * brackets move the selected thing, up and down move the selection.** Shift is
 * the multiplier everywhere it means anything, never a different verb.
 */
export type KeyAction =
  | "play"
  | "stepBack"
  | "stepForward"
  | "toStart"
  | "toEnd"
  | "selectPrev"
  | "selectNext"
  | "markIn"
  | "markOut"
  | "split"
  | "moveEarlier"
  | "moveLater"
  | "toggleMute"
  | "remove"
  | "escape"
  | "help"
  | "panel1"
  | "panel2"
  | "panel3"
  | "panel4";

export type KeySection = "Transport" | "Selection" | "Editing" | "Panels";

export interface KeyEntry {
  id: KeyAction;
  /** How the key is printed on the sheet. */
  keys: string;
  what: string;
  section: KeySection;
  match: (event: KeyboardEvent) => boolean;
}

const is = (key: string) => (event: KeyboardEvent) => event.key === key;

export const KEYMAP: KeyEntry[] = [
  { id: "play", keys: "Space", what: "Play or pause", section: "Transport", match: (e) => e.key === " " },
  {
    id: "stepBack",
    keys: "← / ⇧←",
    what: "Back one frame, or a second with Shift",
    section: "Transport",
    match: is("ArrowLeft"),
  },
  {
    id: "stepForward",
    keys: "→ / ⇧→",
    what: "On one frame, or a second with Shift",
    section: "Transport",
    match: is("ArrowRight"),
  },
  { id: "toStart", keys: "Home", what: "To the top of the film", section: "Transport", match: is("Home") },
  { id: "toEnd", keys: "End", what: "To the end", section: "Transport", match: is("End") },

  { id: "selectPrev", keys: "↑", what: "The shot before this one", section: "Selection", match: is("ArrowUp") },
  { id: "selectNext", keys: "↓", what: "The shot after it", section: "Selection", match: is("ArrowDown") },
  {
    id: "escape",
    keys: "Esc",
    what: "Close what's open, then let the selection go",
    section: "Selection",
    match: is("Escape"),
  },

  {
    id: "markIn",
    keys: "I",
    what: "Start this shot at the playhead",
    section: "Editing",
    match: (e) => e.key.toLowerCase() === "i",
  },
  {
    id: "markOut",
    keys: "O",
    what: "End this shot at the playhead",
    section: "Editing",
    match: (e) => e.key.toLowerCase() === "o",
  },
  {
    id: "split",
    keys: "S",
    what: "Cut this shot in two where the playhead is",
    section: "Editing",
    match: (e) => e.key.toLowerCase() === "s",
  },
  {
    id: "moveEarlier",
    keys: "[ / ⇧[",
    what: "Move it earlier, or to the front with Shift",
    section: "Editing",
    match: is("["),
  },
  {
    id: "moveLater",
    keys: "] / ⇧]",
    what: "Move it later, or to the end with Shift",
    section: "Editing",
    match: is("]"),
  },
  {
    id: "toggleMute",
    keys: "M",
    what: "Silence it, or let it speak again",
    section: "Editing",
    match: (e) => e.key.toLowerCase() === "m",
  },
  {
    id: "remove",
    keys: "Delete",
    what: "Lift the shot out of the cut, or peel a layer off",
    section: "Editing",
    match: (e) => e.key === "Delete" || e.key === "Backspace",
  },

  { id: "panel1", keys: "1", what: "Back to what you picked", section: "Panels", match: is("1") },
  { id: "panel2", keys: "2", what: "Lay something over the picture", section: "Panels", match: is("2") },
  { id: "panel3", keys: "3", what: "Put something underneath it", section: "Panels", match: is("3") },
  { id: "panel4", keys: "4", what: "The film's settings", section: "Panels", match: is("4") },
  { id: "help", keys: "?", what: "This list", section: "Panels", match: (e) => e.key === "?" },
];

export const KEY_SECTIONS: KeySection[] = ["Transport", "Selection", "Editing", "Panels"];

/**
 * Whether a key press belongs to whatever the person is typing into.
 *
 * Range inputs count: the bench is full of sliders, and an arrow key inside
 * one is how you nudge a level, not how you scrub the film.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(
    el.closest("input, textarea, select, [contenteditable='true'], [role='slider']"),
  );
}

/** The one press this handles; anything with a system modifier is the OS's. */
export function findKeyEntry(event: KeyboardEvent): KeyEntry | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  return KEYMAP.find((entry) => entry.match(event)) ?? null;
}
