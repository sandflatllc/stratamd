---
name: stratamd
description: Collaborate on Markdown through StrataMD. Use whenever the user mentions Strata or StrataMD, refers to a document open there, or asks you to review, edit, annotate, or show changes in their Strata document.
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
- Use `stratamd annotate` for comments, questions, and suggestions; `stratamd reply` to answer a thread.
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
