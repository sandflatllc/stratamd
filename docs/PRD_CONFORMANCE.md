# PRD conformance ledger

`docs/PRD.md`, draft v17 dated 2026-08-31, is the source of truth. This ledger is an index, not a substitute. A passing row proves only the cited requirement. Product signoff still requires rereading §§6 through 12 and running the full suite.

References:

- `A01` through `A15` are the executable Playwright tests in `test/e2e/prd-6.12.spec.ts`, numbered to match §6.12.
- `EC` is the black-box filesystem/encoding/large-document suite in `test/e2e/edge-cases.spec.ts`.
- `SC` is the shell, persistence, routing, network, and keyboard suite in `test/e2e/shell-conformance.spec.ts`.
- `RS` is the explorer, drag-drop, window-recreation, and second-launch suite in `test/e2e/renderer-shell.spec.ts`.
- `VH` is the populated design-handoff renderer check in `test/e2e/visual-handoff.spec.ts`.
- `UR` is the undo and redo timeline suite in `test/e2e/undo-redo.spec.ts`.
- `AC` is the agent-collaboration suite in `test/e2e/agent-collaboration.spec.ts` (messages, the Lead, the review rail, the thread panel; cases specified in `docs/plans/completed/agent-collaboration-plan.md` §9).
- `SH` is the seeding and save-history suite in `test/e2e/save-history.spec.ts` (cases specified in `docs/plans/completed/ghost-redesign-plan.md` §10).
- `CC` is the crash-containment suite in `test/e2e/crash-containment.spec.ts` (cases specified in `docs/plans/completed/crash-hardening-plan.md` §9).
- `U` means a focused Vitest test is required for pure state, parser, serializer, storage, or protocol behavior.
- `E` means an additional Electron test is required beyond the 15 release scenarios.
- `S` means a static source or build-policy check is required.
- `M` means a host-specific or visual check cannot be established completely in the headless suite (on macOS this is the manual checklist in `docs/plans/open/mac-plan.md` §8).

An uncited `U`, `E`, `S`, or `M` item is open coverage, not an accepted implementation.

## §6 functional requirements

