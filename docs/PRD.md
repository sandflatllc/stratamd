# StrataMD product requirements

Status: draft v24 · 2026-09-02 · personal Linux and macOS tool

## 1. Summary

StrataMD is a desktop markdown editor for writing documents *with* AI agents. You edit the rendered document, not the syntax. Any agent, from any chat harness, attaches itself to the document you have open with one shell command. From then on it reads your editor buffer, saved or not, along with your comments; each time you press **Send** it receives only what you changed since it last looked, plus your note. It answers with comments, questions, and proposed edits that you accept or reject in place. When an agent edits a file directly, StrataMD shows you exactly what it changed as track-changes, whether the file was open at the time or you open it afterwards.

StrataMD knows nothing about the harness. You type "attach to the doc I have open in Strata" in T3 Code, Haru, Claude Code, or anything else that can run a command, and the agent becomes a participant in that edit session.

It runs as a local desktop app on the owner's Linux workstation or a Mac on macOS 13 or newer, with a `stratamd` CLI on PATH.

## 2. Goals

1. **Edit rendered markdown** without mangling the parts you didn't touch.
2. **Hand agents a diff, not a document.** After the first look, every Send carries only your changed hunks, their line positions, annotations, and your note.
3. **Agent attaches itself.** One command is the whole integration. No host protocol, no adapters, no required environment variables.
4. **See every agent edit.** StrataMD keeps a private copy of the last version of each document you reviewed, so edits made outside the editor are shown as track-changes for you to keep or revert.
5. **Two-way annotation layer.** You and agents comment, question, and suggest on quoted text. Nothing is ever written inside or beside the document.
6. **Run locally.** The owner's own machines only, Linux and macOS; local setup provides the CLI and desktop integration.

## 3. Non-goals

- Not a note-taking system, vault, or sync product. Documents are independent files on disk.
- Not an IDE. No terminal. The explorer shows markdown files only.
- Not a chat client. Conversation with the agent stays in the harness. StrataMD never starts a thread, picks a model, or lists agents.
- No cloud component, accounts, or telemetry.
- No Windows support, installer, or auto-updater. The Mac build ships as an unsigned zip on a GitHub Release; no signing, notarization, DMG, or update channel.
- No attempt to preserve every markdown dialect in the visual editor. Unsupported constructs render as raw blocks and round-trip byte-for-byte.
- No attempt to identify which process wrote a file. Attribution of external edits is best-effort (§13).

## 4. Users

- **Primary:** an individual who reviews and edits agent-written documents (plans, specs, SOPs, research) and wants the agent to see exactly what they changed.
- **Secondary:** agents, as callers of the CLI.
- **Tertiary:** other local tools that want to display a markdown file with annotations by invoking StrataMD.

## 5. Core concepts

| Term | Meaning |
|---|---|
| **Document** | A `.md` file on disk, identified by realpath. A realpath identifies a path, not a durable document: a file moved while StrataMD is closed is a new document. StrataMD writes it only on Save. |
| **Shadow** | The editor's working buffer. Mirrored to `buffer.md` in the ghost store, where agents read and write it. |
| **Ghost** | Per document: the last content the user reviewed. Advances hunk by hunk on user actions, never wholesale. Drives review mode and the changes panel. |
| **Ghost store** | StrataMD's data directory (§9). Holds, per document, the ghost, the buffer mirror, pending hunks, segments, the save history, annotations, attachments, and deliveries. |
| **Reading state** | Private per-document presentation and navigation choices stored separately in `reading.json`; never Markdown and never agent traffic. |
| **Snapshot** | A content-addressed copy of the shadow at a point in time. |
| **Segment** | The changes between two consecutive snapshots, with an author: `user` (edited through the StrataMD UI, including Keep, Revert, and Accept) or `external` (anything else). A new segment starts on every author change, every detected external write, and every Send. The only authorship record. |
| **Tag** | Optional agent id and name recorded by `stratamd changed` before an edit, applied to every external segment until it expires or another tag replaces it (§6.2). Without one, an external segment is "external." |
| **Save round** | One Save that changed the document: its before and after snapshots, its time, and the contributors active since the previous save. Appended to the save history on Save; listed read-only in the changes panel (§6.7). |
| **Hunk** | A contiguous change between two states: start line, removed lines, added lines. |
| **Pending hunk** | An external change applied to the shadow but not yet kept or reverted. Has a range mapped through later edits, and a status: `pending`, or `mixed` once the user has edited inside it. |
| **Review mode** | Pending hunks and pending suggestions rendered as track-changes with Keep / Revert or Accept / Reject. |
| **Annotation** | A comment, question, or suggestion anchored to a quoted span, rendered highlighted. Authored by the user or an agent. |
| **Session** | One open document plus its attachments. |
| **Attachment** | Per agent per document: agent id, name, baseline, delivery queue, annotation cursor. Created by the agent's first `attach`; persisted; survives calls, document close, and app restart. |
| **Agent id** | Stable identifier for one agent across calls, used for attribution and delivery, not authentication. Issued by StrataMD on the first call or supplied by the agent. |
| **Baseline** | Per attachment: the snapshot and segment index the agent has acknowledged seeing. Advances only on acknowledgment. |
| **Delivery** | An immutable per-recipient payload frozen at Send: baseline → the Send snapshot, notes, include-external flag, annotation range. Has an id. Stays queued until acknowledged. |
| **Send** | The user action that snapshots the shadow and creates one delivery per selected recipient. Does not save. |
| **Message** | A note (up to 4 KB) from one attachment to another, frozen as a delivery with an empty range: queued, collected, and acknowledged like any delivery, but advancing no baseline or cursor and carrying no segments or annotation events. Dropped with its attachment; never blocks expiry. |
| **Lead** | The at-most-one attachment per document that may `accept`, `reject`, `resolve` others' annotations, and `save`. A cooperative safeguard, not authentication. |
| **Clipboard recipient** | A pseudo-attachment with its own baseline, used by Copy for agent. |
| **Explorer** | Sidebar listing markdown files under folders the user added, with Scan and Refresh to create ghosts. |

## 6. Functional requirements

### 6.1 Editor

