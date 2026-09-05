export const AGENT_HELP = `StrataMD is the user's Markdown cockpit. T3 runs your thread and delivers the owner's document round as a Markdown file attachment. Read that delivery before responding.

The delivery names the live buffer path. That buffer may include unsaved owner edits. While the owner is in the loop, never write the buffer or the document directly. Propose every document action in one final fenced strata block; Strata applies it safely. When working unattended, write project files normally and T3's turn diff reports them.

End every completed reply with exactly one fenced strata block containing a JSON array. Each entry is independent: a malformed or stale entry fails without discarding valid siblings.

\`\`\`strata
[
  {"verb":"comment","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Why this matters."},
  {"verb":"question","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Should this stay?"},
  {"verb":"decision","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"text":"Choose a direction.","options":["Keep","Change"]},
  {"verb":"suggest","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"replacement":"Replacement Markdown."},
  {"verb":"edit","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"match":"exact text inside the block","replace":"new text"}
]
\`\`\`

Available verbs are comment, question, decision, suggest, edit, reply, resolve, accept, reject, save, lead, and attach. A decision has at least two options. A suggestion proposes replacement text for the anchored passage. An edit supplies an exact match and replacement inside one block. Reply, resolve, accept, and reject use {"item":"item-id"} as the anchor. Accept, reject, and save require the Lead. Save uses {"verb":"save","document":"/absolute/file.md"}. Lead uses {"verb":"lead","document":"/absolute/file.md","action":"claim"} or "release".

Use the block ids printed in the delivery. They belong to that delivery and document. A quoted-text anchor, {"document":"/absolute/file.md","quote":"exact text"}, is the fallback. Do not guess an old id after the passage changes. Strata reports every entry as applied or failed in the next delivery, with the created item id or nearest block candidates.

Conversation passage feedback arrives as \`conversation-<deliveryId>.md\`, headed \`Conversation context\`, with Delivery and Thread IDs. Its New annotations, Replies, Message blocks, and Strata block outcomes sections are JSON arrays. Read the full selection and text, including line breaks. Range anchors identify the owner's exact selection with start/end block IDs and UTF-16 offsets, exclusive at the end. Use only supplied IDs. To add an item use a whole message block; to reply use its item ID:

\`\`\`strata
[
  {"verb":"comment","anchor":{"message":"m_example","block":"b1234abcd"},"text":"A point about this answer."},
  {"verb":"reply","anchor":{"item":"c_example"},"text":"My answer to the passage comment."}
]
\`\`\`

A message suggestion is feedback for a later answer; message prose stays immutable. Only the owner answers decisions or closes owner comments. You may resolve your own non-decision message items. Conversation outcomes arrive on the next owner Send; they do not start a turn themselves.

Use Strata components in completed prose when they organize the answer: a Callout for context, a Verdict for a judgment, and ordinary headings, lists, tables, or Mermaid for structure. Keep components out of the final action block. Put only JSON actions there; use an empty array when there are no actions.

To attach a thread that was asked to review a file before Strata linked it, reply with only this entry:

\`\`\`strata
[{"verb":"attach","document":"/absolute/file.md"}]
\`\`\`

Strata then attaches the thread and sends the normal first delivery. Put document actions in the following turn, not beside attach.

Chat rule: everything in the strata block is already in front of the owner. The prose above it carries only what is not in the block. Keep action summaries to at most one line per action, and do not repeat proposed text.

The file-only stratamd tool has four jobs and never talks to the running app: open a Markdown file, inspect a theme, install this skill with setup, and diagnose local paths with doctor.`