| ID | Requirement | Verification |
|---|---|---|
| 6.1-01 | Visual editing supports every listed CommonMark and GFM construct, including interactive task boxes. | `E` construct matrix; one corpus case per construct |
| 6.1-02 | Frontmatter, footnotes, wiki links, HTML, math, and reference definitions are raw, source-only, and byte-preserved. | `U` raw-block round trip; `E` source-only behavior |
| 6.1-03 | Toolbar and shortcuts cover all visual constructs and named bindings. | `E` toolbar/shortcut matrix |
| 6.1-04 | Source and visual views share one buffer; unsupported source syntax becomes raw. | `U` model conversion; `E` source toggle |
| 6.1-05 | Local images stay inside allowed roots; remote images and URLs are never fetched. | `U` path policy; `SC` network denial |
| 6.1-06 | Save preserves untouched source bytes and rewrites the smallest grammar-safe region, including BOM, CRLF, whitespace, indentation, delimiter, wrap, and EOF conventions. | `A10`; `U` full construct/corpus round trip |
| 6.1-07 | Save is same-directory atomic, preserves mode, hashes disk first, and resolves a race before writing. | `A05`; `U` atomic-save/mode faults |
| 6.1-08 | Only Save writes the document; Save advances user ghost regions without accepting pending external regions. | `A04`, `A11`, `A15`; `U` save transition |
| 6.2-01 | Shadow changes atomically and debounce-mirror to `buffer.md`; buffer writes merge into shadow without writing the document. | `A03`, `A04`, `A11`; `U` debounce/atomic mirror |
| 6.2-02 | Every payload directs agents to the buffer; direct document writes become external review changes. | `E` payload guardrail and direct-write flow |
| 6.2-03 | Own mirror and Save watcher events are ignored by content hash. | `A11`; `U` equal-hash suppression |
| 6.2-04 | External handling re-reads and ignores equal content. | `U` external equal-hash case |
| 6.2-05 | External handling patches last-known content to newly read content. | `U` patch-origin case |
| 6.2-06 | External handling snapshots first, closes the current segment, and opens one tagged or untagged external segment. | `A14`; `U` segment boundaries |
| 6.2-07 | Nonconflicting blocks merge as pending; dirty blocks require incoming/mine resolution with the specified dirty-since boundary. | `A05`; `U` conflict matrix; `SC` both choices |
| 6.2-08 | External handling does not move ghost or attachment baselines. | `A04`, `A14`; `U` state assertions |
| 6.2-09 | A stale whole-buffer write is a reversible external change, with no guessed three-way merge. | `E` stale-buffer flow |
| 6.2-10 | A tag covers every external write until five idle minutes or a replacing tag, never retroactively, one segment per write; using it slides the window and an unused tag expires. | `U` fake-clock burst lifecycle |
| 6.2-11 | Detection covers document and ghost directories, rename writes, all named reread triggers, and local filesystems only. | `A05`, `A08`; `U` watcher trigger matrix; `M` supported filesystems |
| 6.3-01 | Every opened, scanned, or checkpointed document has a ghost; differences render inline or as review cards with author badges in both views. | `A03`, `A04`; `E` rendering matrix |
| 6.3-02 | Open, Scan, and offline store creation seed from the document's current content; file checkpoint alone seeds from filtered Git HEAD, empty when absent from HEAD. | `U` ghost-seeding matrix (explorer, application) |
| 6.3-02b | A pre-upgrade store with an empty ghost and non-empty document re-seeds from the document once at next open, keeping unsaved buffer work pending; a deliberate current-version empty ghost survives. | `U` marker lifecycle (storage, application) |
| 6.3-03 | Pending ranges map through transactions, persist as anchors, and become mixed when edited inside. | `A03`; `U` mapping/anchor persistence |
| 6.3-04 | Keep, Revert, mixed confirmation, Mark reviewed, revert delivery, and author retention follow the hunk contract; a revert segment carries the hunk author's attribution. | `A03`; `U` action transitions, attribution retention; `E` Mark reviewed |
| 6.3-11 | Keep, Revert, and Mark reviewed send an agent-authored hunk's author a `kept`/`reverted` verdict with a capped excerpt, never its own diff; undo before delivery retracts it. | `U` verdict recording, slice targeting, undo retraction, integration flow |
| 6.3-05 | Ghost advances hunk by hunk only and never due to disk write, close, detach, or expiry. | `A04`, `A07`, `A12`; `U` ghost invariants |
| 6.3-06 | One ordered undo/redo history per document across typing and application steps; a step's undo restores only what it owned; Save, Send, and Copy end application history; history survives tab switch and is dropped on close. | `A06b`; `UR` (typing, pending hunk, Keep, interleaved redo, comment survival, source mode, tab switch); `U` frame restore, annotation inverse, coordinator order; `U` main undo/redo and boundaries |
| 6.3-07 | Pending status/authorship survive restart; reopen recomputes differences and the tab shows a count. | `E` partial-review restart; `U` rehydrate matching |
| 6.3-08 | A newer divergent buffer prompts Recover/Discard and overwrites neither side silently. | `A06` |
| 6.3-09 | Dirty close offers Save/Discard/Cancel; Discard resets buffer and removes buffer-only pending hunks next open. | `A07`; `E` Save/Cancel branches |
| 6.3-10 | Open rename follows the session and ghost once; closed rename seeds a new entry and retains the old one. | `A08`; `U` closed-rename case |
| 6.4-01 | Explorer shows only Markdown, honors Git ignore, skips `node_modules`, breaks symlink loops, and deduplicates overlaps. | `U` scanner matrix; `E` explorer list |
| 6.4-02 | Scan seeds missing ghosts; Refresh discovers additions/removals. | `U` Scan/Refresh; `E` controls |
| 6.4-03 | Directory checkpoint matches Scan and folders are not watched in the background. | `U` directory checkpoint/no-watch |
| 6.4-04 | Roots start expanded and subfolders collapsed; root rows show `parent/name` with the name never elided and the full path as tooltip; right-click on any row offers Copy full path. | `RS` label/tooltip/context-menu clipboard |
| 6.5-01 | Selection exposes C/Q/S, highlights quotes, and allows cross-block comment/question quotes. | `E` selection and keyboard flow |
| 6.5-02 | CLI-created agent annotations have author badges and per-agent colors. | `E` agent annotation rendering |
| 6.5-03 | Comments store free text. | `U` annotation kind cases |
| 6.5-04 | Questions accept replies from either side. | `U` reply cases; `SC` thread UI |
| 6.5-05 | Suggestions render track changes; accept-all/reject-all is per agent and ordered; accepted overlap skips and reports. | `U` bulk/overlap; `E` bulk controls |
| 6.5-06 | Suggestions and direct edits share a panel/rendering while keeping distinct actions. | `E` unified changes panel |
| 6.5-07 | Accept updates shadow/ghost as user work carrying the suggestion author's attribution — delivered to others as a plain user hunk, never back to its author; Reject only emits rejection; neither saves. | `A15`; `U` Reject transition, attribution retention, recipient filter |
| 6.5-08 | Anchors use exact quote plus up to 32 context characters, map live, enforce single-block suggestions, stack overlaps, and never fuzzy-apply. | `A09`; `U` anchor matrix; `E` stacked highlights |
| 6.5-09 | Orphan and reattach each emit one event; orphaned suggestions cannot be accepted. | `A09`; `U` event idempotence/reattach |
| 6.5-10 | Any annotation accepts replies; all listed actions get monotonic per-document sequence numbers. | `U` event sequence matrix |
| 6.5-11 | Resolve hides by default but retains data until resolved annotations are cleared. | `U` retention; `E` filter/clear |
| 6.5-12 | Annotations live only in the ghost entry and never alter the document. | `A15`; `U` storage boundary |
| 6.5-13 | Lead accept is external and Lead-tagged, leaves a pending hunk, moves no ghost, records the Lead as event actor, and never returns the event to the Lead; Revert of its hunk leaves the annotation resolved `accepted`. | `AC` Lead round; `U` actor-aware accept/reject/state transitions |
| 6.5-14 | Any agent resolves only its own annotations; the Lead resolves anyone's; reply and resolve stay reachable for unresolved orphans. | `AC` orphan lifecycle; `U` resolve permission cases |
| 6.6-01 | Agents have independent baseline, queue, and cursor. | `A01`, `A14`, `A15`; `U` recipient isolation |
| 6.6-02 | Attachments panel shows name, attach time, and waiting/working/pending state. | `E` panel state matrix |
| 6.6-03 | Attachments persist, use configurable 24-hour default idle expiry, never expire with unacknowledged work, and receive closed after queued deliveries. | `A12`; `U` clock/closed ordering |
| 6.6-04 | A later concurrent attach for the same id supersedes the earlier call. | `U` held-call integration |
| 6.6-05 | Nudge copies the exact one-line prompt. | `E` clipboard assertion |
| 6.6-06 | One Lead per document: claim, first-come denial naming the holder, user transfer/revoke authoritative, death with the attachment including restore-time expiry. | `AC` claim/transfer; `U` lead lifecycle including restart past idle timeout |
| 6.6-07 | Panel disconnect ends the attachment like detach, confirming first when non-message deliveries would be discarded. | `AC` disconnect confirm and cancel |
| 6.6-08 | A queued message never blocks idle expiry (predicate and live scheduler alike); a queued Send delivery still does. | `U` expiry predicate; `E` scheduler timer with message-only queue |
| 6.7-01 | Persistent changes panel lists ghost-relative hunks and jumps to them. | `E` changes-panel navigation |
| 6.7-01b | A Save that changed the file appends a round (before/after snapshots, time, activity authors); a no-change Save appends nothing; rounds and their snapshots survive restart uncapped. | `U` save-history matrix (storage, application); `SH` restart persistence |
| 6.7-01c | The rail lists rounds as collapsed summaries below the review groups, newest first, in plain words; expansion fetches read-only hunks from the round's own snapshots, excluding unsaved work. | `SH` history rows; `U` saveRound serving |
| 6.7-02 | Send enables only for unsent activity some recipient can receive; a segment attributed to the sole attached agent alone does not enable, its verdict does. | `E` enablement matrix; `U` predicate, integration flow |
| 6.7-03 | Composer accepts an optional free-text note. | `A01` |
| 6.7-04 | Composer selects all agents by default and shows a checklist for multiple agents. | `A15`; `SC` recipient deselection |
| 6.7-05 | The composer lists per-recipient items with checkboxes: user changes and comments checked, changes not made by the user unchecked, one shared selection across recipients. | `E` item list and defaults |
| 6.7-06 | Composer gives the exact count/warning for user changes based on unseen external content, beside the external group. | `E` warning and preview |
| 6.7-07 | Ctrl/Cmd+Enter sends from the composer. | `E` keyboard send |
| 6.7-08 | The Exact text view exactly equals delivered `text`, exclusions included. | `E` preview-to-payload equality |
| 6.7-09 | Send does not save. | `A15` |
| 6.7-10 | Send freezes and persists one ordered delivery per selected recipient; later edits/Sends cannot mutate it. | `A01`, `A12` |
| 6.7-11 | Delivery includes ordered user segments, selected external segments, note, cursor-bounded annotation events, and the recipient's verdicts; never a segment or event the recipient authored. | `A01`, `A14`, `A15`; `U` full content matrix, recipient filter |
| 6.7-15 | A deselected item is excluded, the baseline and cursor still advance past it, it is not offered again, and the payload carries `partial` with the plain line. | `U` skip semantics, slice exclusions, integration flow |
| 6.7-16 | A stale preview token refuses the Send with a plain error and a fresh preview sends. | `U` token guard; integration race |
| 6.7-17 | A recipient with nothing to receive shows "Nothing new for this agent"; a resync recipient shows the catch-up notice and ignores selection. | `U` resync exemption; `E` composer notices |
| 6.7-18 | The composer resizes from its corner, remembers its size, and zooms with the pane zoom. | `E` resize and zoom; `U` settings normalization |
| 6.7-12 | Oldest queued delivery wakes attach; baseline/cursor/queue move only after flushed output acknowledgment; unacknowledged id repeats. | `A02`, `A12`; `U` acknowledgment states |
| 6.7-13 | Missing baseline snapshot returns full-buffer resync and sets current baseline. | `U` forced-GC resync |
| 6.7-14 | Copy for agent has its own baseline, starts full, then incremental, moves only after clipboard success, and ignores Save. | `A13`; `U` clipboard failure |
| 6.7-15 | A message queues, wakes a blocked attach, persists across restart, repeats until acknowledged, and its acknowledgment moves no baseline or cursor. | `AC` message round trip; `U` empty-range endpoints both queue orders |
| 6.7-16 | One unacknowledged message per sender→recipient pair; multi-recipient send is all-or-nothing with nothing enqueued on failure. | `U` blocked-pair three-recipient case |
| 6.8-01 | Executable/setup/remove/default behavior is repeatable per platform (Linux desktop entry, icon, and MIME; macOS link-only with the bundle association) and agent help is verbatim §7. | `S` verbatim help; `U` setup idempotence per platform; `M` desktop and Finder integration |
| 6.8-02 | CLI runs as plain Node with `ELECTRON_RUN_AS_NODE=1`, not as a browser launch. | `S` bootstrap; `M` process check |
| 6.8-03 | A generic harness needs only repeatable commands, stdout, and an id; timeout zero polls immediately. | `A01`, `A12` |
| 6.8-04 | Only attach blocks by design; default is 600 seconds; cold open/attach returns when session exists. | `U` timing/argument cases; `E` cold launch |
| 6.8-05 | Online commands use the socket/shadow; named offline commands lock atomically and prefer newer buffer; startup shares the lock. | `U` offline/online and lock races |
| 6.8-06 | CLI open with a ghost difference enters review mode. | `A07`; `E` direct-document edit then open |
| 6.8-07 | State is read-only and exits 2 without a path or focused document. | `U` side-effect and exit-code cases |
| 6.8-08 | JSON annotation batches validate atomically and report all failures with exit 3. | `U` batch validation |
| 6.8-09 | Stdout/stderr JSON, exit codes, UTF-8, and multiline stdin follow the protocol. | `U` CLI protocol matrix |
| 6.8-10 | Sessions and ghost entries identify documents by realpath. | `A08`; `U` symlink identity |
| 6.8-11 | Exit 3 covers every refused-by-state code with machine-readable detail; the six new verbs are online-only and never launch the app. | `U` exit-code and offline-refusal matrix |
| 6.9-01 | Handoff controls appearance and PRD controls behavior when they conflict. | `M` handoff screen/overlay comparison |
| 6.9-02 | Renderer ports prototype markup, styling, and transitions into React/Tailwind with direct ProseMirror and main data. | `S` dependency/component boundaries; `M` prototype parity |
| 6.9-03 | Native frame is on; drawn window controls are absent; toolbar remains in-window. | `S` BrowserWindow options; `E` shell |
| 6.9-04 | Prototype demos island is absent. | `E` shell assertion |
| 6.9-05 | Fonts are bundled and no Google Fonts link remains. | `S` asset/URL scan; `SC` network denial |
| 6.9-06 | Panels resize only within handoff ranges and persist sizes. | `SC` drag/restart |
| 6.9-07 | Ambient motion defaults on, respects reduced motion, and pauses during typing. | `E` motion policy |
| 6.9-08 | Upright Baloo 2 and real Nunito italic share the family mapping; owner approves by eye. | `S` font-face declarations; `M` owner check |
| 6.9-09 | User is pink; agents cycle grape, sky, mint, tangerine in attach order. | `U` assignment; `E` computed colors |
| 6.9-10 | A second path launch opens a tab in the existing instance. | `RS` process/tab assertion |
| 6.9-11 | Each tab owns a session; initial pathless attach/state targets the focused tab. | `SC` multi-tab routing |
| 6.9-12 | Explorer, CLI, file manager, and drag/drop can open files. | `RS` explorer/drop; `A07` CLI; `M` file manager |
| 6.9-13 | Both extensions are associated (Linux MIME database; macOS bundle declaration) and the default handler changes only by explicit owner action (`setup --default` on Linux; Finder steps it prints on macOS). | `U` generated entries and bundle configuration; `M` desktop database and Finder |
| 6.9-14 | Keyboard reaches every review, annotation, composer, conflict, and banner control. | `SC` keyboard-only flows |
| 6.9-15 | XDG config/fallback persists every named setting. | `U` schema/path matrix; `SC` font/color/panel restart |
| 6.9-16 | Explorer, editor, and right rail zoom text independently by hovered pane via Ctrl/Cmd+=/−/wheel within 0.5–2.0; window zoom is disabled; one `Reset zoom` text button restores 1.0 and appears only while zoomed. | `U` factor clamp/normalize; `SC` hover-targeted shortcuts, reset, restart |
| 6.9-17 | Rail rows are compact maps: author/kind/two-line change rows, formatted snippets never raw syntax, plain-everyday copy per the v15 vocabulary with tooltips included and no file paths in rows, click centers the target with no new jump decoration. | `AC` review board; `E` copy strings |
| 6.9-18 | The thread panel floats, moves, resizes with persisted size and unpersisted position, opens beside the span (orphans at last session position or centered), defaults ~660px with 330px minimum, and matches editor body type size. | `AC` long-document thread and resize persistence |
| 6.9-19 | The annotation composer resizes with persisted size at unchanged defaults and position. | `AC` composer resize |
| 6.9-20 | Save state is always visible (Save button state, tab dot, footer sentence); changes group as Proposed/Unsaved/Saved with per-group counts and per-hunk classification; the annotations header counts open and removed-text; the top-bar total tints while anything is unsaved; Revert on a Saved hunk returns the unsaved state. | `AC` save-state flow; `U` per-hunk classification including the mixed case |
| 6.10-01 | Deleted-open tab stays with banner; Save recreates; attachments survive. | `EC` deleted-file flow |
| 6.10-02 | Rename/move follows §6.3. | `A08` |
| 6.10-03 | Save permission failure preserves shadow and state and shows an error. | `U` injected write failure; `EC` read-only directory |
| 6.10-04 | Invalid UTF-8 is read-only source with banner and no ghost. | `U` invalid bytes; `EC` open/no-ghost; `SC` keyboard banner |
| 6.10-05 | Large documents retain full visual editing, review, annotations, Save, and Send; size alone never forces source-only mode. | `U` large-document parser/editor; `EC` >2 MB visual edit/review/Send |
| 6.10-06 | Hash check catches external write racing Save. | `A05` |
| 6.10-07 | Crash recovery follows §6.3. | `A06` |
| 6.10-08 | Missing ghost-referenced file is struck through and retained until forgotten. | `U` scanner state; `EC` explorer/forget |
| 6.10-09 | A pane failure shows the pane card with the rest of the window working; a root failure shows the window card; Reload restores from main with the newest keystrokes intact; each failure is recorded exactly once; uncatchable failures change no UI. | `CC` all three cases |
| 6.10-10 | A renderer process death reloads the window once; a repeat within a minute closes it, and a window is recreated on the next launch or connection. | `S` gone-handler wiring; `RS` window recreation |