- Visual (WYSIWYG) editing of CommonMark + GFM. Editable visually: headings (ATX and setext), paragraphs, emphasis, strong, strikethrough, code spans, links, autolinks, images, lists (ordered, bullet, loose, tight, nested), task lists with interactive checkboxes, tables, fenced and indented code blocks, blockquotes, horizontal rules, hard and soft line breaks, escapes, and entities.
- Rendered as raw blocks, byte-preserved, editable in source view only: YAML frontmatter (collapsible), footnotes, wiki links `[[...]]`, HTML blocks (never rendered as HTML), math, and link reference definitions.
- Formatting toolbar and keyboard shortcuts for all visually editable constructs, following common editor conventions with the platform's primary modifier — Ctrl on Linux, Cmd on macOS (Ctrl/Cmd+B bold, Ctrl/Cmd+I italic, Ctrl/Cmd+K link, Ctrl/Cmd+Shift+C code, Ctrl/Cmd+1..6 heading level, Ctrl/Cmd+Shift+7/8 ordered/bullet list, Ctrl/Cmd+S save, Ctrl/Cmd+Enter send, Ctrl/Cmd+/ source view, Ctrl/Cmd+F find, F7 / Shift+F7 next / previous change).
- **Find.** Ctrl/Cmd+F opens a find bar in the editor pane, in visual and source view alike. The search is a case-insensitive substring match; every match is marked, the current one distinctly and scrolled into view, with a "3 of 12" count. Enter and Shift+Enter (also F3 and Shift+F3) step forward and back with wrap-around; Escape closes the bar, lands the caret on the current match, and returns focus to the editor. The search follows a view toggle.
- **Next / previous change.** F7 and Shift+F7 step through pending hunks and open suggestions in document order, wrapping around, centering each in the editor with the same flash a rail row click gives.
- Spellcheck is the platform's. Code spans and code blocks are rendered with `spellcheck="false"` so paths and identifiers inside them are never flagged; prose is checked as the platform checks it.
- Source view toggle (raw markdown, same buffer). Syntax typed in source view that the visual schema cannot represent becomes a raw block.
- Local images resolve relative to the document and render from disk through a main-process handler that only serves paths under the document's directory or an explorer folder. Remote images and any other remote URL are never fetched; a placeholder is shown.
- A fenced code block whose info string is exactly `mermaid` renders as a diagram in visual view. Mermaid is bundled, loaded only after such a block enters an open document, initialized once with strict security, and permitted no remote resource access. The diagram offers **Diagram** and **Source**, zoom out/in/reset, and pointer or keyboard pan. Source is the ordinary editable code block; renderer-only compatibility normalization never changes its Markdown. A render failure shows a plain error and leaves Source available.
- A fenced code block whose info string is exactly `tree` renders as a read-only, accessible file hierarchy in visual view. Indentation and the ordinary `├──`, `└──`, and `│` guides determine nesting; malformed input shows the preserved source with a plain explanation. **Tree** and **Source** switch presentation without changing Markdown.
- Clicking or pressing Enter on a rendered local image opens inspection inside the center editor window, with its alt text, optional title, resolved path, close control, fit/reset, zoom, and pan. The same path policy and custom protocol used for inline images serve the focused image; remote images never gain inspection. Image and diagram zoom, pan, source/presentation choice, and focus are session-only and survive document-tab switches until that tab closes.
- Activating an ordinary Markdown link to a local `.md` or `.markdown` file, or an inline code span whose complete text resolves to one, opens a bounded preview beside the reference without navigating away. The preview names the file, shows its title and a short plain-text excerpt, and has an explicit **Open document** action. Resolution is relative to the current document, follows realpaths, allows only the document directory or an explorer root, rejects non-Markdown, remote, missing, and outside-root targets, and reads at most 256 KiB. Other code spans stay code; external links keep their existing safe external-open behavior.
- Every visual heading has a disclosure control. Collapsing it hides content through the next heading of the same or a shallower level and shows counts of unresolved annotations and pending changes inside. Folded heading references are private durable state in `reading.json`; all heading levels use the same conservative text/parent/adjacent-context relocation rule as walkthrough headings. Find, F7/Shift+F7, and Changes or Annotations jumps temporarily reveal a hidden target and restore the fold when the target changes, unless the owner explicitly changed that fold.
- **Registered component tags.** Four exact Pascal-case tags are recognized as top-level component blocks in ordinary `.md` files: `Callout`, `Verdict`, `MetricStrip`, and `PhaseBoard`. A component uses a separate opening and closing tag at column 1 on block boundaries and contains one or more ordinary Markdown blocks. Its children remain directly editable in visual view; Source exposes the wrapper and properties. Components cannot nest. The bounded component scanner ignores fenced code and parsed containers, recognizes only registered wrappers, parses their semantic properties without MDX, and parses each Markdown body once while retaining the wrapper span plus every child span.
- The registry is closed. Unknown tags and registered names used inline remain raw HTML under the source-only rule above. A registered block with invalid syntax, an expression, a boolean or duplicate property, an unknown property, an invalid value, no body, or a nested component is byte-preserved and shown as a source-only error card naming the problem. It never executes or renders HTML.
- Component properties carry meaning, never presentation. `Callout` accepts only optional `kind="context|warning|implication|support"` (default `context`). `Verdict` accepts only optional `outcome="recommended|caution|blocked|neutral"` (default `neutral`). `MetricStrip` and `PhaseBoard` accept no properties. No component accepts colors, fonts, dimensions, class names, styles, imports, JavaScript, expressions, event handlers, application tabs, rails, dialogs, toolbars, file operations, or agent controls. The active theme owns every surface and state color.
- Editing one component child rewrites only that child's smallest grammar-safe source span while retaining the original opening tag, closing tag, properties, child gaps, and every untouched child byte. An untouched component round-trips byte-for-byte. A structural child edit may enlarge only within that component body; it never rewrites a neighboring top-level block.
- `Callout` presents context, warnings, implications, or supporting notes; `Verdict` presents the controlling judgment; `MetricStrip` groups a short Markdown list of argument-carrying figures; `PhaseBoard` groups ordered phase headings, prose, and tables. These presentations use existing Strata theme jobs and semantic headings, preserve the wide document measure, expose one accessible component label, and add no author-selected layout.
- The Phase 7 performance probe uses a 2,101,246-byte `PhaseBoard` corpus. Across three paired runs, median ready time was 2,279.1 ms with Phase 7 disabled and 2,312.6 ms enabled (+1.47%); median editor transaction time was 10.5 ms and 9.0 ms respectively. Both stay inside the 10% regression budget, and the component edit remains below 100 ms.
- **Extended registered components.** `DecisionMatrix`, `BeforeAfter`, `Chart`, `EvidenceChain`, and `AnnotatedScreenshot` use the same top-level closed-registry syntax, validation, editable-child, error, theme, and byte-preservation rules. `Timeline` is not registered: status and filtering remain ordinary tables, while a static timeline remains Mermaid.
- `DecisionMatrix` accepts no properties and contains exactly one GFM table whose first header is `Criterion` and whose remaining two to six columns are alternatives. It keeps the source table editable, gives criteria strong row boundaries, and lets the reader focus an alternative column without changing Markdown.
- `BeforeAfter` accepts no properties and contains exactly two blockquotes. Each blockquote starts with an H3 heading naming its side and may contain ordinary Markdown beneath it. The two sides are presented together when width permits and stack in source order when narrow.
- `Chart` accepts only optional `kind="line|bar"` (default `line`) and contains exactly one GFM table. The first column supplies category labels; one to six remaining columns supply finite numeric series, with at most 1,000 data rows. The table remains the editable and accessible source of truth beneath a read-only chart. Chart.js 4.5.1 is bundled in a lazy chunk; StrataMD passes only prepared label/number arrays, registers only line/bar requirements and the built-in legend and tooltip, disables parsing and animation, accepts no document-defined plugins or script callbacks, and makes no network request. A render failure leaves the table and a plain explanation. Six `visuals.category-*` theme jobs own series colors in every stock theme.
- `EvidenceChain` accepts no properties and contains H3 sections named exactly `Claim`, `Evidence`, and `Therefore` in that order. Evidence is a Markdown list and every item contains an explicit local Markdown link or same-document heading link; numeric shorthand alone is invalid. The ordinary links retain StrataMD's bounded preview and explicit-open behavior, while activating the claim, evidence item, or conclusion keeps the connected parts visibly synchronized.
- `AnnotatedScreenshot` accepts no properties. Its body contains exactly one local Markdown image followed by one GFM table with headers `Pin`, `X`, `Y`, `Image version`, and `Note`. Pin numbers are positive unique integers; X and Y are percentages from 0 through 100; the version is StrataMD-generated local file size and nanosecond modification time; and the note is nonempty. Visual view uses that one decoded image for inline focus and numbered overlays, presents synchronized pin notes, and offers **Place pin** to the owner. Activating a pin opens an ordinary question composer anchored to the complete pin row with structured component-line, image, and pin context. If the current image version differs from any stored row, pins remain in place and the component says `Image changed — verify pin positions`; **Positions are correct** updates only the version cells through the normal document edit path. Source exposes every durable value.
- `stratamd pin` is the only supported agent path for adding coordinates. It targets an `AnnotatedScreenshot` by its opening line from `stratamd validate`, checks X/Y and the component schema, reads the allowed local image version, assigns the next pin number, escapes the note into the existing table, and sends one agent-attributed buffer change through the running app. It never writes the document directly. Owner pin placement uses the same row shape through an editor transaction.
- **Byte-preserving save.** Invariant: every syntactic region the user did not touch is written back from its original bytes. Each top-level block keeps its source span; unchanged blocks are emitted verbatim, edited blocks are re-serialized. The serializer may enlarge the rewritten region when the grammar requires it (a paragraph becoming a setext heading, list continuation, a changed link reference definition) and must keep it as small as the grammar allows. Preserved in untouched regions: list marker and emphasis delimiter style, hard wraps, indentation, trailing whitespace, CRLF line endings, a UTF-8 BOM, and a missing final newline.
- Save is atomic (temp file and rename in the document's directory, preserving mode). Immediately before writing, Save re-reads and hashes the document; if it differs from the last known disk content, the change is handled as external first (§6.2) and the user is asked to resolve any conflict before the write proceeds.
- Save is the only StrataMD action that writes the document. After Save the ghost equals the shadow with each pending hunk's region replaced by that hunk's ghost text, so pending external hunks stay pending.
- A Save that changed the file appends one round to the document's save history: the replaced content, the written content, the time, and the contributors active since the previous save (§6.7). A Save that changed nothing appends nothing. The round's author list means activity — it includes a contributor whose edit was later overwritten or undone — and is fixed at Save because segments are pruned later. The Lead's save (§6.6) records exactly like the user's.

### 6.2 Buffer file and external changes

- The shadow is mirrored to `buffer.md` in the document's ghost entry on every change, debounced, written atomically (temp and rename). Agents read it to see unsaved edits and write to it to propose edits. A write to `buffer.md` is merged into the shadow exactly like an external change to the document; the document on disk is untouched until the user saves.
- Every payload tells attached agents to edit the buffer only. StrataMD does not prevent writes to the document, since neither Linux nor macOS offers an enforceable lock against rename-based writes. It handles them as external changes.
- StrataMD ignores its own writes by content hash: a watcher event whose content equals the last mirror or Save it wrote is not an external change.
- **External change handling.** When the document or `buffer.md` changes on disk while open:
  1. Read the file and compare its hash to the last known contents; ignore if equal.
  2. Compute the patch from the last known contents to the new.
  3. Snapshot the shadow before applying; this closes the current segment and opens an `external` one, carrying the pending tag if one was set.
  4. Apply the patch to the shadow for blocks with no unsaved edits, record the resulting hunks as pending, and show them in review mode. A block is a conflict when the patch touches it and the user has edited it since the source was last written (since the last Save for a document write; since the last mirror write for a `buffer.md` write). The user picks the incoming side or their own for each conflict.
  5. Do not touch the ghost or any attachment baseline.
- A stale write, meaning an agent writing a whole buffer from an older copy, appears as an external change that reverses the user's newer edits. That is shown in review mode like any other external change; the user reverts it. StrataMD does not attempt a three-way merge against what the agent might have read.
- Attribution comes only from the tag. `stratamd changed` must run before the edit; a tag set after the fact applies to the next write, not the last. Each detected external write still opens its own segment, but the tag covers every external write until it expires or another agent's tag replaces it: using the tag slides its five-minute window forward, so one logical edit applied as several file writes carries one name throughout. A tag never used expires after 5 minutes, so an agent that tags and never writes cannot claim a later edit made in another editor. The accepted residue: a write by a different program landing within five minutes of a tagged agent's last write is attributed to that agent.
- Detection watches the document's directory and the ghost entry, so temp-and-rename writes are seen. Watch events are wake-ups, not a log: every event triggers a read and hash compare. StrataMD also re-reads and compares on open, on window focus, immediately before Save, after a watcher error or overflow, and on app start. Only local filesystems are supported.

### 6.3 Review mode and the ghost

- Every document StrataMD has opened, checkpointed, or scanned has a ghost. When the shadow differs from the ghost, the difference is rendered in place as track-changes: deletions struck through, insertions marked, each pending hunk with an author badge (the tag name, or "external"). Hunks that cannot render inline (table columns, cross-block deletions, malformed intermediate markdown) appear as a review card in the changes panel with before/after text. Review mode works in source view as well.
- **Ghost seeding**: open, Scan, and offline store creation seed from the document's current content and show nothing pending — a document's baseline is itself, and no commit ceremony is needed before review works. `stratamd checkpoint <file>` alone seeds from `HEAD` read through git's content filters (so line-ending conversion does not create a spurious diff) inside a git work tree; a file absent from `HEAD` gets an empty ghost, showing the whole document as one insertion — now a deliberate request to review everything, not a default. Outside a git work tree checkpoint seeds from the current content.
- A store created under the old rule whose ghost is empty while the document is not carries an upgrade marker and re-seeds from the document once, at its next open; unsaved buffer work stays pending, everything saved counts as reviewed. A deliberate empty ghost created by checkpoint afterwards survives reopening.
- Pending hunk ranges are mapped through every editor transaction while the document is open (ProseMirror position mapping) and stored as text anchors when closed. If the user edits inside a pending hunk it becomes `mixed`.
- Per pending hunk: **Keep** applies the hunk's current region to the ghost and clears it. **Revert** restores the ghost's text in the shadow and clears it; on a `mixed` hunk it asks for confirmation and states that the user's edits inside will be discarded. The revert is a user edit that records the hunk author's attribution on its segment: it reaches *other* agents as a user hunk on their next delivery, never its author (§6.7). **Mark reviewed** keeps all remaining pending hunks. Keep and Revert do not change a hunk's author, and each tells an agent-authored hunk's author its verdict: the author's next delivery carries a `kept` or `reverted` entry with a one-line excerpt, not its own text as a diff. Undoing the Keep or Revert before that delivery retracts the entry.
- The ghost advances only hunk by hunk. Keep and Mark reviewed apply pending hunks. Save applies the user's own hunks by the rule in §6.1; a user hunk overlapping a pending external hunk leaves that region pending and the hunk `mixed`. The ghost never advances because the file changed on disk, and is not touched on close, detach, or attachment expiry.
- **Undo and redo.** Typing and application steps (Keep, Revert, Accept, Mark reviewed, requote, conflict resolution, external merge) share one history per document, walked in the order they happened; undo reverses exactly the most recent step and redo reapplies it. Undoing an application step restores only what it owned: the shadow change, its ghost and pending-hunk side effects, and the annotation records it changed. Annotations added after the step stay. An external merge enters the history as one step; undoing it is an ordinary user edit, reaches agents as a user hunk, and leaves the pending hunk cleared. A Lead accept (§6.5) enters the history the same way. Undoing an Accept or Revert cancels its own user hunk, so agents see nothing. Save, Send, and Copy for agent end the application-step history because their effects have been written or delivered; typing history continues across them. Any new edit, application step, or annotation action clears redo. History survives switching tabs and is dropped on close.
- Pending hunks, their status, and authorship are persisted, so partial review survives close and restart. On open, pending hunks are recomputed as diff(ghost, shadow); persisted authorship is kept where the hunk still matches, otherwise the hunk is `external`. Closing a tab with pending hunks leaves them for the next open; the tab shows a count.
- **Crash recovery.** On open, if `buffer.md` differs from the document and is newer than the last Save, the user is offered **Recover** (shadow = buffer) or **Discard** (shadow = disk, buffer reset). StrataMD never silently overwrites either side.
- **Close.** Closing a tab with unsaved edits offers Save, Discard, or Cancel. Discard resets `buffer.md` to disk; pending hunks that existed only in the buffer disappear on the next open by the recompute rule above.
- Renaming or moving a document while open: the session and its ghost entry follow the new realpath, read from the open file descriptor (`/proc` on Linux, `F_GETPATH` on macOS). While closed: the new path is a new document, seeded by the ghost seeding rule; the old entry remains until forgotten (§9).

### 6.4 Explorer

- A sidebar showing only `*.md` / `*.markdown` files under folders the user has added, honoring `.gitignore` inside git work trees and skipping `node_modules`. Symlink loops and overlapping folders are detected; each file appears once. Files are shown under the subfolders they sit in on disk, nested as on disk, never flattened; subfolders with no markdown files are not shown. Every folder row, root or nested, collapses and expands on click; added folders start expanded and subfolders start collapsed. A root folder row shows its folder name preceded by at most one parent segment (`parent/name`); the name is always fully visible and the parent segment is what gets elided when space runs out. Hovering a folder row for about a second shows the full path in a tooltip. Right-clicking any folder or file row opens a menu with Copy full path, which copies the absolute path to the clipboard; on a root folder row the menu also offers Remove folder, which takes the folder out of the explorer while its documents stay remembered (§9).
- **Scan** on a folder creates a ghost for every file that lacks one, by the ghost seeding rule. **Refresh** rescans for new and removed files.
- `stratamd checkpoint <dir>` does the same from the shell. There is no background watching of folders.

### 6.5 Annotations

- User selects text → floating menu: Comment (`C`), Question (`Q`), Suggest edit (`S`). The selection becomes the annotation's quote and is rendered highlighted. A comment or question may quote a span of any length, across blocks, to mark what should be read alongside it.
- Agents create annotations with `annotate` (§7). Agent-authored ones are visually distinct: author badge, color per agent.
- Kinds:
  - `comment`: free text.
  - `question`: free text, expects an answer; either side replies inline.
  - `suggestion`: replacement text in markdown, shown as inline track-changes with Accept / Reject. Accept-all / reject-all per agent, applied in document order; a suggestion overlapping an already-accepted one is skipped and reported.
- Suggestions and direct agent edits share one rendering and one panel: a suggestion is a proposed hunk (Accept / Reject); a direct edit is an applied hunk (Keep / Revert). Agents use suggestions for small inline proposals and direct edits for rewrites.
- **Accept** replaces the quoted span in the shadow, advances the ghost for that hunk, and records it as a `user` change carrying the suggestion author's attribution: other agents receive it as a plain user hunk on their next delivery, and it is never delivered back to its author, who gets the `accepted` event instead. **Reject** emits `rejected`. Neither saves.
- **Lead accept** (§6.6) is never user-authored: it applies the replacement as an `external` segment tagged with the Lead, creates a pending hunk authored by the Lead, and does not move the ghost; the user reviews it with Keep or Revert like any agent edit. The `accepted` and `rejected` events record the Lead as their author (and are not delivered back to it); other agents receive the change as an external segment under the include-external rule. A user Revert of the Lead's hunk removes the text while the annotation stays resolved `accepted`: both records stand, as two facts about two actors, and the suggestion's author may receive `accepted` for text later reverted. There is no hunk-to-annotation linkage.
- Anchoring: exact quote plus up to 32 characters of prefix/suffix context, mapped live through editor transactions while open. A suggestion's quote must lie within a single top-level block; comments and questions have no such limit. Annotations may overlap; nested highlights render as stacked. On load, re-locate by exact match, then by context, else mark **orphaned** and list in the sidebar; never guess onto other text. An orphaned suggestion cannot be accepted; there is no fuzzy apply. Orphaning emits one event; reattachment on a later load emits one event.
- Replies: any annotation can have them, including orphaned ones. Every create, reply, resolve, accept, reject, orphan, and reattach is an annotation event with a monotonic `seq` per document.
- Resolve/dismiss hides the annotation from the default view; it stays stored until the user clears resolved annotations. An open suggestion offers Accept and Reject in its thread too; choosing Resolve on it first asks for confirmation, in plain words, that resolving hides the suggestion without changing the text. Any agent may resolve annotations it authored; only the Lead may resolve anyone's (§6.6). Reply and resolve stay reachable in the UI for any unresolved annotation, orphaned ones included (§6.9 Thread tab).
- **Decisions.** `decision` is a structured annotation, not document content. It has a prompt, at least two distinct non-empty options, implicit **Other**, and an explicit anchor of `quote`, `heading`, or `document`. Quote and heading anchors retain the same exact-text location data as ordinary annotations; a heading anchor must be one complete ATX heading line. A document anchor is its own stored kind with no invented empty quote or editor range. The owner or an attached agent may create a decision. Its ordinary replies hold clarifying discussion before or after an answer.
- **Decision answers and ownership.** Only the owner can answer or reopen a decision. An answer records `{seq, option, other, author: "user", answeredAt}` in append-only structured answer history: `option` is one stored option and `other` is absent, or `option` is null and `other` is non-empty. It also emits one `answered` event, appears as a readable reply-like entry in the thread and payload, and resolves the decision. Reopening emits `reopened`, returns it to open while preserving every prior answer, and allows another owner answer. An agent, including the Lead, that runs `answer` or tries to `resolve` a decision is refused with exit 3 and `DECISION_OWNER_REQUIRED`; it may reply instead. An unanswered decision informs agents but never blocks edits, Send, or other commands.
- **Decision delivery and document edits.** Decisions, answers, replies, and reopenings use the existing per-recipient annotation cursor and Send checkboxes. A new answer is selected by default in the next Send. New-decision payloads carry their structured options, anchor kind, and answer history; answers to an older decision also travel in an `answers` list with enough parent data to understand the choice. Answering never changes Markdown. If the answer calls for a document edit, that edit arrives separately through the ordinary Changes flow.
- Storage: the document's ghost entry. The document itself is never modified by annotations.

### 6.6 Attachments

- Multiple agents can attach to one document, each with its own baseline, delivery queue, and cursor.
- The attachments panel shows each agent: name, time attached, and state: **waiting** (a blocked `attach` call is open), **working** (no call open, nothing queued), or **pending** (a delivery is waiting to be collected).
- An attachment persists until the agent runs `detach` or it has been idle (no call) for a configurable period, default 24 hours. An attachment with an unacknowledged delivery never expires; a queued message (§6.7) does not block expiry and is dropped with the attachment. Closing the document does not end it: the agent's next call receives `event: "closed"` after any queued deliveries. Attachments are persisted, so an app crash or restart loses nothing.
- Two concurrent `attach` calls for the same agent id: the later one wins; the earlier returns `{"event":"superseded"}`.
- A **nudge** action copies a one-line prompt to the clipboard ("Run `stratamd attach --as <id>` and continue.") for harnesses where the agent has stopped listening.
- **The Lead.** At most one attachment per document holds the Lead, which gates `accept`, `reject`, `resolve` on others' annotations, and `save` (§7). An agent claims it with `stratamd lead`; a claim while another attachment holds it fails, naming the holder. The user grants, transfers, or revokes it from the panel in one click: user actions are authoritative, agent claims are first-come. The Lead dies with its attachment (detach, disconnect, or idle expiry) and is never held by an absent agent. It is a cooperative safeguard: agent ids attribute rather than authenticate (§11), so it stops the honest-but-confused agent; deliberate impersonation is out of scope. Users may confer it in any wording ("take the lead", "you're the overseer", "conduct this edit"); the agent help maps those to the verb. The panel marks the holder and shows the Lead control on every row.
- **Disconnect.** The panel can end any attachment, the same path as agent `detach`, cancelling a blocked attach call. When the attachment holds queued non-message deliveries, it confirms first and names what will be discarded; a message-only queue disconnects without a prompt.

### 6.7 Send and delivery

- Persistent **changes** panel listing hunks against the ghost, with jump-to.
- **Save history** in the changes panel, below the review groups: one collapsed summary row per save round, newest first — "Last save" on top, older rows labeled by their time — each naming the round's active contributors in plain words ("you and Claude"; the anonymous author reads "someone else"). Expanding a row fetches the round's hunks on demand from its own snapshots and renders them read-only: no Keep, no Revert, no jump, because the round's text may no longer exist in the document. Rows are collapsed by default because a round's diff legitimately overlaps the review groups above — an unreviewed hunk that was saved is both — and showing the same text twice would misread as two changes. A round's diff is between its own snapshots, so the newest row excludes unsaved work.
- **Send** button, enabled when there are user hunks, new annotations, replies, resolutions, or verdicts since the last Send that at least one recipient did not author itself; a user segment carrying an agent's attribution counts only when someone other than that agent could receive it. Opens a composer with:
  - free-text note (optional)
  - recipients: all attachments by default; a checklist if more than one
  - what each recipient gets, one tab per selected recipient since baselines differ, as individual items with checkboxes: the user's changes and comments checked by default, changes not made by the user unchecked by default (this replaces the old global include-external toggle), grouped and rendered like the changes and annotations panels. One selection applies to every recipient that would receive the item.
  - a warning when any user hunk in this Send sits on top of an external segment the recipient has not seen: "N of your changes build on changes not made by you," beside that group
  - an **Exact text** view, one toggle away, showing the delivered `text` (§8). What is shown is what is delivered.
  - `Ctrl/Cmd+Enter` sends
  - the composer resizes from its corner and remembers its size; it zooms like the panes (§6.9)
- **Deselecting an item skips it**: the delivery excludes it, the recipient's baseline and cursor still advance past it on acknowledgment, and it is not offered again. The agent still sees the resulting text in the buffer. A recipient whose delivery would carry no items shows "Nothing new for this agent" and receives the note, if any. A recipient needing a full resync shows a plain catch-up notice in place of checkboxes; item selection does not apply to it.
- **A stale preview cannot send.** Each preview carries a token of the document state it was computed against; Send compares it and refuses with a plain error when the document changed in between, and the composer previews again. The frozen delivery therefore always equals the preview the user saw.
- **Send does not save.** Agents see the buffer, so saving is the user's decision alone.
- **On Send**, StrataMD snapshots the shadow (closing the current segment) and creates one delivery per recipient, frozen: recipient baseline → this snapshot, the note, the include-external flag, and the annotation events from the recipient's cursor to the latest `seq`. Deliveries are persisted. Later edits never enter an existing delivery; a later Send to the same recipient creates another delivery, and the composer shows that it will follow the queued one.
- **Delivery content:** the `user` segments in the range, each as hunks against the state before it (the first from the recipient's baseline); the `external` segments in the range only when included by selection; the note; the annotation events and the recipient's verdicts. A segment the recipient authored — its own external writes, or a Keep, Revert, or Accept of its work — is never delivered back to it, whichever author recorded it, and events the recipient authored itself (its own annotations, replies, and resolutions) are never delivered back to it either; the cursor and baseline still advance over all of them. An annotation created in the range is delivered once with its whole thread; a reply to an annotation created before the range — or whose creation the user deselected — is delivered as the reply alone, keyed by annotation id, never with the earlier thread. When anything in range was left out (deselected items, or external changes left unchecked), the payload says so: `partial: true` and one plain line, "Parts of the document changed that are not included here." Removed lines and context of a user hunk may still show text that came from an excluded segment; the warning and the partial line cover this.
- **Collection and acknowledgment.** A blocked `attach` receives the oldest queued delivery at once; otherwise the next call does. The CLI acknowledges the delivery id after it has written the payload to stdout and flushed. Only then does the baseline advance to the delivery's snapshot and segment index, the cursor to its last `seq`, and the delivery leave the queue. An unacknowledged delivery is returned again on the next call, with the same id.
- **Resync.** If a baseline snapshot is missing (garbage-collected after a long absence) the next delivery is `event: "resync"` with the full buffer, and the baseline is set to the current snapshot.
- **Messages (agent to agent).** Send remains the user action; `stratamd send` is the agent action, and it carries only a note (up to 4 KB) from one attachment to every other one, or to named recipients. A message is frozen as a delivery with an empty range: it queues, wakes a blocked `attach` immediately, persists, and is collected and acknowledged exactly like a Send delivery, but acknowledging it advances no baseline or cursor and it carries no segments or annotation events, so the user's unsent work can neither leak nor be skipped. At most one unacknowledged message per sender→recipient pair; a further send to that recipient fails until collection. A multi-recipient send is all-or-nothing, checked before anything is enqueued. Success means queued, not read. The payload names the sender and points the recipient at `state` and `changes`, which are read commands any agent may run unprompted; the substance of agent collaboration belongs in annotation threads and tagged segments, which the user can audit, not in messages, which are gone once acknowledged.
- **Copy for agent.** When no agent is attached, Send is replaced by Copy for agent, which renders a delivery for the clipboard recipient and puts its `text` on the clipboard. The first copy is the whole buffer; later copies contain changes since the previous copy. Its baseline advances only after the clipboard write succeeds. Save never moves it.

### 6.8 CLI

The commands and their semantics are in §7. Requirements:

- `stratamd` is a launcher script (`bin/stratamd`) that runs the CLI as plain Node inside the app's Electron binary (`stratamd-app` beside it on Linux, `StrataMD.app/Contents/MacOS/StrataMD` on macOS); the app executable is separate. `stratamd setup` links the launcher onto PATH; on Linux it also installs the `.desktop` entry and icon and registers the MIME association, while on macOS the `.app` bundle itself declares the association. `stratamd setup --remove` undoes what setup did on that platform — on macOS that is only the link, and deleting the `.app` completes removal. Both are safe to repeat. `stratamd --agent-help` prints §7 verbatim; `--help`, `-h`, and `help` print the one-screen usage with a pointer to it; `--version` prints `{version, protocol, payload, cli, app}` (the app version from package.json, the protocol and payload versions, the CLI path, and the app executable). `stratamd doctor` runs without the app and prints the socket path, whether it answers and at which protocol, the data and config directories, the log path with its last five error records, every lock file under `docs/*/lock` with its pid and whether that process is alive, both versions, and a `problems` list; it exits 0 and changes nothing. `stratamd setup --skill <claude|codex|agents|dir>` copies the bundled skill (`skills/stratamd`) into that harness's skills directory and refreshes a stale copy; packaged builds ship `skills/` beside `resources/`.
- The CLI runs as plain Node (`ELECTRON_RUN_AS_NODE=1`), so a command costs a process start, not a browser launch.
- What a harness needs: the ability to run a command repeatedly, capture its stdout, and carry a short id between runs. Harnesses that cannot hold a command open use `--timeout 0`, which returns at once with a queued delivery or `{"event":"timeout"}`. Harnesses with a per-command limit pick a `--timeout` below it; a call the harness kills is safe, since the delivery is not acknowledged and repeats on the next call.
- `attach` is the only command that blocks by design, for at most `--timeout` seconds (default 90, chosen to sit under the 120 s command limit common to agent harnesses; the socket deadline is the timeout plus 15 s). `open` and `attach` also block for app launch when no instance is running, returning as soon as the session exists, before the window paints. "No instance" means the socket connection failed (absent or refused); a request the instance accepted but did not answer in time exits 4 (`INSTANCE_TIMEOUT`) and never launches a second instance or falls back to an offline handler. `INSTANCE_UNREACHABLE` carries `detail.socket` and `detail.log` (the log path) and points at `stratamd doctor`.
- Version handshake: every request carries the protocol version. The instance answers a well-formed request from another version with `PROTOCOL_MISMATCH` (exit 4) before validating anything else; the message names both versions and says "restart StrataMD to pick up the new build" when the app is older or "update the stratamd command" when the CLI is older. The CLI raises the same error itself when a response's version differs from its own, so an instance too old to know the code is still reported clearly.
- When an instance is running, every command goes through it over the local socket (§10), so quotes are validated against the shadow and the instance owns the ghost store. When none is running, `annotate`, `reply`, `state`, `changes`, `changed`, and `checkpoint` operate on the file and ghost store directly, under a per-document lock file with temp-and-rename writes; the app takes the same lock on startup, so a command in flight cannot race it. Offline commands treat the document on disk as the current content unless a newer `buffer.md` exists, in which case they use the buffer.
- `open` on a document whose shadow differs from its ghost opens it in review mode. This is how an agent shows the user what it changed.
- `state` is read-only: no agent id required, no attachment created, no baseline or cursor moved. With no file given and no document open it exits 2. Every `state` payload carries `open` (whether the document is open in the instance) and `theme`; `attachments` only for an open document. `state --brief` omits `document`, `text`, and `annotations`. `--text-only` on `state` and `attach` omits `document`; `text` already renders the whole buffer with annotations inlined, so the payload halves for a large document and nothing is lost. `state --annotations` omits `document` and reduces `text` to the open-questions list, leaving `annotations` as the content. `state --raw` prints the buffer verbatim to stdout with no JSON, so quotes can be copied from it or piped to a file. The four views are exclusive.
- `docs` lists the documents open in the instance as `{file, buffer, focused, dirty, attachments}` rows from the tab registry and the sessions. It has no offline mode and never launches the app.
- `components [name] [--json]` works offline and reports the closed registry, each component's purpose, accepted properties and values, body guidance, and one complete source example. With an exact name it reports that schema alone; an unknown name exits 2 with `COMPONENT_NOT_FOUND`. The readable form and JSON form describe the same contract.
- `validate <file> [--json]` works offline, reads without rewriting, and returns the realpath, `valid`, every recognized component with its source line, and all problems with stable codes, line, column, component, property when applicable, and a plain fix. Invalid component syntax, properties, values, empty bodies, nesting, and unknown Pascal-case component-like tags make `valid` false; ordinary HTML is not reported as a component problem. A valid result contains `problems: []`. Validation itself exits 0 when it can read and inspect the file; a missing file exits 2.
- `pin <file> --component <line> --x <0..100> --y <0..100> --note "<text>" [--as <id>]` is online-only. It requires an attached agent, targets the valid `AnnotatedScreenshot` opening at that exact one-based line, verifies the allowed local image, assigns the next integer pin, and creates an agent-attributed buffer edit. Invalid coordinates are usage errors; a missing component or image exits 2; invalid component shape or a changed/unavailable image is refused with exit 3 and a dedicated code. It returns `{pinned, component, x, y, note}` and never writes the document itself.
- `edit` is a compare-and-swap change to one or more passages. Each match is located in the live shadow under annotate's quote rules (exact, unique, `precededBy`/`followedBy` to disambiguate; exit 3 `QUOTE_INVALID` with the detail shape below otherwise). An empty `match` with `precededBy` or `followedBy` is a zero-width point located by that context alone (`precededBy: ""` is the start of the document, `followedBy: ""` its end), and `append: true` is the end of the buffer with no match; both work on an empty document, which is how an agent inserts without an anchor. `--dry-run` locates every match and returns `{located: [{line, match}]}` without changing the buffer. The mirror is flushed first, then the replaced text is merged as an external buffer change tagged with the agent, exactly as a `changed` followed by a buffer write: a pending hunk in the agent's name, the ghost unmoved, and no conflict against the agent's own match. `--json` is all-or-nothing like `annotate --json`; edits that overlap exit 3 (`EDITS_OVERLAP`, detail lists both matches). The result's `line` is where the change begins in the buffer after the edit. `edit` has no offline mode and never launches the app.
- `annotate --json` is all-or-nothing: every quote is validated first, and one failure creates nothing (exit 3, detail lists each failing entry).
- Output: every command prints its result on stdout as one JSON object: the payload for `attach`, `state`, `changes`, and `docs`; `{created: [{id, kind, quote}]}` for `annotate`; `{replied, annotation}` for `reply`; `{applied: [{line, match, replace}]}` for `edit`; `{pinned, component, x, y, note}` for `pin`; a one-key object (`sent`, `lead`, `accepted`, `rejected`, `resolved`, `saved`, `tagged`, `opened`, `checkpointed`, `detached`) for the rest; `{"ok": true}` when a command has nothing else to report, so empty stdout never means success. Errors on stderr as one JSON object `{error, code, detail}`; exit codes 0 success, 1 usage (an unknown option lists the valid ones in `detail.valid`; a wrong argument count says what was expected), 2 not found (file, annotation, attachment, component, image; the message and detail name the id or path), 3 refused by document state (quote missing or ambiguous with candidates listed; Lead held or required, `NOT_LEAD` naming the holder; message pending; save blocked; edits overlapping; invalid component or unverified changed image), 4 instance unreachable, stalled, or from another build. `code` is SCREAMING_CASE and machine-readable (`QUOTE_INVALID`, `LEAD_TAKEN`, `NOT_LEAD`, `MESSAGE_PENDING`, `SAVE_BLOCKED`, `EDITS_OVERLAP`, `COMPONENT_NOT_FOUND`, `COMPONENT_INVALID`, `IMAGE_NOT_FOUND`, `IMAGE_VERIFICATION_REQUIRED`, `INSTANCE_TIMEOUT`, `INSTANCE_UNREACHABLE`, `PROTOCOL_MISMATCH`, `NOT_FOUND`, `ANNOTATION_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`) and `detail` carries the specifics. Every anchor failure, in `annotate`, `edit`, or a Lead `accept` of a suggestion whose text moved, goes through one formatter: `detail` is an array with one entry per failing input, `{index, quote, reason, message, total, candidates, hint, exact}`, where `reason` is `missing`, `ambiguous`, `multi_block`, or `whitespace`; `total` counts the places the quote could mean; each candidate is `{line, before, quote, after}` with `before` and `after` about 40 characters on a word boundary, so they can be passed back as `--preceded-by` and `--followed-by`; `hint` says what to do for that reason; and `exact` (with `whitespace`) is the buffer's own text when the quote matched only after CRLF and whitespace-run normalization. Exact matching stays the applied rule. When exactly one input failed, its message is the top-level `error`. `MESSAGE_PENDING` names every blocked recipient in `detail.recipients` and the unblocked ones in `detail.others`. `NOT_LEAD` and `LEAD_TAKEN` carry `detail.holder` (`{agent, name}`, or `null` when nobody holds it and the message says to run `stratamd lead`). `ATTACHMENT_NOT_FOUND` and `ANNOTATION_NOT_FOUND` carry the id and the file in `detail`. After a delivery has been printed, a failed `ack` is a warning on stderr and exit 0: the same delivery repeats on the next attach. All I/O is UTF-8; multi-line `--text` is accepted via stdin with `--text -`.
- `send`, `lead`, `accept`, `reject`, `resolve`, `save`, `docs`, and `edit` require the running instance: they have no offline mode and never launch the app.
- Identity: `--as` if given, else the harness-session id; without either, only a first `attach` mints a fresh id. `annotate`, `edit`, `reply`, `send`, `lead`, `accept`, `reject`, `resolve`, `save`, `changed`, and `detach` exit 1 instead, telling the agent to pass the id its first attach returned. The session hash mixes in `CLAUDE_CODE_CHILD_SESSION` when set, so a subagent never inherits its parent's attachment; sibling subagents are not distinguishable from the environment and pass `--as`. `annotate`, `edit`, and `reply` with an `--as` the document does not know exit 2 (`ATTACHMENT_NOT_FOUND`) with "run stratamd attach first" rather than creating anything under an unknown id.
- Documents are identified by realpath (symlinks resolved), for sessions and ghost entries alike.

### 6.9 App shell and design

- **The design is the handoff in `docs/design/`** (`docs/design/README.md`, `StrataMD App v2.dc.html`, `support.js`, and `animations-handoff.md` for the ambient animation system). It is the source of truth for layout, every screen and overlay, tokens, typography, spacing, motion, and interaction feedback. This PRD does not restate it. Where the handoff and this PRD disagree on behavior, the PRD wins; where they disagree on appearance, the handoff wins.
- **Implementation starts from the prototype, not from prose.** The renderer is built by porting the prototype's markup, styles, and state transitions into React + Tailwind components, replacing the mock document area with the ProseMirror view and the class-component state with data from the main process. Reuse and adapt before rewriting; write from scratch only what the prototype does not contain.
- Deltas from the handoff, decided here:
  - Native window frame (`frame: true`). KDE draws the title bar; the drawn – □ × controls are dropped and the top bar is an in-window toolbar row.
  - The "Prototype demos" island is prototype-only and is not ported.
  - Fonts are bundled; the prototype's Google Fonts links are not copied (§11).
  - Panels are user-resizable within the handoff's ranges, and sizes persist in `settings.json`.
  - Ambient motion defaults on, honors `prefers-reduced-motion`, and pauses while keystrokes arrive. The owner explicitly confirmed the handoff's animated presentation is the intended default on 2026-08-28. The built-in theme's ambient styles are the animation handoff's defaults, `Rising motes` for the background and `Glow orbs` inside windows (§6.13).
  - Typography: Baloo 2 stays for all upright text. Because Baloo 2 has no italic face, Nunito Italic is registered under the same family name with `font-style: italic`, so emphasized text gets a real italic in a matching rounded design instead of a synthesized slant. Owner confirms by eye in the prototype before the typography pass is closed. A theme may name any installed family for text and for code; the Nunito italic mapping applies only when the text font is Baloo 2.
  - Agent colors are assigned in attach order from the handoff palette after pink (reserved for the user): grape, sky, mint, tangerine, then repeat. The colors themselves come from the active theme's `people` group (§6.13).
  - **The right rail is a map, decided 2026-08-30.** Rows are compact click targets; clicking centers the target in the editor, where the span is already marked (annotations by the selected-annotation highlight, hunks by track-changes). A change row shows the author (you, the agent's name, or "external"), whether it adds or removes, and at most two lines of text; the full diff is read in the document, never in the rail. A hunk that cannot render inline keeps Keep and Revert on its row, and a suggestion that cannot (a replacement spanning paragraphs) keeps Accept and Reject on its row the same way. Beside the per-agent Accept all / Reject all rows, an author with more than one pending change gets a Revert all row that confirms first, naming the count and the author; the reverts run one hunk at a time, each its own undo step. Rail snippets render formatted (bold, italics, code face, link text), never raw markdown syntax. Panel copy is plain everyday language, tooltips included; internal vocabulary is kept to this PRD and the code: "waiting for changes" / "working" / "has an update waiting"; "All caught up. Everything reviewed."; "attached 12 minutes ago" with absolute time on hover, and every relative time in the rail and the thread panel refreshes on its own about every 30 seconds; the mirror fine print is replaced by the save-state sentence below; the idle-expiry fine print becomes a plain tooltip (the user's sends are never dropped; an agent's notes do not keep it attached); the orphaned chip reads "text removed", the external author badge reads "someone else", and row copy never shows file paths. The accessible name of every Keep, Revert, Accept, and Reject control is the action, the author, and a short excerpt of the text, never an internal id. With no agent attached, the agents panel offers "Copy the prompt for your agent", which puts a one-line attach instruction on the clipboard.
  - **The thread lives in the left window, decided 2026-09-02.** This supersedes the floating thread panel of 2026-08-30, which landed wherever it fit rather than where the reader expected. One thread surface: the **Thread** tab of the left window. An annotation row click, an in-editor highlight click, or F8 opens the thread there and selects the tab; the span itself is centered and highlighted in the editor, which is where the reader looks for it. The left window keeps two widths, one for Files and Contents and one for Thread, so navigation stays narrow while a conversation gets room; the handle between the left window and the editor edits whichever the selected tab uses, and both persist in `settings.json`. Neither side window has a fixed maximum width: the owner decides, and a drag stops only where the handle would leave the screen. The thread width is never below the old popover's 330px and defaults to 660px; the navigation width floor stays 160px. The Thread tab is always present; with nothing open it says so and tells the reader how to open one. Which tab the left window shows is session state while it is Thread and per-document reading state otherwise. Closing the thread, with its × or Escape, returns the left window to the navigation tab it last showed. Body text keeps the editor's main body size and follows the left window's zoom. An orphan shows the original quote. The tab shows the thread, replies, a reply box, and Resolve for any unresolved ordinary annotation; a decision instead shows its single-choice options, Other, and owner-only Answer or Reopen action. Resolving from the panel closes an ordinary thread (decided 2026-08-30). The reply box is a multi-line field: Enter sends, Shift+Enter starts a new line. The root annotation, each reply, and each decision answer carry a quiet relative time once the annotation log records one, with the absolute time on hover. The annotation composer is user-resizable with its size persisted; its default size and selection-anchored position are unchanged.
  - **User-facing copy, decided 2026-08-30.** Every label, chip, counter, tooltip, and dialog uses plain everyday words; the audience works with agents, not necessarily with code. Internal vocabulary (buffer, ghost, shadow, orphaned, external, delivery, on disk) appears only in this PRD and the code. A file changed by something else while the user edits is "changed outside StrataMD"; the conflict dialog's columns read "Your version · unsaved" and "Changed outside".
  - **Drafts and Escape.** The Send composer's note and per-item choices and the Thread tab's unsent reply are kept per document while the app runs, so Escape, a stray click outside, or reopening never loses them; a successful send clears the composer's draft. Escape closes only the topmost surface (a dialog, the annotate menu, the find bar, the theme panel, an open thread, an error notice), never several at once.
  - **Notices.** A success notice clears itself after a moment. A failure shows as an error notice in the theme's danger color that stays until dismissed with its × or Escape, or until a newer error replaces it; a success never paints over an unexpired error.
  - **Save state and counts, decided 2026-08-30.** The editor always shows whether it matches the saved file: the Save button reads "Save" (accented) while unsaved changes exist and a quiet "Saved" otherwise; the tab carries an unsaved dot beside its name, distinct from its count badge; the rail footer reads "Unsaved changes · last saved 3 minutes ago" or "Everything saved · 3 minutes ago". The changes panel groups rows, each group with its own count: **Proposed** (suggestions, not in the text until accepted; Accept/Reject), **Unsaved** (applied in the editor, lands on the next Save; Keep/Revert), **Saved** (in the file, awaiting review; Keep/Revert). Below them, the save history (§6.7) under a "Saves" heading with rows labeled "Last save" or "Saved <time>", authors as "you and Claude" (anonymous reads "someone else"), an expanded row's count as "N changes", and "Nothing changed" for an empty round. A hunk is classified by comparing its shadow region against disk on each publish; if that cost proves too high under measurement, the fallback is a whole-panel unsaved marker driven by the document's dirty state. The annotations panel header counts open annotations and, when present, those on removed text. The top bar keeps the total pending count and tints it while anything counted is unsaved. Reverting a Saved hunk restores text the file does not have, so the document reads unsaved until the next Save.
  - **Tabbed side hosts, decided 2026-09-02.** The left window is a tab host with application-owned **Files**, **Contents**, and **Thread** tabs; Files and Contents navigate, and Thread is where the reader replies (see the thread decision above). The upper-right window is a review tab host with application-owned **Changes** and **Annotations** tabs; it shows one review tab at a time. **Agents** remains a separate, persistent window beneath it. Tabs have ordinary tablist/tab/tabpanel keyboard behavior and visible counts: Changes counts pending hunks plus open suggestions, Annotations counts all unresolved annotations. While Annotations is selected, **Pin Changes** adds a capped, non-resizable strip of pending-change summaries inside the same upper window; activating a summary selects Changes. Pinning is session-only and creates no pane or persisted setting. Documents and agents cannot add, remove, rename, or replace application tabs. Files, Contents, and Thread keep the `explorer` pane identity and zoom; both review tabs, the pinned strip, and Agents keep the `rightRail` pane identity and zoom.
  - **Open tabs, decided 2026-09-02.** The top-bar tab pills are the only record of which documents are open; the shell has no second list of open or recent files. The open tab set and the focused tab persist in a private `open-documents.json` beside the ghost store and are restored in order at startup before any document named on the command line, which then takes focus. Files that no longer exist are skipped quietly. Persisting and restoring tabs never changes Markdown, `meta.json`, or agent traffic.
  - **Contents, decided 2026-09-02.** Contents is derived from the live ProseMirror document, never from a second Markdown parse. H1 is presented as the document title; H2 headings are primary sections; H3–H6 nest beneath their nearest shallower heading. Editing a heading updates the index immediately. The active row follows the editor's scroll position, and activating a row centers its heading without changing the document. A heading-free document shows a plain empty state. The selected left and review tabs are remembered per document in its private `reading.json`; switching document tabs restores them along with the editor's existing per-document scroll position.
  - **Review host sizing and migration, decided 2026-09-02.** The upper review window is vertically resizable and persists one `upperReviewHeight` setting. Existing settings migrate deterministically by summing the two readable legacy heights plus their former 14px intervening gutter, then clamping to 180–954px; when only one legacy value is readable, that value is used; otherwise the 444px default applies. The renderer further clamps the visible height against the available column so the Agents window remains visible. The Agents window consumes the remaining right-column height.
  - **Structured-reading performance budget.** On the existing greater-than-2-MB corpus, opening and ordinary typing may regress by no more than 10 percent from the pre-phase median. A heading-index update completes within 50ms and is scheduled outside the keystroke-critical transaction path.
  - **Walkthrough, decided 2026-09-02.** Contents offers **Start walkthrough** and, while active, **Leave walkthrough**. Starting selects Contents and creates an ordered step list from all H2 headings; the private `H2 + H3` option also makes every H3 a step. The complete Contents outline remains visible. Each eligible heading has a private include control, initially on; progress, Previous, and Next use only included steps and do not infer numbers from heading text. The current step is restored per document and follows an included section selected in Contents or reached by walkthrough navigation. If no steps remain, the controls explain that the user can include one rather than failing or changing the file.
  - **Reviewed and Revisit.** The current walkthrough step can be marked **Reviewed** or **Revisit**. Reviewed stores a SHA-256 hash of the section's exact UTF-8 Markdown, from its heading through the byte before the next heading of the same or a shallower level. A text change from any ingress—visual/source typing, CLI edit, an agent or outside buffer write, accepted suggestion, Keep/Revert, undo, or redo—rechecks only affected sections. A differing hash changes Reviewed to Revisit; matching the stored hash again restores Reviewed. Manual Revisit keeps the most recent reviewed hash when one exists, so a later exact restoration may return to Reviewed. Keep cannot restore Reviewed unless it restores the reviewed bytes.
  - **Walkthrough identity and persistence.** Walkthrough state is format-versioned inside `reading.json`: active state, H2/H2+H3 mode, current step, exclusions, and markers with reviewed hashes. While the document is open, steps retain their parsed source identity through edits. On reopen, a reference relocates only to a unique heading with the same level and normalized text, using its parent and adjacent heading text to disambiguate duplicates. A deleted or ambiguous reference is discarded; StrataMD never attaches it to a merely nearby unrelated heading. Reconciliation rewrites relocated references atomically and never changes Markdown or agent traffic.
  - **Walkthrough performance budget.** The open session caches section boundaries and hashes. An ordinary edit that cannot change heading structure shifts cached boundaries and hashes only the affected reviewed section; heading-boundary edits rebuild the index conservatively. A change confined to one section updates its marker and hash within 50ms without hashing the whole document on each transaction.
  - **Table views, decided 2026-09-02.** Every editable GFM table has a compact StrataMD toolbar. **Table** is the polished, editable source-order view. Sorting, a case-insensitive column filter, hidden columns, **Focus row**, and **Compare** render a read-only derived view beside the same ProseMirror table node. They never reorder nodes or create a Markdown transaction. **Edit** returns to source order and places the caret in the row and cell last selected in the derived view. Compare requires at least two selected body rows; Focus row shows one body row as labeled fields. Row selection, column visibility, width controls, and comfortable or compact density stay available without turning the editor into a spreadsheet. Controls collapse into a menu below 620px of table width. **Focus** gives the table the center editor's available workspace and preserves both side regions; center focus is session-only and survives document tab switches while the app runs.
  - **Table state and identity.** Table presentation, sort, filter, hidden columns, selected comparison rows, focused row, density, and column widths are private per-document state in `reading.json`. A table reference contains its nearest preceding heading's normalized text and level, its normalized header labels, and its occurrence number among tables with that same heading and header signature. A reference restores only on one exact match. Missing or ambiguous table state is discarded rather than attached to a different table. `reading.json` migrates from v2 to v3 by adding an empty table-state list.
  - **Table discussion.** Clicking a source or derived cell selects its body row and column for the table toolbar. **Discuss row** creates an ordinary question annotation anchored to the complete Markdown row. **Discuss cell** uses that same complete-row anchor and adds structured context with the nearest heading, all column labels, the chosen column label, and its zero-based index. Both actions open the existing annotation composer with Question already selected; the resulting thread, Send behavior, relocation, resolution, and agent delivery remain the ordinary annotation lifecycle. The readable agent payload names the table heading and column context. Header and delimiter rows cannot start row discussion.
  - **Hidden review targets.** A derived table reports the count of unresolved annotations and pending changes hidden in its source table. Find and F7/F8 stepping, Changes and Annotations row clicks, and in-document review activation temporarily show the editable source table, center the exact target, and keep the owner's stored table view unchanged. Moving to another review target or choosing **Return to table view** restores the derived presentation. No filter, Compare, Focus row, hidden column, or center Focus setting can make review work unreachable.
  - **Table performance budget.** Sorting or filtering a 1,000-row table and returning to the editable source-order table each complete within 100ms. Instrumentation verifies that each action dispatches no Markdown transaction.
  - **Decision annotations, decided 2026-09-02.** The Annotations window has **All**, **Decisions**, **Questions**, **Comments**, **Suggestions**, and **Resolved** filters. All and the four kind filters show unresolved rows; Resolved shows every resolved kind so a decision can be reopened with its complete history. **New decision** opens an in-window form for a document-wide or current-heading anchor, prompt, and two initial option fields; selection annotation adds **Decision** for an exact-passage anchor. More option rows can be added, but empty or duplicate values cannot be submitted. A decision row uses its prompt as the primary excerpt and names its anchor in plain words. A document-wide row opens its thread without pretending it has an editor location.
  - **Decision answer flow.** The decision thread keeps the ordinary reply box for clarification. An open decision shows radio choices plus **Other** with a text field and one **Answer decision** action. A resolved decision shows each past answer in sequence and **Reopen decision**. An answer remains checked by default in the next Send composer, whose row says what the owner chose; answering creates no change row. The annotation event projection, filtering, answering, and payload construction each handle 100 decisions with history in under 100ms.
  - **Diagrams and file trees, decided 2026-09-02.** Exact `mermaid` and `tree` fenced info strings receive Strata-owned visual presentations while retaining the existing editable code-block source and byte-preserving serialization. Mermaid loads through a dynamic import only when used, initializes with `startOnLoad: false`, `securityLevel: 'strict'`, HTML labels disabled, and theme values derived from Strata tokens. The renderer may translate `<br>`, `<br/>`, or `<br />` to label newlines in memory after the review-document proof, but never mutates Markdown or relaxes CSP. Diagram controls are Diagram/Source, zoom out, reset, zoom in, and pan; a failed diagram stays editable through Source. File-tree rows expose `treeitem` level and expansion semantics but do not read the filesystem or invent links.
  - **Image inspection.** A ready local image is keyboard focusable; click or Enter opens a center-only inspection surface above the document. It shows alt text, title when present, the resolved local path, Fit, zoom out/in, and Close, and supports pointer and arrow-key pan. Escape closes it and returns focus to the originating image. Side regions remain visible. The focused bitmap reuses the inline image URL rather than requesting or decoding another copy.
  - **Local reference previews.** A local Markdown reference opens a selection-anchored preview on click or Enter and never navigates on that activation. For links, the Markdown destination is the candidate; for inline code, the entire code-span text is the candidate only when it resembles a `.md` or `.markdown` path. Query and fragment text may select a heading in the preview but are removed before filesystem resolution. Main resolves realpaths inside the current document directory or an explorer root and returns at most 256 KiB; the renderer derives a title and bounded plain-text excerpt. The preview has **Open document** as the only navigation action, closes with Escape or outside activation, and restores editor focus. Remote, scheme-bearing, missing, non-Markdown, ambiguous, and outside-root candidates do not preview.
  - **Heading folding.** Each H1-H6 receives a keyboard-operable disclosure before its text. A fold hides all following sibling content until the next heading of equal or smaller depth while leaving the heading visible. It shows separate annotation and change counts when hidden work exists. Folds store conservative heading references in `reading.json` v4, migrate v3 by adding an empty list, and never alter ProseMirror nodes or Markdown. Review jumps and find stepping temporarily reveal all ancestor folds containing the target; moving to another target or explicitly restoring returns the stored fold, while clicking a disclosure is an owner change and therefore becomes the new stored state.
  - **Phase 6 security and performance.** Mermaid and reference preview code is absent from the ordinary open/typing path unless its construct occurs. Renderer CSP remains unchanged and network-denial tests observe no Mermaid, image, or preview request. Against the review fixture, the proof records the lazy Mermaid chunk, first render under one second, retained renderer memory, all three diagrams, and strict-mode `<br/>` behavior before the diagram NodeView ships. A document without Phase 6 constructs regresses open and typing medians no more than 5%; a local Markdown preview opens in under 100ms.
  - Per-pane text zoom. The explorer, the editor, and the right rail each carry an independent text-size factor (default 1.0, steps of 0.1, range 0.5–2.0). Ctrl/Cmd+= and Ctrl/Cmd+- change the factor of the pane under the pointer, or the editor when the pointer is over no pane; Ctrl/Cmd+wheel changes the pane under the pointer by one step per wheel notch, accumulating trackpad deltas so a gesture does not skip steps. The window itself never zooms: the Electron default menu's zoom roles are removed and pinch zoom is locked. A single text button in the top bar, `Reset zoom`, returns all panes to 1.0; it is shown only while some pane is off 1.0, it is the only zoom control drawn, and no zoom icons are added. Only type scales; panel widths, spacing, and the editor toolbar row do not. Factors persist in `settings.json`.
- Single instance: launching with a path while running opens a new tab in the existing instance.
- Tabs for multiple open documents; each tab is one session. The **focused** document is what `attach` and `state` target when no file is given on an initial call. Each tab retains its scroll position across switches, in visual and source view. Ctrl/Cmd+W closes the active tab through the same close confirmation a click gets; Ctrl+Tab / Ctrl+Shift+Tab and Ctrl/Cmd+PageDown / PageUp cycle tabs; a middle click closes a tab.
- Open from the explorer, CLI, file manager, or drag-drop.
- On Linux the `.desktop` entry declares `MimeType=text/markdown;`; `.md` and `.markdown` map to that type through the shared MIME database. On macOS the `.app` bundle declares both extensions (role Editor, rank Alternate) and Launch Services learns the association from it. Making StrataMD the default handler is a separate step done only when the owner requests it: `stratamd setup --default` records it on Linux, and on macOS prints the Finder steps (Open With → Change All) for the user to complete by hand.
- The keyboard reaches and operates every review action, annotation thread, composer tab, conflict, and banner.
- Config in `$XDG_CONFIG_HOME/stratamd` (fallback `~/.config/stratamd`). `settings.json`: active theme id, whether to keep resolved annotations, attachment idle timeout, explorer folders, panel sizes and document measure (the left window's navigation and thread widths among them), theme panel position and size, annotation composer size, per-pane text zoom, ambient motion on/off. Private per-document reading state is atomically written to `reading.json` beside `meta.json` and `buffer.md` in that document's ghost-store entry; shell tab choices therefore do not cause high-frequency `meta.json` writes or alter Markdown.

### 6.10 Edge cases

- **File deleted while open:** the tab stays open with a banner; Save recreates the file. Attachments are unaffected.
- **File renamed or moved while open:** §6.3.
- **Permission failure on Save:** the shadow is kept, the error is shown as a notice that stays until dismissed (§6.9), nothing else changes.
- **Invalid UTF-8:** opens read-only in source view with a banner; no ghost is written.
- **Large documents:** document size must not disable visual editing or any collaboration feature. Parsing, rendering, review, annotations, Save, and Send remain available; performance or memory failures on larger files are implementation defects to optimize, not a reason to impose a product ceiling. The owner explicitly rejected the former 2 MB source-only fallback on 2026-08-28.
- **External write racing Save:** §6.1; the hash check before writing catches it.
- **Crash with unsaved edits:** §6.3 recovery.
- **Failure inside the window:** an error in one pane replaces just that pane with a card — "This part of the window hit a problem. Your document and its pending changes are safe." — and a Reload button; the other panes and the top bar keep working. An error outside every pane degrades to the whole-window card: "StrataMD hit a problem showing this window. Your documents and pending changes are safe." The card's promise is earned, not asserted: the crash and the Reload both flush the not-yet-mirrored edit to the main process (bounded, so a dead channel cannot wedge recovery), and reloading re-derives everything from main, so the newest keystrokes survive. Nothing reloads automatically — a bad state must not loop. Failures no boundary can catch (event handlers, the editor's own DOM dispatch) change no UI and are recorded like every other failure (§9).
- **Renderer process dies:** the window reloads; a second death within a minute closes the window instead of looping, and a fresh one is created on the next launch or agent connection.
- **A background job fails:** the buffer mirror, the file watcher, and the state persist run outside any user action, so their failures cannot surface as a command error. Each is logged (§9) and shown as a banner on the document in plain words — what stopped and what it means (agents may be reading an older copy; outside edits will not be noticed; review notes may not survive closing) — and the banner clears when that job next succeeds. A failed mirror write keeps its content queued and retries on the next edit; one failure never silences later writes.
- **Document referenced by a ghost entry no longer exists:** the explorer shows it struck through; the entry is kept until forgotten.

### 6.11 State model

Per document: **disk** (last bytes read or written), **shadow** (mirrored to `buffer.md`), **ghost**, **pending hunks**, **segments**, **save history**, **annotation log**. Per attachment: **baseline**, **deliveries**, **cursor**.

| Event | disk | shadow | ghost | pending hunks | segments | attachment |
|---|---|---|---|---|---|---|
| Open, no ghost | read | = disk, or recovered buffer | seeded (§6.3) | diff(ghost, shadow), external | — | — |
| Open, ghost exists | read | = disk, or recovered buffer | — | diff(ghost, shadow), persisted authorship kept where matching | — | — |
| User edit, first after external or Send | — | changed | — | ranges mapped; hunk edited inside → mixed | snapshot; open `user` | — |
| User edit, otherwise | — | changed | — | ranges mapped; hunk edited inside → mixed | — | — |
| Save | = shadow, atomic, after hash check | — | + user's own hunks, except regions overlapping pending | — | — | — |
| Save that changed the file | (as Save) | — | (as Save) | — | history += round: before/after snapshots, time, active contributors since the previous round | — |
| Open, stranded empty ghost (pre-upgrade store) | read | = disk, or recovered buffer | re-seeded from disk, once; marker cleared | diff(ghost, shadow) | — | — |
| External change (document or `buffer.md`) | new if document | patched, non-conflicting blocks | — | + hunks, author = tag or external | snapshot; open `external` | — |
| `stratamd changed --as` | — | — | — | — | tag stored; covers external segments until expiry or replacement (§6.2) | — |
| Conflict resolved, pick disk | — | block = disk | — | hunk stays pending | — | — |
| Conflict resolved, pick mine | — | — | — | hunk removed | — | — |
| Keep hunk | — | — | + hunk's current region | − hunk | — | agent author: `kept` verdict on next delivery |
| Revert hunk | — | ghost text restored (confirm if mixed) | — | − hunk | `user`, attributed to the hunk author | agent author: `reverted` verdict; others: user hunk on next delivery |
| Mark reviewed | — | — | + all pending | cleared | — | agent authors: `kept` verdicts on next delivery |
| Accept suggestion | — | span replaced | + that hunk | — | counts as `user`, attributed to the suggestion author | author: `accepted` event, never its own text; others: user hunk on next delivery |
| Reject suggestion | — | — | — | — | — | author: `rejected` event |
| Annotation event | — | — | — | — | — | log += event(seq) |
| Send | — | — | — | — | snapshot; open `user` | recipients: delivery created and persisted |
| Message `send` | — | — | — | — | — | recipients: message queued and persisted; ack removes it, baseline and cursor unchanged |
| Lead accept | — | span replaced | — | + hunk, author = Lead | snapshot; open `external`, tagged Lead | author: `accepted` event with Lead as actor; others: external segment when included |
| First `attach` | — | — | — | — | — | created: baseline = current snapshot, cursor = latest seq |
| `attach` collects | — | — | — | — | — | oldest delivery returned; unchanged until ack |
| CLI acks delivery | — | — | — | — | — | baseline = delivery snapshot/index, cursor = delivery's last seq, delivery removed |
| `attach` timeout, `state`, `changes` | — | — | — | — | — | — |
| Close document, Save/Discard | per choice | dropped; Discard resets buffer to disk | — | persisted | persisted | persisted; `closed` after queued deliveries |
| `detach` / idle expiry (no unacked delivery) | — | — | — | — | — | deleted |
| `checkpoint` | — | — | seeded (§6.3) | cleared | — | — |
| Copy for agent | — | — | — | — | — | clipboard recipient: baseline advances after clipboard write |

### 6.12 Acceptance scenarios

Each must hold before the product is done.

1. A recipient collecting late receives only the content frozen for it at Send time; edits made after that Send arrive in a later delivery.
2. The CLI is killed between the server's socket write and printing; the next `attach` returns the same delivery with the same id.
3. An agent proposal is pending; the user edits inside it; Revert asks for confirmation and Keep preserves the user's edits.
4. Save with agent proposals pending: disk receives the shadow, every proposal stays reviewable, overlapped regions stay pending in the ghost.
5. A disk write lands between the last watcher event and Save; Save detects it and asks for resolution before writing.
6. The app crashes with unsaved edits; reopening offers Recover and does not overwrite the buffer with disk.
7. The user chooses Discard on close; buffer-only pending hunks are gone on the next open.
8. A file is renamed while open; the session and ghost entry follow once.
9. A suggestion whose quote no longer matches is orphaned and cannot be accepted.
10. A no-op Save is byte-identical; each structural edit in the test corpus rewrites only the smallest grammatically safe region. The corpus is `test/corpus/` in the repository: copies of the owner's real documents (PRDs, plans, agent-written reports) plus one hand-written file per construct in §6.1, each with a list of edits to apply and the expected output. The owner adds a document to the corpus whenever a real file round-trips badly.
11. StrataMD's own buffer mirror and Save writes never appear as external changes.
12. An unacknowledged delivery survives close, restart, timeout, and idle expiry.
13. Copy for agent after a Save still includes the edits saved since the previous copy.
14. Two agents attached; one edits the buffer; the other receives nothing about it until the user includes external changes or tells it to run `stratamd changes`. (`state` and `changes` are read commands any agent may run unprompted; a message may prompt one, which grants nothing new.)
15. Accept on a suggestion changes the editor, not the disk; the author receives `accepted`; another attached agent receives the change as a user hunk.
16. Acknowledging a message advances no baseline or cursor: the recipient's next Send delivery is exactly what it would have been without the message.
17. A queued message never blocks attachment expiry; a queued Send delivery still does.
18. A Lead accept is never user-authored: it always leaves a pending hunk for the user, and a Lead save leaves that hunk pending.
19. At most one Lead per document: a second claim fails naming the holder, and the Lead dies with its attachment.
20. An untracked file in a git work tree opened fresh has itself as the baseline: a tagged agent burst shows discrete hunks, every one named, never one whole-document insert.
21. A multi-write agent burst under one tag carries one name throughout; the tag expires after five idle minutes and a second agent's tag replaces it from its next write.
22. A save's round is inspectable after the next save: its hunks come from its own snapshots, exclude unsaved work, and its author list names everyone active in the round, including a contributor whose edit was later overwritten. A save that changed nothing adds no round.
23. A pre-upgrade store with an empty ghost and a non-empty document re-seeds from the document once at next open, keeping unsaved buffer work pending; a checkpoint-created empty ghost survives reopening.
24. `edit` against a passage the user has since changed fails with the closest excerpts and applies nothing; `edit` against an intact passage lands as a pending hunk in the agent's name with the ghost unmoved, while the user's unsaved edits elsewhere in the buffer stay as they were.

### 6.13 Themes

- A theme is a named set of values that decides the app's colors, fonts, and ambient behavior. Themes carry values only, never code or stylesheets: a theme cannot change layout, run scripts, or add animations the app does not already have.
- Seven stock themes ship with the app: Strata Vivid (the default and built-in fallback: Strata's dark purple structure with the owner's vivid text palette, decided 2026-08-30), Strata (the quieter original design handoff), Ember (warm dark), Candyfloss (light pink), Isotope (light grey, no motion), Nebula (deep space), and Paper (light cream); the owner approved this set on 2026-08-29. Every stock theme declares all 46 color swatches, both fonts, and all four effect settings explicitly - none inherits a value from another, so changing one can never silently change the rest. The six `visuals.category-1` through `visuals.category-6` swatches form an ordered categorical chart palette and are never borrowed from controls, change authors, or ambient effects. Strata Vivid's complete definition is the fallback for every missing or invalid value everywhere, and the theme the app returns to when an active theme's file disappears or is deleted; a fresh install opens on Strata Vivid. Stock themes cannot be edited or deleted and never exist as files; New from this copies one into an editable file carrying every chosen value.
- User themes are single JSON files in `$XDG_CONFIG_HOME/stratamd/themes/<id>.json`. The id is assigned at creation and never changes; the name inside the file may. Keys are dotted names grouped as `fonts`, `surfaces`, `interface`, `document`, `controls`, `changes`, `people`, `visuals`, and `effects`. Colors are hex; fonts are family names; `effects` also carries a background style and a panel style from the app's closed list plus intensity and speed. User themes are sparse: a file holds only the values its authors chose, and a missing value falls back to Strata Vivid. Files written by the app carry `schema-version: 3`; v2 files remain valid and acquire missing visual colors from Strata Vivid without rewrite. Unknown keys are preserved. An invalid value falls back to the built-in value for that key and is reported in the panel; a file that is not valid JSON is listed as broken and never applied.
- The 40 swatches name visual jobs, never hues: seven surfaces, four interface text colors, nine document text colors, seven control and status colors, two reviewed-change colors, six author colors, and five effect colors. Function and decoration are independent - confirmation buttons, removed text, author badges, and background glows each have their own value. The theme sets base colors and the app derives the rest at use time: translucent hover and review fills, button gradients and shadows, readable text on filled buttons, selections, popovers, and author badges, panel shadows from the window background, effect opacity from intensity, and light star colors mixed toward the interface text. No color in the app is outside the theme's reach; the attribution assignment rule in §6.9 is unchanged. The one exception is the brand: the StrataMD logo pill in the top bar keeps the fixed pink, orange, and purple mark inside its rounded dark field and pink-to-purple border in every theme.
- The active theme is `settings.json` `theme` (an id). Edits made in the app apply immediately and are written to the file within a moment. The themes directory is watched; adding, editing, or removing a file applies within a second without restart. Removing the active theme's file keeps its last values in memory and marks it missing until another is chosen.
- The theme panel is a floating, movable, resizable panel inside the window that never dims or blocks the app; the open document, explorer, and rail are the live preview, and the panel's position and size persist. It opens from a **Theme** text button in the top bar, which also opens `Theme sample.md` as an ordinary tab: a document containing every construct in §6.1 whose text says which theme value colors it, written to the config directory and rendered like any other file. The panel shows a dropdown of available themes, a sample strip for the states the open document may not be showing (attribution, controls, review colors, popovers, inner surfaces), and the values in eight groups - Fonts, Surfaces, Interface text, Document text, Controls and status, Reviewed changes, Authors and outside changes, Decoration and motion - each group with a one-line explanation. Every row shows its job label, an always-visible description of exactly what it colors, and its control: a swatch that opens the system color picker, a searchable dropdown of installed fonts, the two effect style dropdowns, or the visibility and speed sliders. Hovering a row outlines every one of its targets, and only its targets, in the live app and the strip; effect rows isolate only the ambient elements assigned to that slot. The panel always edits the active theme. A file holds only the values its authors chose; unchosen values show greyed as defaults, and **Use default** removes a chosen one. Revert to when opened, New from this, Use default, Delete, and rename are the only actions. Delete removes the active user theme after a second click to confirm and falls back to the built-in theme.
- Themes are a shared editing surface for the user and agents, last write wins, no conflict handling by design. `stratamd state` reports the active theme; `stratamd theme [id]` prints a theme's set values, default values with descriptions, and problems, and works without the app running. An agent asked to complete a theme reads the file, keeps the values already set, writes the rest, and verifies with `stratamd theme`. Changes an agent makes while the panel is open are highlighted in it.
- Ambient follows `docs/design/animations-handoff.md`: a theme chooses a background style and a window style from its eight options (`Rising motes`, `Aurora drift`, `Starfield`, `Grid drift`, `Glow orbs`, `Shimmer sweep`, `Breathing tint`, `None`) and sets intensity and speed. Every element, placement, and timing is the handoff's; colors are mixed from the theme's five `effects` slots. The ambient motion toggle and `prefers-reduced-motion` render neither layer; `None` skips one layer; typing pauses both.
- Installed fonts are listed by the platform — `fc-list` on Linux, the system font inventory on macOS — with the bundled families as the fallback either way; the renderer requests no browser permissions.

## 7. Agent contract

This is everything an agent needs. It ships verbatim as `stratamd --agent-help` and belongs in the user's global agent instructions (`CLAUDE.md`, `AGENTS.md`, harness system prompt) as one line: *"StrataMD is the user's markdown editor. When the user mentions a document open in Strata, asks you to review or edit a `.md` with them, or asks you to show them your edits, run `stratamd --agent-help` first."* The shipped form of that pointer is the bundled skill at `skills/stratamd/SKILL.md`, installed with `stratamd setup --skill`; the one-line instruction is the fallback for a harness without skills.

Written for agents: positive instructions, one concept per word (buffer, delivery, quote), the loop's stop condition stated, and a hard guardrail on document writes paired with the behavior to do instead.

```
StrataMD is the markdown editor the user is working in. Attach to the
document they have open, read the buffer with their comments, respond
with comments, questions, and proposed edits, then attach again to wait
for their next round. Keep that loop going until the payload says
"closed" or the user tells you to stop.

Quick start:
  1. stratamd attach --name "<who you are>"
     Read "document" (the buffer with the user's comments inlined) and
     keep "file", "buffer", and "agent" from the result.
  2. Respond: stratamd edit changes a passage, stratamd annotate adds a
     comment, question, suggestion, or decision, and stratamd reply
     continues a thread.
  3. stratamd attach <file> --as <agent>, run in the background, waits
     for the user's next Send. Act on what it returns.
  4. Repeat from 2. Stop when attach returns {"event":"closed"}.
  Copy quotes and matches from "document" or the buffer file, never
  from "text": "text" has the comment markers inlined and will not
  match the buffer.

  stratamd attach [file] [--as <agent id>] [--name "<who you are>"]
                         [--timeout <seconds>, default 90; 0 = poll]
                         [--text-only]
      Attaches you to the document (the focused one if no file is given)
      and opens it if it is not open.
      The FIRST call returns immediately with the whole buffer, the
      user's comments rendered inline, the file path, the buffer path,
      and your agent id. Pass that id with --as and the path as <file>
      on every later call.
      LATER calls return immediately if the user has pressed Send since
      your last call; otherwise they block until the user does. They
      return only what the USER changed since your last call: hunks
      with line numbers and one unchanged line either side, new
      comments, decisions, replies, owner decision answers, which of
      your suggestions were accepted or rejected, annotations whose
      quoted span the user moved (listed again with the new quote plus
      a "requoted" line), and the user's notes. Changes made by anyone
      else (other agents, other editors)
      are NOT included unless the user chose to include them.
      Nothing is lost while you are not waiting; sends queue until your
      next call, even across restarts. Run it in the background and act
      when it returns. Re-run it after each response to keep listening.
      It returns {"event":"timeout"} after --timeout seconds if nothing
      happens; just run it again. Pick a timeout below your tool's
      command limit: the default 90 fits a 120 second limit. A call
      your harness kills is safe; the delivery repeats on your next
      call with the same deliveryId.
      --timeout 0 never blocks: it returns a queued delivery or
      {"event":"timeout"} at once, for a harness that cannot hold a
      command open. It returns {"event":"closed"} when the user has
      closed the document, after anything that was queued. It returns
      {"event":"superseded"} when a newer attach call for your id
      replaced this one: do nothing, the newer call is listening.
      A delivery can arrive twice if a call was cut off; the same
      deliveryId means you already handled it.
      --text-only leaves out the "document" field; "text" already holds
      the whole buffer with the comments inlined, so you miss nothing
      and the payload is half the size on a large document. Copy quotes
      from the buffer file then. The same flag works on state.

  stratamd annotate <file> --kind <comment|question|suggestion>
                           --quote "<exact text from the buffer>"
                           [--text "<your comment or replacement>" | --text -]
                           [--label "<short label>"]
                           [--preceded-by "<text right before the quote>"]
                           [--followed-by "<text right after the quote>"]
                           [--as <agent id>]
      Comments on text or proposes a change. The quote is text copied
      exactly from "document" or the buffer file, unique within it. A
      suggestion's quote sits inside one markdown block (a paragraph,
      list item, heading, or table cell: the same block ranges edit
      uses), and its --text is markdown; a comment or question may
      quote a long span to mark what should be read with it.
      If the quote is missing, ambiguous, differs only in whitespace,
      or crosses blocks, the command fails (exit 3, code QUOTE_INVALID)
      with detail [{reason, total, candidates: [{line, before, quote,
      after}], hint, exact}]. Pass a candidate's before or after text
      as --preceded-by or --followed-by and retry; for reason
      "whitespace", use "exact" as the quote. --preceded-by "" means
      the start of the document and --followed-by "" its end.
      A decision instead uses:
        stratamd annotate <file> --kind decision --text "<prompt>"
          --option "<choice>" --option "<choice>"
          (--quote "<exact passage>" | --heading "<complete # heading>"
           | --document) [--as <agent id>]
      Give at least two distinct non-empty --option values. Other is
      always available and is not an --option. Give exactly one anchor:
      --quote, --heading, or --document. A heading is one complete ATX
      heading line copied from the buffer, including its # markers. It
      must begin at column 1 and end at that line's boundary; a prefix
      of a longer heading is not an anchor.
      Pass --json <file or -> with an array. Ordinary entries use
      {kind, quote, text, label, precededBy, followedBy}; decisions use
      {kind:"decision", text, options, and exactly one of quote,
      heading, document:true}. One bad entry creates none. Suggestions
      are not applied until the user accepts them. Prints
      {"created":[{id, kind, quote}]}; use the ids in reply and resolve.

  stratamd edit <file> --match "<exact text from the buffer>"
                       --replace "<new text>" | --replace -
                       [--preceded-by "<text right before the match>"]
                       [--followed-by "<text right after the match>"]
                       [--append] [--dry-run]
                       [--as <agent id>] [--name "<who you are>"]
      Changes one passage. The match follows the quote rules of
      annotate: copied exactly from the buffer and unique within it,
      with the same QUOTE_INVALID failure (exit 3) and the same
      --preceded-by / --followed-by fix. The replacement lands in the
      live buffer as YOUR change, marked for the user's review like a
      write to the buffer file. Use it instead of rewriting the buffer
      file when you want to change a passage: the match is checked
      against the buffer at the moment of the write, so it can never
      undo an edit the user made after you last read. An empty
      --replace deletes the passage.
      Insert = an empty match with a context. --match "" together with
      --preceded-by or --followed-by inserts at that point, and
      --preceded-by "" is the start of the document. --append inserts
      at the end of the buffer with no --match at all. Both work on an
      empty document. --dry-run locates every match and prints
      {"located":[{line, match}]} without changing anything.
      Pass --json <file or -> with an array of {match, replace,
      precededBy, followedBy, append} to make many changes at once; one
      bad match applies none of them, and two edits that overlap fail
      (exit 3, code EDITS_OVERLAP, detail names both). Prints
      {"applied":[{line, match, replace}]}; line is where the change
      begins in the buffer after the edit. Needs the running app.

  stratamd reply <file> --to <annotation id> --text "<reply>" [--as <id>]
      Answers a question or continues a thread. --text - reads stdin.
      Prints {"replied": <reply id>, "annotation": <thread id>}.

  stratamd answer <file> --decision <id> --choice "<choice>" [--as <id>]
  stratamd answer <file> --decision <id> --other "<answer>" [--as <id>]
      Decision answers belong to the user. This command always fails
      with exit 3 and code DECISION_OWNER_REQUIRED, whether the app is
      running or stopped; reply to the thread when you need to clarify
      or recommend an option.

  stratamd send <file> --as <your id> --text "<note>" [--text -]
                       [--to <id[,id,...]>]
      Sends a short note (up to 4 KB) to every other attached agent, or
      only those named with --to. It wakes their waiting attach calls;
      notes queue for absent agents and survive restarts. Keep the
      discussion in annotations and replies; send is the doorbell, and
      the recipient runs state or changes to catch up. One note may
      wait per recipient: sending another before it is collected fails
      (exit 3, detail names every blocked recipient); retry after they
      attach, or send only to the others with --to. Success means
      queued, not read.

  stratamd lead <file> --as <your id>
      Claims the Lead for this document. Run it when the user puts you
      in charge, in any wording: "take the lead", "you're the
      overseer", "conduct this edit". Only the Lead may run accept,
      reject, resolve on others' ordinary annotations, and save. A Lead
      still cannot answer or resolve a decision. The claim
      fails, naming the holder, if another agent already leads; the
      user can transfer or revoke it in the app. Detaching gives it up.

  stratamd accept <file> --annotation <id> --as <your id>
  stratamd reject <file> --annotation <id> --as <your id>
      Lead only. Accept applies a suggestion to the buffer as YOUR
      change, left pending for the user's review; reject dismisses it.
      Accept fails with QUOTE_INVALID, in the same shape as annotate,
      when the text the suggestion quotes has moved.

  stratamd resolve <file> --annotation <id> --as <your id>
      Closes a thread. Any agent may resolve annotations it created;
      the Lead may resolve anyone's ordinary annotation. Decisions can
      be answered or reopened only by the user; trying this command on
      one fails with DECISION_OWNER_REQUIRED, including when local
      document state is read while the app is stopped.

  stratamd save <file> --as <your id>
      Lead only. Saves the buffer to the document, exactly as the
      user's save: agent edits stay pending for the user's review.
      Fails when a conflict needs the user; report that and stop.

  stratamd state [file] [--brief | --text-only | --annotations | --raw]
      Read-only: the same content as a first attach, without attaching
      or affecting any attachment. Also reports whether the document is
      open in the app ("open"), the active theme (id, name, file path)
      and, for an open document, the attached agents: id, name, state,
      and which one leads. An agent's state is "waiting" while its
      attach call is blocked, "working" when it has no call open and
      nothing queued, and "pending" when a delivery is waiting for it
      to collect. --brief leaves out the document, text, and
      annotations: run it to see who is attached and who leads, for
      example after a message. --annotations leaves out the document
      and reduces text to the open questions and decisions; the
      annotations are the content. --raw prints the buffer itself,
      exactly, with no JSON:
      copy quotes from it, or pipe it to a file to work on the text
      with other tools.

  stratamd docs
      Lists the documents open in the app: each file, its buffer path,
      whether it is focused, whether it has unsaved changes, and its
      attached agents. Needs the running app.

  stratamd theme [id] [--json]
      Prints a theme: its file path, the values its authors SET, and
      every remaining key at its DEFAULT value with a one-line
      description of what it colors, then any problems. Works without
      the app running. When the user asks you to build or finish "the
      theme open in Strata", run stratamd state to find it, read the
      file, keep every value already set, write the remaining keys in
      the same shape, and run stratamd theme again to confirm there
      are no problems. The app applies the file as soon as it lands.

  stratamd components [name] [--json]
      Prints the closed StrataMD component registry, or one exact
      component: its purpose, accepted semantic properties and values,
      body guidance, and a complete source example. Works without the
      app running. Query it before authoring a component instead of
      relying on remembered syntax. Unknown names fail with exit 2 and
      code COMPONENT_NOT_FOUND.

  stratamd validate <file> [--json]
      Checks component tags and properties without changing the file.
      It reports the real path, whether the component syntax is valid,
      every recognized component and source line, and all problems with
      a stable code and plain fix. It uses the editor's Markdown parser:
      component wrappers must be top-level at column 1, fenced or list
      examples remain ordinary Markdown, and a registered tag used
      inline is invalid. Other ordinary HTML is ignored. Run it after
      adding or changing components and fix every problem before handing
      the document back. Works without the app running.

  stratamd pin <file> --component <line> --x <0..100> --y <0..100>
                       --note "<text>" [--as <agent id>]
      Adds one numbered pin to the valid AnnotatedScreenshot whose
      opening tag is on that line. Coordinates are percentages of the
      displayed image. The command checks the allowed local image,
      records its current version, appends the escaped note through an
      agent-attributed buffer change, and prints the created pin. Query
      stratamd validate for component lines first. Needs the running app
      and an attached agent; it never writes the document directly.

  stratamd changes <file>
      Returns every change the user has not yet reviewed, including
      yours, as hunks against the current buffer. Run this when the
      user tells you someone else edited the document. For everything
      already reviewed, read the buffer file.

  stratamd changed <file> --as <agent id> [--name "<who you are>"]
      Optional. Run it BEFORE you edit the buffer or document; it tags
      your writes with your id so the user sees your name instead of
      "external." The tag covers every write you make until you pause
      for five minutes; another agent's changed replaces it. A harness
      pre-edit hook can call it automatically.

  stratamd open <file>
      Shows the file to the user. If you edited it, they see your
      changes marked for review. Use this after editing a file
      directly.

  stratamd checkpoint <file or directory>
      Records the user's last-reviewed version (from git HEAD if the
      file is in a repository, otherwise the current content) so edits
      you make afterwards show up for review. Run it before editing
      files the user has not opened in StrataMD.

  stratamd detach <file> --as <agent id>
      Ends your attachment. Optional; idle attachments expire on their
      own.

  stratamd doctor
      Works without the app. Prints the socket path and whether the app
      answers on it, the data and config directories, the log path with
      its last errors, every document lock with the process holding it,
      and the app and command versions, plus a list of problems. Run it
      whenever a command exits 4, and report what it says.
      stratamd --version prints the versions and paths alone.

Every command prints its result to stdout as one JSON object; a
command with nothing else to report prints {"ok":true}. Errors go to
stderr as one JSON object {error, code, detail}; a not-found error
names the id or path it looked for, and detail says what to do next.
Exit codes:
  0  done
  1  usage: a bad option (detail lists the valid ones), or a command
     that needs --as without one
  2  not found: the file, annotation, attachment, component, or image
  3  refused by the document's state; detail says why and what to do
  4  the app is not reachable, did not answer in time, or was built
     from a different version than this command (PROTOCOL_MISMATCH:
     the message says whether to restart StrataMD or update the
     command). Run stratamd doctor.
Your id: pass --as with the id your first attach returned. Without
--as, the id comes from your harness session when there is one;
otherwise every command except a first attach fails with exit 1. A
subagent shares its parent's session, so subagents always pass --as,
after an attach of their own. An --as the document does not know is
refused (exit 2, ATTACHMENT_NOT_FOUND): run stratamd attach first.

Payload fields, for attach, state, and changes: "event"; "file" and
"buffer" (paths); "agent" (your id); "deliveryId" (on send, message,
resync, closed); "notes" (the user's note); "document" (the buffer, on
initial, resync, state); "segments" (hunks per author: oldStart,
oldLines, newStart, newLines, removed, added, contextBefore,
contextAfter, line); "annotations" (id, seq, kind, author, agent,
name, label, status, anchor, quote, text, line, replies, decision,
context, including exact table-cell or screenshot-pin context);
"replies" (replies
to earlier threads: id, annotation, author, name, text, parent {kind,
quote, line, text}); "answers" (structured owner decision answers with
their parent prompt, options, and anchor); "resolved" (id, kind,
resolution); "edits" (your
kept or reverted changes); "partial"; "attachments"; "open"; "cursor";
and "text", a readable rendering of all of it.

What you see is the user's editor buffer, which may be unsaved;
"buffer" in the payload is its path. Edit by writing to that buffer
file, with stratamd edit for one passage, or by suggestions for small
inline proposals. The user sees your edits marked for review and
decides when to save. Re-read the buffer right before you write to it;
a write based on an old copy shows up to the user as undoing their
newer edits. The buffer is the only file you write while attached.
Writing the document itself bypasses the user's unsaved edits, so
every payload names the buffer path. Your own edits come back to you
only if the user includes changes not made by them.
```

Agent identity: `--as` if given; otherwise a stable id derived from `$CLAUDE_CODE_SESSION_ID` or an equivalent harness session variable if present, mixed with `$CLAUDE_CODE_CHILD_SESSION` when set so a subagent gets an id of its own. Only a first `attach` may go without both, minting a fresh id; every other command that needs an identity (`annotate`, `edit`, `reply`, `answer`, `send`, `lead`, `accept`, `reject`, `resolve`, `save`, `changed`, `detach`) exits 1 with `Pass --as <the agent id your first attach returned>` rather than minting one, since a fresh id would create a second attachment. Subagents always pass `--as`. The initial payload always returns the id. `--name` sets the display name (default `$AI_AGENT`, else the id).

## 8. Payload (StrataMD → agent)

Printed to stdout as one JSON object when `attach`, `state`, `changes`, or `docs` returns. `text` is a complete human-readable rendering; an agent that reads only `text` misses nothing, but quotes and matches are copied from `document` or the buffer file, never from `text`, which has markers inlined. Fields absent for an event are omitted. `--text-only` (on `attach` and `state`) omits `document`; `state --brief` omits `document`, `text`, and `annotations`; `state --annotations` omits `document` and reduces `text` to the open-questions and open-decisions lists.

```json
{
  "version": 13,
  "file": "/abs/path/doc.md",
  "buffer": "/home/u/.local/share/stratamd/docs/<12-hex key>/buffer.md",
  "agent": "ag_7f3k",
  "event": "initial" | "send" | "message" | "resync" | "closed" | "timeout" | "superseded" | "state" | "changes" | "docs",
  "deliveryId": "d_0192",
  "open": true,
  "from": { "agent": "ag_2b", "name": "GPT" },
  "notes": ["the user's note for this Send, or the sender's message note"],
  "attachments": [ { "agent": "ag_2b", "name": "GPT", "state": "waiting", "lead": false } ],
  "cursor": 118,
  "document": "full buffer text; present on initial, resync, and state",
  "segments": [
    { "author": "user", "hunks": [
      { "oldStart": 42, "oldLines": 3, "newStart": 42, "newLines": 5,
        "removed": ["..."], "added": ["..."],
        "contextBefore": ["the unchanged line before"], "contextAfter": ["the unchanged line after"],
        "line": 42 } ] },
    { "author": "external", "tag": { "agent": "ag_2b", "name": "GPT" }, "hunks": [ "only when included" ] }
  ],
  "annotations": [
    { "id": "a1", "seq": 112, "kind": "question", "author": "user",
      "agent": null, "status": "open",
      "quote": "the exact text", "text": "why this?", "line": 17,
      "replies": [ { "id": "r1", "seq": 115, "author": "user", "text": "..." } ] },
    { "id": "a2", "seq": 113, "kind": "suggestion", "author": "agent",
      "agent": "ag_2b", "name": "GPT", "label": "Tone", "status": "open",
      "anchor": "quote", "quote": "the exact text", "text": "the replacement", "line": 17, "replies": [] },
    { "id": "a3", "seq": 114, "kind": "decision", "author": "agent",
      "agent": "ag_2b", "name": "GPT", "status": "resolved",
      "anchor": "document", "quote": "", "text": "Which gate?", "line": 1,
      "decision": { "options": ["CI", "Manual"],
        "answers": [ { "seq": 118, "option": "CI", "author": "user", "answeredAt": 1788375600000 } ] },
      "replies": [] }
  ],
  "replies": [
    { "id": "r2", "seq": 116, "annotation": "a0", "author": "user", "text": "...",
      "parent": { "kind": "comment", "quote": "what a0 quotes", "line": 9, "text": "a0's opening text" } }
  ],
  "answers": [
    { "annotation": "a3", "seq": 118, "option": "CI", "author": "user",
      "answeredAt": 1788375600000,
      "parent": { "text": "Which gate?", "options": ["CI", "Manual"],
        "anchor": "document", "quote": "", "line": 1 } }
  ],
  "resolved": [ { "id": "a3", "seq": 117, "kind": "suggestion", "resolution": "accepted" } ],
  "edits": [ { "seq": 118, "verdict": "kept" | "reverted", "quote": "first line of the edit" } ],
  "partial": true,
  "text": "...",
  "documents": [ { "file": "/abs/path/doc.md", "buffer": "/home/u/.local/share/stratamd/docs/<12-hex key>/buffer.md",
                   "focused": true, "dirty": false,
                   "attachments": [ { "agent": "ag_2b", "name": "GPT", "state": "waiting", "lead": false } ] } ]
}
```

- Events: `initial` (first attach), `send` (one delivery), `message` (another agent's note; `from` names the sender; carries `notes` only and acknowledging it advances nothing), `resync` (baseline lost; full buffer), `closed` (document closed; sent after queued deliveries), `timeout`, `superseded` (a newer call for the same id took over), `state`, `changes`, `docs` (the open documents; carries `documents` and `text` only, no `file` or `buffer`).
- `open` is present on `state`: true when the document is open in the instance, false for a closed one and for offline `state`. `theme` is present on every `state`.
- `deliveryId` is present on `send`, `message`, `resync`, and `closed`. The same id is returned again if the previous return was not acknowledged.
- `attachments` is present on `state` for an open document: every attachment as `{agent, name, state, lead}`, states per §6.6. Omitted for a closed document. `docs` carries the same rows inside each `documents` entry, with `focused` and `dirty` (unsaved changes).
- `segments` are in order; each segment's `hunks` are against the state just before that segment, the first against the recipient's baseline. `author` is `user` or `external`; `tag` is present when the external segment was tagged; user segments never carry one, so an accepted suggestion reads as a plain user change. A segment the recipient authored is never present (§6.7). External segments appear only when the user included them, or as the whole content of a `changes` payload. Line numbers are 1-based; `oldStart`/`newStart` refer to the segment's before and after states and count only changed lines. Each hunk also carries one unchanged line on either side when there is one (`contextBefore`, `contextAfter`; the rendered `@@` header widens to include them) and `line`, the 1-based line in the delivered document (the current buffer for `changes`) where the change begins; for a pure deletion it is the line before the removed text.
- `edits` holds, on `send` and `closed`, the verdicts on the recipient's own kept and reverted buffer edits (§6.3): `verdict` is `kept` or `reverted`, `quote` the first non-blank line of the edit, capped. `partial` is present and true when the user left changes or events out of this delivery; the buffer holds the full current text.
- `annotations` holds, on `initial`, `resync`, and `state`, every annotation with its full thread; on `send` and `closed`, only annotations created past the cursor, each with its full thread. Every annotation carries `anchor`: `quote`, `heading`, or `document`; records written before version 13 read as `quote`. Document anchors use `quote: ""` and `line: 1` only as neutral payload fields while the anchor discriminant supplies the meaning. A decision also carries `decision.options` and its append-only structured `decision.answers`. `replies` holds, on `send` and `closed`, replies past the cursor to annotations created at or before it; `annotation` names the thread and `parent` carries the thread's `kind`, `quote`, `line`, and opening `text`, so the recipient can answer without looking it up. `answers` likewise holds owner answers past the cursor to older decisions and carries the parent prompt, options, anchor, quote, and line. None includes events the recipient authored. `agent` identifies the authoring attachment for agent-authored ones and `name` is the display name that attachment had when it wrote (on replies too); `label` is present when the author set one; `status` is `open`, `resolved`, or `orphaned`; `line` refers to the current buffer. `cursor` is the latest `seq` included.
- `text` begins with one line. On `initial` and `resync`: `While attached, write only to the buffer file: <buffer path>. The document <document path> is the user's to save.` On every other event: `Write only to <buffer path>.` The agent named the document itself and has had the full sentence once; repeating only the path it must act on keeps the per-delivery cost low.
- `text` then renders: on `initial`, `resync`, and `state`, the whole buffer with quote- and heading-anchored annotations inlined, followed by lists of open questions and open decisions; document-wide decisions appear in the decision list rather than in the document text. On `send` and `closed`, it renders notes, one unified diff per segment with its author, new annotations with context and replies, replies to earlier annotations, structured owner answers under `Decision answers:`, then resolutions and verdicts, then the partial-content line when needed. An answer reads `<id> ← user chose "<option>"` or `<id> ← user answered Other: <text>` followed by a `decision:` line with its prompt, choices, and location; it never claims the document changed. Other event renderings are unchanged.
- Annotation markers: comment and question → `⟦id kind (author) [label]: text⟧…⟦/id⟧` around the quoted span; suggestion → `⟦id suggestion (author)⟧~~quoted span~~ replacement⟦/id⟧`, the replacement rendered once; decision → the comment form with kind `decision` and the choices in its marker heading when quote- or heading-anchored. `author` is `user` or the agent's display name followed by its id, `(GPT ag_7f3k2a)`; `[label]` appears only when set; replies and decision answers render as indented reply-like entries; resolutions one line each. A reply or answer delivered alone carries an indented parent line with enough context to act. Annotation text inside a heading has its line breaks collapsed to spaces. Literal `⟦` or `⟧` in the document and in annotation text are escaped as `\⟦` and `\⟧` inside `text`.
- Limits: notes and annotation texts are up to 64 KB each; a message note is up to 4 KB. Payload construction and transport handle large document content; document size alone never changes the event to `resync`.

## 9. Files on disk

StrataMD writes the document only on Save. Nothing is ever written beside it.

Ghost store, in `$XDG_DATA_HOME/stratamd` when set; otherwise `~/.local/share/stratamd` on Linux and `~/Library/Application Support/StrataMD` on macOS. Directories `0700`, files `0600`:

```
docs/<first 12 hex of sha256 of realpath>/   # short so the buffer path is cheap in every payload; salted on collision
  meta.json          # format version, realpath, ghost blob, save history (before/after blobs, time, authors),
                     # pending hunks (range anchors, status, author), segments (blob, author, tag, time),
                     # pending tag, attachments (baseline blob + segment index, deliveries, cursor),
                     # clipboard recipient, annotation event log
  buffer.md          # live mirror of the editor buffer; agents read and write it
  reading.json       # atomically written private navigation and presentation state; never sent to agents
  lock               # held by the app or by an offline CLI command
objects/<sha256 of content>   # content-addressed blobs: ghosts, segment snapshots, delivery snapshots, baselines
logs/stratamd.log             # failure log: one JSON line per warning or error, from main and the renderer
```

- `meta.json` is one file written atomically, so a crash never leaves annotations and review state out of step. `reading.json` is written atomically and independently so display choices do not increase collaboration-state writes.
- `logs/stratamd.log` holds warnings and errors only — no info chatter — and rotates once to `stratamd.log.1` at 2 MB. It is a local file like everything else here (§3): nothing leaves the machine.
- Blobs are garbage-collected when no `meta.json` references them. Segment history is capped (default 200 segments per document, oldest dropped after their snapshots are no longer referenced by a baseline or delivery). The save history is never capped; its snapshots are referenced and retained.
- **Forget document** (explorer context menu, or `stratamd forget <file>`) deletes the entry and its unreferenced blobs.

Config, in `$XDG_CONFIG_HOME/stratamd` (fallback `~/.config/stratamd`) on both platforms — agents edit these files directly and existing instructions name the location, so it deliberately does not move on macOS: `settings.json` (§6.9) and `themes/<id>.json`, one file per user theme (§6.13).
- `meta.json` carries a format version; the app migrates older entries on open.

## 10. Architecture

- **Electron.** CLI, socket server, and editor share one language and one binary.
- **Main process** owns file I/O, the shadow, the ghost store, explorer scanning, diffing, file watching, the single-instance and agent socket, and config.
- **Renderer** owns the editor, explorer, annotation overlay, changes panel, attachments panel, and composer. Loaded from a custom `app://` protocol; context isolation and sandbox on; no Node integration; CSP allows only `app://` and the local-image handler; new windows denied and navigation denied outside the app's own `app://` origin (crash recovery reloads through it); every IPC message validated by sender and argument; external links opened through the OS opener (Electron's `shell.openExternal`) only for `http`, `https`, and `mailto`.
- **Editor** is built directly on the ProseMirror toolkit (document model, transactions, selection, undo, IME, DOM reconciliation, position mapping). The markdown schema, the source-span-tracking parser, and the byte-preserving serializer are StrataMD's own and must satisfy §6.1. No prebuilt markdown editor layer.
- **Socket:** an absolute `$XDG_RUNTIME_DIR/stratamd.sock` when set; otherwise `~/.cache/stratamd/run/stratamd.sock` on Linux, and an absolute `$TMPDIR/stratamd.sock`, else `~/Library/Caches/StrataMD/run/stratamd.sock`, on macOS — StrataMD-owned fallback directories are `0700`, the socket mode `0600`; the CLI derives the path the same way and needs no discovery file. Peer credentials checked: the kernel-reported peer uid must match (`SO_PEERCRED` on Linux, `getpeereid` on macOS). `attach` is a request the main process answers immediately or holds open until a delivery, close, or timeout; attachment state is independent of the connection.
- **Diff:** Myers line diff between snapshots. Block-level byte preservation on serialize keeps diffs minimal.

### 10.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | One language across main, renderer, CLI. |
| Build | electron-vite; electron-builder for the Linux unpacked build and the macOS `.app` | Fast dev loop; CI checks both hosts and a version tag publishes the Mac zip (§3). |
| Markdown parsing | micromark + mdast-util-from-markdown with the GFM and frontmatter extensions; a bounded registry-aware scanner and attribute parser for component wrappers | Every node carries exact source offsets, which the byte-preserving serializer needs. Component bodies use the ordinary Markdown parse, fenced and contained examples stay ordinary Markdown, and no MDX executes. `prosemirror-markdown` (markdown-it) exposes only block line ranges and is not used. |
| Serializer | StrataMD's own, per block; `mdast-util-to-markdown` for edited blocks, configured to match the file's detected conventions (bullet char, emphasis char, list indent) | Unchanged blocks emit original bytes; edited blocks should look like their neighbors. If `mdast-util-to-markdown` cannot match a file's style closely enough, the affected node types get hand-written serializers. |
| Editor | `prosemirror-model/state/view/transform/history/keymap/inputrules/commands`, `prosemirror-tables` | The toolkit only; schema is StrataMD's. |
| Diff | `diff` (jsdiff) `structuredPatch` | Myers, hunks in the §8 shape. |
| File watching | Node `fs.watch`, one non-recursive watch per directory, shared by every document and the theme folder | The reconciler only needs change notifications for two known files per document. A recursive native watcher on the document's parent watched the whole home directory or repository (inotify exhaustion, slow subscribe, event storms on `git checkout`); a flat inotify or FSEvents watch on a single local directory is reliable, and detection still re-reads by content hash rather than trusting the event. Network filesystems remain unsupported. |
| Socket | Node `net`, newline-delimited JSON | Long-held `attach` requests are connections the server answers later. |
| Panels UI | React + Tailwind | The ProseMirror view mounts as an uncontrolled element inside it. No component library. |
| Tests | vitest for parser, serializer, diff, and state transitions (pure functions, no Electron); Playwright with the Electron driver for attach → Send → collect and the §6.12 scenarios | The byte-preservation invariant and the state table are testable without a window. |

## 11. Environment and security

- The targets are the owner's current Linux workstation, running from a local checkout or build, on local filesystems (ext4, btrfs, xfs, tmpfs), and Macs on macOS 13 or newer (Electron's minimum) on APFS or HFS+. Network and virtualized filesystems are unsupported.
- `stratamd setup` and `stratamd setup --remove` are the only install and uninstall steps (§6.8).
- Everything is local. No network calls; the renderer never fetches remote resources.
- The agent socket and the ghost store are reachable only by processes running as the same user. Agent ids attribute; they do not authenticate.
- The only agent path that writes the document through StrataMD is the Lead's `save` (§6.6), and everything it writes stays pending for the user's review. Suggestions require acceptance by the user or the Lead, and a Lead accept is itself left pending; buffer writes and direct file edits are shown in review mode. The Lead is a cooperative safeguard, not authentication.
- `annotate` with a missing or ambiguous quote fails rather than creating an orphan.

## 12. Success criteria

Everything in §6–§11 is in scope; the product is done when all of it exists, every scenario in §6.12 holds, and:

- An agent given only §7 can attach, read the document and comments, respond with annotations, and receive the user's next round without any other instruction, from any harness that can run commands and capture their output.
- The full check — types, unit, integration, the E2E suite, and the packaged CLI test — is green on both hosts in CI.
- No Send is lost: every delivery is returned until acknowledged, across document close and app restart.
- Editing and saving a file with no changes produces a byte-identical file.
- An agent never receives its own edits back, and never receives another agent's or editor's changes as changes, unless the user includes external changes in a Send or tells it to run `stratamd changes`.
- A Save while agent edits are pending review leaves every one of them pending.
- An agent reading `buffer.md` sees the user's unsaved edits; an agent writing to it changes the editor without changing the document on disk.
- Every net unreviewed difference between a ghosted document and its ghost is visible as track-changes on next open, even if StrataMD was not running when the edits happened.
- After local setup, `stratamd --agent-help` runs from the shell. After the owner selects StrataMD as the default handler, double-clicking a `.md` file opens it in StrataMD.

## 13. Design rationale

Decisions that are not derivable from the requirements, with the alternative that was rejected. Anyone reviewing or implementing this document should read these before proposing changes.

- **The agent attaches itself; there is no host protocol.** Rejected: StrataMD pushing messages into chat harnesses via per-host adapters. The harnesses in use (T3 Code, Claude Code, Codex) are third-party and can't be made to set environment variables or accept messages; a blocking CLI command the agent runs is the one integration every harness already supports.
- **External changes are never delivered automatically.** Rejected: forwarding every external change to every attached agent. The owner's workflow is one agent editing and another reviewing; forwarding would double each agent's context with the other's work. The user decides when an agent should see someone else's edits, via the composer checkbox or by telling the agent to run `changes`. The known cost, that a user hunk's context lines may reveal excluded text, is accepted, and the composer warning shows it.
- **Attribution is best-effort.** Rejected: inferring the writer from which agent was active, and requiring agents to edit through a StrataMD command. Linux gives a user-level app no way to learn which process wrote a file, and agents don't reliably follow a "use our tool instead of yours" rule. Inference would produce confident wrong badges. The `changed` tag exists because harness hooks can call it for free; where it's absent, "external" is the honest label.
- **Authorship is recorded as segments, not an operation log.** Rejected: logging every editor transaction with an author. Authorship only changes at a handful of points per session (an external write, the first user edit after one, a Send), so a snapshot at each boundary yields the same diffs at a fraction of the machinery. Snapshots are content-addressed, so they cost almost nothing.
- **One shared buffer file per document, not one per agent.** Rejected: per-agent proposal files with three-way merge. Per-agent files would identify the writer by path and isolate concurrent writers, but the agent would then edit a copy that drifts from what the user sees, and the merge logic is a larger surface than the problem. A stale whole-file write from an agent is visible in review mode as a reversal the user can revert; that is judged acceptable for a single-user tool.
- **Send freezes a snapshot; delivery is acknowledged by the CLI.** Rejected: computing payloads at collection time (recipient selection and the preview were both violated when the shadow changed between Send and collection), and advancing the baseline on socket write (a CLI killed mid-print lost the Send). Explicit `ack` from the agent was rejected as friction; the CLI acknowledging after a successful flush covers the failure that actually occurs.
- **The ghost advances hunk by hunk.** Rejected: advancing it wholesale on Save. A routine Save after fixing a typo would have silently marked every pending agent edit as reviewed.
- **Send does not save.** Rejected: saving on Send. Agents read the buffer, so there is no reason to couple sharing with persistence; the user saves when they choose.
- **Scan and checkpoint share one seeding rule.** Rejected: giving non-git files an empty ghost so agent-created files show as insertions. Outside git there is no way to tell an agent-created file from the user's own old one, and showing an entire old document as one pending insertion is noise. Inside git, absence from `HEAD` is the signal.
- **No milestones.** The full specification is the scope; nothing in it is deferred. Milestones invite deferring items and declaring completion with pieces missing.
- **Local filesystems only; platforms added deliberately, one at a time.** macOS and Windows were originally dropped to remove whole toolchains. macOS was added in v17 (2026-08-31) once the port carried its own path, socket, menu, and packaging code with tests and a CI job of its own; Windows remains out. Network filesystems stay excluded because their watch semantics are unreliable and the product depends on detecting external writes.
