# Handoff: StrataMD editor UI

## Overview
Full UI design for StrataMD, a desktop Markdown cockpit for working with T3 threads (Electron + React + Tailwind, no component library — see `PRD.md` §10.1). The design covers the app shell, WYSIWYG editor with track-changes review mode, items, the Send composer, Attached panel, and explorer.

## About the Design Files
`StrataMD App v2.dc.html` is a **design reference created in HTML** — an interactive prototype showing intended look and behavior, not production code. The task is to **recreate this design in the StrataMD codebase** (Electron renderer, React, Tailwind, ProseMirror for the editor surface) using its established patterns. The prototype's document area is a static mock; in production it is a ProseMirror view with the same visual treatment. The logic in the file is plain React class-component state — port the behavior, not the file.

The product spec is `docs/PRD.md`. Every element in the design maps to a PRD requirement; when in doubt the PRD wins.

**Structured reading (2026-09-02).** `structured-reading/dense-review-faithful-shell.html` is the current authority for the structured-document reading experience: Contents and the walkthrough card, the center-bottom walkthrough bar, section hierarchy inside the editor, the composed table header with Table / Focus row / Compare, and the populated Changes, Items, Pin Changes, and Attached states. `structured-reading/widget-vivid-showcase.html` and `structured-reading/high-value-visual-candidates.html` are the authorities for the nine registered components. Where those prototypes and this document's prose disagree about appearance, the prototypes win; where they disagree with the PRD about data ownership, persistence, byte preservation, security, or delivery behavior, the PRD wins. `StrataMD App v2.dc.html` remains the authority for shell behavior the newer prototypes did not replace. See `structured-reading/README.md` for the capture workflow.

## Integrated top bar

The owner approved [the frameless-window mockup](./frameless-window/prototype.html) on September 4, 2026. It supersedes the original title-bar and toolbar arrangement. The production bar is 52 pixels high, keeps the fixed brand pill, and puts Open file, Accounts, Theme, and Reset zoom in its dropdown. Docs, Conversations, active/pinned tabs, engine status, Send, and separated Linux window controls share the row. The empty spacer moves the window; interactive controls and menus do not. macOS keeps native traffic lights. Use the existing theme tokens in production. The header has no separate fill or bottom border, so the shell background and ambient effects continue behind the top-bar controls.

[Implementation screenshots](./frameless-window/captures/implementation/) cover the normal and 960-pixel layouts in Strata Vivid, Paper, and Strata, plus the logo menu. These are real Electron captures; the original browser mockup remains the approved design reference. Window behavior and close semantics are specified in PRD section 6.9.

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
Full-viewport dark canvas; three floating working regions over it in one flex row. **All regions are user-resizable**: the two gutters between columns carry vertical pill drag-handles (left window at least 160px for Files and Contents and at least 330px for Conversation, right collaboration column at least 240px, neither with a fixed maximum; editor takes the rest); one horizontal pill handle below the upper review window sets its height (it scrolls internally once constrained); a vertical pill handle at the top-right of the document column sets the text measure (620–1600px, stays centered — widen for tables). Persist all sizes in settings. The 2026-09-02 structured-reading handoff supersedes the prototype's three independently stacked right-rail windows.
The integrated top bar above supersedes the original shell header: Linux uses an opaque frameless window with app-owned controls, and macOS keeps native traffic lights in a hidden inset title bar (PRD §6.9). The next item's drawn-control description is the original prototype's, kept for the record.