## §6.11 state model

| ID | Event/invariant | Verification |
|---|---|---|
| 6.11-01 | Open without ghost reads disk/recovery, seeds ghost, and computes external pending. | `U` state table |
| 6.11-02 | Open with ghost reads disk/recovery, recomputes pending, and retains matching authorship. | `U` state table |
| 6.11-03 | First user edit after external/Send maps pending, marks overlap mixed, snapshots, and opens user segment. | `A03`; `U` state table |
| 6.11-04 | Later user edit changes shadow and maps/mixes without another boundary. | `U` state table |
| 6.11-05 | Save atomically writes after hash check and advances only nonoverlapping user ghost regions. | `A04`, `A05`; `U` state table |
| 6.11-06 | External document/buffer change updates disk when applicable, patches shadow, adds attributed pending, and opens external segment. | `A03`, `A14`; `U` state table |
| 6.11-07 | Changed stores a next-segment tag only. | `A14`; `U` state table |
| 6.11-08 | Conflict pick incoming updates shadow and leaves pending. | `SC` conflict choice; `U` state table |
| 6.11-09 | Conflict pick mine retains shadow and removes incoming hunk. | `SC` conflict choice; `U` state table |
| 6.11-10 | Keep advances current hunk region in ghost and removes pending. | `A03`; `U` state table |
| 6.11-11 | Revert restores ghost text, confirms mixed, and removes pending. | `A03`; `U` state table |
| 6.11-12 | Mark reviewed advances all pending regions and clears them. | `E` review action; `U` state table |
| 6.11-13 | Accept replaces span, advances ghost, counts as user with the author's attribution, and routes accepted event. | `A15`; `U` state table |
| 6.11-14 | Reject changes no document state and routes rejected event. | `U` state table; `E` suggestion rejection |
| 6.11-15 | Annotation action appends a monotonic event. | `U` state table |
| 6.11-16 | Send snapshots, opens user segment, and persists recipient deliveries. | `A01`; `U` state table |
| 6.11-17 | First attach sets current baseline and latest cursor. | `A01`; `U` state table |
| 6.11-18 | Attach collection returns oldest without state movement before acknowledgment. | `A01`, `A02`; `U` state table |
| 6.11-19 | CLI acknowledgment advances baseline/cursor and removes delivery. | `A01`, `A02`; `U` state table |
| 6.11-20 | Timeout, state, and changes have no attachment side effects. | `A12`, `A14`; `U` state table |
| 6.11-21 | Close applies Save/Discard, drops shadow, persists review/segments/attachments, and orders closed after deliveries. | `A07`, `A12`; `U` closed ordering |
| 6.11-22 | Detach or eligible idle expiry deletes attachment. | `U` state table |
| 6.11-23 | Checkpoint reseeds ghost and clears pending. | `U` state table |
| 6.11-24 | Copy advances clipboard baseline only after successful clipboard write. | `A13`; `U` state table |
| 6.11-25 | Message send queues per recipient; acknowledgment removes it with baseline and cursor unchanged. | `U` state table |
| 6.11-26 | Lead accept replaces the span, opens a Lead-tagged external segment with a Lead-authored pending hunk, and routes the accepted event with the Lead as actor. | `U` state table |

