# StrataMD

**Write with agents. Keep the final say.**

![StrataMD mark](../../resources/stratamd-icon.svg)

StrataMD is a visual Markdown editor and desktop cockpit for people who write plans, specs, documentation, and other `.md` files with AI agents. T3 runs the agents; Strata keeps their conversations, document work, and questions together.

> Start a thread for the document I have open in Strata.

Choose the project, model, effort, and access, then Strata starts the T3 thread and sends the first delivery. The conversation stays beside the document while T3 owns execution.

![StrataMD reviewing agent changes](../screenshots/review.png)

*This page was written and reviewed in StrataMD. The screenshots use this document as the editing surface.*

## Why StrataMD?

Agents are good at producing a lot of Markdown. Reviewing it is still awkward. Chat puts your feedback somewhere other than the document. Direct file edits can replace the text before you have decided what belongs.

StrataMD lets agents work with the live document while you keep approval. They can read, comment, suggest, and edit. You decide what stays and when the file is saved.

### Keep the conversation beside the work

Projects and Conversation expose the T3 threads used at the desk. Agent prose, approvals, user-input requests, and document items stay in the same cockpit.

Send to more than one thread when the work calls for it. One thread can draft while another checks technical claims or leaves questions. Their replies stay attributed, and you choose what each thread receives.

### Send only what changed

The first delivery carries the whole live draft unless Strata can prove the thread already wrote that version. After that, StrataMD remembers what the thread has seen. Each Send contains only the new changes, notes, and item activity meant for that recipient.

Before anything leaves the editor, the Send preview shows the exact text prepared for each agent. If two agents joined at different times, each gets the context it needs.

![Exact per-recipient Send preview](../screenshots/send.png)

### Review the answer where it belongs

Agents post comments, questions, replacements, and edits in the final `strata` block of their reply. Suggestions come back with Accept and Reject. Direct edits come back with Keep and Revert. Both appear in the document and the Changes panel, with the thread's identity attached.

You do not have to reconstruct the review from a chat transcript, and nothing is saved because an agent decided it was finished. Comments, questions, and suggestions live beside the document instead of adding metadata to the Markdown file.

![Reviewing agent work in source view](../screenshots/source.png)

### Your Markdown stays your Markdown

Write in rendered CommonMark and GitHub Flavored Markdown instead of staring at syntax. Switch to source with `Ctrl+/` whenever the source itself matters.

StrataMD does not clean up untouched Markdown behind your back. Blocks you never edit are written back from their original bytes. Frontmatter, footnotes, wiki links, HTML, math, and reference definitions stay as protected raw blocks when the visual editor cannot represent them safely.

![Editing rendered Markdown](../screenshots/editor.png)

### Make the workspace yours

Choose a built-in theme or change fonts, document colors, agent colors, accents, and ambient motion from the floating theme panel. Try rising motes, aurora drift, starfield, glow orbs, or no motion at all.

Themes are plain JSON, so an agent can inspect the active theme and help finish it while the panel is open. Motion pauses while you type and respects the operating system's reduced-motion setting.

![Editing a StrataMD theme live](../screenshots/theme-panel.png)

---

## Technical reference

### Collaboration loop

```text
Open a file
    ↓
Start or open a T3 thread
    ↓
You edit and annotate
    ↓
Send starts a turn with a frozen delivery
    ↓
Agent replies with prose and a strata block
    ↓
You review in StrataMD
    ├── Continue editing, then Send again
    └── Save when ready
```

1. Open a `.md` file in StrataMD.
2. Start a thread from the document or open one from Projects.
3. Edit, annotate, and press **Send** when you want the agent to continue.
4. Review suggestions with Accept or Reject and direct edits with Keep or Revert.
5. Save when the document is ready. Send never saves.

### Delivery and review model

| Part | Behavior |
|---|---|
| Working buffer | StrataMD mirrors live editor state to a private `buffer.md`. A delivery names it so the thread can read unsaved work; in-loop writes return through the final strata block. |
| Thread attachment | Each attached T3 thread has an independent baseline, delivery queue, and annotation cursor. |
| Send | StrataMD freezes one delivery per selected recipient. Later edits cannot enter that delivery, and the preview shows its exact text. |
| Suggestions | An agent anchors replacement Markdown to quoted text. Accept applies it; Reject dismisses it. Neither action saves the file. |
| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |
| Ghost | The ghost is the last version you reviewed. It lets StrataMD show outside file edits as track changes, including edits made while the document was closed. |

StrataMD instructs in-loop agents to return structured document actions in their final strata block. If an unattended tool writes to the document itself, the T3 turn diff and Strata's reconciler bring it into the same review flow. Save rechecks the document before writing and stops for conflict resolution if the file changed on disk.

### Markdown engine

| Area | Behavior |
|---|---|
| Visual editing | Headings, emphasis, links, images, lists, task lists, tables, code blocks, blockquotes, horizontal rules, and the rest of CommonMark and GFM edit in the rendered document. |
| Raw blocks | Frontmatter, footnotes, wiki links, HTML, math, and reference definitions remain byte-preserved blocks and edit in source view. |
| Save | Untouched regions come from the original bytes. A no-op Save is byte-identical, while a real edit rewrites only the smallest region the grammar requires. |
| Source details | Untouched CRLF line endings, UTF-8 BOMs, trailing whitespace, indentation, and delimiter styles survive a save. |
| Disk safety | Save uses a temporary file and rename, preserves file mode, and hashes the document immediately before writing. |
| Recovery | The mirrored buffer supports recovery after a crash, and pending review state survives closing and reopening the document. |

## Quick start

StrataMD currently builds from source on Linux. It requires Node.js 22 or newer and pnpm.

```bash
pnpm install
pnpm build:linux
./dist/linux-unpacked/stratamd setup
stratamd open README.md
```

Pair Strata with the T3 server, then start a thread from a document or Projects. `stratamd --agent-help` prints the thread contract.

For development, run `pnpm dev`. The setup command is safe to repeat, and `stratamd setup --remove` removes the PATH link and desktop integration.

The file-only command has four jobs: `open`, `theme`, `setup`, and `doctor`. Agent traffic stays in T3 messages and final strata blocks.

## Local by design

StrataMD has no account of its own and no telemetry. It stores working buffers, reviewed copies, annotations, and queued deliveries locally. One paired credential connects it to the T3 server over HTTP and WebSocket.

Other than the paired T3 engine, Strata makes no network calls. A thread may send document content to its model provider according to that provider's configuration and privacy policy.

## Project status

StrataMD is an early-stage personal Linux tool. There is no public package, installer, auto-updater, macOS build, or Windows build yet.

Read the [product specification](../PRD.md) for the full behavior and edge cases. The bundled [agent skill](../../skills/stratamd/SKILL.md) defines the T3 thread contract.

Bug reports go to <dillonc@sandflatllc.com>.[^1]

[^1]: Or leave a question on this paragraph and send it to a thread.
