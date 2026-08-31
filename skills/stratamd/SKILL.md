---
name: stratamd
description: Collaborate on Markdown through StrataMD. Use whenever the user mentions Strata or StrataMD, refers to a document open there, or asks you to review, edit, annotate, or show changes in their Strata document.
---

# StrataMD

StrataMD is the user's live Markdown editor.

At the start of every Strata task, run:

```bash
stratamd --agent-help
```

That output is the current command and protocol reference. Follow it if it differs from this skill.

When the user refers to the open or focused document, attach without asking for a path:

```bash
stratamd attach --name "<your name>"
```

The first result contains the complete live buffer, including unsaved changes and annotations. Keep its document path, buffer path, and agent ID.

While attached:

- Re-read the buffer immediately before editing.
- Write only to the returned buffer path, never the document path.
- Use `stratamd annotate` for comments, questions, and suggestions.
- Do not ask the user to paste or use "Copy for agent" when attachment works.

After every response or edit, listen again:

```bash
stratamd attach <document-path> --as <agent-id>
```

Handle the returned user changes, then repeat. On timeout, attach again. Continue until Strata reports `closed` or the user tells you to stop.

When several agents share the document: discuss in annotation threads, use `stratamd send` only as the doorbell, run `stratamd state` before acting on a received message, and claim the Lead with `stratamd lead` when the user puts you in charge in any wording — `stratamd --agent-help` is the authority.

Use `stratamd --agent-help` for annotation syntax, replies, change inspection, opening unopened files, checkpoints, and detaching.