## §6.12 acceptance scenarios

| ID | Scenario | Executable test |
|---|---|---|
| 6.12-01 | Late collection receives frozen Send content; later edits arrive later. | `A01` |
| 6.12-02 | CLI death before output flush acknowledgment repeats the same delivery id. | `A02` |
| 6.12-03 | Mixed proposal confirms Revert; Keep preserves the user's edit. | `A03` |
| 6.12-04 | Save writes shadow and leaves proposals, including overlap, pending. | `A04` |
| 6.12-05 | A disk write immediately before Save forces resolution. | `A05` |
| 6.12-06 | Crash recovery offers Recover and preserves newer buffer and disk. | `A06` |
| 6.12-07 | Close Discard removes buffer-only pending on reopen. | `A07` |
| 6.12-08 | Open rename follows one session and one ghost entry. | `A08` |
| 6.12-09 | Missing suggestion quote becomes orphaned and cannot Accept. | `A09` |
| 6.12-10 | Corpus no-op is byte-identical and structural edits stay minimal. | `A10`; `U` visual/raw construct matrices and borrowed real corpus |
| 6.12-11 | Own mirror/Save writes never become external review. | `A11` |
| 6.12-12 | Unacknowledged delivery survives timeout, close, restart, and idle expiry. | `A12` |
| 6.12-13 | Save does not move the clipboard recipient baseline. | `A13` |
| 6.12-14 | Agent edits stay hidden from peers unless included or queried with changes. | `A14` |
| 6.12-15 | Accept changes editor only, notifies author, and reaches a peer as user work. | `A15` |
| 6.12-16 | Message acknowledgment advances nothing; the next Send delivery is unchanged by it. | `AC`; `U` delivery endpoints |
| 6.12-17 | A queued message never blocks expiry; a queued Send delivery still does. | `U` expiry cases; `E` live timer |
| 6.12-18 | Lead accept is never user-authored, always leaves a pending hunk, and Lead save leaves it pending. | `AC` Lead round |
| 6.12-19 | One Lead per document; a second claim fails naming the holder; the Lead dies with its attachment. | `AC`; `U` lead lifecycle |
| 6.13-01 | Themes carry values only; all seven stock themes declare all 40 swatches and six non-color values explicitly, and Strata's complete definition is the fallback for every missing or invalid value. | `U` schema counts, stock completeness, normalize/fallback matrix; `M` built-in visually identical |
| 6.13-02 | User theme files are sparse with `schema-version: 2`, ids fixed at creation, unknown keys preserved, broken files listed and never applied; a stock-theme copy carries every value. | `U` store/slug/create/copy; `E` broken-file listing |
| 6.13-03 | Every color in the app derives from theme tokens, attribution colors included. | `S` no color literal outside the token layer; `E` computed attribution colors |
| 6.13-04 | Edits apply on the same frame and reach the file within a moment; the themes directory is watched; external writes apply live; a deleted active file keeps its values and is marked missing. | `E` fast path, own-write suppression, external reload, deletion |
| 6.13-05 | The floating panel never dims the app, is movable and resizable with persisted geometry, edits only the active theme, and offers exactly Revert to when opened, New from this, Use default, Delete, rename. | `SC` panel geometry/restart, swatch to file, external highlight, revert |
| 6.13-06 | `stratamd state` reports the active theme; `stratamd theme` prints set and default values with descriptions and problems, offline. | `A` CLI on a sparse file |
| 6.13-07 | Ambient background and window styles come from the animation handoff's eight options at two scales, colors mixed from accents, gated by the toggle and reduced motion. | `U` element counts per style/scale; `SC` style switch; `M` handoff parity |
| 6.13-08 | Fonts list through the platform inventory (`fc-list` on Linux, the system font query on macOS) with the bundled fallback; no renderer permission is requested. | `U` parsing/fallback for both platforms' output; `E` permission denial unchanged |

