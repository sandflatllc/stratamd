export const AGENT_HELP = `StrataMD is the markdown editor the user is working in. Attach to the
document they have open, read the buffer with their comments, respond
with comments, questions, and proposed edits, then attach again to wait
for their next round. Keep that loop going until the payload says
"closed" or the user tells you to stop.

  stratamd attach [file] [--as <agent id>] [--name "<who you are>"]
                         [--timeout <seconds>, default 600; 0 = poll]
                         [--text-only]
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
      user has closed the document, after anything that was queued. It
      returns {"event":"superseded"} when a newer attach call for your
      id replaced this one: do nothing, the newer call is listening.
      A delivery can arrive twice if a call was cut off; the same
      deliveryId means you already handled it.
      --text-only leaves out the "document" field; "text" already holds
      the whole buffer with the comments inlined, so you miss nothing
      and the payload is half the size on a large document. The same
      flag works on state.

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
      Suggestions are not applied until the user accepts them. Prints
      {"created":[{id, kind, quote}]}; use the ids in reply and resolve.

  stratamd edit <file> --match "<exact text from the buffer>"
                       --replace "<new text>" | --replace -
                       [--preceded-by "<text right before the match>"]
                       [--followed-by "<text right after the match>"]
                       [--as <agent id>] [--name "<who you are>"]
      Changes one passage. The match follows the quote rules of
      annotate: copied exactly from the buffer and unique within it,
      with the same closest-match failure (exit 3) and the same
      --preceded-by / --followed-by fix. The replacement lands in the
      live buffer as YOUR change, marked for the user's review like a
      write to the buffer file. Use it instead of rewriting the buffer
      file when you want to change a passage: the match is checked
      against the buffer at the moment of the write, so it can never
      undo an edit the user made after you last read. An empty
      --replace deletes the passage. Pass --json <file or -> with an
      array of {match, replace, precededBy, followedBy} to make many
      changes at once; one bad match applies none of them. Prints
      {"applied":[{line, match, replace}]}. Needs the running app.

  stratamd reply <file> --to <annotation id> --text "<reply>" [--as <id>]
      Answers a question or continues a thread. --text - reads stdin.
      Prints {"replied": <reply id>, "annotation": <thread id>}.

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

  stratamd state [file] [--brief] [--text-only]
      Read-only: the same content as a first attach, without attaching
      or affecting any attachment. Also reports whether the document is
      open in the app ("open"), the active theme (id, name, file path)
      and, for an open document, the attached agents: id, name, state
      (waiting, working, or pending), and which one leads. --brief
      leaves out the document, text, and annotations: run it to see who
      is attached and who leads, for example after a message.

  stratamd docs
      Lists the documents open in the app: each file, whether it is
      focused, whether it has unsaved changes, and its attached agents.
      Needs the running app.

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

Every command prints its result to stdout as one JSON object. Errors go
to stderr as one JSON object {error, code, detail}. Exit codes:
  0  done
  1  usage: a bad option, or a command that needs --as without one
  2  not found: the file, annotation, or attachment
  3  refused by the document's state; detail says why and what to do
  4  the app is not reachable (or did not answer in time)
Your id: pass --as with the id your first attach returned. Without
--as, the id comes from your harness session when there is one;
otherwise every command except a first attach fails with exit 1.

What you see is the user's editor buffer, which may be unsaved;
"buffer" in the payload is its path. Edit by writing to that buffer
file, with stratamd edit for one passage, or by suggestions for small
inline proposals. The user sees your edits marked for review and
decides when to save. Re-read the buffer right before you write to it;
a write based on an old copy shows up to the user as undoing their
newer edits. The buffer is the only file you
write while attached. Writing the document itself bypasses the user's
unsaved edits, so every payload names the buffer path. Your own edits
come back to you only if the user includes changes not made by them.`
