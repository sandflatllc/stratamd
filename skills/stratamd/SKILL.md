---
name: stratamd
description: Collaborate on a document open in Strata. Triggers on a Strata delivery message carrying a Markdown attachment, or on the owner asking you to work in a document that is open in Strata. Reviewing a file by path, writing a Markdown file, and working on the StrataMD codebase do not trigger it on their own.
---

# Collaborate in Strata

Strata holds the document and its unsaved changes. T3 runs your thread.
An attachment links the thread to the document. Once attached, document
context reaches you as T3 messages, and your document actions travel in
one fenced `strata` block at the end of each completed reply.

`COMPONENTS.md` beside this file is the reference for Strata components.

## 1. Begin

### The owner sends the document

When the owner uses Send or starts a thread from the document, Strata
attaches the thread for you. The message is one line naming the delivery,
followed by a line giving the on-disk path of the attached Markdown file:

    [Attached file "<deliveryId>.md" is saved at: /path/to/<deliveryId>.md]

Read that file and begin the work.

### The owner asks you to join an open document

When the owner asks you to work in a document open in Strata and no
delivery has arrived, reply with only this block, using the absolute path
already in the conversation:

```strata
[{"verb":"attach","document":"/absolute/path/document.md"}]
```

Strata attaches the thread and sends the first delivery as the next turn.
Document actions begin on that following turn. If no path has been
supplied and none is obvious, ask which document.

## 2. Read the delivery

Read all of it: the owner's note, the document text or diff, comments,
replies, decision answers, verdicts on your earlier edits, and the outcomes
of your last action block.

The delivery names the live buffer path. Read that buffer for the current
text; the saved file may lack the owner's unsaved edits. A first delivery
carries the whole document, a diff, or no document when the thread already
holds the current text. Later deliveries carry changes since the last one.

Every block in delivered text carries a short block id that belongs to
that delivery and that document. Keep the document path, block ids, and
item ids exactly as supplied. Delivered document text has annotation
markers such as `⟦user: note⟧` inlined, so it locates passages but is not
the exact text. Copy `match` and `quote` values from the buffer.

## 3. Return actions

While the owner is in the loop, change the document only through actions.
Leave the buffer and the file alone. When you work unattended, write
project files normally and T3's turn diff reports them.

End every completed reply with exactly one fenced `strata` block holding a
JSON array. Put every action for the round in it. An empty array means no
actions. Each entry stands alone: a malformed or stale entry fails without
discarding its siblings.

```strata
[
  {"verb":"comment","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Why this matters."},
  {"verb":"question","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Should this stay?"},
  {"verb":"decision","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Choose a direction.","options":["Keep","Change"]},
  {"verb":"suggest","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"replacement":"Replacement Markdown."},
  {"verb":"edit","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"match":"exact text inside the block","replace":"new text"},
  {"verb":"reply","anchor":{"item":"item-id"},"text":"Clarification in an existing thread."},
  {"verb":"resolve","anchor":{"item":"item-id"}},
  {"verb":"accept","anchor":{"item":"item-id"}},
  {"verb":"reject","anchor":{"item":"item-id"}},
  {"verb":"save","document":"/absolute/file.md"},
  {"verb":"lead","document":"/absolute/file.md","action":"claim"}
]
```

The verbs, and what each needs:

- `comment`, `question`: a document anchor and `text`.
- `decision`: a document anchor, `text`, and `options` with at least two
  distinct choices. Only the owner answers.
- `suggest`: a document anchor and `replacement`, the Markdown that would
  replace the anchored passage.
- `edit`: a document anchor, `match` with exact current text that occurs
  once inside that one block, and `replace`.
- `reply`, `resolve`, `accept`, `reject`: an item anchor,
  `{"item":"item-id"}`, from the delivery.
- `save`: the document path. `lead`: the document path and `action`,
  `claim` or `release`.
- `attach`: the document path, alone in its block, as in section 1.

A document anchor is `{"document":"/absolute/file.md","block":"b1234abcd"}`.
When the block id no longer fits, the fallback is an exact quote:
`{"document":"/absolute/file.md","quote":"exact current text"}`. After a
passage changes, take the new id from the new delivery rather than reusing
an old one.