## §7 agent contract

| ID | Requirement | Verification |
|---|---|---|
| 7-01 | `--agent-help` reproduces §7 verbatim, including the attach/respond/re-attach loop and stop condition. | `S` byte comparison |
| 7-02 | First attach targets named/focused document, opens if needed, and returns whole annotated buffer, paths, and id immediately. | `A01`; `E` focused/cold attach |
| 7-03 | Later attach immediately returns queued Send or blocks, returns user deltas/events/notes, and excludes others by default. | `A01`, `A14`, `A15` |
| 7-04 | Sends queue across absence/restart; timeout retries; closed arrives after queued work. | `A12`; `U` closed ordering |
| 7-05 | Annotate enforces exact unique/context quote rules, cross-block comment/question rules, single-block suggestion rules, JSON batches, and proposal-only behavior. | `A09`, `A15`; `U` quote/batch matrix |
| 7-06 | Reply supports all annotation threads and stdin. | `U` reply CLI |
| 7-07 | State equals first-attach content without attachment changes. | `U` read-only comparison |
| 7-08 | Changes returns all current unreviewed external hunks. | `A04`, `A14`; `U` hunk shape |
| 7-09 | Changed tags only a following write. | `A14`; `U` timing matrix |
| 7-10 | Open displays direct edits in review mode. | `A07`; `E` offline direct edit |
| 7-11 | Checkpoint handles file/directory with the common seeding rule. | `U` checkpoint matrix |
| 7-12 | Detach ends the named attachment. | `U` detach CLI |
| 7-13 | Payload always names buffer; buffer changes editor; no CLI agent path writes document; stale writes remain reviewable. | `A03`, `A15`; `E` stale write |
| 7-14 | Own edits return to their author only when external content is explicitly included. | `A14`; `U` author filter |
| 7-15 | Explicit id wins; otherwise harness session id is stable or fresh; name precedence is explicit, `AI_AGENT`, then id. | `U` identity environment matrix |
| 7-16 | Help documents send, lead, accept, reject, resolve, and save with the doorbell loop and Lead trigger wording; state lists attachments with states and the Lead. | `S` verbatim help; `AC` state discovery |

