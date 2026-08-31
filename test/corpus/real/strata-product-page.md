# StrataMD

**Write with agents. Keep the final say.**

![StrataMD mark](../../resources/stratamd-icon.svg)

StrataMD is a visual Markdown editor for people who write plans, specs, documentation, and other `.md` files with AI agents. Your agent can read the draft you have open, respond inside the document, and continue from the changes you choose to send.

> Attach to the document I have open in Strata.

That one instruction is the whole handoff. You do not need to paste a path, install a StrataMD-specific plugin, or move the conversation into another app. Claude Code, Codex, T3 Code, and any other agent that can run a shell command can join.

![StrataMD reviewing agent changes](../screenshots/review.png)

*This page was written and reviewed in StrataMD. The screenshots use this document as the editing surface.*

## Why StrataMD?

Agents are good at producing a lot of Markdown. Reviewing it is still awkward. Chat puts your feedback somewhere other than the document. Direct file edits can replace the text before you have decided what belongs.

StrataMD lets agents work with the live document while you keep approval. They can read, comment, suggest, and edit. You decide what stays and when the file is saved.

### Bring the agent you already use

StrataMD is not another chat client. Keep talking to your agent where you already work, then ask it to join the document open in StrataMD.

Attach more than one when the work calls for it. One agent can draft while another checks technical claims or leaves questions. Their replies stay attributed, and you choose what each agent receives.

### Send only what changed

The first time an agent attaches, it sees the complete live draft, including unsaved edits and annotations. After that, StrataMD remembers what that agent has already seen. Each Send contains only the new changes, notes, and annotation activity meant for that recipient.

Before anything leaves the editor, the Send preview shows the exact text prepared for each agent. If two agents joined at different times, each gets the context it needs.

![Exact per-recipient Send preview](../screenshots/send.png)

### Review the answer where it belongs

Agents can leave comments, ask questions, propose a replacement, or edit a larger section directly. Suggestions come back with Accept and Reject. Direct edits come back with Keep and Revert. Both appear in the document and the Changes panel, with the agent's name attached.

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
Agent attaches
    ↓
You edit and annotate
    ↓
Send freezes a delivery
    ↓
Agent comments or edits the buffer
    ↓
You review in StrataMD
    ├── Continue editing, then Send again
    └── Save when ready
```

1. Open a `.md` file in StrataMD.
2. Ask an agent to attach. The agent runs `stratamd attach` and receives the focused document without needing its path.
3. Edit, annotate, and press **Send** when you want the agent to continue.
4. Review suggestions with Accept or Reject and direct edits with Keep or Revert.
5. Save when the document is ready. Send never saves.

### Delivery and review model

| Part | Behavior |
|---|---|
| Working buffer | StrataMD mirrors the live editor state to a private `buffer.md`. Attached agents read and edit that buffer, including unsaved work. |
| Agent attachment | Each agent has an independent baseline, delivery queue, and annotation cursor. Multiple agents can attach without sharing each other's changes by default. |
| Send | StrataMD freezes one delivery per selected recipient. Later edits cannot enter that delivery, and the preview shows its exact text. |
| Suggestions | An agent anchors replacement Markdown to quoted text. Accept applies it; Reject dismisses it. Neither action saves the file. |
| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |
| Ghost | The ghost is the last version you reviewed. It lets StrataMD show outside file edits as track changes, including edits made while the document was closed. |

StrataMD instructs attached agents to edit the private buffer. If another tool writes to the document itself, StrataMD detects the change and brings it into the same review flow. Save rechecks the document before writing and stops for conflict resolution if the file changed on disk.

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

Then ask your agent to attach to the document you have open. If it needs the protocol, `stratamd --agent-help` prints the current instructions.

For development, run `pnpm dev`. The setup command is safe to repeat, and `stratamd setup --remove` removes the PATH link and desktop integration.

<details>
<summary>Agent CLI reference</summary>

| Command | What it does |
|---|---|
| `stratamd attach [file]` | Joins the focused or named document and waits for your next Send |
| `stratamd annotate` | Leaves a comment, question, or suggestion on quoted text |
| `stratamd reply` | Answers a question or continues an annotation thread |
| `stratamd changes` | Lists every change you have not reviewed |
| `stratamd changed` | Attributes the agent's next direct edit |
| `stratamd open` | Opens a file with outside edits marked for review |
| `stratamd checkpoint` | Creates the reviewed baseline for a file or directory |
| `stratamd theme` | Describes the active theme so an agent can edit it |
| `stratamd detach` | Leaves the document session |

Commands write one JSON object to stdout. The attachment payload includes a complete rendered `text` field, so an agent that reads nothing else still receives the full delivery.

</details>

## Local by design

StrataMD has no accounts or telemetry. It stores working buffers, reviewed copies, annotations, and queued deliveries on your machine. The app and CLI communicate through a local Unix socket that checks the caller's user ID.

StrataMD itself makes no network calls. An attached agent may send document content to its model provider according to that agent's own configuration and privacy policy.

## Project status

StrataMD is an early-stage personal Linux tool. There is no public package, installer, auto-updater, macOS build, or Windows build yet.

Read the [product specification](../PRD.md) for the full behavior and edge cases. The bundled [agent skill](../../skills/stratamd/SKILL.md) shows how an agent attaches and stays in the editing loop.

Bug reports go to <dillonc@sandflatllc.com>.[^1]

[^1]: Or leave a question on this paragraph and attach an agent to it.