Put only JSON in the block. Components and prose belong above it.

## 4. Owner and Lead

Only the owner answers or reopens a decision. Recommending an option is a
comment, and authorizes nothing.

At most one attached thread holds the Lead. Claim it with the `lead` verb
when the owner puts you in charge and nobody holds it; a claim while
another thread holds it fails naming the holder, and only the owner
transfers it. Accept, reject, save, and resolving another thread's item
are Lead-only. Use them only while your thread holds the Lead and the
owner's request covers them. An edit changes the working document; Save is a separate
action, and sending context never saves.

## 5. Continue from the next delivery

Strata applies the block and reports each entry as applied or failed in
the next delivery, with the created item id or the nearest block
candidates for a miss. Read the outcomes before acting again. Keep what
applied. For a failed anchor, reread the current passage and target it
afresh.

Finish the round, then end your turn. T3 delivers the owner's next message
as a new turn. There is no listener to run and nothing to poll.

If an attach request produced no delivery and the owner follows up, say the
document context did not arrive. Send no second attach block.

## 6. Feedback on your conversation messages

Owner comments on your replies arrive as `conversation-<deliveryId>.md`,
headed `Conversation context`, with Delivery and Thread ids. Its New
annotations, Replies, Message blocks, and Strata block outcomes sections
are JSON arrays. Read the full selection and text, line breaks included. A
range anchor gives the owner's exact selection as start and end block ids
with UTF-16 offsets, end exclusive.

Answer that feedback in your normal prose in the main conversation. Each
comment is one-time context that stays saved for navigation; it needs no
threaded reply and no resolution. A message suggestion is guidance for a
later answer; message prose never changes.

To attach an item of your own to one of your messages, anchor to a whole
message block with the ids supplied:

```strata
[{"verb":"comment","anchor":{"message":"m_example","block":"b1234abcd"},"text":"A point about this answer."}]
```

You may resolve your own non-decision message items. Conversation outcomes
arrive on the owner's next Send; they start no turn themselves.

## 7. Visual comments

The owner can mark up a screenshot or a captured page and send it to you.
Each one arrives in the same `conversation-<deliveryId>.md` under a
`Visual comments` section: its id (`v_…`), the revision number, the note,
marks with plain names and pixel rects in the named screenshot, drawings,
and the attachment name of each marked screenshot, which is attached to
the turn as an image. Read the image beside the entry: the rects and names
point at what the owner marked.

Do the change, then answer by revision in your final block:

```strata
[{"verb":"reply","anchor":{"item":"v_example"},"revision":1,"text":"Moved the button into the header row.","ready":true,"file":"/absolute/path/after.png"}]
```

`ready` asks the owner to review; without it the reply is a note. A reply
to an earlier revision stays readable but does not make the comment ready.
`file` is optional and names a screenshot you took yourself. Only the owner
accepts or reopens a visual comment; `resolve` on one fails.

An `adjustments` list gives the exact property and value the owner tried on
a mark, and a capture marked `requested` shows the page with those applied.
Implement the intent with the project's styling rules rather than copying
the values. Once you reply `ready`, Strata takes its own picture of the
marked thing and shows the owner then and now.

When Strata is the engine's browser host, your preview tools (open, navigate,
click, type, press, scroll, wait for, resize, evaluate, snapshot, screenshot)
land in a tab of your own in the owner's Strata window, under the project's
preview. The owner can watch it; a click of theirs inside your tab pauses it
until they resume, and a request that names no tab goes to the last tab you
opened. Open a page before acting on it.

## 8. Chat beside the block

Everything in the block is already in front of the owner. The prose above
it carries only what the block does not: one line per action at most, no
repeated proposed text, and any failure that stopped the requested work.
Describe actions as submitted until an outcome confirms them.

Use components in that prose when they organize the answer: a Callout for
context, a Verdict for a judgment, and ordinary headings, lists, tables, or
Mermaid for structure.

## The stratamd command

The `stratamd` command is file-only and never talks to the running app. It
opens a Markdown file, inspects a theme, installs this skill with `setup`,
and diagnoses local paths with `doctor`. `stratamd --agent-help` prints the
action contract this file embeds.