## §8 payload

| ID | Requirement | Verification |
|---|---|---|
| 8-01 | Attach/state/changes print one JSON object and `text` alone loses no information. | `A01`, `A14`; `U` text completeness |
| 8-02 | Version 11 schema and event-specific omission match the documented object. | `U` schema matrix |
| 8-03 | All nine event kinds have documented semantics. | `A01`, `A12`; `U` event matrix |
| 8-04 | Send/resync/closed carry delivery id, repeated until acknowledgment. | `A02`, `A12`; `U` resync/closed |
| 8-05 | Segments are ordered, before-state based, 1-based, attributed, and externally filtered. | `A01`, `A14`, `A15`; `U` exact hunk fixtures |
| 8-06 | Annotations contain all events after cursor with author/status/current line/replies and latest cursor. | `A15`; `U` cursor matrix |
| 8-07 | Every `text` starts with the exact buffer-only guardrail naming both paths. | `U` every event |
| 8-08 | Initial/resync/state/send/closed/changes render the specified body content. | `A01`, `A12`, `A14`; `U` render fixtures |
| 8-09 | Annotation markers, suggestions, replies, resolutions, and literal-bracket escaping match the contract. | `U` payload rendering |
| 8-10 | `edits` carries the recipient's verdicts with capped quotes; `partial` and its plain line appear exactly when content was left out; user segments never carry a tag. | `U` payload rendering, delivery filters |
| 8-10 | Note/text limits are 64 KB; large document content is delivered without a size-triggered resync. | `U` boundary values; `E` large-document delivery |
| 8-11 | Message payloads carry `from`, notes only, the documented `text` rendering, and the 4 KB note bound; `state` carries `attachments` for open documents only. | `U` message rendering and bounds; `AC` state field |

