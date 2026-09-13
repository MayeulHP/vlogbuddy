/**
 * What the inspector is pointed at. The bench now edits three different kinds
 * of thing, and they live in three different arrays, so "the selected clip id"
 * stopped being enough.
 */
export type Selection =
  | { kind: "none" }
  | { kind: "clip"; id: string }
  | { kind: "layer"; id: string }
  | { kind: "audio"; id: string };

export const NO_SELECTION: Selection = { kind: "none" };