1. **Top bar** (not a window): logo pill containing the fixed-color StrataMD horizontal lockup, document tabs as pills (active = near-white `#f4f0fe` pill w/ dark text; inactive = card bg; pending-count badge in the owning agent's color), spacer, status text ("N pending"), `Ctrl+Enter` hint, **Send** gradient pill, divider, then **Linux window controls on the RIGHT**: – □ × as 26px circles (`--card2`, hover `#3d3563`; close hovers pink `#FF5C8A`). No mac traffic lights.
2. **Left navigation window** 212px default: application-owned **Files** and **Contents** tabs. Files contains the existing Scan (mint), Refresh, folder tree (md files only per PRD §6.4), active-file tint, missing-file treatment, and footer. Open documents show only as the top-bar tab pills. Contents shows the live document heading hierarchy, highlights the current heading, and centers a heading when activated. Both tabs use explorer zoom and the selected tab is private per-document state.
3. **Editor window** flex:1, stretches on ultrawide; toolbar row (wraps at narrow widths; B, I, code, link, H, bullet list, ordered list, task list, blockquote, table, code block, image, horizontal rule — each hovers in its own candy color; `{ } source` toggle; Save pill), optional banner strip (see Banners), then the document area: content column at the user-set measure (default 860px) **centered**; frontmatter collapsed chip; scrollable.
4. **Right collaboration column** 300px default: one upper review window with application-owned **Changes** and **Items** tabs, followed by a separate persistent **Attached** window. One review tab is visible at a time and carries its visible count. While Items is selected, Pin Changes may show a capped summary strip inside that same window; it is not independently resizable, and a summary opens Changes. The upper window is resizable; Attached fills the remaining height and never becomes a review tab. The save-state line stays below the windows. All three surfaces use right-rail zoom.

Tab hosts use the existing rounded-window geometry and the faithful-shell prototype's compact treatment. Their tablists sit at the top of the window; the active tab uses pink text with a purple-to-pink underline, while inactive tabs are quiet text buttons. Tabs expose `aria-selected` and linked tabpanels and support ArrowLeft/ArrowRight/Home/End. Stable tab and tabpanel names are "Files", "Contents", "Projects", "Conversation", "Changes", and "Items"; the separate "Attached" landmark remains visible.

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
- **Selection menu**: select ≥3 chars → floating near-white pill bar (Comment C / Question Q / Suggest S; keyboard letters work) → compose popover (kind label, quoted text with grape left border, textarea, Cancel/Add). Added annotations appear in the Items rail (pink chip for user-authored) with a toast about quote+context anchoring (PRD §6.5).

### Source view (`Ctrl+/` or `{ } source`)
Same buffer as JetBrains Mono 16px/1.8, centered 860px; frontmatter dimmed; pending hunks keep strike/highlight rendering (PRD: review mode works in source view).

### Changes window (PRD §6.7)
This is the first tab in the upper review window. Its tab badge counts pending hunks plus open suggestions. Rows persist across Send (see above); Save removes the user's own rows.
Rows: color dot + author (agent color) + kind ("edit · buffer.md", "suggestion", "insert", "edit") + label line. Click = jump (switches tab if needed + flashRing on the hunk). Header action **Mark reviewed** (mint) keeps all pending *hunks* only — it never accepts suggestions; those always require explicit Accept/Reject. Empty state: "All caught up ✓ / shadow matches ghost".

### Items rail
This is the second tab in the upper review window. Its tab badge counts open items. A compact filter row contains **All**, **Decisions**, **Questions**, **Comments**, **Suggestions**, and **Answered**. All and the kind filters show open rows; Answered shows completed rows. Rows use a kind chip (question = tangerine tint, suggestion = grape tint, decision = warning tint, user-added = pink tint) and a truncated quote; decisions lead with their prompt and name a selected passage, heading, or the whole document. Click opens Conversation and jumps when a document item has an editor range. **New decision** opens an inline form with a document or heading anchor, prompt, two required option fields, and an add-option control. Selecting text also offers **Decision D** beside Comment, Question, and Suggest. **Pin Changes** toggles a non-resizable summary strip capped at 155px inside this tab; clicking a summary selects Changes. Pin state lasts for the app session only.

The decision thread reuses the left window's Conversation. It keeps the normal reply box for clarification. An open decision shows one radio per stored option, **Other** with a text field, and **Answer decision**; a resolved one shows its structured answer history as reply-like owner entries and **Reopen decision**. It never shows the ordinary Resolve action. Answering leaves the document and Changes list untouched and creates a checked event row in the next Send composer.

### Contents window
Contents shares the left navigation window with Files. Its index comes from the live ProseMirror document: the first H1 is displayed as the document title, any later H1 remains a root row, H2 headings are primary sections, and H3–H6 nest beneath the nearest prior shallower heading. The row at the editor's reading line is active. Activating a row centers its heading without changing the file. Heading edits update the list on the next frame; a heading-free document says "This document has no headings." Files/Contents selection is stored privately per document in `reading.json`.

The Phase 2 large-document probe uses a 2,101,005-byte rich corpus and three runs of `test/performance/structured-reading.spec.ts`. Against detached pre-phase `adc4610`, median open readiness moved from 8,702.8 to 7,472.4 ms, median heading typing from 1,330.1 to 1,372.7 ms (+3.2%), and the incremental heading index completed in 36.2–41.0 ms.

Contents (2026-09-02 recovery, `structured-reading/dense-review-faithful-shell.html`) is a section route, not a file tree. H2 rows are the numbered primary route (`01`, `02`, …) with a state box at the right that reads ✓ Reviewed or ↻ Revisit in text as well as color. H3 through H6 rows sit beneath the active or explicitly expanded primary section (a small disclosure on rows with children) so they never flood the rail; in H2 + H3 mode every H3 shows because it is a step. Inactive long headings truncate; the active row wraps to show its full value. **Start walkthrough** sits in the panel heading. While active, a walkthrough card above the route shows the kicker `Walkthrough · Section 3 of 12`, the current section title, a short preview derived from the section's first paragraph, a progress track, Previous, Next, the H2 / H2 + H3 depth choice, and **Leave** (accessible name `Leave walkthrough`). Include checkboxes appear only on rows that are steps at the current depth: H2 in H2 mode, H2 and H3 in H2 + H3 mode. A center-bottom walkthrough bar inside the editor island repeats `03 / 12`, the section title, the progress track, Previous and Next, and the **Reviewed** and **Revisit** marks; it complements Contents and shows in both reading and source view. Excluded rows stay in the outline at quiet opacity. When every step is excluded, the card reads `No sections included` and the outline controls remain available.

Inside the editor, each H2 gets a numbered section badge and a rule beneath it; the H1 is the document title and the paragraph after it reads as the lede.

Walkthrough navigation centers its target exactly like a normal Contents click. It does not replace the editor, collapse Files permanently, hide review work, or change the Markdown. State is private per document and restored after tab switches and restart. A reviewed section that no longer matches its stored source hash reads **Revisit** immediately after the changed document view arrives, regardless of whether the text came from the editor, an agent, or another program.

The Phase 3 large-document probe uses 2,101,005 bytes and 1,624 H2 sections. Three isolated body edits updated walkthrough state in 7.8–8.5 ms. Each run hashed one section and did not rebuild the heading boundaries.

### Table controls and views

Each GFM table sits in a rounded table block with a composed header (2026-09-02 recovery). The nearest heading's text and the visible-row count (`17 rows`, or `8 of 17 shown`) lead; **Table**, **Focus row**, and **Compare** form one segmented mode control; **Tools** and **Focus** are quiet outlined actions. Sort, Filter, Columns, width, and density live in a quieter utility row beneath the header that opens when a cell is current, when a derived view is active, or when Tools is pressed. **Select row**, **Discuss row**, and **Discuss cell** appear only once a body cell is current. Below 620px of table width the utility row collapses into one **Table options** menu and the discussion controls move into the header. The default view is finished before any control is touched: a sticky inset header row, strong row separators, the first column in the heading color, and readable long cells. Focus row is a labeled card; Compare lays the selected rows out as cards with per-cell labels. Read-only state is stated in text beside **Edit**, not communicated by tint alone.

Clicking a body cell gives it the current-cell ring and updates the row and column named in the controls. **Focus row** presents that row as stacked header/value pairs. **Compare** shows the selected rows in their original columns after any chosen sort or filter. Hidden columns remain available in the Columns checklist. Column width uses compact decrease and increase buttons, and Density toggles between Comfortable and Compact. Empty filters say `No rows match this filter.` Compare with fewer than two rows says `Select at least two rows to compare.`

**Focus** hides the other document blocks only inside the center editor. It changes to **Exit focus** while active. Files, Contents, or Projects; Changes or Items; and Attached remain visible. A derived table with hidden review work shows `N review items hidden`. A review jump temporarily replaces the derived view with the editable table, adds **Return to table view**, and centers the exact mark. Choosing that action or navigating to another target restores the stored derived view.

**Discuss row** and **Discuss cell** are in the table controls once a body cell is current. Either action opens the existing annotation composer with Question selected. The quoted text is the exact Markdown row. Cell discussion also shows the selected column label in the composer context. It opens the same Conversation used by every other question.

The Phase 4 large-table probe uses a 2,154,781-byte fixture with 1,000 rows. Three runs sorted and filtered it in 0.50–1.14 ms and returned to source order in 0.03–0.07 ms. The projection layer made zero Markdown transactions and left the source unchanged.

The Phase 5 decision probe creates 100 decisions with two prior answers and reopenings each. Across five measured runs, all six annotation filters peaked at 0.052ms, one owner answer at 0.016ms, and a complete delivery slice plus payload construction at 0.823ms. Each stays under the 100ms budget on the standard integration fixture.

### Diagrams, images, references, trees, and folds

An exact `mermaid` fence is a rounded visual block with a quiet **Diagram / Source** switch in its header. Diagram is the default. Compact −, Reset, and + controls change zoom; drag, arrow keys, and Shift+arrow pan the canvas. The diagram surface is focusable, states its current zoom, clips at the block edge, and takes every fill, line, and text color from active Strata theme jobs. Source returns the ordinary editable code block. A render error replaces the canvas with plain text—`This diagram could not be drawn.` plus Mermaid's short error—and keeps Source one action away. No control or error rewrites the fence.

A ready local image receives the same visible focus ring as editor controls. Click or Enter opens a center-window inspection overlay, not an application modal and not a new pane. The overlay preserves both rails, uses the existing resolved image URL, and includes the alt text as its heading, optional title, quiet local path, Fit, −, +, and Close. Drag or arrow keys pan once zoomed; Escape closes and restores focus. Diagram/image/source/focus transforms survive document-tab switches only for the running session.

Local Markdown links and path-like inline code spans use a compact preview popover beside the reference. Its heading is the target document title when found, followed by the filename and a short plain-text excerpt; it never renders target HTML or embeds another editor. **Open document** is explicit and pink-accented. Ordinary activation only previews, so the current reading position is not lost. Escape and outside activation close the preview and return focus. Missing or disallowed targets keep ordinary link/code styling and open no blank surface.

Registered components are full-width Strata Vivid document blocks inside the existing wide editor measure, each with its own visual grammar (2026-09-02 recovery; authorities `structured-reading/widget-vivid-showcase.html` and `structured-reading/high-value-visual-candidates.html`). Every block has a non-editable eyebrow with an icon and short human copy (`Verdict`, `Warning`, `Metrics`, `Phases`, `Decision matrix`, `Before and after`, `Bar chart`, `Evidence`, `Annotated screenshot`), never a registry name, plus a directly editable Markdown body. `Callout` is a compact message: a large accent flare, the kind as a small label, a strong title from its H3, and a soft inset body. `Verdict` is the strongest section-level emphasis: a gradient block with an outcome chip and large body text. `MetricStrip` lays its list out as metric cells with a quiet uppercase label and a large value. `PhaseBoard` lays its H3 phases out as coordinated columns (up to three; one column when narrow) with each task as a card. Invalid registered syntax is a danger-accented source-only card with “Component needs attention,” the component name, the first plain problem, and the preserved source. Unknown tags retain the existing raw-source presentation. Components never narrow prose, create shell tabs, or introduce author-selected colors or dimensions.

The Phase 7 probe wraps a 2,101,246-byte Markdown corpus in `PhaseBoard`. Three paired runs measured median ready time at 2,279.1ms before component recognition and 2,312.6ms with it (+1.47%); median editor transaction time improved from 10.5ms to 9.0ms. The component path therefore stays within the 10% large-document budget, and the measured child edit is well below 100ms.

`DecisionMatrix` leads with the alternatives as column headers, gives each criterion row a rounded band, and offers a quiet alternative-column focus without hiding the editable source table. `BeforeAfter` is two contrasted panels split by a hairline: the first side's heading in coral with × item markers, the second in mint with ✓ markers, stacking in source order below 620px. `EvidenceChain` draws Claim, Evidence, and Therefore as one vertical sequence: a claim card, evidence items as cards on a gradient spine, and a mint conclusion; focus on a part highlights it without inventing navigation. `Timeline` is deliberately absent: Mermaid owns static timelines and an ordinary table owns filterable status.

`Chart` presents the drawing as the artifact and keeps its still-editable source table beneath a quiet `Source data` label. Line and bar use prepared table data, no animation, and the six ordered `visuals.category-*` swatches; axes and labels use document/table/surface theme jobs. The chart module loads only when a valid Chart is present, failure leaves the table visible, and no chart affordance changes source.

`AnnotatedScreenshot` gives the image priority at full block width with numbered gradient pins over it, and shows the exact five-column table as a grid of note cards (pin number badge plus note) that remain editable Markdown. **Place pin** arms one image click, pin/note focus highlights both, and **Focus image** enlarges that same inline image without opening a second inspection surface. Activating a pin opens the ordinary Question composer with the full pin row and readable screenshot context. A warning above the image says `Image changed — verify pin positions` until **Positions are correct** records the current version in every row.

The Phase 8 proof uses a 1,000-value line chart. After the lazy module is available, Chart.js renders it in 26.4ms; the emitted lazy chunk is 348,654 bytes. Measured visual feedback is 24.4ms for Matrix focus, 25.7ms for screenshot focus, and 12.0ms for pin activation. The screenshot has one complete decoded image before and after annotation, and the resource inventory contains no HTTP request.

An exact `tree` fence has **Tree / Source** in the same block header. Tree uses nested accessible rows, monospaced labels, subtle guide lines, and folder/file glyphs derived only from the written text. Rows may collapse locally for inspection, but the fence is never treated as a live explorer and never touches disk. If nesting cannot be parsed safely, the block explains the problem and displays its preserved source.

Every heading places a small disclosure chevron before the editable heading text. A closed heading keeps its own row visible and visually mutes the hidden body boundary. When hidden work exists, small text beside it says `2 annotations hidden`, `1 change hidden`, or both; color supplements the words. Clicking or pressing Enter/Space toggles the private durable fold. A find or review jump opens the needed fold temporarily and marks the disclosure `Temporarily open`; moving away restores it unless the owner toggles it.

The Phase 6 proof rendered all three Mermaid fences in the 7,756-word review under strict mode in 165.9ms, 121.2ms, and 38.2ms. The lazy Mermaid core is 1,229,264 bytes and retained renderer heap increased by 11,099,200 bytes after collection. On the 2,101,218-byte construct-free corpus, three paired runs measured a 0.37% median open regression and a 4.17% editor-transaction regression; no run requested the Mermaid core. The populated local preview took 4.7ms. These measurements are implementation evidence, not looser design budgets.

### Changes, Items, and Pin Changes (populated states)
Populated rows are cards (2026-09-02 recovery). A change card carries the author's avatar initial, name, action, and relative time, then a monospaced diff box with the removed line struck in the removed tint and the added line in the added tint; cards a hunk cannot render inline keep Keep and Revert beneath. An item card has a left accent by kind (amber for decisions and questions, pink for comments, purple for suggestions, mint when answered), a monospaced meta line (kind chip, place such as `Selected passage` or `Table row`, reply count), the text, the exact quote as a small italic line, and a decision's choices as chips with the answered one highlighted. Empty panels stay quiet. **Pin changes** sits in the Items heading; the pinned strip has a sticky `Pinned changes · N pending` head and is capped at 155px.

### Attached panel (PRD §6.6)
This is a persistent window below the upper review tabs, never a tab itself. Its header reads **Attached** and always shows the attached thread count and status; it remains visible while either review tab or Pin Changes is in use. Each thread is a gradient card.
### Send composer (modal, PRD §6.7)
Backdrop blur over dark scrim. 560px window: title "Send changes", subtitle "Snapshots the buffer and queues one delivery per recipient · does not save"; note textarea; recipient toggle chips (outlined in each thread's color when selected); tangerine warning card with per-item checkboxes under "Changes not made by you" + "1 of your changes builds on changes not made by you."; **Exact text per recipient** with one tab per selected recipient over a mono `<pre>` payload preview. The preview must render exactly the delivery attached to the T3 turn; the shared delivery renderer is the single source of truth. It begins with the PRD §8 guardrail line verbatim ("…The document <path> is the **user's** to save.") and includes the note, one unified diff per segment with author, and the external section only when the checkbox is on. The "--- you (baseline …) ---" header format in the prototype is illustrative only; Cancel + gradient Send; `Ctrl+Enter` sends. Send button in the top bar is desaturated + toast-explains when nothing is sendable (PRD: enabled only with user hunks / items / replies / resolutions **since the last Send** — sending disables it until new user activity, but does NOT remove the user's hunks from the Changes panel; the panel lists hunks against the ghost, and only Save advances the ghost for user hunks).

### Toasts
Single bottom-center near-white pill (`#f4f0fe`, dark text, pink dot), toastIn, auto-dismiss 2.8s. All action feedback goes through it; copy is PRD-semantic (see prototype `say()` calls).

## Screens designed as overlays (never leave the main layout)
All secondary PRD states are modals, banners, or in-panel elements over the same shell — the user is never navigated away. All live in the prototype; rare ones are triggered from the dashed "Prototype demos" island (prototype-only UI, bottom of right rail; not part of the product).

- **Conflict resolution modal** (§6.2): "This file was changed outside StrataMD while you were editing" — two side-by-side cards per conflicted block, "Your version" (pink outline) vs "Changed outside" (gray), click a card to pick; footnote notes non-conflicting blocks were already applied as pending.
- **Crash recovery modal** (§6.3): "Recover unsaved edits?" — Recover buffer (mint, primary) / Discard — use disk (pink outline). Copy states StrataMD never silently overwrites either side.
- **Close-tab dialog** (§6.3): × affordance on the active tab; Save (mint) / Discard (pink outline) / Cancel; copy explains pending review persists and Discard resets buffer.md.
- **Mixed-hunk Revert confirmation** (§6.3): a hunk the user edited inside shows badge "<agent> · mixed"; Revert opens "Revert a mixed hunk?" — Cancel / Revert & discard (pink). Keep preserves the user's inner edits without a prompt.
- **Review card in Changes** (§6.3): for hunks that can't render inline (table columns etc.) — author row, "can't render inline" note, mono −/+ before/after lines, Keep/Revert pills.
- **Orphaned item** (§6.5): gray "orphaned" chip row in Items; click explains it cannot be accepted (no fuzzy apply). **Clear answered** appears under the list when answered items exist.
- **Queued-delivery notice** (§6.7): chip in the composer under recipients — "<agent> already has d_NNNN queued — this delivery will follow it."
- **Start thread** (§6.7): when no thread is attached, the top-bar action opens the thread picker; Attached explains that the first Send creates the link.
- **Explorer actions** (§6.4, §9): "+ Add folder" row (mint); "forget" chip on the struck-through missing file deletes the ghost entry.
- **Banners** (§6.10): strip across the top of the editor window, dismissible — file deleted (tangerine; "Save will recreate it") and invalid UTF-8 (pink; read-only source view). The former over-2-MB banner is superseded by the owner's 2026-08-28 decision that large documents retain full visual editing.

## Interactions & Behavior — keyboard
`Ctrl+Enter` open composer / send · `Ctrl+/` source toggle · `Ctrl+S` save (toast: pending hunks stay reviewable — PRD §6.1) · `Esc` closes popovers/modal · `C`/`Q`/`S` with selection menu open · Enter sends an inline reply · Esc closes any modal/popover. Full review keyboard reach is a PRD §6.9 requirement the prototype does NOT demonstrate: Keep/Revert/Accept/Reject pills, item rows, composer tabs, conflicts, and banners all need focus order and key bindings in the implementation.

## State Management (prototype → production mapping)
Prototype state to reproduce: active document tab, visual/source view, per-hunk status (`pending | kept | reverted | mixed`), per-doc pending counts (drive tab badges), task checks, question items (replies, answered), selection menu + compose popover, user annotations, composer (note, recipients, include-external, preview tab, queued notice), thread states, modal states (conflict, recovery, revert-confirm, close-tab), banner state, panel sizes (explorer/rail widths, one `upperReviewHeight`, document measure), toast, saved-ago. Files/Contents/Projects and Changes/Items selections are per-document state in `reading.json`; Pin Changes is session-only. In production collaboration state comes from the main process over IPC (ghost store, segments, attachments — PRD §6.11 state table); the visual states and transitions are what this design specifies.

## Assets
Fonts: Baloo 2 + JetBrains Mono (bundle locally — the renderer never fetches remote resources, PRD §11). Brand assets are `resources/stratamd-logo.svg` for the horizontal lockup and `resources/stratamd-icon.svg` for square icon placements. Both use the fixed pink, orange, and purple mark; the icon and the lockup's icon block retain the rounded dark field and pink-to-purple border in every theme. Both assets ship locally.

## Files
- `structured-reading/dense-review-faithful-shell.html` — the approved structured-reading prototype: Contents, walkthrough, tables, review rail, Attached panel (authority for those surfaces)
- `structured-reading/dense-review-walkthrough.html` — supporting dense-document hierarchy prototype
- `structured-reading/widget-vivid-showcase.html` — registered component visual quality (Callout, Verdict, MetricStrip, PhaseBoard, BeforeAfter)
- `structured-reading/high-value-visual-candidates.html` — DecisionMatrix, BeforeAfter, Chart, EvidenceChain, AnnotatedScreenshot
- `structured-reading/captures/` — prototype and real-app captures at matching viewports (see `structured-reading/README.md`)
- `StrataMD App v2.dc.html` — the interactive hi-fi prototype (all behavior above is live; requires `support.js`, included)
- `support.js` — prototype runtime (reference-only; not part of the design)
- `../../docs/PRD.md` — product spec this design implements

Note: the prototype loads Baloo 2 / JetBrains Mono from Google Fonts for preview convenience. Production must bundle fonts locally — the renderer never fetches remote resources (PRD §11). Do not copy the `<link>` tags.
