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

After every response, listen again in the background with a long wait; every wakeup is a turn the user sees, so fewer is better. When your harness runs background commands without a time limit (Claude Code's Bash tool does), use an hour:

```bash
stratamd attach <file> --as <agent> --timeout 3600
```

When the command must finish inside a limit, set that limit as high as the tool allows and pass a `--timeout` 30 seconds below it; the default 90 fits a 120 second limit. Act on what it returns, then repeat. `{"event":"timeout"}` means nothing happened: run it again and say nothing in chat. `{"event":"superseded"}` means a newer call of yours is listening: do nothing and say nothing. A call your harness kills is safe; the delivery repeats on the next call with the same `deliveryId`. Stop when it returns `{"event":"closed"}` or the user tells you to stop.

## What to say in chat

The user reads the document in StrataMD. Everything you put in an annotation, reply, edit, or decision is already in front of them there. In chat, report only the actions you took, one line each: which thread you replied to, which passage you edited, which decisions you created, and what you are waiting on. Do not repeat or summarize the content of a reply, an edit, or an annotation; that is the same text twice. Report content in chat only when the document is not where the user will read it: an error, a refusal, or something you could not post. A `timeout` is not an action. Do not announce it, do not say you are reattaching, and do not summarize what you are waiting for again. The user sees your listening state in the Agents panel. Your next chat message is the next action you take.

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

When you create or substantially edit a local `.md` file for the user, write StrataMD-friendly Markdown unless the file is clearly for another renderer (a GitHub README, package docs, a changelog). Write meaning; StrataMD owns presentation.

Structure a long document for scanning before adding more prose:

- One H1, then a one-paragraph lead. H2 headings are the reading route: each one is a walkthrough step with its own number, so name them for what the reader decides or learns there. H3 and deeper hold detail beneath a step.
- Open a judgment-heavy section with its controlling judgment in a `Verdict`, then the evidence, then the change.
- Put figures that carry part of the argument in a `MetricStrip`, not in a sentence.
- Put ordered work in a `PhaseBoard`: one H3 per phase, one list item per task with the effort or owner in emphasis at the end.
- Compare explicit alternatives against the same criteria in a `DecisionMatrix`.
- Show a transformation as a `BeforeAfter`.
- Plot a bounded numeric relationship as a `Chart` when the table hides the shape.
- Keep a claim, its evidence links, and the conclusion together in an `EvidenceChain` when the reader must be able to check why.
- Discuss a specific image position with an `AnnotatedScreenshot`.
- Use a `Callout` for information that must stand apart from the surrounding argument: a warning, an implication, supporting context, or a decision the owner alone can make.
- Keep ordinary headings, paragraphs, lists, links, tables, Mermaid, images, and `tree` fences when they already communicate the idea well. A fact table stays a table; StrataMD gives every table sorting, filtering, Focus row, and Compare.

Never wrap every paragraph, and never manufacture a component to add color. Most sections of a good review contain one or two components and ordinary Markdown around them.

Rules that keep the file safe:

- Use a real Markdown link when evidence must target another file. A complete local Markdown path in inline code may preview; numeric shorthand does not.
- Create a decision annotation when the owner must choose; a component cannot record a decision.
- Before authoring a component, run `stratamd components [name] --json`. After adding or changing one, run `stratamd validate <file> --json` and fix every problem. Validation uses the editor's Markdown parser and never rewrites the file: wrappers are top-level at column 1, fenced or list examples remain ordinary Markdown, and registered tags used inline are invalid.
- Add screenshot coordinates with `stratamd pin <file> --component <opening-line> --x <0..100> --y <0..100> --note "<text>" --as <agent>`. Do not hand-author agent pin coordinates.
- Components contain ordinary Markdown. Never write CSS, colors, fonts, dimensions, layout, imports, JavaScript, expressions, event handlers, reading state, application tabs, rails, dialogs, toolbars, file operations, or agent controls into them.
- Unknown component names remain raw source. Do not invent one from memory.

### A dense review, before and after

An ordinary draft of one review section reads like this. The verdict is a paragraph, the numbers hide in prose, the plan is a table, and nothing tells the reader what to check first:

```md
## 6. CI and release gates

A red check cannot protect main when deployment ignores it. CI has been red since
2026-06-19 and every push to main deployed anyway; Playwright has never run in CI.
The integration lane cannot start a database. Pre-commit runs eleven jobs and CI
runs nine lanes, and in August the gates caught two defects between them. The fix
is to make the gate mechanical.

| Change | Days | Owner |
|---|---|---|
| Fix the integration lane migration ordering; get one green run. | 1 | Tests |
| Wire deploys to green CI. | 0.5 | Owner decision |
| Cut pre-commit to four jobs and CI to five lanes. | 0.5 | Gates |
```

The same section written for StrataMD keeps every fact and adds the meaning the reader needs. The verdict leads, the numbers become metrics, the evidence links to the file that proves it, the plan becomes phases, and the one choice the owner must make stands apart:

```md
## 6. CI and release gates

<Verdict outcome="caution">
A red check cannot protect main when deployment ignores it. Make the gate mechanical.
</Verdict>

<MetricStrip>
- **CI red since:** 2026-06-19
- **Playwright runs in CI:** 0
- **Pre-commit jobs:** 11
- **Defects caught by gates in August:** 2
</MetricStrip>

<EvidenceChain>
### Claim

Deployment has been ignoring the gate for months.

### Evidence

- [CI status log](./evidence/03-ci.md#status) — red since 2026-06-19, every push deployed.
- [Playwright lane history](./evidence/04-tests.md#playwright) — the lane has never run.

### Therefore

Wire Render and Vercel to deploy only on green CI, then cut the gates that catch nothing.
</EvidenceChain>

<PhaseBoard>
### Now, this week

- Fix the integration lane migration ordering; get one green run. *1 day · Tests*
- Wire deploys to green CI. *0.5 day · Owner decision*
- Cut pre-commit to four jobs and CI to five lanes. *0.5 day · Gates*
</PhaseBoard>

<Callout kind="implication">
### Your call

Deploy only on green CI, or keep CI informational and accept that main can ship red.
</Callout>
```

Then create the decision itself so the owner can answer it in StrataMD:

```bash
stratamd annotate REVIEW.md --kind decision --quote "## 6. CI and release gates" \
  --text "Should deploys wait for green CI?" --option "Gate deploys" --option "Informational" --as <agent>
```

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
