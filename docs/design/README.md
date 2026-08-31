# Handoff: StrataMD editor UI

## Overview
Full UI design for StrataMD, a Linux desktop markdown editor for writing documents with AI agents (Electron + React + Tailwind, no component library — see `PRD.md` §10.1). The design covers the app shell, WYSIWYG editor with track-changes review mode, annotations, the Send composer, attachments panel, and explorer.

## About the Design Files
`StrataMD App v2.dc.html` is a **design reference created in HTML** — an interactive prototype showing intended look and behavior, not production code. The task is to **recreate this design in the StrataMD codebase** (Electron renderer, React, Tailwind, ProseMirror for the editor surface) using its established patterns. The prototype's document area is a static mock; in production it is a ProseMirror view with the same visual treatment. The logic in the file is plain React class-component state — port the behavior, not the file.

The product spec is `docs/PRD.md`. Every element in the design maps to a PRD requirement; when in doubt the PRD wins.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and motion are final. Recreate pixel-perfectly with Tailwind utilities (extend the theme with the tokens below).

## Design Tokens

Colors (CSS variables in the prototype):
- `--bg` true background: `#0a0810`; background radial highlight: `#141026` at 30% -10%
- `--card` window background: `#241e3b`
- `--card2` raised surface / input hover: `#312a50`
- `--line` borders: `#463c6e`
- `--text` primary text: `#f4f3f6`
- Agent color order: 1st agent grape `#9B5CFF`, 2nd sky `#4F8DFF`, 3rd tangerine `#FFB03A`, 4th mint `#3DC97C`; 5th+ cycle the same four. Pink is reserved for the user and Revert accents; gray is reserved for untagged "external".
- Body text: `#dbdade` · secondary: `#a8a6b0` (`--dim`) · muted: `#8b8994` · disabled/struck: `#73717d`
- Code/input background: `#1d1731`; code text: `#bebcc6`
- Candy palette (participant identity): pink `#FF5C8A` (you / Send), tangerine `#FFB03A` (questions / warnings), mint `#3DC97C` (Keep/Accept), sky `#4F8DFF` (agent "Haru" — 2nd agent color), grape `#9B5CFF` (agent "Claude" — 1st agent color)
- Hunk highlights: insertion bg `rgba(155,92,255,.22)` text `#d5beff` (grape agents) or `rgba(79,141,255,.2)` text `#b0ccff` (sky agents); deletion bg `rgba(255,92,138,.14)` text `#f395b3`, line-through
- Send button / composer Send: gradient `linear-gradient(135deg,#FF5C8A,#9B5CFF)`

Typography:
- UI + document: **Baloo 2** (rounded sans; weights 500–800)
- Code, shortcuts, source view: **JetBrains Mono** (400/500)
- Scale: document body 21px/1.7 wt500 · h1 40px/800 · section heads 24px/800 · task items 20px · panel titles 15px/800 · list rows 14px/600 · badges 12px/800 · fine print 11–12px
- Built for 1440p and ultrawide; never shrink below this scale.
- **Italic decision required**: Baloo 2 ships no italic face, and emphasis is a core markdown construct. Pair Baloo 2 (headings + UI) with a body face that has a real italic for the document surface, or accept synthesized oblique (not recommended at 21px). This is an open decision for the owner.
- Muted `#8b8994` on `#241e3b` is ~4:1 — use only for fine print, never for repeatedly-read text.

Shape & depth:
- Radii: windows 22–24px · rows/buttons 10–14px · pills/badges/buttons 999px (fully rounded) · checkboxes 8px
- Shadows: windows `0 16–20px 40–50px -18px rgba(0,0,0,.55–.6)`; modal `0 40px 100px -24px rgba(0,0,0,.8)`
- Spacing: app padding 18/26px; gutter between windows 18px; window padding 16px; editor padding 34px 46px

