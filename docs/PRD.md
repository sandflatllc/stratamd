# StrataMD product requirements

Status: draft v26 · 2026-09-04 · personal Linux and macOS tool

## 1. Summary

StrataMD is a desktop Markdown editor and the owner's cockpit for working with agents. The paired T3 server is its required engine: T3 runs agents and owns projects, threads, turns, and messages; Strata shows the conversation, documents, and every item that needs the owner in one window. The owner edits rendered Markdown, reviews external changes as track-changes, answers anchored items where they sit, and sends document rounds back as T3 turns.

StrataMD runs on the owner's Linux workstation or a Mac on macOS 13 or newer. Its file-only `stratamd` tool opens Markdown files, inspects themes, installs the bundled skill, and diagnoses local paths. It does not carry agent traffic.

## 2. Goals

1. **Edit rendered markdown** without mangling untouched source.
2. **Keep the owner in one loop.** Projects, conversations, documents, approvals, items, drafts, review, and Stop are available in Strata.
3. **Use T3 threads as agents.** Agents run in T3 threads and a final fenced `strata` block is their structured write channel.
4. **Hand each thread the right document round.** Deliver only the relevant changes and anchored owner input, with persisted retry-safe acknowledgment.
5. **See every agent edit.** External Markdown edits remain pending until the owner keeps or reverts them.
6. **Keep private work private.** Held comments are drafts outside the annotation log and every agent-readable payload until Send.
7. **Run on the owner's machines.** One paired T3 engine; local document and ghost storage; no Strata account or telemetry.

## 3. Non-goals

- Not a note-taking system, vault, or sync product. Documents remain independent files on disk.
- Not an IDE. There is no terminal or native code editor; code changes are read-only diffs.
- Not a general chat client for arbitrary engines. The paired T3 server is the only engine.
- No Strata-hosted account, cloud storage, or telemetry.
- No laptop or phone browser client for Strata, document features on the phone, preview hosting, or Outcrop integration in v1.
- No Windows support, installer, or auto-updater. The Mac build is an unsigned zip.
- No attempt to preserve every Markdown dialect visually. Unsupported constructs remain raw, byte-preserved blocks.

## 4. Users

- **Primary:** an individual who reviews and edits agent-written documents (plans, specs, SOPs, research) and wants the agent to see exactly what they changed.
- **Secondary:** agents running in T3 threads and posting strata blocks.
- **Tertiary:** other local tools that want to display a markdown file with annotations by invoking StrataMD.

## 5. Core concepts

| Term | Meaning |
|---|---|
| **Engine** | The one paired T3 server. It runs agents and owns projects and threads. |
| **Project** | A T3 project: a folder on disk with its threads. |
| **Thread** | A T3 conversation with one agent. The thread id is the agent identity in Strata. |
| **Turn** | One owner message and the agent work that follows until it stops. |
| **Message** | One owner or agent message in a thread. |
| **Conversation** | The panel that renders a thread in the left window or a center tab. |
| **Attached** | The right-window panel listing threads attached to the open document. |
| **Attachment** | The link between one thread and one document, with a per-thread delivery queue and cursor. |
| **Item** | A decision, question, suggestion, edit, or comment requiring the owner. |
| **Draft** | A private unsent owner comment or answer. It is not an annotation or agent-readable state. |
| **Send** | Materializes selected drafts and answers and produces one delivery for each selected thread. |
| **Delivery** | The immutable document round produced for one thread; it becomes that thread's next turn. |
| **Anchor** | A passage in a document or immutable message, relocated conservatively. |
| **Block id** | A short stable id for a Markdown block in one delivery or message. |
| **Strata block** | The final fenced `strata` JSON array in an agent reply. |
| **Working folder** | The project root or the thread's T3-managed worktree copy. |
| **Composer** | Message input with inline model/account, thinking/context, access, and attachment controls, shared by new and existing conversations. |
| **Stop** | Interrupt the running T3 turn. |
| **Detach** | End a document/thread attachment without changing the thread. |
| **Settle** | T3's lifecycle state for a finished thread. |
| **Disconnected** | The engine is unreachable. |
| **Document** | A `.md` file identified by realpath. Strata writes it only on Save. |
| **Shadow** | The live editor buffer, mirrored to `buffer.md` in the ghost store. |
| **Ghost** | The last content the owner reviewed, advanced hunk by hunk. |
| **Ghost store** | Private per-document state: ghost, buffer, pending hunks, segments, save history, annotations, drafts, attachments, deliveries, and reading state. |
| **Snapshot** | A content-addressed copy of the shadow. |
| **Segment** | Changes between snapshots, authored by the owner or externally. |
| **Hunk** | One contiguous change; pending hunks support Keep and Revert. |
| **Annotation** | A delivered comment, question, decision, or suggestion anchored to text. Every annotation projects as an item. |
| **Lead** | The at-most-one attached thread allowed to accept, reject, save, or resolve another thread's work. |
| **Explorer** | Main's index of Markdown files under folders the owner added. Since 2026-09-04 nothing in the shell draws it; it serves agent access, ghost lookup, and reference resolution. |

## 6. Functional requirements

### 6.0 Starting a conversation

- New thread on a project row opens a blank central conversation for that project and focuses the message input. Global New thread and Ctrl/Cmd+Shift+N use the active project. No setup dialog or name field precedes typing.
- The first Send creates the thread with the title New thread and submits the message. T3 generates a title using its configured text-generation model and streams it to Strata; its manual-rename protection remains authoritative. Empty drafts create no threads. Draft text, attachments, and settings survive navigation and reload. Failed sends keep the draft and reuse the created thread on retry.
- New and existing conversations share a composer. The model picker follows Model family → Subscription → Model. New conversations may choose a family and subscription. Astra and the newest Fable are the daily models; other models stay in a collapsed dropdown. Existing GPT conversations show only GPT and can change GPT subscriptions. Existing Claude conversations show only models from their current Claude subscription, with no other subscription choices. Unusable subscriptions cannot send. Restored drafts and engine turn dispatch enforce the same restrictions. Thinking and context options come from T3's model descriptors, including defaults. Access options explain their behavior. Project selections persist. Account management remains reachable through Engine status and settings.
- A regular new conversation carries no previous messages or open documents. Start thread from a document previews the document, held drafts, and pending comment and infers its containing project. Sending carries that context and the owner's message as one first turn. An unmatched folder can be added inline.
- Current checkout and workspace appear below the composer; an existing thread's known branch is shown. These are informational, with no branch-switching operation.

### 6.1 Editor

