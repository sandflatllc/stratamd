# StrataMD product requirements

Status: draft v16 · 2026-08-31 · personal Linux tool

## 1. Summary

StrataMD is a desktop markdown editor for writing documents *with* AI agents. You edit the rendered document, not the syntax. Any agent, from any chat harness, attaches itself to the document you have open with one shell command. From then on it reads your editor buffer, saved or not, along with your comments; each time you press **Send** it receives only what you changed since it last looked, plus your note. It answers with comments, questions, and proposed edits that you accept or reject in place. When an agent edits a file directly, StrataMD shows you exactly what it changed as track-changes, whether the file was open at the time or you open it afterwards.

StrataMD knows nothing about the harness. You type "attach to the doc I have open in Strata" in T3 Code, Haru, Claude Code, or anything else that can run a command, and the agent becomes a participant in that edit session.

It runs as a local desktop app on the owner's Linux workstation, with a `stratamd` CLI on PATH.

## 2. Goals

1. **Edit rendered markdown** without mangling the parts you didn't touch.
2. **Hand agents a diff, not a document.** After the first look, every Send carries only your changed hunks, their line positions, annotations, and your note.
3. **Agent attaches itself.** One command is the whole integration. No host protocol, no adapters, no required environment variables.
4. **See every agent edit.** StrataMD keeps a private copy of the last version of each document you reviewed, so edits made outside the editor are shown as track-changes for you to keep or revert.
5. **Two-way annotation layer.** You and agents comment, question, and suggest on quoted text. Nothing is ever written inside or beside the document.
6. **Run locally.** Owner's Linux workstation only; local setup provides the CLI and desktop integration.

## 3. Non-goals