Motion (all cubic-bezier(.34,1.56,.64,1) "springy" unless noted):
- `popIn` .3s — popovers, modal, list items appearing
- `flashRing` .7s — ring pulse on a hunk when acted on or jumped to
- `checkPop` .35s — checkbox check
- `toastIn` .38s — toast
- `pulseDot` 1.6s loop — "waiting" attachment state dot
- Hover: buttons scale 1.06–1.15; active: scale ~.9; changes rows translateX(5px)
- Ambient (see Background layer): `bgShift` 34s, `rise` 24–35s, `glow1/2/3` 22–31s, `innerA/innerB` 14–18s, `moteWander` 16–23s
- All ambient motion sits behind a single boolean setting (`animatedBackground` in the prototype). Implementation guidance: honor `prefers-reduced-motion`, pause ambient layers while the editor has focus and keystrokes are arriving, and consider defaulting off — animated blurred layers repaint continuously and compete with typing latency. Avoid animating `filter: blur()` directly; pre-blur via gradient falloff or `will-change: transform` on transform-only loops.

## Layout (app shell)
Full-viewport dark canvas; three floating "windows" over it in one flex row. **All panels are user-resizable**: the two gutters between columns carry vertical pill drag-handles (explorer width 160–340px, right rail 240–440px; editor takes the rest); horizontal pill handles below the Changes and Annotations islands set their heights (they scroll internally once constrained); a vertical pill handle at the top-right of the document column sets the text measure (620–1600px, stays centered — widen for tables). Persist all sizes in settings.
Window controls are drawn in-app, which implies `frame: false` in Electron. On KDE/Wayland that costs native title-bar drag, tiling shortcuts, and the window menu unless drag regions (`-webkit-app-region: drag` on top-bar dead space) and double-click-to-maximize are handled manually. Record this decision in the PRD or switch to the native frame and drop the drawn controls.