- Visual (WYSIWYG) editing of CommonMark + GFM. Editable visually: headings (ATX and setext), paragraphs, emphasis, strong, strikethrough, code spans, links, autolinks, images, lists (ordered, bullet, loose, tight, nested), task lists with interactive checkboxes, tables, fenced and indented code blocks, blockquotes, horizontal rules, hard and soft line breaks, escapes, and entities.
- Rendered as raw blocks, byte-preserved, editable in source view only: YAML frontmatter (collapsible), footnotes, wiki links `[[...]]`, HTML blocks (never rendered as HTML), math, and link reference definitions.
- Formatting toolbar and keyboard shortcuts for all visually editable constructs, following common editor conventions with the platform's primary modifier — Ctrl on Linux, Cmd on macOS (Ctrl/Cmd+B bold, Ctrl/Cmd+I italic, Ctrl/Cmd+K link, Ctrl/Cmd+Shift+C code, Ctrl/Cmd+1..6 heading level, Ctrl/Cmd+Shift+7/8 ordered/bullet list, Ctrl/Cmd+S save, Ctrl/Cmd+Enter send, Ctrl/Cmd+/ source view, Ctrl/Cmd+F find, F7 / Shift+F7 next / previous change).
- **Find.** Ctrl/Cmd+F opens a find bar in the editor pane, in visual and source view alike. The search is a case-insensitive substring match; every match is marked, the current one distinctly and scrolled into view, with a "3 of 12" count. Enter and Shift+Enter (also F3 and Shift+F3) step forward and back with wrap-around; Escape closes the bar, lands the caret on the current match, and returns focus to the editor. The search follows a view toggle.
- **Next / previous change.** F7 and Shift+F7 step through pending hunks and open suggestions in document order, wrapping around, centering each in the editor with the same flash a rail row click gives.
- Spellcheck is the platform's. Code spans and code blocks are rendered with `spellcheck="false"` so paths and identifiers inside them are never flagged; prose is checked as the platform checks it.
- Source view toggle (raw markdown, same buffer). Syntax typed in source view that the visual schema cannot represent becomes a raw block.
- Local images resolve relative to the document and render from disk through a main-process handler that only serves paths under the document's directory or an explorer folder. Remote images and any other remote URL are never fetched; a placeholder is shown.
- A fenced code block whose info string is exactly `mermaid` renders as a diagram in visual view. Mermaid is bundled, loaded only after such a block enters an open document, initialized once with strict security, and permitted no remote resource access. The diagram offers **Diagram** and **Source**, zoom out/in/reset, and pointer or keyboard pan. Pointer pan owns the gesture inside the viewport, focuses it for continued keyboard pan, and suppresses document selection and native drag. Ctrl+wheel or trackpad pinch over the viewport changes diagram zoom within its existing limits; ordinary wheel movement still scrolls the document. Source is the ordinary editable code block; renderer-only compatibility normalization never changes its Markdown. A render failure shows a plain error and leaves Source available.
- A fenced code block whose info string is exactly `tree` renders as a read-only, accessible file hierarchy in visual view. Indentation and the ordinary `├──`, `└──`, and `│` guides determine nesting; malformed input shows the preserved source with a plain explanation. **Tree** and **Source** switch presentation without changing Markdown.
- Clicking or pressing Enter on a rendered local image opens inspection inside the center editor window, with its alt text, optional title, resolved path, close control, fit/reset, zoom, and pan. The same path policy and custom protocol used for inline images serve the focused image; remote images never gain inspection. Image and diagram zoom, pan, source/presentation choice, and focus are session-only and survive document-tab switches until that tab closes.
- Activating an ordinary Markdown link to a local `.md` or `.markdown` file, or an inline code span whose complete text resolves to one, opens a bounded preview beside the reference without navigating away. The preview names the file, shows its title and a short plain-text excerpt, and has an explicit **Open document** action. Resolution is relative to the current document, follows realpaths, allows only the document directory or an explorer root, rejects non-Markdown, remote, missing, and outside-root targets, and reads at most 256 KiB. Other code spans stay code; external links keep their existing safe external-open behavior.
- Every visual heading has a disclosure control. Collapsing it hides content through the next heading of the same or a shallower level and shows counts of unresolved items and pending changes inside. Folded heading references are private durable state in `reading.json`; all heading levels use the same conservative text/parent/adjacent-context relocation rule as walkthrough headings. Find, F7/Shift+F7, and Changes or Items jumps temporarily reveal a hidden target and restore the fold when the target changes, unless the owner explicitly changed that fold.
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
- Owner pin placement edits an `AnnotatedScreenshot` through the normal editor transaction. An agent proposes the same row through a block-id anchored strata edit; neither path writes the document before Save.
- **Byte-preserving save.** Invariant: every syntactic region the user did not touch is written back from its original bytes. Each top-level block keeps its source span; unchanged blocks are emitted verbatim, edited blocks are re-serialized. The serializer may enlarge the rewritten region when the grammar requires it (a paragraph becoming a setext heading, list continuation, a changed link reference definition) and must keep it as small as the grammar allows. Preserved in untouched regions: list marker and emphasis delimiter style, hard wraps, indentation, trailing whitespace, CRLF line endings, a UTF-8 BOM, and a missing final newline.
- Save is atomic (temp file and rename in the document's directory, preserving mode). Immediately before writing, Save re-reads and hashes the document; if it differs from the last known disk content, the change is handled as external first (§6.2) and the user is asked to resolve any conflict before the write proceeds.
- Save is the only StrataMD action that writes the document. After Save the ghost equals the shadow with each pending hunk's region replaced by that hunk's ghost text, so pending external hunks stay pending.
- A Save that changed the file appends one round to the document's save history: the replaced content, the written content, the time, and the contributors active since the previous save (§6.7). A Save that changed nothing appends nothing. The round's author list means activity — it includes a contributor whose edit was later overwritten or undone — and is fixed at Save because segments are pruned later. The Lead's save (§6.6) records exactly like the user's.

### 6.2 Buffer file and external changes

- The shadow is mirrored to `buffer.md` in the document's ghost entry on every change, debounced, and written atomically. Engine deliveries name this path so a thread can read unsaved owner work. While the owner is in the loop, the agent never writes the buffer or document directly; its final strata block is the write channel. A legacy or outside write to `buffer.md` is still merged into the shadow as an external change, and the document on disk remains untouched until Save.
- Every delivery tells the thread to read the buffer and return document actions in its final strata block. Strata cannot prevent unattended tools from writing a project document; those writes arrive through the engine turn diff and the external-change reconciler.
- StrataMD ignores its own writes by content hash: a watcher event whose content equals the last mirror or Save it wrote is not an external change.
- **External change handling.** When the document or `buffer.md` changes on disk while open:
  1. Read the file and compare its hash to the last known contents; ignore if equal.
  2. Compute the patch from the last known contents to the new.
  3. Snapshot the shadow before applying; this closes the current segment and opens an `external` one.
  4. Apply the patch to the shadow for blocks with no unsaved edits, record the resulting hunks as pending, and show them in review mode. A block is a conflict when the patch touches it and the user has edited it since the source was last written (since the last Save for a document write; since the last mirror write for a `buffer.md` write). The user picks the incoming side or their own for each conflict.
  5. Do not touch the ghost or any attachment baseline.
- A stale outside write of a whole buffer from an older copy appears as an external change that reverses the owner's newer edits. It is shown in review mode like any other external change; Strata does not guess the writer's earlier baseline.
- Attribution comes from the engine's per-turn diff only when one thread certainly wrote the file: its own worktree, or the only running thread in that project root. Shared-root and non-git writes are labeled external.
- Detection watches the document's directory and the ghost entry, so temp-and-rename writes are seen. Watch events are wake-ups, not a log: every event triggers a read and hash compare. StrataMD also re-reads and compares on open, on window focus, immediately before Save, after a watcher error or overflow, and on app start. Only local filesystems are supported.

### 6.3 Review mode and the ghost

- Every document Strata has opened, scanned, or learned from a thread diff has a ghost. When the shadow differs from it, track-changes show deletions, insertions, and an author badge. Hunks that cannot render inline appear as review cards with before/after text; review mode also works in source view.
- **Ghost seeding:** Open and Scan seed a missing ghost from current document content and show nothing pending. A Markdown file first learned from a completed turn instead seeds from the pre-turn checkpoint, so opening it later shows that turn's content as pending hunks without having auto-opened it. If the engine cannot prove a pre-turn baseline, Strata labels the difference external.
- A pre-upgrade store whose ghost is accidentally empty while its document is not re-seeds from the document once on next open; unsaved buffer work stays pending.
- Pending hunk ranges are mapped through every editor transaction while the document is open (ProseMirror position mapping) and stored as text anchors when closed. If the user edits inside a pending hunk it becomes `mixed`.
- Per pending hunk: **Keep** applies the hunk's current region to the ghost and clears it. **Revert** restores the ghost's text in the shadow and clears it; on a `mixed` hunk it asks for confirmation and states that the owner's edits inside will be discarded. The revert is an owner edit that records the hunk author's attribution on its segment: it reaches other attached threads as an owner hunk on their next delivery, never its author (§6.7). **Mark reviewed** keeps all remaining pending hunks. Keep and Revert do not change a hunk's author, and each tells an agent-authored hunk's thread its verdict: the thread's next delivery carries a `kept` or `reverted` entry with a one-line excerpt, not its own text as a diff. Undoing the Keep or Revert before that delivery retracts the entry.
- The ghost advances only hunk by hunk. Keep and Mark reviewed apply pending hunks. Save applies the owner's own hunks by the rule in §6.1; an owner hunk overlapping a pending external hunk leaves that region pending and the hunk `mixed`. The ghost never advances because the file changed on disk, and is not touched on close or Detach.
- **Undo and redo.** Typing and application steps (Keep, Revert, Accept, Mark reviewed, requote, conflict resolution, external merge) share one history per document, walked in the order they happened. Undo reverses only the most recent step. Save and Send end application-step history because their effects have been written or delivered; typing history continues across them. New edits or annotation actions clear redo. History survives tab switches and is dropped on close.
- Pending hunks, their status, and authorship are persisted, so partial review survives close and restart. On open, pending hunks are recomputed as diff(ghost, shadow); persisted authorship is kept where the hunk still matches, otherwise the hunk is `external`. Closing a tab with pending hunks leaves them for the next open; the tab shows a count.
- **Crash recovery.** On open, if `buffer.md` differs from the document and is newer than the last Save, the user is offered **Recover** (shadow = buffer) or **Discard** (shadow = disk, buffer reset). StrataMD never silently overwrites either side.
- **Close.** Closing a tab with unsaved edits offers Save, Discard, or Cancel. Discard resets `buffer.md` to disk; pending hunks that existed only in the buffer disappear on the next open by the recompute rule above.
- Renaming or moving a document while open: the session and its ghost entry follow the new realpath, read from the open file descriptor (`/proc` on Linux, `F_GETPATH` on macOS). While closed: the new path is a new document, seeded by the ghost seeding rule; the old entry remains until forgotten (§9).

### 6.4 Explorer

- **No Files panel, decided 2026-09-04.** The shell draws no folder or file list. Documents open from the **Open file** button (top bar and welcome card, which call the system file dialog), the CLI, the file manager, or drag-drop. The explorer below is a main-process index: it still decides which files agents may reach and which local references resolve, and its folders still live in `settings.json`. Scan, Refresh, Add folder, Remove folder, and Forget have no control in the shell; their IPC and storage remain.
- The index covers only `*.md` / `*.markdown` files under folders the user has added, honoring `.gitignore` inside git work trees and skipping `node_modules`. Symlink loops and overlapping folders are detected; each file appears once. Files are shown under the subfolders they sit in on disk, nested as on disk, never flattened; subfolders with no markdown files are not shown. Every folder row, root or nested, collapses and expands on click; added folders start expanded and subfolders start collapsed. A root folder row shows its folder name preceded by at most one parent segment (`parent/name`); the name is always fully visible and the parent segment is what gets elided when space runs out. Hovering a folder row for about a second shows the full path in a tooltip. Right-clicking any folder or file row opens a menu with Copy full path, which copies the absolute path to the clipboard; on a root folder row the menu also offers Remove folder, which takes the folder out of the explorer while its documents stay remembered (§9).
- **Scan** on a folder creates a ghost for every file that lacks one, by the ghost seeding rule. **Refresh** rescans for new and removed files.
- Folders are not watched in the background; Refresh is explicit.

### 6.5 Drafts, annotations, and items

- Selecting document or completed agent-message text opens kind pills, text, recipient pills, **Hold**, and **Send**. Escape discards; Hold or an outside click with text stores a private draft. Enter quick-sends only that comment; Shift+Enter inserts a newline.
- Drafts use a separate atomic ghost-store file per document or thread. They never enter reading state, the annotation log, the buffer, or any delivery until selected in Send. They render dashed with a `draft` chip and a distinct Contents marker.
- Send lists drafts under **Your comments**, checked by default. Unchecked drafts remain drafts and are offered again. A stale preview cannot materialize them.
- An annotation is the delivered form of an owner or agent comment, question, decision, or suggestion. Items are the owner-facing view over annotations, edits, hunks, user-input requests, and inferred message questions.
- Items carry author, anchor, status, and producing turn. The turn checklist orders decisions first and then document/message order. Immediate actions are decision options, Accept/Reject, Keep/Revert, approval or user-input response, and jump. Any row may hold an inline reply.
- An inline reply remains **Drafted** until its delivery is acknowledged, then the row is done. Done rows dim and may collapse. The Items rail lists open, inferred, and answered items for the document and active conversation with progress.
- Document anchors use exact quote plus context and relocate conservatively; message anchors additionally key by thread and immutable message id. Document items support Reviewed and Revisit by hashing anchored text. Message items are open or done.
- Decisions have at least two distinct options plus Other. Only the owner answers or reopens them. T3 user-input requests render in the same decision style but dispatch their answer immediately through the engine.
- Suggestions and direct edits share the review presentation. Accept/Reject and Keep/Revert update the same underlying records used by the document controls. Storage remains outside Markdown.

### 6.6 Attachments

- An attachment links one T3 thread to one document and persists its delivery queue, block map, and annotation cursor. The thread id is the identity.
- Engine state supplies running, awaiting approval, idle, settled, pinned, disconnected, and elapsed status. The Attached panel shows each thread with status, Lead, Stop, open-as-tab, and Detach.
- Detach ends only the document/thread link. It never settles, archives, deletes, or interrupts the T3 thread.
- The first document Send to a thread creates the attachment. An unattached thread may instead post an attach-only strata block; Strata links it and sends the normal first delivery, and document actions begin on the following turn.
- At most one attached thread holds the Lead. Owner actions grant, transfer, or revoke it; Lead-only block verbs are accept, reject, save, and resolving another thread's item.

### 6.7 Send and delivery

- The Changes panel lists pending hunks and save history. Send snapshots the shadow but never saves the document.
- Recipient pills contain attached threads and the active conversation in the same project. The Lead alone is preselected when present; otherwise the active conversation alone is. Additional recipients require deliberate clicks.
- The composer groups checked owner changes, annotations and replies, drafts, and optional external context. Each selected recipient has a preview tab. Unchecked delivered items are skipped for that recipient; unchecked drafts remain private drafts.
- A stale preview cannot send. Send freezes one immutable delivery per selected thread with a persisted command id. Sending while a turn runs dispatches immediately for T3 to steer or queue.
- A delivery becomes a T3 turn. Its message is one line naming the delivery and counts; the exact delivery text, including block ids, travels as a file attachment. The delivery id is the chosen message id.
- T3's message-sent event for that id acknowledges the delivery. Only then do its baseline and cursor advance and its queue entry leave. Retrying reuses the command id, so a crash between dispatch and acknowledgment cannot duplicate a turn.
- Quick send creates an empty-range delivery containing only that new annotation. It advances no baseline or cursor and does not sweep other drafts, unsent edits, or annotation events.
- First delivery uses turn attribution: no document when the buffer is unchanged since that same thread's certain write; a diff when it changed; otherwise the whole buffer. Later deliveries contain diffs, comments, replies, verdicts, strata outcomes, and the note.
- A strata block's entry outcomes return line by line in the next delivery as applied with item id or failed with reason and nearest block candidates.

### 6.8 File-only tool

- `stratamd` is a plain-Node file-only launcher. It never connects to the app or transports agent work.
- `stratamd open [file]` launches StrataMD, optionally with one Markdown path. Single-instance routing is owned by Electron.
- `stratamd theme [id] [--json]` inspects the active, named, or built-in theme without mutating it.
- `stratamd setup [--skill <claude|codex|agents|dir>] [--default] [--remove]` installs the launcher, desktop integration, or bundled skill and is safe to repeat.
- `stratamd doctor` reports local app, data, config, log, and engine-credential paths and readable problems without changing state.
- `stratamd --agent-help` prints §7 verbatim. `--help` describes only these file-only jobs, and `--version` reports the app, CLI, and contract versions.
- Agents receive the live buffer path and block ids inside the engine delivery. All document communication returns in their completed message's final strata block.

### 6.9 App shell and design

- The left window has Projects, and Conversation and Contents while a document is in the center. The top bar shows pinned documents and conversations, and the active one of each, as pills; every other open item waits in the Docs or Conversations dropdown pill. The right window has Changes, Items, and Attached. Conversation is one component in either placement. Agent prose is always shown in full; earlier turns fold only their work log.
- Projects renders active threads in collapsible T3 project folders, and future-snoozed and explicitly settled threads in separate collapsed shelves. Pinned threads sort first and do not count toward the folder preview cap. Rows show only the star, current attention state, title, relative time, pending-work and attachment marks, and hover Settle. Every other action lives in the right-click menu. Engine status opens the Accounts modal and Settings reaches the same modal. Empty engine surfaces share the same server-naming disconnected line and Reconnect action.
- **The design is the handoff in `docs/design/`** (`docs/design/README.md`, `StrataMD App v2.dc.html`, `support.js`, and `animations-handoff.md` for the ambient animation system). It is the source of truth for layout, every screen and overlay, tokens, typography, spacing, motion, and interaction feedback. This PRD does not restate it. Where the handoff and this PRD disagree on behavior, the PRD wins; where they disagree on appearance, the handoff wins.
- **Implementation starts from the prototype, not from prose.** The renderer is built by porting the prototype's markup, styles, and state transitions into React + Tailwind components, replacing the mock document area with the ProseMirror view and the class-component state with data from the main process. Reuse and adapt before rewriting; write from scratch only what the prototype does not contain.
- Deltas from the handoff, decided here:
  - Native window frame (`frame: true`). KDE draws the title bar; the drawn – □ × controls are dropped and the top bar is an in-window toolbar row.
  - The "Prototype demos" island is prototype-only and is not ported.
  - Fonts are bundled; the prototype's Google Fonts links are not copied (§11).
  - Panels are user-resizable within the handoff's ranges, and sizes persist in `settings.json`. The right sidebar and its width handle appear only in document mode. Double-clicking the width handle collapses the entire sidebar, leaving only the handle; double-clicking again restores the saved width. Enter or Space on the handle also toggles it. Collapse state lasts for the window session and survives mode and document tab switches.
  - Ambient motion defaults on, honors `prefers-reduced-motion`, and pauses while keystrokes arrive. The owner explicitly confirmed the handoff's animated presentation is the intended default on 2026-08-28. The built-in theme's ambient styles are the animation handoff's defaults, `Rising motes` for the background and `Glow orbs` inside windows (§6.13).
  - Typography: Baloo 2 stays for all upright text. Because Baloo 2 has no italic face, Nunito Italic is registered under the same family name with `font-style: italic`, so emphasized text gets a real italic in a matching rounded design instead of a synthesized slant. Owner confirms by eye in the prototype before the typography pass is closed. A theme may name any installed family for text and for code; the Nunito italic mapping applies only when the text font is Baloo 2.
  - Thread colors are assigned in attachment order from the handoff palette after pink (reserved for the owner): grape, sky, mint, tangerine, then repeat. The colors themselves come from the active theme's `people` group (§6.13).
  - **The right rail is a map, decided 2026-08-30 and normalized for the cockpit on 2026-09-03.** Changes and Items use compact rows that center their marked document or message passage. Attached lists document-linked T3 threads with live engine state, Lead, Stop, open-as-tab, and Detach. A row names its action, author, and a short excerpt rather than an internal id or path.
  - **Conversation lives in the left window or a center tab.** The same component follows the active T3 thread. Agent prose stays visible in both placements. All messages appear newest first regardless of sender, with each message still read from top to bottom. This also applies to This passage discussions, including replies and decision answers. Opening or returning to a conversation starts at the beginning of its newest message; incoming messages keep the view at the top when it is already there, and otherwise preserve the current reading position. The composer stays at the bottom. Finished work collapses by turn into step toggles, while running work stays live with Working, elapsed time, and Thinking states. Document-anchored item activation still centers and highlights its passage. Message items open the immutable agent passage. The left window has one width for every tab, `explorerWidth` in `settings.json` (decided 2026-09-04; the older `threadPanel` width is read but ignored). Conversation text scales with the left window's zoom factor in the side placement and with the editor's factor in the center, where the conversation is the editor pane. Messages render block-level Markdown (headings, lists, code blocks, quotes, tables) with the document's typography tokens at conversation scale; the same parser serves messages and rail snippets. A turn's changed files fold into one card after its last agent message (decided 2026-09-04, matching T3): a count and a net delta in thousands form, the top-level folders they fall under with counts, up to three file chips named by file with an extension mark, and **Show all** or **Show files** to list every file by folder with its relative path and counts. Paths read relative to the project's workspace root and never print in full unless they lie outside it; the full path is the row's tooltip. A changed Markdown file opens as a document from its chip or row; other files list without an action. Enter sends from its compact composer and Shift+Enter inserts a newline.
  - **User-facing copy, decided 2026-08-30.** Every label, chip, counter, tooltip, and dialog uses plain everyday words; the audience works with agents, not necessarily with code. Internal vocabulary (buffer, ghost, shadow, orphaned, external, delivery, on disk) appears only in this PRD and the code. A file changed by something else while the user edits is "changed outside StrataMD"; the conflict dialog's columns read "Your version · unsaved" and "Changed outside".
  - **Drafts and Escape.** The Send composer's note, choices, and unsent item replies are kept per document while the app runs, so Escape or reopening never loses them; successful Send clears only what it carried. Escape closes only the topmost surface.
  - **Notices.** A success notice clears itself after a moment. A failure shows as an error notice in the theme's danger color that stays until dismissed with its × or Escape, or until a newer error replaces it; a success never paints over an unexpired error.
  - **Save state and counts, decided 2026-08-30.** The editor always shows whether it matches the saved file: the Save button reads "Save" (accented) while unsaved changes exist and a quiet "Saved" otherwise; the tab carries an unsaved dot beside its name, distinct from its count badge; the rail footer reads "Unsaved changes · last saved 3 minutes ago" or "Everything saved · 3 minutes ago". Changes groups **Proposed**, **Unsaved**, and **Saved** rows and lists save history below them. The Items header counts open items and those anchored to removed text. The top bar keeps the total pending count and tints it while anything counted is unsaved. Reverting a Saved hunk restores text the file does not have, so the document reads unsaved until the next Save.
  - **Workspace restoration.** On first launch or when saved layout state is missing or invalid, Conversation occupies the center even before a thread is selected. Reopening restores the last center or side placement and open conversation tabs, along with the existing document and reading state. Selecting a thread under Projects keeps the current placement, including when that thread already has a center tab. Explicitly opening a document puts it in the center; restoring recent documents does not replace a saved centered conversation.
  - **Tabbed side hosts, normalized 2026-09-03 and reordered 2026-09-04.** The left window owns **Projects** first, then **Conversation** and **Contents**, which appear only while a document is in the center; with a conversation or nothing in the center it offers Projects alone. Files was removed on 2026-09-04 (§6.4). The selected left tab is remembered per document in `reading.json` for all three values; a stored `files` reads as Contents. The upper-right review host owns **Changes** and **Items**; **Pin Changes** adds a capped session-only strip while Items is selected. **Attached** remains visible below it. Documents and threads cannot alter application tabs. Projects, Conversation, and Contents keep the `explorer` pane identity; Changes, Items, and Attached keep `rightRail`; the center conversation takes the `editor` pane.
  - **Top bar pills, decided 2026-09-04.** Documents and conversations never mix in one strip. The strip shows, in order: pinned documents in pin order, the active document when unpinned, the **Docs** dropdown pill, pinned conversations, the active conversation when unpinned, and the **Conversations** dropdown pill. Each dropdown lists every open item of its kind in opening order with its unsaved dot or badge, a pin toggle, and a close control; a document pill's right-click menu adds Pin or Unpin beside the §5.16 actions. The dropdown pill carries the open count and, while the active item is not a pill, its name. Pins are a preference of the window kept in local storage; they never record what is open, a pinned item that closes leaves the bar, and reopening it pins again. Ctrl+Tab cycling, Ctrl/Cmd+W, and middle click behave as before.
  - **Open tabs, decided 2026-09-02.** The top bar, pills plus the Docs dropdown, is the only record of which documents are open; the shell has no second list of open or recent files. The open tab set and the focused tab persist in a private `open-documents.json` beside the ghost store and are restored in order at startup before any document named on the command line, which then takes focus. Files that no longer exist are skipped quietly. Persisting and restoring tabs never changes Markdown, `meta.json`, or agent traffic.
  - **Contents, decided 2026-09-02.** Contents is derived from the live ProseMirror document, never from a second Markdown parse. H1 is presented as the document title; H2 headings are primary sections; H3–H6 nest beneath their nearest shallower heading. Editing a heading updates the index immediately. The active row follows the editor's scroll position, and activating a row centers its heading without changing the document. A heading-free document shows a plain empty state. The selected left and review tabs are remembered per document in its private `reading.json`; switching document tabs restores them along with the editor's existing per-document scroll position.
  - **Review host sizing and migration, decided 2026-09-02.** The upper review window is vertically resizable and persists one `upperReviewHeight` setting. Existing settings migrate deterministically by summing the two readable legacy heights plus their former 14px intervening gutter, then clamping to 180–954px; when only one legacy value is readable, that value is used; otherwise the 444px default applies. The renderer further clamps the visible height against the available column so Attached remains visible. Attached consumes the remaining right-column height.
  - **Structured-reading performance budget.** On the existing greater-than-2-MB corpus, opening and ordinary typing may regress by no more than 10 percent from the pre-phase median. A heading-index update completes within 50ms and is scheduled outside the keystroke-critical transaction path.
  - **Walkthrough, decided 2026-09-02.** Contents offers **Start walkthrough** and, while active, **Leave walkthrough**. Starting selects Contents and creates an ordered step list from all H2 headings; the private `H2 + H3` option also makes every H3 a step. The complete Contents outline remains visible. Each eligible heading has a private include/remove control, initially included and visually distinct from its review-status checkbox; progress, Previous, and Next use only included steps and do not infer numbers from heading text. The current step is restored per document and follows an included section selected in Contents or reached by walkthrough navigation. If no steps remain, the controls explain that the user can include one rather than failing or changing the file.
  - **Reviewed and Revisit.** Every eligible Contents row has a review-status checkbox: activating an unchecked or Revisit row marks it Reviewed, and activating a Reviewed row marks it Revisit. The bottom walkthrough bar offers the same two explicit states for the current step. Reviewed stores a SHA-256 hash of the section's exact UTF-8 Markdown, from its heading through the byte before the next heading of the same or a shallower level. A text change from any ingress—visual/source typing, a strata edit, an outside write, accepted suggestion, Keep/Revert, undo, or redo—rechecks only affected sections. A differing hash changes Reviewed to Revisit; matching the stored hash again restores Reviewed. Manual Revisit keeps the most recent reviewed hash when one exists, so a later exact restoration may return to Reviewed. Keep cannot restore Reviewed unless it restores the reviewed bytes.
  - **Walkthrough identity and persistence.** Walkthrough state is format-versioned inside `reading.json`: active state, H2/H2+H3 mode, current step, exclusions, and markers with reviewed hashes. While the document is open, steps retain their parsed source identity through edits. On reopen, a reference relocates only to a unique heading with the same level and normalized text, using its parent and adjacent heading text to disambiguate duplicates. A deleted or ambiguous reference is discarded; StrataMD never attaches it to a merely nearby unrelated heading. Reconciliation rewrites relocated references atomically and never changes Markdown or agent traffic.
  - **Walkthrough performance budget.** The open session caches section boundaries and hashes. An ordinary edit that cannot change heading structure shifts cached boundaries and hashes only the affected reviewed section; heading-boundary edits rebuild the index conservatively. A change confined to one section updates its marker and hash within 50ms without hashing the whole document on each transaction.
  - **Table views, decided 2026-09-02.** Every editable GFM table has a compact StrataMD toolbar. **Table** is the polished, editable source-order view. Sorting, a case-insensitive column filter, hidden columns, **Focus row**, and **Compare** render a read-only derived view beside the same ProseMirror table node. They never reorder nodes or create a Markdown transaction. **Edit** returns to source order and places the caret in the row and cell last selected in the derived view. Compare requires at least two selected body rows; Focus row shows one body row as labeled fields. Row selection, column visibility, width controls, and comfortable or compact density stay available without turning the editor into a spreadsheet. Controls collapse into a menu below 620px of table width. **Focus** gives the table the center editor's available workspace and preserves both side regions; center focus is session-only and survives document tab switches while the app runs.
  - **Table state and identity.** Table presentation, sort, filter, hidden columns, selected comparison rows, focused row, density, and column widths are private per-document state in `reading.json`. A table reference contains its nearest preceding heading's normalized text and level, its normalized header labels, and its occurrence number among tables with that same heading and header signature. A reference restores only on one exact match. Missing or ambiguous table state is discarded rather than attached to a different table. `reading.json` migrates from v2 to v3 by adding an empty table-state list.
  - **Table discussion.** Clicking a source or derived cell selects its body row and column for the table toolbar. **Discuss row** creates an ordinary question annotation anchored to the complete Markdown row. **Discuss cell** uses that same complete-row anchor and adds structured context with the nearest heading, all column labels, the chosen column label, and its zero-based index. Both actions open the existing annotation composer with Question already selected; the resulting thread, Send behavior, relocation, resolution, and agent delivery remain the ordinary annotation lifecycle. The readable agent payload names the table heading and column context. Header and delimiter rows cannot start row discussion.
  - **Hidden review targets.** A derived table reports the count of unresolved items and pending changes hidden in its source table. Find and F7/F8 stepping, Changes and Items row clicks, and in-document review activation temporarily show the editable source table, center the exact target, and keep the owner's stored table view unchanged. Moving to another review target or choosing **Return to table view** restores the derived presentation. No filter, Compare, Focus row, hidden column, or center Focus setting can make review work unreachable.
  - **Table performance budget.** Sorting or filtering a 1,000-row table and returning to the editable source-order table each complete within 100ms. Instrumentation verifies that each action dispatches no Markdown transaction.
  - **Decision items.** The Items rail filters All, Decisions, Questions, Comments, Suggestions, and Resolved. Decision creation supports document, heading, and selection anchors with at least two unique options. Resolved decisions retain answer history and can be reopened.
  - **Decision answer flow.** The decision thread keeps the ordinary reply box for clarification. An open decision shows radio choices plus **Other** with a text field and one **Answer decision** action. A resolved decision shows each past answer in sequence and **Reopen decision**. An answer remains checked by default in the next Send composer, whose row says what the owner chose; answering creates no change row. The annotation event projection, filtering, answering, and payload construction each handle 100 decisions with history in under 100ms.
  - **Diagrams and file trees, decided 2026-09-02.** Exact `mermaid` and `tree` fenced info strings receive Strata-owned visual presentations while retaining the existing editable code-block source and byte-preserving serialization. Mermaid loads through a dynamic import only when used, initializes with `startOnLoad: false`, `securityLevel: 'strict'`, HTML labels disabled, and theme values derived from Strata tokens. The renderer may translate `<br>`, `<br/>`, or `<br />` to label newlines in memory after the review-document proof, but never mutates Markdown or relaxes CSP. Diagram controls are Diagram/Source, zoom out, reset, zoom in, and pan; pointer pan suppresses selection and native drag, Ctrl+wheel or trackpad pinch zooms only the diagram, and ordinary wheel input keeps scrolling the document. A failed diagram stays editable through Source. File-tree rows expose `treeitem` level and expansion semantics but do not read the filesystem or invent links.
  - **Image inspection.** A ready local image is keyboard focusable; click or Enter opens a center-only inspection surface above the document. It shows alt text, title when present, the resolved local path, Fit, zoom out/in, and Close, and supports pointer and arrow-key pan. Escape closes it and returns focus to the originating image. Side regions remain visible. The focused bitmap reuses the inline image URL rather than requesting or decoding another copy.
  - **Local reference previews.** A local Markdown reference opens a selection-anchored preview on click or Enter and never navigates on that activation. For links, the Markdown destination is the candidate; for inline code, the entire code-span text is the candidate only when it resembles a `.md` or `.markdown` path. Query and fragment text may select a heading in the preview but are removed before filesystem resolution. Main resolves realpaths inside the current document directory or an explorer root and returns at most 256 KiB; the renderer derives a title and bounded plain-text excerpt. The preview has **Open document** as the only navigation action, closes with Escape or outside activation, and restores editor focus. Remote, scheme-bearing, missing, non-Markdown, ambiguous, and outside-root candidates do not preview.
  - **Heading folding.** Each H1-H6 receives a keyboard-operable disclosure before its text. A fold hides all following sibling content until the next heading of equal or smaller depth while leaving the heading visible. It shows separate annotation and change counts when hidden work exists. Folds store conservative heading references in `reading.json` v4, migrate v3 by adding an empty list, and never alter ProseMirror nodes or Markdown. Review jumps and find stepping temporarily reveal all ancestor folds containing the target; moving to another target or explicitly restoring returns the stored fold, while clicking a disclosure is an owner change and therefore becomes the new stored state.
  - **Phase 6 security and performance.** Mermaid and reference preview code is absent from the ordinary open/typing path unless its construct occurs. Renderer CSP remains unchanged and network-denial tests observe no Mermaid, image, or preview request. Against the review fixture, the proof records the lazy Mermaid chunk, first render under one second, retained renderer memory, all three diagrams, and strict-mode `<br/>` behavior before the diagram NodeView ships. A document without Phase 6 constructs regresses open and typing medians no more than 5%; a local Markdown preview opens in under 100ms.
  - Per-pane text zoom. The explorer, the editor, and the right rail each carry an independent text-size factor (default 1.0, steps of 0.1, range 0.5–2.0). Ctrl/Cmd+= and Ctrl/Cmd+- change the factor of the pane under the pointer, or the editor when the pointer is over no pane; Ctrl/Cmd+wheel changes the pane under the pointer by one step per wheel notch, accumulating trackpad deltas so a gesture does not skip steps. A Mermaid viewport owns Ctrl+wheel and trackpad pinch that begins inside it, so those gestures change only its diagram zoom. The window itself never zooms: the Electron default menu's zoom roles are removed and pinch zoom is locked. A single text button in the top bar, `Reset zoom`, returns all panes to 1.0; it is shown only while some pane is off 1.0, it is the only zoom control drawn, and no zoom icons are added. Only type scales; panel widths, spacing, and the editor toolbar row do not. Factors persist in `settings.json`. Every pane-scoped size, including the cockpit panels Projects, Conversation, and Documents, is written as pixels times the pane factor and every color is a theme token; `test/unit/styles-zoom.test.ts` fails the build on a bare rem size or a custom property no theme defines (added 2026-09-04 after Conversation shipped with neither).
- Single instance: launching with a path while running opens a new tab in the existing instance. Closing the last window quits the app; engine deliveries and document attachments remain durable.
- Tabs hold multiple open documents and center conversations. Each document retains its scroll position across switches in visual and source view. Ctrl/Cmd+W closes the active tab through the same close confirmation a click gets; Ctrl+Tab / Ctrl+Shift+Tab and Ctrl/Cmd+PageDown / PageUp cycle tabs; a middle click closes a tab.
- Open from the Open file button (system dialog), CLI, file manager, or drag-drop. The file-drop overlay and messages respond only to transfers that contain files; text, HTML, images, and internal editor drags do not enter the open-file workflow.
- On Linux the `.desktop` entry declares `MimeType=text/markdown;`; `.md` and `.markdown` map to that type through the shared MIME database. On macOS the `.app` bundle declares both extensions (role Editor, rank Alternate) and Launch Services learns the association from it. Making StrataMD the default handler is a separate step done only when the owner requests it: `stratamd setup --default` records it on Linux, and on macOS prints the Finder steps (Open With → Change All) for the user to complete by hand.
- The keyboard reaches and operates every review action, annotation thread, composer tab, conflict, and banner.
- Config lives in `$XDG_CONFIG_HOME/stratamd` (fallback `~/.config/stratamd`). `settings.json` stores the active theme id, resolved-item preference, explorer folders, panel sizes and document measure, theme-panel and composer geometry, per-pane text zoom, and ambient motion. Private per-document reading state is atomically written to `reading.json` beside `meta.json` and `buffer.md`; shell tab choices do not cause high-frequency collaboration-state writes or alter Markdown.

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
- **A background job fails:** the buffer mirror, file watcher, and state persist run outside any owner action. Each failure is logged (§9) and shown as a plain document banner explaining what stopped and what it means (a thread may read an older copy; outside edits may not be noticed; review notes may not survive closing). The banner clears when the job next succeeds. A failed mirror write stays queued and retries on the next edit.
- **Document referenced by a ghost entry no longer exists:** the entry is kept until forgotten; since 2026-09-04 the shell lists no ghosts, so the tab of an open document is where a deletion shows (§6.2).

### 6.11 State model

Per document: disk, shadow, ghost, pending hunks, segments, save history, annotation log, and drafts. Per attachment: thread id, baseline, delivery queue, cursor, block maps, and command receipts. Per engine: paired credential, shell snapshot/stream cursor, thread snapshots/stream cursors, and last-visited times.

| Event | Document effect | Attachment / engine effect |
|---|---|---|
| Open | Read disk, restore buffer/ghost/review/drafts, and detect external differences. | None. |
| User edit | Change shadow, map pending ranges, and append owner segment as needed. | None until Send. |
| External write | Patch shadow when safe and add externally authored pending hunks. | Turn diff supplies thread attribution only when certain. |
| Keep / Revert | Advance ghost for that hunk, or restore ghost text. | Queue the producing thread's verdict. |
| Hold | Persist a private draft only. | None. |
| Quick send | Materialize one annotation. | Queue and dispatch one empty-range delivery. |
| Send | Materialize checked drafts and freeze the reviewed snapshot. | Queue one delivery per selected thread and dispatch each as a turn. |
| Message sent | None. | Acknowledge the matching delivery once; advance baseline/cursor and remove it. |
| Completed agent message | Apply valid strata entries and derive explicit/inferred items. | Persist entry outcomes for the next delivery. |
| Turn diff | Seed ghosts for created/edited Markdown without opening files. | Add file rows and Changes summaries. |
| Stop / approval / user input | None. | Dispatch the corresponding engine command immediately. |
| Detach | Keep document, review, drafts, and thread. | Delete only this document/thread link. |
| Engine disconnect/reconnect | Document behavior continues. | Render the shared disconnected state; resubscribe from persisted cursors. |

### 6.12 Acceptance scenarios

Each must hold before the product is done. `docs/PRD_CONFORMANCE.md` §6.12 names the test that proves each one, or records it as open with the reason; as of 2026-09-04, 11 and the server half of 13 are open because they need unchanged T3 mobile and a controlled restart of the owner's server.

1. With the engine disconnected, every document feature works and every engine surface shows the same disconnected line. Reconnecting restores conversation without losing drafts or scroll.
2. Selecting a thread in Projects shows its transcript in Conversation within one second, with live trace and working Stop.
3. One turn posting a decision, question, suggestion, and edit yields a four-row checklist, decisions first; its controls agree with the document and Items rail.
4. Seven unposted prose questions yield seven inferred items. Four inline answers sent together produce exactly four item-keyed replies; three stay open.
5. Enter on one comment delivers only that comment. Two held drafts remain absent from the delivery, buffer, and all agent-readable state.
6. An unchecked draft remains private and returns checked in the next composer.
7. Of two attached threads, the active conversation alone is preselected; after Lead transfer, only the Lead is preselected; multi-recipient Send needs a second click.
8. Start thread from a document preselects its containing project; confirming with a pending comment creates the thread and sends the comment plus the correct first-delivery document form.
9. A turn creating two Markdown files adds both to Files with seeded ghosts and opens neither; opening one shows pending hunks.
10. A crash between turn dispatch and message-sent acknowledgment leaves the delivery queued; restart does not send twice and advances the baseline once.
11. Unchanged T3 mobile pairs with the published server, opens a Strata-started thread, replies, and Strata renders the reply in that same thread.
12. For corpus turns posting items, agent chat prose contains at most one line per action and does not repeat proposed text.
13. Over localhost, Strata continues a thread started elsewhere as the same thread, Stop interrupts within two seconds, and server restart resubscribes without duplicates.
14. A strata block with two valid entries and one stale block id creates two items and one failure, all reported entry by entry in the next delivery; an attach-only block bootstraps an unattached thread.
15. A prior certain write yields no document on unchanged first delivery and a diff after owner change; no/uncertain attribution yields the whole buffer.
16. With two simultaneous root-mode threads, a write is external and attributed to neither; either thread's first delivery receives the whole buffer.
17. Answering an agent user-input request in Conversation resumes the turn immediately without waiting for Send.
18. A no-op Save is byte-identical; structural corpus edits rewrite only the smallest grammar-safe region.
19. Save with agent changes pending writes the shadow while every pending hunk stays reviewable.
20. An external disk write racing Save is detected before writing.
21. Crash recovery preserves unsaved edits; explicit Discard removes buffer-only work.
22. Renaming an open file moves its session and ghost once.
23. A stale suggestion becomes orphaned and cannot be accepted.
24. Strata's buffer mirror and Save never appear as external changes.

### 6.13 Themes

- A theme is a named set of values that decides the app's colors, fonts, and ambient behavior. Themes carry values only, never code or stylesheets: a theme cannot change layout, run scripts, or add animations the app does not already have.
- Seven stock themes ship with the app: Strata Vivid (the default and built-in fallback: Strata's dark purple structure with the owner's vivid text palette, decided 2026-08-30), Strata (the quieter original design handoff), Ember (warm dark), Candyfloss (light pink), Isotope (light grey, no motion), Nebula (deep space), and Paper (light cream); the owner approved this set on 2026-08-29. Every stock theme declares all 46 color swatches, both fonts, and all four effect settings explicitly - none inherits a value from another, so changing one can never silently change the rest. The six `visuals.category-1` through `visuals.category-6` swatches form an ordered categorical chart palette and are never borrowed from controls, change authors, or ambient effects. Strata Vivid's complete definition is the fallback for every missing or invalid value everywhere, and the theme the app returns to when an active theme's file disappears or is deleted; a fresh install opens on Strata Vivid. Stock themes cannot be edited or deleted and never exist as files; New from this copies one into an editable file carrying every chosen value.
- User themes are single JSON files in `$XDG_CONFIG_HOME/stratamd/themes/<id>.json`. The id is assigned at creation and never changes; the name inside the file may. Keys are dotted names grouped as `fonts`, `surfaces`, `interface`, `document`, `controls`, `changes`, `people`, `visuals`, and `effects`. Colors are hex; fonts are family names; `effects` also carries a background style and a panel style from the app's closed list plus intensity and speed. User themes are sparse: a file holds only the values its authors chose, and a missing value falls back to Strata Vivid. Files written by the app carry `schema-version: 3`; v2 files remain valid and acquire missing visual colors from Strata Vivid without rewrite. Unknown keys are preserved. An invalid value falls back to the built-in value for that key and is reported in the panel; a file that is not valid JSON is listed as broken and never applied.
- The 40 swatches name visual jobs, never hues: seven surfaces, four interface text colors, nine document text colors, seven control and status colors, two reviewed-change colors, six author colors, and five effect colors. Function and decoration are independent - confirmation buttons, removed text, author badges, and background glows each have their own value. The theme sets base colors and the app derives the rest at use time: translucent hover and review fills, button gradients and shadows, readable text on filled buttons, selections, popovers, and author badges, panel shadows from the window background, effect opacity from intensity, and light star colors mixed toward the interface text. No color in the app is outside the theme's reach; the attribution assignment rule in §6.9 is unchanged. The one exception is the brand: the StrataMD logo pill in the top bar keeps the fixed pink, orange, and purple mark inside its rounded dark field and pink-to-purple border in every theme.
- The active theme is `settings.json` `theme` (an id). Edits made in the app apply immediately and are written to the file within a moment. The themes directory is watched; adding, editing, or removing a file applies within a second without restart. Removing the active theme's file keeps its last values in memory and marks it missing until another is chosen.
- The theme panel is a floating, movable, resizable panel inside the window that never dims or blocks the app; the open document, explorer, and rail are the live preview, and the panel's position and size persist. It opens from a **Theme** text button in the top bar, which also opens `Theme sample.md` as an ordinary tab: a document containing every construct in §6.1 whose text says which theme value colors it, written to the config directory and rendered like any other file. The panel shows a dropdown of available themes, a sample strip for the states the open document may not be showing (attribution, controls, review colors, popovers, inner surfaces), and the values in eight groups - Fonts, Surfaces, Interface text, Document text, Controls and status, Reviewed changes, Authors and outside changes, Decoration and motion - each group with a one-line explanation. Every row shows its job label, an always-visible description of exactly what it colors, and its control: a swatch that opens the system color picker, a searchable dropdown of installed fonts, the two effect style dropdowns, or the visibility and speed sliders. Hovering a row outlines every one of its targets, and only its targets, in the live app and the strip; effect rows isolate only the ambient elements assigned to that slot. The panel always edits the active theme. A file holds only the values its authors chose; unchosen values show greyed as defaults, and **Use default** removes a chosen one. Revert to when opened, New from this, Use default, Delete, and rename are the only actions. Delete removes the active user theme after a second click to confirm and falls back to the built-in theme.
- Themes are a shared editing surface, last write wins. `stratamd theme [id]` prints set values, defaults, descriptions, and problems without the app running. Changes made directly to a theme file while the panel is open are highlighted.
- Ambient follows `docs/design/animations-handoff.md`: a theme chooses a background style and a window style from its eight options (`Rising motes`, `Aurora drift`, `Starfield`, `Grid drift`, `Glow orbs`, `Shimmer sweep`, `Breathing tint`, `None`) and sets intensity and speed. Every element, placement, and timing is the handoff's; colors are mixed from the theme's five `effects` slots. The ambient motion toggle and `prefers-reduced-motion` render neither layer; `None` skips one layer; typing pauses both.
- Installed fonts are listed by the platform — `fc-list` on Linux, the system font inventory on macOS — with the bundled families as the fallback either way; the renderer requests no browser permissions.

## 7. Agent contract

This is the complete one-page contract for agents working through T3 threads. It ships verbatim as `stratamd --agent-help`; the bundled skill at `skills/stratamd/SKILL.md` contains the same contract.

````
StrataMD is the user's Markdown cockpit. T3 runs your thread and delivers the owner's document round as a Markdown file attachment. Read that delivery before responding.

The delivery names the live buffer path. That buffer may include unsaved owner edits. While the owner is in the loop, never write the buffer or the document directly. Propose every document action in one final fenced strata block; Strata applies it safely. When working unattended, write project files normally and T3's turn diff reports them.

End every completed reply with exactly one fenced strata block containing a JSON array. Each entry is independent: a malformed or stale entry fails without discarding valid siblings.

```strata
[
  {"verb":"comment","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Why this matters."},
  {"verb":"question","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Should this stay?"},
  {"verb":"decision","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Choose a direction.","options":["Keep","Change"]},
  {"verb":"suggest","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"replacement":"Replacement Markdown."},
  {"verb":"edit","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"match":"exact text inside the block","replace":"new text"}
]
```

Available verbs are comment, question, decision, suggest, edit, reply, resolve, accept, reject, save, lead, and attach. A decision has at least two options. A suggestion proposes replacement text for the anchored passage. An edit supplies an exact match and replacement inside one block. Reply, resolve, accept, and reject use {"item":"item-id"} as the anchor. Accept, reject, and save require the Lead. Save uses {"verb":"save","document":"/absolute/file.md"}. Lead uses {"verb":"lead","document":"/absolute/file.md","action":"claim"} or "release".

Use the block ids printed in the delivery. They belong to that delivery and document. A quoted-text anchor, {"document":"/absolute/file.md","quote":"exact text"}, is the fallback. Do not guess an old id after the passage changes. Strata reports every entry as applied or failed in the next delivery, with the created item id or nearest block candidates.

To attach a thread that was asked to review a file before Strata linked it, reply with only this entry:

```strata
[{"verb":"attach","document":"/absolute/file.md"}]
```

Strata then attaches the thread and sends the normal first delivery. Put document actions in the following turn, not beside attach.

Chat rule: everything in the strata block is already in front of the owner. The prose above it carries only what is not in the block. Keep action summaries to at most one line per action, and do not repeat proposed text.

The file-only stratamd tool has four jobs and never talks to the running app: open a Markdown file, inspect a theme, install this skill with setup, and diagnose local paths with doctor.
````

## 8. Engine delivery (StrataMD → thread)

A delivery is attached to a one-line T3 user message as a UTF-8 Markdown file. It names the live buffer and document, the delivery/message id, its persisted command id, and each selected item's stable id. The first delivery contains the whole document, a diff, or no document according to §6.7. Later deliveries contain selected changes, materialized comments and replies, verdicts, prior strata-block outcomes, and an optional note.

Every Markdown block in delivered document text carries a short delivery-scoped block id and a private map to Strata's anchor. Text rendering is sufficient to understand the round; machine fields preserve ids, kinds, anchors, and outcome status. A partial delivery says plainly that other document changes were omitted. A quick send has an empty range and carries only its one new annotation.

The next matching T3 message-sent event is acknowledgment. The same message id and command id are reused on retry. Agent responses return structured actions only in the final strata block defined by §7.

## 9. Files on disk

StrataMD writes the document only on Save. Nothing is ever written beside it.

Ghost store, in `$XDG_DATA_HOME/stratamd` when set; otherwise `~/.local/share/stratamd` on Linux and `~/Library/Application Support/StrataMD` on macOS. Directories `0700`, files `0600`:

```
docs/<first 12 hex of sha256 of realpath>/   # short so the buffer path is cheap in every payload; salted on collision
  meta.json          # format version, realpath, ghost blob, save history, hunks, segments,
                     # thread attachments, delivery receipts, block maps, annotation event log
  drafts.json        # atomic private unsent drafts; absent from every engine payload
  buffer.md          # live mirror of the editor buffer; named in engine deliveries
  reading.json       # atomically written private navigation and presentation state; never sent to agents
  lock               # held by the app while document state is open
objects/<sha256 of content>   # content-addressed blobs: ghosts, segment snapshots, delivery snapshots, baselines
logs/stratamd.log             # failure log: one JSON line per warning or error, from main and the renderer
```

- `meta.json` is one file written atomically, so a crash never leaves annotations and review state out of step. `reading.json` is written atomically and independently so display choices do not increase collaboration-state writes.
- `logs/stratamd.log` holds warnings and errors only — no info chatter — and rotates once to `stratamd.log.1` at 2 MB. It is a local file like everything else here (§3): nothing leaves the machine.
- Blobs are garbage-collected when no `meta.json` references them. Segment history is capped (default 200 segments per document, oldest dropped after their snapshots are no longer referenced by a baseline or delivery). The save history is never capped; its snapshots are referenced and retained.
- **Forget document** deletes the entry and its unreferenced blobs; it has no shell control since 2026-09-04 (§6.4).

Config, in `$XDG_CONFIG_HOME/stratamd` (fallback `~/.config/stratamd`) on both platforms — agents edit these files directly and existing instructions name the location, so it deliberately does not move on macOS: `settings.json` (§6.9) and `themes/<id>.json`, one file per user theme (§6.13).
- `meta.json` carries a format version; the app migrates older entries on open.

## 10. Architecture

- **Electron.** Main, renderer, and the file-only launcher share TypeScript and one packaged application.
- **Main process** owns file I/O, the shadow, ghost storage, engine HTTP/WebSocket traffic, explorer scanning, diffing, file watching, single-instance routing, and config.
- **Renderer** owns the editor, projects, conversations, item/review overlays, rails, tabs, and composer. It is context-isolated and sandboxed behind validated IPC.
- **Editor** is built directly on the ProseMirror toolkit (document model, transactions, selection, undo, IME, DOM reconciliation, position mapping). The markdown schema, the source-span-tracking parser, and the byte-preserving serializer are StrataMD's own and must satisfy §6.1. No prebuilt markdown editor layer.
- **Engine client:** `src/main/engine/` alone owns the vendored T3 schemas, paired credential, snapshots, stream cursors, reconnect, and retry-safe dispatch.
- **Diff:** Myers line diff between snapshots. Block-level byte preservation on serialize keeps diffs minimal.

### 10.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | One language across main, renderer, and file-only tool. |
| Build | electron-vite; electron-builder for the Linux unpacked build and the macOS `.app` | Fast dev loop; CI checks both hosts and a version tag publishes the Mac zip (§3). |
| Markdown parsing | micromark + mdast-util-from-markdown with the GFM and frontmatter extensions; a bounded registry-aware scanner and attribute parser for component wrappers | Every node carries exact source offsets, which the byte-preserving serializer needs. Component bodies use the ordinary Markdown parse, fenced and contained examples stay ordinary Markdown, and no MDX executes. `prosemirror-markdown` (markdown-it) exposes only block line ranges and is not used. |
| Serializer | StrataMD's own, per block; `mdast-util-to-markdown` for edited blocks, configured to match the file's detected conventions (bullet char, emphasis char, list indent) | Unchanged blocks emit original bytes; edited blocks should look like their neighbors. If `mdast-util-to-markdown` cannot match a file's style closely enough, the affected node types get hand-written serializers. |
| Editor | `prosemirror-model/state/view/transform/history/keymap/inputrules/commands`, `prosemirror-tables` | The toolkit only; schema is StrataMD's. |
| Diff | `diff` (jsdiff) `structuredPatch` | Myers, hunks in the §8 shape. |
| File watching | Node `fs.watch`, one non-recursive watch per directory, shared by every document and the theme folder | The reconciler only needs change notifications for two known files per document. A recursive native watcher on the document's parent watched the whole home directory or repository (inotify exhaustion, slow subscribe, event storms on `git checkout`); a flat inotify or FSEvents watch on a single local directory is reliable, and detection still re-reads by content hash rather than trusting the event. Network filesystems remain unsupported. |
| Engine | HTTP snapshots plus WebSocket subscriptions against the vendored T3 contract | Snapshot recovery and live traces use the published server protocol. |
| Panels UI | React + Tailwind | The ProseMirror view mounts as an uncontrolled element inside it. No component library. |
| Tests | vitest for pure and main-process behavior; Playwright with Electron for the cockpit and §6.12 scenarios | Each phase closes only with a real-behavior evidence test and the full gate. |

## 11. Environment and security

- Targets are the owner's Linux workstation and Macs on macOS 13 or newer, on local filesystems.
- Strata talks to exactly one paired T3 server over HTTP and WebSocket. The paired session credential has owner-only permissions in the ghost store, never `settings.json`. T3 sessions end after a fixed term; when the pairing link carried Manage access, Strata renews its session in the last week by issuing itself a one-time pairing credential and exchanging it, so the owner pairs once per machine. Without that permission the engine dialog says when to pair again.
- Strata makes no other network calls. The renderer never fetches remote document resources.
- The renderer stays context-isolated and sandboxed; IPC arguments and sender are validated; navigation and new windows are denied except safe OS-opened external links.
- Agent output is untrusted data. Strata blocks are strict JSON, validated entry by entry, and a failed or stale anchor never lands elsewhere.
- Save is the only Strata action that writes the document. In-loop agent edits apply to the buffer and remain reviewable; unattended project writes arrive through T3 turn diffs.

## 12. Success criteria

Everything in §6–§11 is in scope; the product is done when all of it exists, every scenario in §6.12 holds, and:

- An agent given only §7 can read an engine delivery, post valid document actions in its final strata block, and receive entry-by-entry outcomes.
- The full check — types, unit, integration, the E2E suite, and the packaged CLI test — is green on both hosts in CI.
- No Send is lost or duplicated: every delivery remains queued until the matching engine acknowledgment, across document close and app restart.
- Editing and saving a file with no changes produces a byte-identical file.
- A thread never receives its own certainly attributed edits back; uncertain or shared-root writes are labeled external and included only when the owner selects them.
- A Save while agent edits are pending review leaves every one of them pending.
- A delivery's buffer path sees the owner's unsaved edits; an in-loop agent changes it only through validated strata-block actions.
- Every net unreviewed difference between a ghosted document and its ghost is visible as track-changes on next open, even if StrataMD was not running when the edits happened.
- After local setup, `stratamd --agent-help` runs from the shell. After the owner selects StrataMD as the default handler, double-clicking a `.md` file opens it in StrataMD.

## 13. Design rationale

- **The reply is the write channel.** A socket CLI and MCP server both add a second tool channel for text already present in the transcript. A final JSON block is cheaper and unambiguous; failed entries report on the next delivery.
- **Block ids over quotes.** Exact quotes remain a fallback, but stable delivery-scoped ids avoid whitespace ambiguity and prevent an edit landing on the wrong passage.
- **The T3 server is the required engine.** An engine abstraction and engine-free mode add permanent complexity for users and providers that do not exist.
- **Native Conversation.** A T3 webview cannot share Strata's items, drafts, document anchors, and review controls.
- **Drafts instead of held annotations.** A private draft is unreachable from annotation and delivery read paths; a withheld annotation is not.
- **The old agent polling loop is retired.** The engine starts turns on demand and supplies durable thread identity.
- **Items are derived.** Items project annotations, decisions, hunks, message anchors, and inference instead of introducing a second drifting store.
- **Inference is punctuation and list shape.** A model extractor is unnecessary until the corpus proves otherwise.
- **Enter sends one comment and sweeps nothing.** Large-document batching must not leak unrelated work.
- **Exactly one recipient is preselected.** The Lead wins; otherwise the active conversation. Multi-recipient sends remain deliberate.
- **Message anchors reuse document anchoring.** The same relocation and per-passage rules cover immutable messages and files.
- **First delivery skips what the thread certainly has.** Turn diffs permit this only under unambiguous attribution; uncertain writes remain external.
- **No T3 fork change.** Thread ids already supply identity and the engine already carries file attachments.
- **The strata block is JSON.** Replacements, options, and replies contain punctuation and newlines; JSON needs no custom escaping grammar.
- **In-loop edits go through the block.** The buffer may sit outside the agent workspace and project writes alone have turn-diff attribution.
- **Attribution only when certain.** Shared root-mode folders and non-git projects must not produce confident wrong badges.