## §9 files on disk

| ID | Requirement | Verification |
|---|---|---|
| 9-01 | Only Save writes document and nothing is written beside it. | `A04`, `A11`, `A15`; `U` directory inventory |
| 9-02 | XDG/fallback layout on both platforms (macOS data under `~/Library/Application Support/StrataMD`), realpath hash, object addressing, and 0700/0600 modes match the tree. | `U` layout/mode matrix for Linux and Darwin; `M` host permissions |
| 9-03 | Meta updates atomically, including annotation/review consistency across faults. | `U` write fault injection |
| 9-04 | GC removes only unreferenced blobs and caps history at 200 without dropping referenced snapshots. | `U` reference/GC matrix |
| 9-05 | Forget from UI/CLI removes entry and only unreferenced blobs. | `U` forget; `E` explorer action |
| 9-06 | Meta has format version and older formats migrate on open. | `U` migration fixtures |
| 9-07 | The failure log is JSON lines under `logs/` with store modes, warnings and errors only, rotating once at 2 MB; malformed or untrusted renderer reports are dropped. | `U` log contract; `U` report-channel guards |

## §10 architecture and stack

| ID | Requirement | Verification |
|---|---|---|
| 10-01 | Electron, CLI, socket, and editor share TypeScript and one binary. | `S` build/source boundaries |
| 10-02 | Main owns file/state/store/scan/diff/watch/socket/instance/config work. | `S` import/IPC boundaries |
| 10-03 | Renderer owns UI only and enforces custom protocol, isolation, sandbox, CSP, window denial with same-origin-only navigation, IPC validation, and safe external schemes. | `S` BrowserWindow/protocol config; `E` security probes |
| 10-04 | Direct ProseMirror toolkit is used with StrataMD schema/parser/serializer and no prebuilt Markdown editor. | `S` dependency/import policy; `U` editor model |
| 10-05 | Socket path/fallback, modes, peer UID, held attach, and connection-independent attachment state match the contract. | `U` socket integration; `M` mode/credential check |
| 10-06 | Diff is Myers line diff and byte preservation keeps hunks minimal. | `A10`; `U` diff fixtures |
| 10.1-01 | Language is TypeScript throughout. | `S` source inventory |
| 10.1-02 | Build uses electron-vite and only local unpacked electron-builder output. | `S` scripts/config; `M` local build |
| 10.1-03 | Parsing uses micromark/mdast GFM/frontmatter with offsets and excludes `prosemirror-markdown`. | `S` dependency/import policy; `U` offsets |
| 10.1-04 | Serializer emits original unchanged blocks and neighboring conventions for edits. | `A10`; `U` full corpus |
| 10.1-05 | Editor dependency set is the specified ProseMirror toolkit and tables. | `S` manifest/imports |
| 10.1-06 | Diff uses jsdiff `structuredPatch`. | `S` import; `U` hunk shape |
| 10.1-07 | Watcher uses `@parcel/watcher`, never `fs.watch`. | `S` import scan |
| 10.1-08 | Socket uses Node net with newline-delimited JSON and held requests. | `U` fragmented/multiple message integration |
| 10.1-09 | Panels use React/Tailwind and mount ProseMirror uncontrolled. | `S` renderer inspection |
| 10.1-10 | Vitest covers pure logic and Playwright Electron covers attach/Send/collect and all §6.12 cases. | `A01` through `A15`; pure suites remain required |

