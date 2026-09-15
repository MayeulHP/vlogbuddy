# Film page — menu system audit

Read-only UX audit of the editor's navigation and menus, 2026-09-15.

**Method and caveats.** Inventory from code (`apps/web/src/components/editor/*.tsx`,
`workspace-nav.tsx`, `vlog-shell.tsx`, `hooks/use-editor-shortcuts.ts`). Live check
against `/v/f6phnjapwe` as a friend ("Claude (review)" cookie already present), so the
creator-only Print button was inferred from code. The `PORT=3300 pnpm dev` I started died
(`SESSION_SECRET is not set` — `pnpm dev` doesn't read `.env`); a pre-existing `tsx watch`
from an earlier session was already serving live source on :3300, so I used that and left
it running. Several dev servers share `apps/web/.next` and another agent was editing
`editor-view.tsx` mid-audit (Auto-cut + Format were merged into one "Film" tab while I
watched), so the server 404/500'd repeatedly and the in-app browser pane was hidden by
another session for most of the run. I got one full screenshot at 1440×900 and full DOM
measurements (rects, font sizes, scroll heights) at 1024×768 and 375×812; 1280×720 is
derived from the layout formulae in code. **Everything below is against the on-disk state
at the end of the run (five side tabs: Shot | Pile | Layers | Mix | Film).**

---

## (a) Inventory

Legend: **Reach** = M mouse, T touch, K keyboard. **Gate** = what state it depends on.

| # | Where | Control | Does | Reach | Gate | Size (measured) |
|---|---|---|---|---|---|---|
| 1 | Masthead (`vlog-shell.tsx:134-185`) | Wordmark · title · counts line ("20 clips · 1 track · 3 crew · In production") | Identity + slate line | — | Always, all rooms | Sticky, ~130px tall at desktop incl. rail |
| 2 | Masthead | PresenceBar, ShareBar ("Invite crew") | Who's here / copy link | M T | Always | — |
| 3 | Room rail (`workspace-nav.tsx:136-198`) | **Trip / Film / Watch** with badges ("20 to mark", "18", "···/✓") | Switch room; per-browser `localStorage` | M T K(tab) | Disabled except Watch while rendering/published; Watch hidden until a render exists | 20.8px display serif, 38px tall |
| 4 | Phone bottom bar (`workspace-nav.tsx:72-133`) | Same three rooms | Same | T | Same | 3 × 125×56px |
| 5 | Editor toolbar (`editor-view.tsx:549-615`, rendered *inside* the preview column by `PreviewPlayer`) | "← Back to the floor" | `setTab("gather")` — duplicates the rail | M T K | Always | 184×34 (44 tall on phone) |
| 6 | Editor toolbar | ↩ / ↪ Undo/Redo | Local history | M T, ⌘Z/⌘⇧Z/⌘Y | Disabled when stack empty | 37×34 |
| 7 | Editor toolbar | "?" shortcut legend popover | Shows 9-row key card | M T | — | 37×34; card 256×278 |
| 8 | Editor toolbar (right) | **Print the film** (`PrintFilmButton`) → confirm dialog | Starts render | M T K | **Creator only**; disabled when 0 clips; dialog has Cancel/Confirm | btn-signal |
| 9 | Preview transport (`preview-player.tsx:918-970`) | ▶/❙❙ | Play/pause | M T, Space | — | **25×27** |
| 10 | Transport | timecode `0:00 / 1:12` | Status | — | — | 10px mono |
| 11 | Transport | Playhead range slider | Scrub | M T K(arrows when focused) | — | 3px track |
| 12 | Transport | "+N layers" / "N layers" | Status only | — | Only if layers | 10px |
| 13 | Transport | "Shot 01/18" | Selects active clip → inspector | M | Hidden `<sm` | 74×14 (!) |
| 14 | Strip toolbar (`timeline-tracks.tsx:592-624`) | "Reel 02 · Strip" | Decorative label | — | — | eyebrow |
| 15 | Strip toolbar | "Drag shots to reorder · drag their edges to trim" | Hint | — | `lg+` only | — |
| 16 | Strip toolbar | − / + / Fit | Zoom about playhead | M T; ⌘-wheel, pinch | — | 34×34, 36×34 |
| 17 | Strip gutter | lane names: Picture / Layer n / Bed / Snd n (`Pic`, `L1` on phone) + "91 bpm" | Labels | — | — | 74px desk, 52px touch |
| 18 | Strip lanes | Clip blocks (drag to reorder, edge grips to trim, click to select, badges ✂ / silent / title / hand-trimmed) | Select + edit | M T; K via `[ ] S Delete ← →` after selection | Selection | 69px tall |
| 19 | Strip lanes | **Cut marker** ◆/glyph between shots (`:1034-1063`) | Opens transition popover | M (hover-reveal for hard cuts) T (50% opacity) | — | **16×16 desk, 24×24 touch** |
| 20 | Transition popover (`:1223-1300`) | Cut (full width) + 10 transitions in 2 cols + duration slider | Sets `transitionIn`/`transitionDuration` | M T K(Esc, focus trap) | — | 216×309; buttons 98×30–44 |
| 21 | Strip lanes | Layer bars (drag to move, grips to lengthen), audio bars (same) | Edit layers/cues | M T | — | 34/30px desk lanes |
| 22 | Side column tab strip (`editor-view.tsx:539-545, 701-726`) | **Shot\|Layer\|Track (contextual) · Pile n · Layers n · Mix n · Film** | Switch panel; any selection snaps back to inspector | M T (role=tab but **no arrow-key handling**) | Inspector tab omitted on phone | 60×34, **10px uppercase mono** |
| 23 | Inspector — Shot (`clip-inspector.tsx`) | Header: "Shot 02 of 18", duration, filename; ◀ Earlier / Later ▶ | Reorder by one | M T | total>1 | 91×34 / 75×34 |
| 24 | Inspector — Shot | Section **Timing** (open by default): trim bar with In/Out handles (32×34), "▶ Play this shot", "Keep going round", −5s / +5s / Use all, Split at the playhead | Trim/audition/split | M T K | Split needs playhead inside | small buttons **24px tall** |
| 25 | Inspector — Shot | Section **Transition**: current-value button → 11-way grid, duration | Same as #20, second entry point | M T | disabled on shot 1 | 38px rows |
| 26 | Inspector — Shot | Section **Look**: Fit (Auto/Bars/Fill/Blur), speed slider, Look (As shot/Warm/Cool/Faded/Mono) | Per-shot look | M T | — | |
| 27 | Inspector — Shot | Section **Sound**: mute, level slider | | M T | video only | |
| 28 | Inspector — Shot | Section **Text**: "+ title" → list of title editors (text, start, duration, position, size, colour) | Titles | M T | — | |
| 29 | Inspector — Shot | Footer: "Take this shot out" | `clip.remove` → cutOverride exclude | M T, Delete | — | full width |
| 30 | Inspector — Layer (`layer-inspector.tsx`) | Header; sections Timing (fields + "at playhead"), Frame (size, 9 corner presets), Fade & opacity, Sound; footer "Take this layer out" | | M T K | | |
| 31 | Inspector — Track (`audio-inspector.tsx`) | Header ("The bed" / "Sound"); sections Trim & audition, Level & fades, Options (held out, loops); footer "Play it dry" / "Take this track out" | | M T | Bed: "Swap it on the floor" | |
| 32 | Section header (`section.tsx`) | ▸/▾ + title + red dot + summary when collapsed | Fold; persisted per browser | M T K | | 38px tall, 10px title |
| 33 | Panel **Pile** (`pile-drawer.tsx`) | All/Photos/Video segmented filter (22px tall), search field, rows with "Add after shot N" / "At the end" | Adds via cut engine | M T | "Add after" disabled with no selection | rows 34px btns |
| 34 | Panel **Layers** (`stack-panels.tsx:25-167`) | "+ Add" toggle → inline picker list of ready footage; list of layers (L1 · filename · start) | `layer.add` at playhead | M T | — | "+ Add" 43×34 |
| 35 | Panel **Mix** (`:169-375`) | "+ Add" → picker (File/Link); track list (Bed/Cue); **"The bed" chooser (Dry / File / Link)**; "Duck the shots under the score" checkbox | Bed via `setMusicBedAction`, cues via ops | M T | Link tracks disabled until extracted | rows 44px; checkbox 14px |
| 36 | Panel **Film** (`director-panel.tsx` + `format-panel.tsx` stacked) | Pace (Snappy/Standard/Relaxed), "Shots of the wrong shape" (Bars/Fill/Blur), 3 checkboxes (scene names, cut on the beat, let the vote set lengths), **Re-cut from scratch** (inline confirm), then Format (Widescreen/Upright/Square) | Server actions + resync | M T | locked while rendering; Format **no longer creator-gated in the panel** (was `isCreator` before the mid-audit edit) | checkboxes **13×13**; panel scrolls (902px content in 547px) |
| 37 | Phone inspector sheet (`editor-view.tsx:818-852`) | Bottom sheet, "The shot / The layer / The track", **Done**; same inspector inside | Opens on pick, `useDialog` (Esc, focus trap, scroll lock) | T K | `<768px` | 72dvh max; sheet content 758px in 585px |
| 38 | Empty strip | "Nothing has made the cut" + "Back to the floor" | | | 0 clips | |
| 39 | Keyboard (`use-editor-shortcuts.ts`) | Space, ←/→ (+⇧), Home/End, [ ], S, Delete, J K L, ⌘Z/⌘⇧Z/⌘Y | | K | Suppressed inside inputs | — |

Measured layouts:

- **1440×900** (screenshot): header 129px; preview 405px cap (`min(45vh, 100dvh−470)`), strip ~170px lanes, aside 320px; no page scroll. Toolbar row sits centred *over the preview*, so "Back to the floor" starts at x≈155 and Print sits at x≈700, not at the page edges.
- **1280×720** (from `heightCap` formula): preview = `min(324, 250)` = 250px tall → 444px wide, i.e. a 444px picture in a 960px column; aside 320px. The strip gets ~120px for lanes; with one layer + bed the lanes need ~170px, so the strip scrolls vertically inside itself.
- **1024×768** (measured): aside 300×584, inspector content 697px in 584 (scrolls), tab strip exactly fills 300px with five 60px tabs at 10px type.
- **375×812** (measured): page scrolls to **1713px**; toolbar row (4 buttons) 44px; preview 341×192; strip 259px at y=404; the side "column" is stacked *below* the strip at y=679–1564 (Pile/Layers/Mix/Film tabs 86×34); bottom bar 56px. Gutter labels become `91 / L1 / Pic / Bed`. Cut markers 24px. Inspector sheet 585px tall with 758px of content.

---

## (b) Findings, by severity

### S1 — Two navigation systems say "go back" and one of them is a lie of scale
**Heuristic:** consistency & standards; minimalist design; Krug ("obvious click targets").
**Evidence:** the room rail (`workspace-nav.tsx`) already offers Trip; the editor toolbar
adds "← Back to the floor" (`editor-view.tsx:551`) as the *first, largest* control on the
page (184×34 at desktop, 189×44 on phone where it eats half the row). On the phone the
bottom bar also shows Trip. Meanwhile the one action that changes the world — Print — is
creator-only and sits at the far right of a row that is centred over the preview, so at
1440 it floats at x≈700. The most prominent control in the editor is the one that leaves
it.
**Fix:** delete "Back to the floor" from the toolbar (the empty-strip state can keep its
own). Make the toolbar span the whole main column, not the preview's `maxWidth`. Left:
Undo/Redo/?; right: film status ("1:12 · 18 shots", currently in the transport) and Print
for the creator. One primary action per screen: Print, and only for the person who can.

### S1 — The side tab strip is a 10px uppercase mono row with no keyboard model and a name that changes under you
**Heuristic:** Fitts/HIG (44pt), recognition over recall, consistency; WAI-ARIA tabs
pattern (arrow keys, `aria-controls`).
**Evidence:** tabs are 60×34 at `text-2xs` (10px) uppercase tracking-label
(`editor-view.tsx:709`), the smallest type on the page for the most-used navigation.
`role="tablist"` is declared but there is no `tabpanel`, no `aria-controls`, no arrow-key
handling (`:701-720`). The first tab is relabelled "Shot / Layer / Track / Inspector"
depending on selection (`inspectorLabel`, `:892-900`), so the same position reads as four
different things and the user can't build a spatial memory of it. Picking anything on the
strip force-switches to it (`choose`, `:322-327`), so someone browsing the Pile who taps a
shot to re-anchor "Add after shot N" is thrown out of the Pile — the one panel whose *whole
point* is to pick a shot and then add.
**Fix:** keep a stable label ("Selected", or the glyph of the kind), 12–13px, 40–44px
tall. Implement the ARIA tabs pattern. Stop auto-switching when the active panel is Pile;
instead let Pile show the selected shot as its anchor ("after shot 04 ▾"). Consider
splitting the column into two stacked regions — inspector (top, always) and a single
"drawer" tab row (Pile · Film) below — so selection never hides the drawer.

### S1 — Phone: the editor is a scroll, not a screen, and the panels are stranded under it
**Heuristic:** visibility of system status; Material 3 bottom-sheet/nav-bar guidance;
CapCut/iMovie "contextual tool strip under the preview".
**Evidence:** at 375×812 the page is 1713px tall. Order: 44px toolbar → 192px preview →
transport → 259px strip → *then* the Pile/Layers/Mix/Film tab strip at y=679 with its
panel content running to y=1564 → footer → 56px fixed bottom bar. A phone user who taps
"Layers" gets a panel that starts under the fold; "+ Add" then places a layer *at the
playhead*, which is off-screen above. The "?" keyboard-shortcuts button is shown at 42×44
on a device with no keyboard (`editor-view.tsx:577-586` has no `hidden md:flex`). The
inspector sheet's content (758px) exceeds its 585px cap so Timing's "Split" and the
Take-out footer are always under a scroll.
**Fix:** on `<md`, make the editor a fixed viewport too: preview ≤ 40dvh, strip fills the
rest, and *all* secondary panels (Pile, Layers, Mix, Film) become the same bottom sheet
the inspector already uses, launched from a 4-item tool row directly under the strip
(the CapCut pattern). Hide "?" below `md`. Put "Add" actions inside the sheet header so
the sheet can be dismissed straight after.

### S2 — Transition has three entry points; layers and sound have two; the bed has four
**Heuristic:** minimalist design; consistency; progressive disclosure (Cooper: one place
per decision, disclosed by context).
**Evidence:** transition = cut-line marker popover (`timeline-tracks.tsx:1034`) *and*
inspector section (`clip-inspector.tsx:398`) *and* the "Dissolve · 0.6s" summary. Bed =
Mix panel "The bed" chooser (`stack-panels.tsx:333-358`), Mix "+ Add" picker, the bed's
own inspector ("Play it dry"), and the Trip page's music lane ("Swap it on the floor",
`audio-inspector.tsx:190`). Layers = Layers panel list *and* the Layer lanes on the strip
(the TODO already called the lists duplicates and proposed "+ Layer / + Sound" buttons on
the strip toolbar — that half didn't land: the panels are still tabs).
**Fix:** transitions live on the cut line only; the inspector's Transition section becomes
a one-line summary that *focuses the marker* ("Dissolve · 0.6s — change on the strip").
Replace the Layers and Mix tabs with `+ Layer` / `+ Sound` buttons in the strip toolbar
that open a picker popover anchored to the button (same picker component as today);
the lanes are the list. Bed choice stays in one place — the Trip page's music lane,
which is where the vote happens — and the Mix leftovers (Duck) move to Film settings.

### S2 — The cut-line marker is 16px and invisible until hovered
**Heuristic:** Fitts; visibility; discoverability of a hidden affordance.
**Evidence:** `LANES.desk.marker = 16` (`timeline-tracks.tsx:60`); hard cuts render at
`opacity-0 hover:opacity-100` (`:1052`). Measured 16×16 at desktop. Nobody discovers a
transition picker that is a transparent 16px square between two thumbnails; the TODO
item "transition marker on the cut line, picker opens from it" shipped, but the only
way most people will find it is the inspector.
**Fix:** 24px marker on desktop too, always faintly visible (the touch rule, everywhere),
brighter on hover/selection of an adjacent clip. Also show it in the ruler gutter above
the lane so it's not competing with the trim grips.

### S2 — Sub-44 targets across the transport and the inspector
**Heuristic:** Apple HIG 44pt, Material 48dp.
**Evidence (measured):** Play 25×27 (`preview-player.tsx:919`); "Shot 01/18" 74×14;
"▶ Play this shot" 87×24; −5s / +5s / Use all 37×24 (`clip-inspector.tsx:325-345`);
Film-panel checkboxes 13×13; Pile filter segments 38×22; trim handles 32×34; Mix checkbox
14×14. The same buttons stay 24px on the phone sheet (measured at 375: "− 5s" 37×24).
`.btn` gets 44px on touch via the media query (`globals.css:516`) but these are hand-rolled
classes that don't.
**Fix:** route every inspector button through `.btn`/`.btn-outline-dark` so the touch rule
applies; make the transport Play 36px on desk, 44 on touch; wrap checkboxes in a 44px
label row (the label is already the hit area — make the row full-width and ≥40px).

### S2 — "Film" tab now hands the frame shape to every friend, while Print stays creator-only
**Heuristic:** user control & freedom; error prevention; the product's own premise.
**Evidence:** the mid-audit edit stacks `FormatPanel` under `DirectorPanel` in a tab
offered to everyone (`editor-view.tsx:783-803`) and the tab list no longer consults
`isCreator` (`:539-545`). `format-panel.tsx:35-36` still documents "Creator-only for the
same reason printing is: it re-proportions everybody's layers at once", and
`setVlogFormatAction` may or may not enforce it server-side (not checked — out of scope).
Either the copy or the gate is wrong.
**Fix:** decide once. My recommendation: Format is a *film setting* like pace, so
everyone may see it, but the choice buttons are disabled for friends with the note
"Only <creator> can change the shape — it moves everyone's layers". That keeps the panel
honest (it *shows* the current frame) without a lock with the door open.

### S3 — The "Film" tab holds two audiences' worth of settings and needs a scroll to find the second
**Heuristic:** progressive disclosure; information scent.
**Evidence:** Film panel content is 902px in a 547px pane at 1024×768; Format is the last
thing, under "Re-cut from scratch" (a destructive control with an inline confirm), so the
visual order says "reset the film, then pick its shape". Three checkboxes with 2-line
blurbs each, and the fit policy ("Shots of the wrong shape") is explained twice (panel
blurb and Format's `FIT_POLICY_NOTE`).
**Fix:** this is a settings *sheet*, not a tab: open it from a gear/"Film settings" button
in the toolbar (desktop popover-sheet; phone bottom sheet). Order: Shape → Pace → Wrong-
shape policy → toggles (with the blurbs as `title`/expander, not always-on text) → Re-cut
as a red footer. Remove the duplicated fit note.

### S3 — The masthead + rail cost 129px of a 720px screen in a room that has its own toolbar
**Heuristic:** minimalist design; Fitts (more distance to everything).
**Evidence:** header 129px at desktop; the slate line ("20 clips · 1 track · 3 crew · In
production") repeats counts that the Film badge and transport already show. At 1280×720
the preview is left with 250px → a 444px picture beside 320px of inspector.
**Fix:** on the Film room collapse the masthead to one 48px row: wordmark · title ·
Trip/Film/Watch as a compact segmented control · presence · share. Keep the big display
rail on Trip, where it's editorial.

### S3 — Undo/Redo are unlabeled glyphs; the "?" card is the only place Delete/Split are named
**Heuristic:** recognition over recall; Krug.
**Evidence:** `↩ ↪` with `aria-label` only (`editor-view.tsx:554-573`); `S` split and
Delete are discoverable only via the legend; Split's button in the inspector doesn't show
its key. NLE convention (Premiere/Resolve) is that every menu item shows its shortcut.
**Fix:** show the key on the control (`Split ⌘… S` style — a small mono kbd on the right of
the inspector button, `title` on toolbar buttons already does this); consider text
"Undo" on desktop widths.

### S3 — Tab-strip counts read as part of the word ("Pile2", "Mix1")
**Evidence:** `get_page_text` renders them as `Pile2` / `Mix1`; visually the number is
`opacity-60` at 10px, 6px after the label. Compare the rail's badge treatment ("18" in a
bordered chip).
**Fix:** use the same chip as the rail, or a superscript dot count.

### S3 — Pile "Add after shot N" is disabled with no selection and there's no "at the playhead"
**Evidence:** `pile-drawer.tsx:158-170`; TODO claims "Add a shot from the pile directly on
the strip, at the playhead" is done, but the panel offers "after shot N" or "at the end".
**Fix:** one primary "Add here" that inserts after whichever shot the playhead is over
(fall back to end), plus a small "▾" for "at the end".

---

## (c) Target information architecture

Principles for this product: the vote made the cut; the editor is for *tightening* it.
So follow consumer editors (iMovie/CapCut) for structure — preview on top, strip, a
short contextual tool row — and borrow only two things from NLEs: a persistent inspector
on wide screens and the JKL/[ ]/S keys. There is no source monitor (auditioning is
"Play this shot" in the program monitor — correct), no tool palette (one direct-
manipulation mode — correct), and no menu bar. Where things go:

| Layer | What belongs | Why |
|---|---|---|
| **Room bar** (top, compact on Film) | Trip · Film · Watch, title, presence, share | Hub navigation between rooms; per-browser |
| **Toolbar** (one row over the main column) | Undo · Redo · ? (desk only) · ⎯ · "1:12 · 18 shots" · Film settings ⚙ · **Print** (creator) | Global, stateless controls; one primary action |
| **Strip toolbar** | + Shot (Pile picker) · + Layer · + Sound · ⎯ · − + Fit | Verbs that *add to the strip* sit on the strip |
| **Contextual popovers** | Transition (cut line), Add-pickers (anchored to their + button), title colour/position | Decisions about one thing, made where the thing is |
| **Inspector** (right column desk / sheet phone) | Selected shot / layer / track only; sections Timing · Look · Sound · Text; Transition as a one-line link to the marker | Progressive disclosure per selection |
| **Film settings sheet** | Shape · Pace · Wrong-shape policy · Scene names · Cut on the beat · Vote sets lengths · Duck · Re-cut | Set once, rarely revisited; audience = whole crew, gated fields for friends |
| **Trip room** | Bed choice, votes, pins | The vote owns these — don't duplicate on Film |

Desktop (≥ md):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ROLLCALL │ Van Alpes        [Trip] [Film 18] [Watch]        ●●● · Invite │ 48px
├──────────────────────────────────────────────────┬───────────────────────┤
│ ↩ ↪ ?            1:12 · 18 shots     ⚙ Film settings   [PRINT THE FILM] │ toolbar spans column
│ ┌──────────────────────────────────────────────┐ │ SELECTED  Shot 02/18  │
│ │                                              │ │ 0:04 · IMG_0924.mov   │
│ │                  preview                     │ │ ◀ Earlier   Later ▶   │
│ │                                              │ │ ▾ Timing  ──────────  │
│ └──────────────────────────────────────────────┘ │   [trim bar]          │
│ ▶  0:00 / 1:12  ────────●──────────  Shot 02/18  │   ▶ Play  Split  S    │
│ + Shot  + Layer  + Sound              − + Fit    │ ▸ Look        Blur    │
│ 91bpm│ ruler ·····|·····|·····                   │ ▸ Sound               │
│ L1   │      ▭▭▭                                  │ ▸ Text        1 title │
│ Pic  │ [01][02]◆[03]⇄[04]…                       │ ▸ Transition  Dissolve│
│ Bed  │ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~      │  → change on the strip│
│      │                                           │ ───────────────────── │
│      │                                           │ [ Take this shot out ]│
├──────┴───────────────────────────────────────────┴───────────────────────┤
│ ● Synced                                                     ROLLCALL ·  │
└──────────────────────────────────────────────────────────────────────────┘
```

Phone (< md), fixed viewport, no page scroll:

```
┌───────────────────────────┐
│ Van Alpes        ●● Invite│ 44
│ ┌───────────────────────┐ │
│ │       preview         │ │ ≤40dvh
│ └───────────────────────┘ │
│ ▶ 0:00/1:12 ────●──────── │ 44
│ + Shot + Layer + Sound ⚙  │ 44  ← tool row (CapCut)
│ L1 │   ▭▭                 │
│ Pic│[01][02]◆[03]⇄[04]    │ strip fills the rest,
│ Bed│~~~~~~~~~~~~~~~~~~~~  │ scrolls horizontally only
│    │        − + Fit       │
├───────────────────────────┤
│  Trip      Film      Watch│ 56 bottom bar
└───────────────────────────┘
Tap a shot → inspector sheet (72dvh, Done).  Tap + Shot → Pile sheet.
Tap ⚙ → Film settings sheet.  Cut marker → transition sheet (not a 216px popover).
```

---

## (d) Labelling and voice

The film-set metaphor is doing two jobs: brand voice (good) and wayfinding (mixed).
Counts across the editor/gather/render components: "the bench" 44, "the strip" 30, "the
floor" 22, "the pile" 20, "the lab" 17, "the bed" 11. Most are in comments, which is fine;
the ones that reach the screen need a rule: **a metaphor may name a place the user can
see, never a place they must infer.**

| Term | Where on screen | Verdict |
|---|---|---|
| **Trip / Film / Watch** | Rail | Good — plain nouns, and they match what's inside. Keep. |
| **"Back to the floor"** | Toolbar, empty state, bed inspector ("Swap it on the floor"), shot footer ("bring it back from the Trip page") | Inconsistent: the same destination is "the floor" in three places and "the Trip page" in one. The rail says *Trip*. Use "Trip" everywhere; "floor" can live in comments. |
| **"the lab" / "Print the film" / "Sending to the lab…"** | Print button | Charming, and the confirm dialog explains it. Keep "Print the film" — it's the one bit of metaphor that adds warmth to the scariest button. Watch tab copy should echo it ("printed"). |
| **"Reel 02 · Strip"** | Strip toolbar | Decorative, already flagged in TODO. It costs the left edge of the strip toolbar where "+ Shot / + Layer / + Sound" should be. Delete. |
| **"Strip"** | copy | Neutral, fine — but nowhere is it *named* for the user except that label, so nothing depends on it. |
| **Bed / Cue / Snd n / Pic / L1** | Lane gutter, Mix rows | "Bed" is trade jargon that hides meaning: a friend sees BED beside a waveform and has to guess. "Music" is what it is (the crew "voted up a record"). Cue → "Sound". On phone the truncations `Pic / L1 / Bed` are three different abbreviation styles; use icons (🎞 ▣ ♪) at 52px, words at 74px. |
| **Beat / "Cut on the beat" / "91 bpm"** | Film panel, ruler | Real-world meaning, matches Nielsen #2. Keep. |
| **"Auto-cut", "Let the vote set the lengths", "the crew's marks"** | Film panel | "Marks" for reactions is a third name (Trip uses reactions/"to mark", Pile uses "rank 0.0"). Pick "marks" everywhere and drop "rank" from the Pile row — a friend never sees a rank number elsewhere. |
| **"Pile"** | Tab | Good, matches Trip. But the tab's job is *adding*, so "+ Shot" as a verb beats "Pile" as a noun on the strip. |
| **"Mix"**, **"Layers"** | Tabs | Nouns for lists the lanes already show; when they become "+ Sound" / "+ Layer" the naming problem disappears. |
| **"Look"** section, "As shot", "Shots of the wrong shape", "Play it dry", "Held out", "Keep going round" | Inspector/panels | Warm and specific — the best copy in the app. "Held out" for *muted* is the one that hides meaning: say "Muted". |
| **"The shot / The layer / The track"** sheet titles vs **"Shot / Layer / Track"** tab | Phone vs desk | Same thing, two forms. Use "Shot 02 of 18" in both. |
| **"Take this shot out" / "Take this layer out" / "Take this track out"** | Footers | Consistent verb, good; the shot's helper text should say "back from Trip" not "Trip page". |
| **"Inspector"**, **"Bench panels"** (aria) | Fallback tab label, tablist name | Jargon leaking from the code; "Nothing selected" is already the header, use "Selected". |

---

## (e) Implementation list (paste into TODO.md)

```
## Film page — menu system (2026-09-15 audit)

- [ ] **Toolbar owns the room's chrome.** (S) Drop "← Back to the floor" from the
      toolbar (keep it in the empty-strip state); span the row across the main
      column instead of the preview's maxWidth; left Undo/Redo/?, right
      "1:12 · 18 shots" + Film settings + Print. Hide "?" below md.
- [ ] **Strip toolbar gets the verbs.** (M) Replace the Layers and Mix tabs with
      `+ Shot` / `+ Layer` / `+ Sound` buttons on the strip toolbar; each opens the
      existing picker as an anchored popover (desk) or bottom sheet (phone).
      Delete "Reel 02 · Strip". The lanes are the list — no panel duplicates them.
- [ ] **Film settings is a sheet, not a tab.** (M) Move Director + Format (+ Duck)
      behind a ⚙ "Film settings" button. Order Shape → Pace → wrong-shape policy →
      toggles → Re-cut footer. Friends see Shape but its buttons are disabled with
      "Only <creator> can change the shape". Remove the duplicated fit blurb.
- [ ] **Side column = inspector, full stop.** (M) One stable header ("Selected ·
      Shot 02 of 18"), no relabelling tab; ARIA tabs pattern only if any tab row
      survives (arrow keys, aria-controls, 12px labels, ≥40px tall). Selection no
      longer force-switches panels; the Pile picker shows its anchor ("after shot
      04 ▾") and defaults to the shot under the playhead.
- [ ] **Phone editor is a fixed viewport.** (L) Preview ≤40dvh, strip fills the
      rest and scrolls horizontally only; tool row (+ Shot, + Layer, + Sound, ⚙)
      under the transport; every secondary panel is the bottom sheet the inspector
      already uses; sheet content gets a sticky footer for the Take-out/Done row.
- [ ] **Cut marker you can find.** (S) 24px on desk as on touch; hard cuts at ~50%
      opacity always, 100% on hover or when an adjacent shot is selected. Inspector
      Transition section shrinks to a one-line summary that focuses the marker.
- [ ] **44px everywhere it's tapped.** (S) Transport Play 36/44; "Play this shot",
      −5s/+5s/Use all, Pile filter, Film checkboxes → `.btn`-derived classes so the
      touch media query applies; checkbox rows full-width ≥40px.
- [ ] **Compact masthead on Film.** (M) One 48px row (wordmark · title · segmented
      Trip/Film/Watch · presence · share); the slate line and display rail stay on
      Trip only. Frees ~80px, which at 1280×720 is the difference between a 444px
      and a 590px picture.
- [ ] **Shortcuts on the controls.** (S) kbd hint on Split (S), Take out (⌫), Undo
      (⌘Z) buttons; keep the "?" card as the index.
- [ ] **One name per thing.** (S) "Trip" not "the floor"/"the Trip page"; "Music"
      not "Bed"; "Sound n" not "Cue/Snd"; "Muted" not "Held out"; "marks" not
      "rank"; sheet titles = inspector header; tab counts use the rail's chip.
- [ ] **Gutter labels by width.** (S) Icons at 52px, words at 74px, instead of
      `Pic / L1 / Bed`.
- [ ] **Format gate decision.** (S) `format-panel.tsx` says creator-only; the
      new Film tab shows it to everyone. Enforce in `setVlogFormatAction` and
      disable the buttons for friends, or update the comment and CLAUDE.md.
```
