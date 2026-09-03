export const AGENT_HELP = `StrataMD is the markdown editor the user is working in. Attach to the
document they have open, read the buffer with their comments, respond
with comments, questions, and proposed edits, then attach again to wait
for their next round. Keep that loop going until the payload says
"closed" or the user tells you to stop.

Quick start:
  1. stratamd attach --name "<who you are>"
     Read "document" (the buffer with the user's comments inlined) and
     keep "file", "buffer", and "agent" from the result.
  2. Respond: stratamd edit changes a passage, stratamd annotate adds a
     comment, question, suggestion, or decision, and stratamd reply
     continues a thread.
  3. stratamd attach <file> --as <agent>, run in the background, waits
     for the user's next Send. Act on what it returns.
  4. Repeat from 2. Stop when attach returns {"event":"closed"}.
  Copy quotes and matches from "document" or the buffer file, never
  from "text": "text" has the comment markers inlined and will not
  match the buffer.

What to say in chat:
  The user reads the document in StrataMD, so everything you put in an
  annotation, reply, edit, or decision is already in front of them.
  Report only the actions you took, one line each. A timeout or a
  superseded call is not an action: listen again and say nothing about
  it; if your harness demands a visible reply, one word is enough.
  Report content in chat only when the document is not where the user
  will read it: an error, a refusal, or something you could not post.

  stratamd attach [file] [--as <agent id>] [--name "<who you are>"]
                         [--timeout <seconds>, default 90; 0 = poll]
                         [--text-only]
      Attaches you to the document (the focused one if no file is given)
      and opens it if it is not open.
      The FIRST call returns immediately with the whole buffer, the
      user's comments rendered inline, the file path, the buffer path,
      and your agent id. Pass that id with --as and the path as <file>
      on every later call.
      LATER calls return immediately if the user has pressed Send since
      your last call; otherwise they block until the user does. They
      return only what the USER changed since your last call: hunks
      with line numbers and one unchanged line either side, new
      comments, decisions, replies, owner decision answers, which of
      your suggestions were accepted or rejected, annotations whose
      quoted span the user moved (listed again with the new quote plus
      a "requoted" line), and the user's notes. Changes made by anyone
      else (other agents, other editors)
      are NOT included unless the user chose to include them.
      Nothing is lost while you are not waiting; sends queue until your
      next call, even across restarts. Run it in the background and act
      when it returns. Re-run it after each response to keep listening.
      It returns {"event":"timeout"} after --timeout seconds if nothing
      happens: run it again and say nothing about it in chat; if your
      harness demands a visible reply after a tool-only turn, one word
      is enough. Every wakeup is a turn the user sees, so wait as long
      as your harness allows: --timeout 3600 in a background command
      that has no time limit (Claude Code's Bash tool), otherwise the
      tool's limit minus 30 seconds; the default 90 fits a 120 second
      limit. A call your harness kills is safe; the delivery repeats on
      your next call with the same deliveryId.
      --timeout 0 never blocks: it returns a queued delivery or
      {"event":"timeout"} at once, for a harness that cannot hold a
      command open. It returns {"event":"closed"} when the user has
      closed the document, after anything that was queued. It returns
      {"event":"superseded"} when a newer attach call for your id
      replaced this one: do nothing and say nothing, the newer call is
      listening.
      A delivery can arrive twice if a call was cut off; the same
      deliveryId means you already handled it.
      --text-only leaves out the "document" field; "text" already holds
      the whole buffer with the comments inlined, so you miss nothing
      and the payload is half the size on a large document. Copy quotes
      from the buffer file then. The same flag works on state.

  stratamd annotate <file> --kind <comment|question|suggestion>
                           --quote "<exact text from the buffer>"
                           [--text "<your comment or replacement>" | --text -]
                           [--label "<short label>"]
                           [--preceded-by "<text right before the quote>"]
                           [--followed-by "<text right after the quote>"]
                           [--as <agent id>]
      Comments on text or proposes a change. The quote is text copied
      exactly from "document" or the buffer file, unique within it. A
      suggestion's quote sits inside one markdown block (a paragraph,
      list item, heading, or table cell: the same block ranges edit
      uses), and its --text is markdown; a comment or question may
      quote a long span to mark what should be read with it.
      If the quote is missing, ambiguous, differs only in whitespace,
      or crosses blocks, the command fails (exit 3, code QUOTE_INVALID)
      with detail [{reason, total, candidates: [{line, before, quote,
      after}], hint, exact}]. Pass a candidate's before or after text
      as --preceded-by or --followed-by and retry; for reason
      "whitespace", use "exact" as the quote. --preceded-by "" means
      the start of the document and --followed-by "" its end.
      A decision instead uses:
        stratamd annotate <file> --kind decision --text "<prompt>"
          --option "<choice>" --option "<choice>"
          (--quote "<exact passage>" | --heading "<complete # heading>"
           | --document) [--as <agent id>]
      Give at least two distinct non-empty --option values. Other is
      always available and is not an --option. Give exactly one anchor:
      --quote, --heading, or --document. A heading is one complete ATX
      heading line copied from the buffer, including its # markers. It
      must begin at column 1 and end at that line's boundary; a prefix
      of a longer heading is not an anchor.
      Pass --json <file or -> with an array. Ordinary entries use
      {kind, quote, text, label, precededBy, followedBy}; decisions use
      {kind:"decision", text, options, and exactly one of quote,
      heading, document:true}. One bad entry creates none. Suggestions
      are not applied until the user accepts them. Prints
      {"created":[{id, kind, quote}]}; use the ids in reply and resolve.

  stratamd edit <file> --match "<exact text from the buffer>"
                       --replace "<new text>" | --replace -
                       [--preceded-by "<text right before the match>"]
                       [--followed-by "<text right after the match>"]
                       [--append] [--dry-run]
                       [--as <agent id>] [--name "<who you are>"]
      Changes one passage. The match follows the quote rules of
      annotate: copied exactly from the buffer and unique within it,
      with the same QUOTE_INVALID failure (exit 3) and the same
      --preceded-by / --followed-by fix. The replacement lands in the
      live buffer as YOUR change, marked for the user's review like a
      write to the buffer file. Use it instead of rewriting the buffer
      file when you want to change a passage: the match is checked
      against the buffer at the moment of the write, so it can never
      undo an edit the user made after you last read. An empty
      --replace deletes the passage.
      Insert = an empty match with a context. --match "" together with
      --preceded-by or --followed-by inserts at that point, and
      --preceded-by "" is the start of the document. --append inserts
      at the end of the buffer with no --match at all. Both work on an
      empty document. --dry-run locates every match and prints
      {"located":[{line, match}]} without changing anything.
      Pass --json <file or -> with an array of {match, replace,
      precededBy, followedBy, append} to make many changes at once; one
      bad match applies none of them, and two edits that overlap fail
      (exit 3, code EDITS_OVERLAP, detail names both). Prints
      {"applied":[{line, match, replace}]}; line is where the change
      begins in the buffer after the edit. Needs the running app.

  stratamd reply <file> --to <annotation id> --text "<reply>" [--as <id>]
      Answers a question or continues a thread. --text - reads stdin.
      Prints {"replied": <reply id>, "annotation": <thread id>}.

  stratamd answer <file> --decision <id> --choice "<choice>" [--as <id>]
  stratamd answer <file> --decision <id> --other "<answer>" [--as <id>]
      Decision answers belong to the user. This command always fails
      with exit 3 and code DECISION_OWNER_REQUIRED, whether the app is
      running or stopped; reply to the thread when you need to clarify
      or recommend an option.

  stratamd send <file> --as <your id> --text "<note>" [--text -]
                       [--to <id[,id,...]>]
      Sends a short note (up to 4 KB) to every other attached agent, or
      only those named with --to. It wakes their waiting attach calls;
      notes queue for absent agents and survive restarts. Keep the
      discussion in annotations and replies; send is the doorbell, and
      the recipient runs state or changes to catch up. One note may
      wait per recipient: sending another before it is collected fails
      (exit 3, detail names every blocked recipient); retry after they
      attach, or send only to the others with --to. Success means
      queued, not read.

  stratamd lead <file> --as <your id>
      Claims the Lead for this document. Run it when the user puts you
      in charge, in any wording: "take the lead", "you're the
      overseer", "conduct this edit". Only the Lead may run accept,
      reject, resolve on others' ordinary annotations, and save. A Lead
      still cannot answer or resolve a decision. The claim
      fails, naming the holder, if another agent already leads; the
      user can transfer or revoke it in the app. Detaching gives it up.

  stratamd accept <file> --annotation <id> --as <your id>
  stratamd reject <file> --annotation <id> --as <your id>
      Lead only. Accept applies a suggestion to the buffer as YOUR
      change, left pending for the user's review; reject dismisses it.
      Accept fails with QUOTE_INVALID, in the same shape as annotate,
      when the text the suggestion quotes has moved.

  stratamd resolve <file> --annotation <id> --as <your id>
      Closes a thread. Any agent may resolve annotations it created;
      the Lead may resolve anyone's ordinary annotation. Decisions can
      be answered or reopened only by the user; trying this command on
      one fails with DECISION_OWNER_REQUIRED, including when local
      document state is read while the app is stopped.

  stratamd save <file> --as <your id>
      Lead only. Saves the buffer to the document, exactly as the
      user's save: agent edits stay pending for the user's review.
      Fails when a conflict needs the user; report that and stop.

  stratamd state [file] [--brief | --text-only | --annotations | --raw]
      Read-only: the same content as a first attach, without attaching
      or affecting any attachment. Also reports whether the document is
      open in the app ("open"), the active theme (id, name, file path)
      and, for an open document, the attached agents: id, name, state,
      and which one leads. An agent's state is "waiting" while its
      attach call is blocked, "working" when it has no call open and
      nothing queued, and "pending" when a delivery is waiting for it
      to collect. --brief leaves out the document, text, and
      annotations: run it to see who is attached and who leads, for
      example after a message. --annotations leaves out the document
      and reduces text to the open questions and decisions; the
      annotations are the content. --raw prints the buffer itself,
      exactly, with no JSON:
      copy quotes from it, or pipe it to a file to work on the text
      with other tools.

  stratamd docs
      Lists the documents open in the app: each file, its buffer path,
      whether it is focused, whether it has unsaved changes, and its
      attached agents. Needs the running app.

  stratamd theme [id] [--json]
      Prints a theme: its file path, the values its authors SET, and
      every remaining key at its DEFAULT value with a one-line
      description of what it colors, then any problems. Works without
      the app running. When the user asks you to build or finish "the
      theme open in Strata", run stratamd state to find it, read the
      file, keep every value already set, write the remaining keys in
      the same shape, and run stratamd theme again to confirm there
      are no problems. The app applies the file as soon as it lands.

  stratamd components [name] [--json]
      Prints the closed StrataMD component registry, or one exact
      component: its purpose, accepted semantic properties and values,
      body guidance, and a complete source example. Works without the
      app running. Query it before authoring a component instead of
      relying on remembered syntax. Unknown names fail with exit 2 and
      code COMPONENT_NOT_FOUND.

  stratamd validate <file> [--json]
      Checks component tags and properties without changing the file.
      It reports the real path, whether the component syntax is valid,
      every recognized component and source line, and all problems with
      a stable code and plain fix. It uses the editor's Markdown parser:
      component wrappers must be top-level at column 1, fenced or list
      examples remain ordinary Markdown, and a registered tag used
      inline is invalid. Other ordinary HTML is ignored. Run it after
      adding or changing components and fix every problem before handing
      the document back. Works without the app running.

  stratamd pin <file> --component <line> --x <0..100> --y <0..100>
                       --note "<text>" [--as <agent id>]
      Adds one numbered pin to the valid AnnotatedScreenshot whose
      opening tag is on that line. Coordinates are percentages of the
      displayed image. The command checks the allowed local image,
      records its current version, appends the escaped note through an
      agent-attributed buffer change, and prints the created pin. Query
      stratamd validate for component lines first. Needs the running app
      and an attached agent; it never writes the document directly.

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
      Shows the file to the user. If you edited it, they see your
      changes marked for review. Use this after editing a file
      directly.

  stratamd checkpoint <file or directory>
      Records the user's last-reviewed version (from git HEAD if the
      file is in a repository, otherwise the current content) so edits
      you make afterwards show up for review. Run it before editing
      files the user has not opened in StrataMD.

  stratamd detach <file> --as <agent id>
      Ends your attachment. Optional; idle attachments expire on their
      own.

  stratamd doctor
      Works without the app. Prints the socket path and whether the app
      answers on it, the data and config directories, the log path with
      its last errors, every document lock with the process holding it,
      and the app and command versions, plus a list of problems. Run it
      whenever a command exits 4, and report what it says.
      stratamd --version prints the versions and paths alone.

Every command prints its result to stdout as one JSON object; a
command with nothing else to report prints {"ok":true}. Errors go to
stderr as one JSON object {error, code, detail}; a not-found error
names the id or path it looked for, and detail says what to do next.
Exit codes:
  0  done
  1  usage: a bad option (detail lists the valid ones), or a command
     that needs --as without one
  2  not found: the file, annotation, attachment, component, or image
  3  refused by the document's state; detail says why and what to do
  4  the app is not reachable, did not answer in time, or was built
     from a different version than this command (PROTOCOL_MISMATCH:
     the message says whether to restart StrataMD or update the
     command). Run stratamd doctor.
Your id: pass --as with the id your first attach returned. Without
--as, the id comes from your harness session when there is one;
otherwise every command except a first attach fails with exit 1. A
subagent shares its parent's session, so subagents always pass --as,
after an attach of their own. An --as the document does not know is
refused (exit 2, ATTACHMENT_NOT_FOUND): run stratamd attach first.

Payload fields, for attach, state, and changes: "event"; "file" and
"buffer" (paths); "agent" (your id); "deliveryId" (on send, message,
resync, closed); "notes" (the user's note); "document" (the buffer, on
initial, resync, state); "segments" (hunks per author: oldStart,
oldLines, newStart, newLines, removed, added, contextBefore,
contextAfter, line); "annotations" (id, seq, kind, author, agent,
name, label, status, anchor, quote, text, line, replies, decision,
context, including exact table-cell or screenshot-pin context);
"replies" (replies
to earlier threads: id, annotation, author, name, text, parent {kind,
quote, line, text}); "answers" (structured owner decision answers with
their parent prompt, options, and anchor); "resolved" (id, kind,
resolution); "edits" (your
kept or reverted changes); "partial"; "attachments"; "open"; "cursor";
and "text", a readable rendering of all of it.

What you see is the user's editor buffer, which may be unsaved;
"buffer" in the payload is its path. Edit by writing to that buffer
file, with stratamd edit for one passage, or by suggestions for small
inline proposals. The user sees your edits marked for review and
decides when to save. Re-read the buffer right before you write to it;
a write based on an old copy shows up to the user as undoing their
newer edits. The buffer is the only file you write while attached.
Writing the document itself bypasses the user's unsaved edits, so
every payload names the buffer path. Your own edits come back to you
only if the user includes changes not made by them.`