## §11 environment and security

| ID | Requirement | Verification |
|---|---|---|
| 11-01 | Only the owner's Linux workstation, Macs on macOS 13 or newer, and listed local filesystems are supported. | `M` ext4/btrfs/xfs/tmpfs and APFS matrix |
| 11-02 | Setup and setup-remove are the only install lifecycle. | `U` idempotent setup; `M` desktop state |
| 11-03 | App makes no network calls and renderer never fetches remote resources. | `S` URL/CSP scan; `E` deny/log all requests |
| 11-04 | Socket/store are same-user only (`SO_PEERCRED` on Linux, `getpeereid` on macOS); agent ids attribute rather than authenticate. | `U` peer UID and modes; `M` host ownership |
| 11-05 | Only the Lead's save writes documents through StrataMD and everything it writes stays pending; suggestions require user or Lead acceptance with Lead accepts left pending; direct/buffer writes remain reviewable. | `A03`, `A15`; `AC` Lead save; `E` command boundary |
| 11-06 | Missing or ambiguous annotation quotes fail instead of creating orphans. | `U` exit-3 cases |

## §12 success criteria

| ID | Criterion | Verification |
|---|---|---|
| 12-01 | An agent given only §7 can attach, read/comments, annotate, and receive another round in a generic command harness. | `E` agent-help-only flow |
| 12-02 | No Send is lost before acknowledgment across close/restart. | `A02`, `A12` |
| 12-03 | No-op save is byte-identical. | `A10`; full corpus `U` |
| 12-04 | Own/other external edits are excluded unless included or queried through changes. | `A14` |
| 12-05 | Save leaves all pending agent work pending. | `A04` |
| 12-06 | Buffer reads expose unsaved user edits; buffer writes update editor without disk. | `A03`, `A04`, `A11` |
| 12-07 | Every net ghost difference appears on next open, including edits while app was stopped. | `E` checkpoint/offline-edit/reopen |
| 12-08 | Installed agent help runs from shell and explicit default selection makes file-manager open work. | `M` local setup and double-click |

## Release use

Run `pnpm exec playwright test --list` first. It must list the 15 original §6.12 tests; scenarios 16–19 run in the `AC` suite. Then run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm exec playwright test`. A green build with open `U`, `E`, `S`, or `M` rows is not PRD completion.