1. **Top bar** (not a window): logo pill containing the fixed-color StrataMD horizontal lockup, document tabs as pills (active = near-white `#f4f0fe` pill w/ dark text; inactive = card bg; pending-count badge in the owning agent's color), spacer, status text ("N pending"), `Ctrl+Enter` hint, **Send** gradient pill, divider, then **Linux window controls on the RIGHT**: – □ × as 26px circles (`--card2`, hover `#3d3563`; close hovers pink `#FF5C8A`). No mac traffic lights.
2. **Explorer window** 212px fixed: "Files" title + Scan (mint) + Refresh; folder tree (md files only per PRD §6.4); active file row tinted grape; missing file struck-through; footer status chip.
3. **Editor window** flex:1, stretches on ultrawide; toolbar row (wraps at narrow widths; B, I, code, link, H, bullet list, ordered list, task list, blockquote, table, code block, image, horizontal rule — each hovers in its own candy color; `{ } source` toggle; Save pill), optional banner strip (see Banners), then the document area: content column at the user-set measure (default 860px) **centered**; frontmatter collapsed chip; scrollable.
4. **Right rail** 300px: three windows stacked (Changes, Annotations, Attached agents), each `flex:none`, column scrolls; fine-print line "buffer.md mirrored · saved Xm ago".

## Background layer (lowest, visible in gaps)
- Slow-shifting 4-color gradient wash (8%→5% alpha candy tints, `background-size:300% 300%`, `bgShift` 34s)
- Small candy dots (5–10px, 28–40% alpha) rising bottom→top over 24–35s, positioned **in the gaps**: screen edges, the gutter right of the explorer, the seam left of the right rail, plus a few mid-screen for ultrawide

## In-window ambient layer (below text)
Every window has a decor layer behind its content (implemented as absolute inset-0, `z-index:-1`, parent `isolation:isolate; overflow:hidden`):
- Editor: 3 large blurred glows (grape .09 / pink .07 / sky .06, blur 34–40px) drifting on 22–31s loops + 3 tiny motes (15–18% alpha) wandering
- Each right-rail window + explorer: 1 glow (its own hue, ~.1–.12 alpha) + 1 mote
Text must always sit above; alphas are tuned for 21px body legibility — do not raise them.

## Screens / Views & Components

### Document with review mode (main state)
- **Pending agent hunk** (buffer.md edit, PRD §6.2–6.3): deleted text struck pink + inserted text grape-highlighted, followed by inline pill cluster: author badge (agent color, white text), **Keep** (mint pill, dark text), **Revert** (pink outline pill). Acting: flashRing on the span, then 260ms later the resolved text remains (Keep → clean inserted text; Revert → original text). Toast confirms with PRD-correct copy ("Kept — ghost advanced for this hunk" / "Reverted — ghost text restored; <agent> sees it as your hunk next delivery").
- **Suggestion** (PRD §6.5): same rendering with badge "<agent> · suggestion" and **Accept / Reject**. Accept records a user change + `accepted` event; Reject emits `rejected` (toast copy in prototype).
- **Untagged external hunk**: gray "external" badge, whole inserted row tinted grape at .1, Keep/Revert.
- **Question annotation**: quoted span highlighted tangerine (.16 bg + 3px underline); click opens thread popover (question text, replies left-bordered grape, reply input, "✓ Resolve thread").
- **Task list items**: 22px rounded checkboxes; checked = mint fill + white check (checkPop) + struck label.
- **Frontmatter**: collapsed mono chip "▸ --- frontmatter · 2 keys ---", click toggles.
- **Selection menu**: select ≥3 chars → floating near-white pill bar (Comment C / Question Q / Suggest S; keyboard letters work) → compose popover (kind label, quoted text with grape left border, textarea, Cancel/Add). Added annotations appear in the Annotations window (pink chip for user-authored) with a toast about quote+context anchoring (PRD §6.5).

### Source view (`Ctrl+/` or `{ } source`)
Same buffer as JetBrains Mono 16px/1.8, centered 860px; frontmatter dimmed; pending hunks keep strike/highlight rendering (PRD: review mode works in source view).

### Changes window (PRD §6.7)
Rows persist across Send (see above); Save removes the user's own rows.
Rows: color dot + author (agent color) + kind ("edit · buffer.md", "suggestion", "insert", "edit") + label line. Click = jump (switches tab if needed + flashRing on the hunk). Header action **Mark reviewed** (mint) keeps all pending *hunks* only — it never accepts suggestions; those always require explicit Accept/Reject. Empty state: "All caught up ✓ / shadow matches ghost".

### Annotations window
Rows: kind chip (question = tangerine tint, suggestion = grape tint, user-added = pink tint) + truncated quote. Click opens the thread / jumps.

### Attached agents window (PRD §6.6)
Per agent: 34px rounded-square avatar in the agent's color, name + attach-age, state dot + label — the three PRD §6.6 states only: `waiting — attach call open` (agent-color dot, pulseDot), `working — nothing queued` (gray), `delivery queued, unacked` (tangerine). Any "collecting…" moment is transient UI feedback during a state change, not a state the main process reports. **nudge** text button (hover = grape fill, wobble) → copies "Run `stratamd attach --as <id>` and continue." Fine print: "idle expiry 24h · unacked deliveries never expire".

### Send composer (modal, PRD §6.7)
Backdrop blur over dark scrim. 560px window: title "Send changes", subtitle "Snapshots the buffer and queues one delivery per recipient · does not save"; note textarea; recipient toggle chips (outlined in each agent's color when selected); tangerine warning card with checkbox "Include changes not made by me" + "1 of your changes builds on changes not made by you."; **Exact text per recipient** with one tab per selected recipient over a mono `<pre>` payload preview. The preview must render **exactly what the CLI would print** — the CLI's `text` renderer is the single source of truth; the composer calls it, never re-implements it. It begins with the PRD §8 guardrail line verbatim ("…The document <path> is the **user's** to save.") and includes the note, one unified diff per segment with author, and the external section only when the checkbox is on. The "--- you (baseline …) ---" header format in the prototype is illustrative only; Cancel + gradient Send; `Ctrl+Enter` sends. Send button in the top bar is desaturated + toast-explains when nothing is sendable (PRD: enabled only with user hunks / annotations / replies / resolutions **since the last Send** — sending disables it until new user activity, but does NOT remove the user's hunks from the Changes panel; the panel lists hunks against the ghost, and only Save advances the ghost for user hunks).

### Toasts
Single bottom-center near-white pill (`#f4f0fe`, dark text, pink dot), toastIn, auto-dismiss 2.8s. All action feedback goes through it; copy is PRD-semantic (see prototype `say()` calls).

## Screens designed as overlays (never leave the main layout)
All secondary PRD states are modals, banners, or in-panel elements over the same shell — the user is never navigated away. All live in the prototype; rare ones are triggered from the dashed "Prototype demos" island (prototype-only UI, bottom of right rail; not part of the product).

- **Conflict resolution modal** (§6.2): "External write conflicts with your edits" — two side-by-side cards per conflicted block, YOURS (pink outline) vs INCOMING (gray), click a card to pick; footnote notes non-conflicting blocks were already applied as pending.
- **Crash recovery modal** (§6.3): "Recover unsaved edits?" — Recover buffer (mint, primary) / Discard — use disk (pink outline). Copy states StrataMD never silently overwrites either side.
- **Close-tab dialog** (§6.3): × affordance on the active tab; Save (mint) / Discard (pink outline) / Cancel; copy explains pending review persists and Discard resets buffer.md.
- **Mixed-hunk Revert confirmation** (§6.3): a hunk the user edited inside shows badge "<agent> · mixed"; Revert opens "Revert a mixed hunk?" — Cancel / Revert & discard (pink). Keep preserves the user's inner edits without a prompt.
- **Review card in Changes** (§6.3): for hunks that can't render inline (table columns etc.) — author row, "can't render inline" note, mono −/+ before/after lines, Keep/Revert pills.
- **Orphaned annotation** (§6.5): gray "orphaned" chip row in Annotations; click explains it can't be accepted (no fuzzy apply). **Clear resolved** link appears under the list when resolved annotations exist.
- **Queued-delivery notice** (§6.7): chip in the composer under recipients — "<agent> already has d_NNNN queued — this delivery will follow it."
- **Copy for agent** (§6.7): when no agent is attached, the top-bar Send is replaced by a pink-outline "Copy for agent ⧉" pill; attachments window shows the empty state explaining the swap.
- **Explorer actions** (§6.4, §9): "+ Add folder" row (mint); "forget" chip on the struck-through missing file deletes the ghost entry.
- **Banners** (§6.10): strip across the top of the editor window, dismissible — file deleted (tangerine; "Save will recreate it") and invalid UTF-8 (pink; read-only source view). The former over-2-MB banner is superseded by the owner's 2026-08-28 decision that large documents retain full visual editing.

## Interactions & Behavior — keyboard
`Ctrl+Enter` open composer / send · `Ctrl+/` source toggle · `Ctrl+S` save (toast: pending hunks stay reviewable — PRD §6.1) · `Esc` closes popovers/modal · `C`/`Q`/`S` with selection menu open · Enter sends a thread reply · Esc closes any modal/popover. Full review keyboard reach is a PRD §6.9 requirement the prototype does NOT demonstrate: Keep/Revert/Accept/Reject pills, thread rows, composer tabs, conflicts, and banners all need focus order and key bindings in the implementation.

## State Management (prototype → production mapping)
Prototype state to reproduce: active tab, visual/source view, per-hunk status (`pending | kept | reverted | mixed`), per-doc pending counts (drive tab badges), task checks, question thread (replies, resolved), selection menu + compose popover, user annotations, composer (note, recipients, include-external, preview tab, queued notice), agent states, modal states (conflict, recovery, revert-confirm, close-tab), banner state, panel sizes (explorer/rail widths, island heights, document measure), toast, saved-ago. In production these come from the main process over IPC (ghost store, segments, attachments — PRD §6.11 state table); the visual states and transitions are what this design specifies.

## Assets
Fonts: Baloo 2 + JetBrains Mono (bundle locally — the renderer never fetches remote resources, PRD §11). Brand assets are `resources/stratamd-logo.svg` for the horizontal lockup and `resources/stratamd-icon.svg` for square icon placements. Both use the fixed pink, orange, and purple mark; the icon and the lockup's icon block retain the rounded dark field and pink-to-purple border in every theme. Both assets ship locally.

## Files
- `StrataMD App v2.dc.html` — the interactive hi-fi prototype (all behavior above is live; requires `support.js`, included)
- `support.js` — prototype runtime (reference-only; not part of the design)
- `../../docs/PRD.md` — product spec this design implements

Note: the prototype loads Baloo 2 / JetBrains Mono from Google Fonts for preview convenience. Production must bundle fonts locally — the renderer never fetches remote resources (PRD §11). Do not copy the `<link>` tags.
