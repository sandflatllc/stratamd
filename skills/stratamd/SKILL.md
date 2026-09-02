---
name: stratamd
description: Collaborate on Markdown through StrataMD. Use whenever the user mentions Strata or StrataMD, refers to a document open there, asks you to review, edit, annotate, or show changes in their Strata document, or asks you to create or substantially edit a local .md file for them. Clearly external Markdown such as a GitHub README, package documentation, changelog, or content for another renderer stays portable unless the user explicitly requests StrataMD components.
---

# StrataMD

StrataMD is the user's live Markdown editor. The `stratamd` command is how you read what they are looking at, respond, and wait for their next round.

## Install

This skill lives with the harness that runs you. `stratamd setup --skill claude` copies it to `~/.claude/skills/stratamd`, `--skill codex` to Codex's skills directory, `--skill agents` to `~/.agents/skills/stratamd`, and `--skill <dir>` anywhere else; running it again refreshes a stale copy. The reference below is `stratamd --agent-help`; if this file and that output disagree, the output is current.

At the start of every Strata task, run:

```bash
stratamd --agent-help
```

## The loop

When the user refers to the open or focused document, attach without asking for a path:

```bash
stratamd attach --name "<your name>"
```

The first result carries the complete live buffer, including unsaved changes and annotations. Keep three fields from it: `file` (the document path), `buffer` (the path of the buffer file you write to), and `agent` (your id).

While attached:

- Copy quotes and matches from `document` or the buffer file, never from `text`, which has markers inlined.
- Use `stratamd edit` to change a passage: it matches the exact current text and cannot undo an edit the user made after you last read. An empty `--match` with `--preceded-by` or `--followed-by` inserts at that point; `--append` inserts at the end.
- Use `stratamd annotate` for comments, questions, suggestions, and owner decisions; `stratamd reply` for clarification in any thread. A decision needs a prompt, at least two distinct options, and an exact quote, complete ATX heading line, or document anchor. The heading line starts at column 1, includes its `#` markers, and ends at the line boundary. Create a decision when the owner must choose; its answer does not edit the document.
- Only the owner answers, reopens, or resolves a decision. An agent, including the Lead, receives `DECISION_OWNER_REQUIRED` with exit 3 when it tries `stratamd answer` or `stratamd resolve` on one, whether the app is running or the local document state is read offline. Reply when the choice needs clarification, then wait for the owner’s answer through the normal Send flow.
- Write only to the `buffer` path when you rewrite larger parts, and re-read it right before you write.
- Pass `--as <agent>` on every command after the first attach. Subagents always pass `--as`; they do not inherit your attachment.
- Do not ask the user to paste or use "Copy for agent" when attachment works.

After every response, listen again, in the background, with a timeout below your tool's command limit (the default is 90 seconds):

```bash
stratamd attach <file> --as <agent> --timeout 90
```

Act on what it returns, then repeat. `{"event":"timeout"}` means nothing happened: run it again. A call your harness kills is safe; the delivery repeats on the next call with the same `deliveryId`. Stop when it returns `{"event":"closed"}` or the user tells you to stop.

## Exit codes

Every command prints one JSON object on stdout; errors go to stderr as `{error, code, detail}`.

- 0: done.
- 1: usage; `detail` lists the valid options or what was expected.
- 2: not found; the message names the file, annotation, or attachment. `ATTACHMENT_NOT_FOUND` on your own id means run `stratamd attach` first.
- 3: refused by the document's state. `QUOTE_INVALID` lists `candidates` with `before` and `after` text to pass as `--preceded-by` and `--followed-by`, or `exact` when only whitespace differed.
- 4: the app is not running or its build changed (`PROTOCOL_MISMATCH`). Run `stratamd doctor` and report what it says: the socket, the log path with the last errors, and both versions. The message says whether the app needs a restart or the command an update.

## Several agents

Discuss in annotation threads. Use `stratamd send` only as the doorbell, run `stratamd state --brief` to see who is attached and who leads and `stratamd state` before acting on a received message, and claim the Lead with `stratamd lead` when the user puts you in charge in any wording.

`stratamd docs` lists every document open in Strata, with each one's `buffer` path, when the user refers to one that is not focused.

`stratamd --agent-help` covers annotation and edit syntax, `state --raw` and `state --annotations`, change inspection, opening unopened files, checkpoints, and detaching. `stratamd --version` prints the app, protocol, and payload versions.

## Writing documents for StrataMD

Write meaning; StrataMD owns presentation.

- Use one H1 and meaningful heading levels. Prefer ordinary paragraphs, lists, tables, images, links, Mermaid, and fenced `tree` blocks.
- Use a real Markdown link when evidence must target another file. A complete local Markdown path in inline code may preview; numeric shorthand does not.
- Put a controlling judgment near the start of a judgment-heavy section. Create a decision annotation when the owner must choose.
- Use a registered component only when it expresses a relationship ordinary Markdown does not. Never use one only to decorate prose.
- Before authoring a component, run `stratamd components [name] --json`. After adding or changing one, run `stratamd validate <file> --json` and fix every problem. Validation uses the editor's Markdown parser and never rewrites the file: wrappers are top-level at column 1, fenced or list examples remain ordinary Markdown, and registered tags used inline are invalid.
- Add screenshot coordinates with `stratamd pin <file> --component <opening-line> --x <0..100> --y <0..100> --note "<text>" --as <agent>`. Do not hand-author agent pin coordinates.
- Components contain ordinary Markdown. Never write CSS, colors, fonts, dimensions, layout, imports, JavaScript, expressions, event handlers, reading state, application tabs, rails, dialogs, toolbars, file operations, or agent controls into them.
- Unknown component names remain raw source. Do not invent one from memory.

Complete examples of the initial registry:

```md
<Callout kind="warning">
### Before continuing

Back up the local store before changing its format.
</Callout>
```

```md
<Verdict outcome="recommended">
### Adopt the bounded parser

It preserves source identity without allowing executable MDX.
</Verdict>
```

```md
<MetricStrip>
- **Open time:** 224 ms
- **Typing:** 9.8 ms
- **Byte drift:** 0
</MetricStrip>
```

```md
<PhaseBoard>
### Phase 1

| Work | Status |
|---|---|
| Parser | Complete |

### Phase 2

- Add editor views.
</PhaseBoard>
```

```md
<DecisionMatrix>
| Criterion | Keep current | Adopt bounded parser |
|---|---|---|
| Byte preservation | Partial | Strong |
| Executable content | Possible | Blocked |
</DecisionMatrix>
```

```md
<BeforeAfter>
> ### Before
> Copy the document into chat and compare rewrites manually.

> ### With StrataMD
> Discuss tracked edits in the open document.
</BeforeAfter>
```

```md
<Chart kind="line">
| Month | Open time | Typing |
|---|---:|---:|
| Jul | 240 | 12.4 |
| Aug | 224 | 9.8 |
</Chart>
```

```md
<EvidenceChain>
### Claim

Mechanical guards hold better than prose.

### Evidence

- [Database findings](./evidence.md#database-guards) — enforced invariants held.
- [CI findings](#ci-findings) — prose-only gates drifted.

### Therefore

Move the invariant into executable boundaries.
</EvidenceChain>
```

```md
<AnnotatedScreenshot>
![Review table](./review-table.png)

| Pin | X | Y | Image version | Note |
|---:|---:|---:|---|---|
| 1 | 24.0 | 31.5 | 48211:1788372000000000000 | Long rows need a clearer boundary. |
</AnnotatedScreenshot>
```