- Not a note-taking system, vault, or sync product. Documents are independent files on disk.
- Not an IDE. No terminal. The explorer shows markdown files only.
- Not a chat client. Conversation with the agent stays in the harness. StrataMD never starts a thread, picks a model, or lists agents.
- No cloud component, accounts, or telemetry.
- No macOS or Windows support, public packages, installer, auto-updater, or release pipeline.
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
- Formatting toolbar and keyboard shortcuts for all visually editable constructs, following common editor conventions (Ctrl+B bold, Ctrl+I italic, Ctrl+K link, Ctrl+Shift+C code, Ctrl+1..6 heading level, Ctrl+Shift+7/8 ordered/bullet list, Ctrl+S save, Ctrl+Enter send, Ctrl+/ source view).
- Spellcheck is the platform's. Code spans and code blocks are rendered with `spellcheck="false"` so paths and identifiers inside them are never flagged; prose is checked as the platform checks it.
- Source view toggle (raw markdown, same buffer). Syntax typed in source view that the visual schema cannot represent becomes a raw block.
- Local images resolve relative to the document and render from disk through a main-process handler that only serves paths under the document's directory or an explorer folder. Remote images and any other remote URL are never fetched; a placeholder is shown.
- **Byte-preserving save.** Invariant: every syntactic region the user did not touch is written back from its original bytes. Each top-level block keeps its source span; unchanged blocks are emitted verbatim, edited blocks are re-serialized. The serializer may enlarge the rewritten region when the grammar requires it (a paragraph becoming a setext heading, list continuation, a changed link reference definition) and must keep it as small as the grammar allows. Preserved in untouched regions: list marker and emphasis delimiter style, hard wraps, indentation, trailing whitespace, CRLF line endings, a UTF-8 BOM, and a missing final newline.
- Save is atomic (temp file and rename in the document's directory, preserving mode). Immediately before writing, Save re-reads and hashes the document; if it differs from the last known disk content, the change is handled as external first (§6.2) and the user is asked to resolve any conflict before the write proceeds.
- Save is the only StrataMD action that writes the document. After Save the ghost equals the shadow with each pending hunk's region replaced by that hunk's ghost text, so pending external hunks stay pending.
- A Save that changed the file appends one round to the document's save history: the replaced content, the written content, the time, and the contributors active since the previous save (§6.7). A Save that changed nothing appends nothing. The round's author list means activity — it includes a contributor whose edit was later overwritten or undone — and is fixed at Save because segments are pruned later. The Lead's save (§6.6) records exactly like the user's.

### 6.2 Buffer file and external changes

- The shadow is mirrored to `buffer.md` in the document's ghost entry on every change, debounced, written atomically (temp and rename). Agents read it to see unsaved edits and write to it to propose edits. A write to `buffer.md` is merged into the shadow exactly like an external change to the document; the document on disk is untouched until the user saves.
- Every payload tells attached agents to edit the buffer only. StrataMD does not prevent writes to the document, since Linux offers no enforceable lock against rename-based writes. It handles them as external changes.
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
- Renaming or moving a document while open: the session and its ghost entry follow the new realpath. While closed: the new path is a new document, seeded by the ghost seeding rule; the old entry remains until forgotten (§9).

### 6.4 Explorer

- A sidebar showing only `*.md` / `*.markdown` files under folders the user has added, honoring `.gitignore` inside git work trees and skipping `node_modules`. Symlink loops and overlapping folders are detected; each file appears once. Files are shown under the subfolders they sit in on disk, nested as on disk, never flattened; subfolders with no markdown files are not shown. Every folder row, root or nested, collapses and expands on click; added folders start expanded and subfolders start collapsed. A root folder row shows its folder name preceded by at most one parent segment (`parent/name`); the name is always fully visible and the parent segment is what gets elided when space runs out. Hovering a folder row for about a second shows the full path in a tooltip. Right-clicking any folder or file row opens a menu with one item, Copy full path, which copies the absolute path to the clipboard.
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
- Resolve/dismiss hides the annotation from the default view; it stays stored until the user clears resolved annotations. Any agent may resolve annotations it authored; only the Lead may resolve anyone's (§6.6). Reply and resolve stay reachable in the UI for any unresolved annotation, orphaned ones included (§6.9 thread panel).
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
  - `Ctrl+Enter` sends
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

- `stratamd` is the app executable. `stratamd setup` links it onto PATH, installs the `.desktop` entry and icon, and registers the MIME association; `stratamd setup --remove` undoes all of it. Both are safe to repeat. `stratamd --agent-help` prints §7 verbatim.
- The CLI runs as plain Node (`ELECTRON_RUN_AS_NODE=1`), so a command costs a process start, not a browser launch.
- What a harness needs: the ability to run a command repeatedly, capture its stdout, and carry a short id between runs. Harnesses that cannot hold a command open use `--timeout 0`, which returns at once with a queued delivery or `{"event":"timeout"}`.
- `attach` is the only command that blocks by design, for at most `--timeout` seconds (default 600). `open` and `attach` also block for app launch when no instance is running, returning as soon as the session exists, before the window paints.
- When an instance is running, every command goes through it over the local socket (§10), so quotes are validated against the shadow and the instance owns the ghost store. When none is running, `annotate`, `reply`, `state`, `changes`, `changed`, and `checkpoint` operate on the file and ghost store directly, under a per-document lock file with temp-and-rename writes; the app takes the same lock on startup, so a command in flight cannot race it. Offline commands treat the document on disk as the current content unless a newer `buffer.md` exists, in which case they use the buffer.
- `open` on a document whose shadow differs from its ghost opens it in review mode. This is how an agent shows the user what it changed.
- `state` is read-only: no agent id required, no attachment created, no baseline or cursor moved. With no file given and no document open it exits 2.
- `annotate --json` is all-or-nothing: every quote is validated first, and one failure creates nothing (exit 3, detail lists each failing entry).
- Output: payloads on stdout as one JSON object; errors on stderr as one JSON object `{error, code, detail}`; exit codes 0 success, 1 usage, 2 not found (file, annotation, attachment), 3 refused by document state (quote missing or ambiguous with closest matches listed; Lead held or required; message pending; save blocked), 4 instance unreachable. `detail` always carries a machine-readable `code` (`QUOTE_INVALID`, `LEAD_TAKEN`, `NOT_LEAD`, `MESSAGE_PENDING`, `SAVE_BLOCKED`) and the specifics. All I/O is UTF-8; multi-line `--text` is accepted via stdin with `--text -`.
- `send`, `lead`, `accept`, `reject`, `resolve`, and `save` require the running instance: they have no offline mode and never launch the app.
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
  - **The right rail is a map, decided 2026-08-30.** Rows are compact click targets; clicking centers the target in the editor, where the span is already marked (annotations by the selected-annotation highlight, hunks by track-changes). A change row shows the author (you, the agent's name, or "external"), whether it adds or removes, and at most two lines of text; the full diff is read in the document, never in the rail. A hunk that cannot render inline keeps Keep and Revert on its row. Rail snippets render formatted (bold, italics, code face, link text), never raw markdown syntax. Panel copy is plain everyday language, tooltips included; internal vocabulary is kept to this PRD and the code: "waiting for changes" / "working" / "has an update waiting"; "All caught up. Everything reviewed."; "attached 12 minutes ago" with absolute time on hover; the mirror fine print is replaced by the save-state sentence below; the idle-expiry fine print becomes a plain tooltip (the user's sends are never dropped; an agent's notes do not keep it attached); the orphaned chip reads "text removed", the external author badge reads "someone else", and row copy never shows file paths.
  - **The thread panel, decided 2026-08-30.** One thread surface: a floating, movable, user-resizable panel like the theme panel, opened by an annotation row click or an in-editor highlight click, positioned beside the annotated span at open and clamped to the viewport; an orphan opens it at its most recent position this session, else centered, and shows the original quote. Size persists; position never does. Default width about twice the old popover's 330px, minimum 330px; body text at the editor's main body size, tracking the editor pane's zoom. It shows the thread, replies, a reply box, and Resolve for any unresolved annotation; resolving from the panel closes it (decided 2026-08-30). The annotation composer is user-resizable with its size persisted; its default size and selection-anchored position are unchanged.
  - **User-facing copy, decided 2026-08-30.** Every label, chip, counter, tooltip, and dialog uses plain everyday words; the audience works with agents, not necessarily with code. Internal vocabulary (buffer, ghost, shadow, orphaned, external, delivery, on disk) appears only in this PRD and the code.
  - **Save state and counts, decided 2026-08-30.** The editor always shows whether it matches the saved file: the Save button reads "Save" (accented) while unsaved changes exist and a quiet "Saved" otherwise; the tab carries an unsaved dot beside its name, distinct from its count badge; the rail footer reads "Unsaved changes · last saved 3 minutes ago" or "Everything saved · 3 minutes ago". The changes panel groups rows, each group with its own count: **Proposed** (suggestions, not in the text until accepted; Accept/Reject), **Unsaved** (applied in the editor, lands on the next Save; Keep/Revert), **Saved** (in the file, awaiting review; Keep/Revert). Below them, the save history (§6.7) under a "Saves" heading with rows labeled "Last save" or "Saved <time>", authors as "you and Claude" (anonymous reads "someone else"), an expanded row's count as "N changes", and "Nothing changed" for an empty round. A hunk is classified by comparing its shadow region against disk on each publish; if that cost proves too high under measurement, the fallback is a whole-panel unsaved marker driven by the document's dirty state. The annotations panel header counts open annotations and, when present, those on removed text. The top bar keeps the total pending count and tints it while anything counted is unsaved. Reverting a Saved hunk restores text the file does not have, so the document reads unsaved until the next Save.
  - Per-pane text zoom. The explorer, the editor, and the right rail each carry an independent text-size factor (default 1.0, steps of 0.1, range 0.5–2.0). Ctrl+= and Ctrl+- change the factor of the pane under the pointer, or the editor when the pointer is over no pane; Ctrl+wheel changes the pane under the pointer by one step per wheel notch, accumulating trackpad deltas so a gesture does not skip steps. The window itself never zooms: the Electron default menu's zoom roles are removed and pinch zoom is locked. A single text button in the top bar, `Reset zoom`, returns all panes to 1.0; it is shown only while some pane is off 1.0, it is the only zoom control drawn, and no zoom icons are added. Only type scales; panel widths, spacing, and the editor toolbar row do not. Factors persist in `settings.json`.
- Single instance: launching with a path while running opens a new tab in the existing instance.
- Tabs for multiple open documents; each tab is one session. The **focused** document is what `attach` and `state` target when no file is given on an initial call. Each tab retains its scroll position across switches, in visual and source view.
- Open from the explorer, CLI, file manager, or drag-drop.
- The `.desktop` entry declares `MimeType=text/markdown;`; `.md` and `.markdown` map to that type through the shared MIME database. Making StrataMD the default handler is a separate step (`stratamd setup --default`) done only when the owner requests it.
- The keyboard reaches and operates every review action, annotation thread, composer tab, conflict, and banner.
- Config in `$XDG_CONFIG_HOME/stratamd` (fallback `~/.config/stratamd`). `settings.json`: active theme id, whether to keep resolved annotations, attachment idle timeout, explorer folders, panel sizes and document measure, theme panel position and size, thread panel and annotation composer sizes, per-pane text zoom, ambient motion on/off.

### 6.10 Edge cases

- **File deleted while open:** the tab stays open with a banner; Save recreates the file. Attachments are unaffected.
- **File renamed or moved while open:** §6.3.
- **Permission failure on Save:** the shadow is kept, the error is shown, nothing else changes.
- **Invalid UTF-8:** opens read-only in source view with a banner; no ghost is written.
- **Large documents:** document size must not disable visual editing or any collaboration feature. Parsing, rendering, review, annotations, Save, and Send remain available; performance or memory failures on larger files are implementation defects to optimize, not a reason to impose a product ceiling. The owner explicitly rejected the former 2 MB source-only fallback on 2026-08-28.
- **External write racing Save:** §6.1; the hash check before writing catches it.
- **Crash with unsaved edits:** §6.3 recovery.
- **Failure inside the window:** an error in one pane replaces just that pane with a card — "This part of the window hit a problem. Your document and its pending changes are safe." — and a Reload button; the other panes and the top bar keep working. An error outside every pane degrades to the whole-window card: "StrataMD hit a problem showing this window. Your documents and pending changes are safe." The card's promise is earned, not asserted: the crash and the Reload both flush the not-yet-mirrored edit to the main process (bounded, so a dead channel cannot wedge recovery), and reloading re-derives everything from main, so the newest keystrokes survive. Nothing reloads automatically — a bad state must not loop. Failures no boundary can catch (event handlers, the editor's own DOM dispatch) change no UI and are recorded like every other failure (§9).
- **Renderer process dies:** the window reloads; a second death within a minute closes the window instead of looping, and a fresh one is created on the next launch or agent connection.
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

### 6.13 Themes

- A theme is a named set of values that decides the app's colors, fonts, and ambient behavior. Themes carry values only, never code or stylesheets: a theme cannot change layout, run scripts, or add animations the app does not already have.
- Seven stock themes ship with the app: Strata (the built-in fallback, reproducing the design handoff), Strata Vivid (the default view: Strata's structure with the owner's vivid text palette, decided 2026-08-30), Ember (warm dark), Candyfloss (light pink), Isotope (light grey, no motion), Nebula (deep space), and Paper (light cream); the owner approved this set on 2026-08-29. Every stock theme declares all 40 color swatches, both fonts, and all four effect settings explicitly - none inherits a value from another, so changing one can never silently change the rest. Strata's complete definition is the fallback for every missing or invalid value everywhere, and the theme the app returns to when an active theme's file disappears or is deleted; a fresh install opens on Strata Vivid. Stock themes cannot be edited or deleted and never exist as files; New from this copies one into an editable file carrying every chosen value.
- User themes are single JSON files in `$XDG_CONFIG_HOME/stratamd/themes/<id>.json`. The id is assigned at creation and never changes; the name inside the file may. Keys are dotted names grouped as `fonts`, `surfaces`, `interface`, `document`, `controls`, `changes`, `people`, and `effects`. Colors are hex; fonts are family names; `effects` also carries a background style and a panel style from the app's closed list plus intensity and speed. User themes are sparse: a file holds only the values its authors chose, and a missing value falls back to Strata. Files written by the app carry `schema-version: 2`; unknown keys are preserved. An invalid value falls back to the built-in value for that key and is reported in the panel; a file that is not valid JSON is listed as broken and never applied.
- The 40 swatches name visual jobs, never hues: seven surfaces, four interface text colors, nine document text colors, seven control and status colors, two reviewed-change colors, six author colors, and five effect colors. Function and decoration are independent - confirmation buttons, removed text, author badges, and background glows each have their own value. The theme sets base colors and the app derives the rest at use time: translucent hover and review fills, button gradients and shadows, readable text on filled buttons, selections, popovers, and author badges, panel shadows from the window background, effect opacity from intensity, and light star colors mixed toward the interface text. No color in the app is outside the theme's reach; the attribution assignment rule in §6.9 is unchanged. The one exception is the brand: the StrataMD logo pill in the top bar keeps the fixed pink, orange, and purple mark inside its rounded dark field and pink-to-purple border in every theme.
- The active theme is `settings.json` `theme` (an id). Edits made in the app apply immediately and are written to the file within a moment. The themes directory is watched; adding, editing, or removing a file applies within a second without restart. Removing the active theme's file keeps its last values in memory and marks it missing until another is chosen.
- The theme panel is a floating, movable, resizable panel inside the window that never dims or blocks the app; the open document, explorer, and rail are the live preview, and the panel's position and size persist. It opens from a **Theme** text button in the top bar, which also opens `Theme sample.md` as an ordinary tab: a document containing every construct in §6.1 whose text says which theme value colors it, written to the config directory and rendered like any other file. The panel shows a dropdown of available themes, a sample strip for the states the open document may not be showing (attribution, controls, review colors, popovers, inner surfaces), and the values in eight groups - Fonts, Surfaces, Interface text, Document text, Controls and status, Reviewed changes, Authors and outside changes, Decoration and motion - each group with a one-line explanation. Every row shows its job label, an always-visible description of exactly what it colors, and its control: a swatch that opens the system color picker, a searchable dropdown of installed fonts, the two effect style dropdowns, or the visibility and speed sliders. Hovering a row outlines every one of its targets, and only its targets, in the live app and the strip; effect rows isolate only the ambient elements assigned to that slot. The panel always edits the active theme. A file holds only the values its authors chose; unchosen values show greyed as defaults, and **Use default** removes a chosen one. Revert to when opened, New from this, Use default, Delete, and rename are the only actions. Delete removes the active user theme after a second click to confirm and falls back to the built-in theme.
- Themes are a shared editing surface for the user and agents, last write wins, no conflict handling by design. `stratamd state` reports the active theme; `stratamd theme [id]` prints a theme's set values, default values with descriptions, and problems, and works without the app running. An agent asked to complete a theme reads the file, keeps the values already set, writes the rest, and verifies with `stratamd theme`. Changes an agent makes while the panel is open are highlighted in it.
- Ambient follows `docs/design/animations-handoff.md`: a theme chooses a background style and a window style from its eight options (`Rising motes`, `Aurora drift`, `Starfield`, `Grid drift`, `Glow orbs`, `Shimmer sweep`, `Breathing tint`, `None`) and sets intensity and speed. Every element, placement, and timing is the handoff's; colors are mixed from the theme's five `effects` slots. The ambient motion toggle and `prefers-reduced-motion` render neither layer; `None` skips one layer; typing pauses both.
- Installed fonts are listed through `fc-list`; the renderer requests no browser permissions.

## 7. Agent contract

This is everything an agent needs. It ships verbatim as `stratamd --agent-help` and belongs in the user's global agent instructions (`CLAUDE.md`, `AGENTS.md`, harness system prompt) as one line: *"StrataMD is the user's markdown editor. When the user mentions a document open in Strata, asks you to review or edit a `.md` with them, or asks you to show them your edits, run `stratamd --agent-help` first."*

Written for agents: positive instructions, one concept per word (buffer, delivery, quote), the loop's stop condition stated, and a hard guardrail on document writes paired with the behavior to do instead.

```
StrataMD is the markdown editor the user is working in. Attach to the
document they have open, read the buffer with their comments, respond
with comments, questions, and proposed edits, then attach again to wait
for their next round. Keep that loop going until the payload says
"closed" or the user tells you to stop.

  stratamd attach [file] [--as <agent id>] [--name "<who you are>"]
                         [--timeout <seconds>, default 600; 0 = poll]
      Attaches you to the document (the focused one if no file is given)
      and opens it if it is not open.
      The FIRST call returns immediately with the whole buffer, the
      user's comments rendered inline, the file path, the buffer path,
      and your agent id. Pass that id with --as and the path as <file>
      on every later call.
      LATER calls return immediately if the user has pressed Send since
      your last call; otherwise they block until the user does. They
      return only what the USER changed since your last call: hunks with
      line numbers, new comments and replies, which of your suggestions
      were accepted or rejected, annotations whose quoted span the user
      moved (listed again with the new quote plus a "requoted" line),
      and the user's notes. Changes made by
      anyone else (other agents, other editors) are NOT included unless
      the user chose to include them.
      Nothing is lost while you are not waiting; sends queue until your
      next call, even across restarts. Run it in the background and act
      when it returns. Re-run it after each response to keep listening.
      It returns {"event":"timeout"} after --timeout seconds if nothing
      happens; just run it again. It returns {"event":"closed"} when the
      user has closed the document, after anything that was queued.

  stratamd annotate <file> --kind <comment|question|suggestion>
                           --quote "<exact text from the buffer>"
                           [--text "<your comment or replacement>" | --text -]
                           [--label "<short label>"]
                           [--preceded-by "<text right before the quote>"]
                           [--followed-by "<text right after the quote>"]
                           [--as <agent id>]
      Comments on text or proposes a change. The quote is text copied
      exactly from the buffer, unique within it. A suggestion's quote
      sits inside a single paragraph, list item, heading, or cell, and
      its --text is markdown; a comment or question may quote a long
      span to mark what should be read with it. If the quote is missing
      or ambiguous the command fails (exit 3) and lists the closest
      matches; add --preceded-by or --followed-by and retry. Pass --json <file or -> with an array of
      {kind, quote, text, label, precededBy, followedBy} to create many.
      Suggestions are not applied until the user accepts them.

  stratamd reply <file> --to <annotation id> --text "<reply>" [--as <id>]
      Answers a question or continues a thread. --text - reads stdin.

  stratamd send <file> --as <your id> --text "<note>" [--text -]
                       [--to <id[,id,...]>]
      Sends a short note (up to 4 KB) to every other attached agent, or
      only those named with --to. It wakes their waiting attach calls;
      notes queue for absent agents and survive restarts. Keep the
      discussion in annotations and replies; send is the doorbell, and
      the recipient runs state or changes to catch up. One note may
      wait per recipient: sending another before it is collected fails.
      Success means queued, not read.

  stratamd lead <file> --as <your id>
      Claims the Lead for this document. Run it when the user puts you
      in charge, in any wording: "take the lead", "you're the
      overseer", "conduct this edit". Only the Lead may run accept,
      reject, resolve on others' annotations, and save. The claim
      fails, naming the holder, if another agent already leads; the
      user can transfer or revoke it in the app. Detaching gives it up.

  stratamd accept <file> --annotation <id> --as <your id>
  stratamd reject <file> --annotation <id> --as <your id>
      Lead only. Accept applies a suggestion to the buffer as YOUR
      change, left pending for the user's review; reject dismisses it.

  stratamd resolve <file> --annotation <id> --as <your id>
      Closes a thread. Any agent may resolve annotations it created;
      the Lead may resolve anyone's.

  stratamd save <file> --as <your id>
      Lead only. Saves the buffer to the document, exactly as the
      user's save: agent edits stay pending for the user's review.
      Fails when a conflict needs the user; report that and stop.

  stratamd state [file]
      Read-only: the same content as a first attach, without attaching
      or affecting any attachment. Also reports the active theme (id,
      name, file path) and the attached agents: id, name, state
      (waiting, working, or pending), and which one leads.

  stratamd theme [id] [--json]
      Prints a theme: its file path, the values its authors SET, and
      every remaining key at its DEFAULT value with a one-line
      description of what it colors, then any problems. Works without
      the app running. When the user asks you to build or finish "the
      theme open in Strata", run stratamd state to find it, read the
      file, keep every value already set, write the remaining keys in
      the same shape, and run stratamd theme again to confirm there
      are no problems. The app applies the file as soon as it lands.

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
      Shows the file to the user. If you edited it, they see your changes
      marked for review. Use this after editing a file directly.

  stratamd checkpoint <file or directory>
      Records the user's last-reviewed version (from git HEAD if the file
      is in a repository, otherwise the current content) so edits you
      make afterwards show up for review. Run it before editing files the
      user has not opened in StrataMD.

  stratamd detach <file> --as <agent id>
      Ends your attachment. Optional; idle attachments expire on their own.

What you see is the user's editor buffer, which may be unsaved;
"buffer" in the payload is its path. Edit by writing to that buffer
file, or by suggestions for small inline proposals. The user sees your
edits marked for review and decides when to save. Re-read the buffer
right before you write to it; a write based on an old copy shows up to
the user as undoing their newer edits. The buffer is the only file you
write while attached. Writing the document itself bypasses the user's
unsaved edits, so every payload names the buffer path. Your own edits
come back to you only if the user includes changes not made by them.
```

Agent identity: `--as` if given; otherwise a stable id derived from `$CLAUDE_CODE_SESSION_ID` or an equivalent harness session variable if present; otherwise a fresh id. The initial payload always returns it. `--name` sets the display name (default `$AI_AGENT`, else the id).

## 8. Payload (StrataMD → agent)

Printed to stdout as one JSON object when `attach`, `state`, or `changes` returns. `text` is a complete human-readable rendering; an agent that reads only `text` misses nothing. Fields absent for an event are omitted.

```json
{
  "version": 11,
  "file": "/abs/path/doc.md",
  "buffer": "/home/u/.local/share/stratamd/docs/<12-hex key>/buffer.md",
  "agent": "ag_7f3k",
  "event": "initial" | "send" | "message" | "resync" | "closed" | "timeout" | "superseded" | "state" | "changes",
  "deliveryId": "d_0192",
  "from": { "agent": "ag_2b", "name": "GPT" },
  "notes": ["the user's note for this Send, or the sender's message note"],
  "attachments": [ { "agent": "ag_2b", "name": "GPT", "state": "waiting", "lead": false } ],
  "cursor": 118,
  "document": "full buffer text; present on initial, resync, and state",
  "segments": [
    { "author": "user", "hunks": [
      { "oldStart": 42, "oldLines": 3, "newStart": 42, "newLines": 5,
        "removed": ["..."], "added": ["..."] } ] },
    { "author": "external", "tag": { "agent": "ag_2b", "name": "GPT" }, "hunks": [ "only when included" ] }
  ],
  "annotations": [
    { "id": "a1", "seq": 112, "kind": "question", "author": "user",
      "agent": null, "status": "open",
      "quote": "the exact text", "text": "why this?", "line": 17,
      "replies": [ { "id": "r1", "seq": 115, "author": "user", "text": "..." } ] }
  ],
  "replies": [
    { "id": "r2", "seq": 116, "annotation": "a0", "author": "user", "text": "..." }
  ],
  "resolved": [ { "id": "a3", "seq": 117, "kind": "suggestion", "resolution": "accepted" } ],
  "edits": [ { "seq": 118, "verdict": "kept" | "reverted", "quote": "first line of the edit" } ],
  "partial": true,
  "text": "..."
}
```

- Events: `initial` (first attach), `send` (one delivery), `message` (another agent's note; `from` names the sender; carries `notes` only and acknowledging it advances nothing), `resync` (baseline lost; full buffer), `closed` (document closed; sent after queued deliveries), `timeout`, `superseded` (a newer call for the same id took over), `state`, `changes`.
- `deliveryId` is present on `send`, `message`, `resync`, and `closed`. The same id is returned again if the previous return was not acknowledged.
- `attachments` is present on `state` for an open document: every attachment as `{agent, name, state, lead}`, states per §6.6. Omitted for a closed document.
- `segments` are in order; each segment's `hunks` are against the state just before that segment, the first against the recipient's baseline. `author` is `user` or `external`; `tag` is present when the external segment was tagged; user segments never carry one, so an accepted suggestion reads as a plain user change. A segment the recipient authored is never present (§6.7). External segments appear only when the user included them, or as the whole content of a `changes` payload. Line numbers are 1-based; `oldStart`/`newStart` refer to the segment's before and after states.
- `edits` holds, on `send` and `closed`, the verdicts on the recipient's own kept and reverted buffer edits (§6.3): `verdict` is `kept` or `reverted`, `quote` the first non-blank line of the edit, capped. `partial` is present and true when the user left changes or events out of this delivery; the buffer holds the full current text.
- `annotations` holds, on `initial`, `resync`, and `state`, every annotation with its full thread; on `send` and `closed`, only annotations created past the cursor, each with its full thread. `replies` holds, on `send` and `closed`, replies past the cursor to annotations created at or before it; `annotation` names the thread. Neither includes events the recipient authored. `agent` identifies the authoring attachment for agent-authored ones; `status` is `open`, `resolved`, or `orphaned`; `line` refers to the current buffer. `cursor` is the latest `seq` included.
- `text` begins with one line. On `initial` and `resync`: `While attached, write only to the buffer file: <buffer path>. The document <document path> is the user's to save.` On every other event: `Write only to <buffer path>.` The agent named the document itself and has had the full sentence once; repeating only the path it must act on keeps the per-delivery cost low.
- `text` then renders: on `initial`, `resync`, and `state`, the whole buffer with annotations inlined at their anchors, followed by a list of open questions; on `send` and `closed`, the notes, one unified diff per segment with its author, new annotations with their surrounding paragraph and their replies listed after the paragraph, then replies to earlier annotations as `<id> ← <author>: <text>` one per line, then resolutions, then verdicts as `Your change was kept: <quote>` / `Your change was reverted: <quote>`, then, when `partial` is set, one line: `Parts of the document changed that are not included here.`; on `changes`, the external diffs only; on `message`, `Message from <name> (<id>):`, the note, then one line pointing at `stratamd state` and `stratamd changes`.
- Annotation markers: comment and question → `⟦id kind (author): text⟧…⟦/id⟧` around the quoted span; suggestion → the quoted span struck through followed by the replacement; replies indented under their parent; resolutions one line each. Literal `⟦` or `⟧` in the document are escaped as `\⟦` and `\⟧` inside `text`.
- Limits: notes and annotation texts are up to 64 KB each; a message note is up to 4 KB. Payload construction and transport handle large document content; document size alone never changes the event to `resync`.

## 9. Files on disk

StrataMD writes the document only on Save. Nothing is ever written beside it.

Ghost store, in `$XDG_DATA_HOME/stratamd` (fallback `~/.local/share/stratamd`), directories `0700`, files `0600`:

```
docs/<first 12 hex of sha256 of realpath>/   # short so the buffer path is cheap in every payload; salted on collision
  meta.json          # format version, realpath, ghost blob, save history (before/after blobs, time, authors),
                     # pending hunks (range anchors, status, author), segments (blob, author, tag, time),
                     # pending tag, attachments (baseline blob + segment index, deliveries, cursor),
                     # clipboard recipient, annotation event log
  buffer.md          # live mirror of the editor buffer; agents read and write it
  lock               # held by the app or by an offline CLI command
objects/<sha256 of content>   # content-addressed blobs: ghosts, segment snapshots, delivery snapshots, baselines
logs/stratamd.log             # failure log: one JSON line per warning or error, from main and the renderer
```

- `meta.json` is one file written atomically, so a crash never leaves annotations and review state out of step.
- `logs/stratamd.log` holds warnings and errors only — no info chatter — and rotates once to `stratamd.log.1` at 2 MB. It is a local file like everything else here (§3): nothing leaves the machine.
- Blobs are garbage-collected when no `meta.json` references them. Segment history is capped (default 200 segments per document, oldest dropped after their snapshots are no longer referenced by a baseline or delivery). The save history is never capped; its snapshots are referenced and retained.
- **Forget document** (explorer context menu, or `stratamd forget <file>`) deletes the entry and its unreferenced blobs.

Config, in `$XDG_CONFIG_HOME/stratamd` (fallback `~/.config/stratamd`): `settings.json` (§6.9) and `themes/<id>.json`, one file per user theme (§6.13).
- `meta.json` carries a format version; the app migrates older entries on open.

## 10. Architecture

- **Electron.** CLI, socket server, and editor share one language and one binary.
- **Main process** owns file I/O, the shadow, the ghost store, explorer scanning, diffing, file watching, the single-instance and agent socket, and config.
- **Renderer** owns the editor, explorer, annotation overlay, changes panel, attachments panel, and composer. Loaded from a custom `app://` protocol; context isolation and sandbox on; no Node integration; CSP allows only `app://` and the local-image handler; new windows denied and navigation denied outside the app's own `app://` origin (crash recovery reloads through it); every IPC message validated by sender and argument; external links opened with `xdg-open` only for `http`, `https`, and `mailto`.
- **Editor** is built directly on the ProseMirror toolkit (document model, transactions, selection, undo, IME, DOM reconciliation, position mapping). The markdown schema, the source-span-tracking parser, and the byte-preserving serializer are StrataMD's own and must satisfy §6.1. No prebuilt markdown editor layer.
- **Socket:** `$XDG_RUNTIME_DIR/stratamd.sock` (fallback: `~/.cache/stratamd/run/stratamd.sock` in a `0700` directory), mode `0600`; the CLI derives the path the same way and needs no discovery file. Peer credentials checked (`SO_PEERCRED` uid must match). `attach` is a request the main process answers immediately or holds open until a delivery, close, or timeout; attachment state is independent of the connection.
- **Diff:** Myers line diff between snapshots. Block-level byte preservation on serialize keeps diffs minimal.

### 10.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | One language across main, renderer, CLI. |
| Build | electron-vite; electron-builder only for the local unpacked build | Fast dev loop; no distributable artifacts are produced (§3). |
| Markdown parsing | micromark + mdast-util-from-markdown with the GFM and frontmatter extensions | Every node carries exact source offsets, which the byte-preserving serializer needs. `prosemirror-markdown` (markdown-it) exposes only block line ranges and is not used. |
| Serializer | StrataMD's own, per block; `mdast-util-to-markdown` for edited blocks, configured to match the file's detected conventions (bullet char, emphasis char, list indent) | Unchanged blocks emit original bytes; edited blocks should look like their neighbors. If `mdast-util-to-markdown` cannot match a file's style closely enough, the affected node types get hand-written serializers. |
| Editor | `prosemirror-model/state/view/transform/history/keymap/inputrules/commands`, `prosemirror-tables` | The toolkit only; schema is StrataMD's. |
| Diff | `diff` (jsdiff) `structuredPatch` | Myers, hunks in the §8 shape. |
| File watching | `@parcel/watcher` | Native, reliable on local Linux filesystems; `fs.watch` is not. |
| Socket | Node `net`, newline-delimited JSON | Long-held `attach` requests are connections the server answers later. |
| Panels UI | React + Tailwind | The ProseMirror view mounts as an uncontrolled element inside it. No component library. |
| Tests | vitest for parser, serializer, diff, and state transitions (pure functions, no Electron); Playwright with the Electron driver for attach → Send → collect and the §6.12 scenarios | The byte-preservation invariant and the state table are testable without a window. |

## 11. Environment and security

- The only target is the owner's current Linux workstation, running from a local checkout or build, on local filesystems (ext4, btrfs, xfs, tmpfs). Network and virtualized filesystems are unsupported.
- `stratamd setup` and `stratamd setup --remove` are the only install and uninstall steps (§6.8).
- Everything is local. No network calls; the renderer never fetches remote resources.
- The agent socket and the ghost store are reachable only by processes running as the same user. Agent ids attribute; they do not authenticate.
- The only agent path that writes the document through StrataMD is the Lead's `save` (§6.6), and everything it writes stays pending for the user's review. Suggestions require acceptance by the user or the Lead, and a Lead accept is itself left pending; buffer writes and direct file edits are shown in review mode. The Lead is a cooperative safeguard, not authentication.
- `annotate` with a missing or ambiguous quote fails rather than creating an orphan.

## 12. Success criteria

Everything in §6–§11 is in scope; the product is done when all of it exists, every scenario in §6.12 holds, and:

- An agent given only §7 can attach, read the document and comments, respond with annotations, and receive the user's next round without any other instruction, from any harness that can run commands and capture their output.
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
- **Linux only, local filesystems only.** macOS and Windows were dropped to remove whole toolchains; network filesystems were excluded because their watch semantics are unreliable and the product depends on detecting external writes.
