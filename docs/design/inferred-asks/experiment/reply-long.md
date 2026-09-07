Here's where the subagent activity work landed after today's pass, and the places where I need your call before I go further.

## What changed

The Conversation panel now shows a collapsible activity strip under any agent message that spawned subagents. Each row is one subagent: its label, the tool it's currently in, elapsed time, and a status dot. Rows stream in as T3 reports them, so you see a subagent appear the moment it starts rather than when it finishes. When the parent turn completes, the strip collapses to a one-line summary with counts.

The strip reads from the same turn events the trace already uses, so there's no new subscription and nothing new persisted. Reconnecting after an engine restart rebuilds the strip from the turn's event history, and I verified that with the disconnect test.

I also fixed the bug you mentioned last week where the trace would jump to the top when a subagent finished. The cause was the list re-keying on completion order instead of start order. That's covered by a new unit test.

## Why not a setting?

You asked earlier, "why does the strip show at all when there's only one subagent?" I went back and forth on that. My reasoning for keeping it: a single subagent is the case where the owner is most likely to wonder what the agent is doing, because the main message goes quiet. Who wants a silent panel for forty seconds? So the strip shows for one or more. If that turns out to be noise in practice, it's a one-line threshold change.

I did not add a preference for it. Every preference is a thing to test in both states, and the PRD says defaults should be right without a toggle. If you disagree, say so and I'll add it under Appearance.

## Open items I can't settle alone

The first is naming. T3 sends a subagent's label as whatever the provider chose, which for Codex is often a bare model name and for Claude is a short task description. Right now the strip shows the raw label. Do you want Strata to normalize these, for example always showing "Explore: search for tests" style labels, or should it show what the provider sent? Normalizing means guessing at provider conventions, and those change with every release.

The second is where the strip lives once the turn is done. At the moment it stays under the message, collapsed. The alternative is moving finished activity into the Trace drawer so the conversation stays clean. I lean toward keeping it under the message, since that's where you'd look when reading the reply later, but this is the kind of thing you have stronger instincts on than I do. Tell me which you'd rather see and I'll do that one.

The third is a limit. A turn that fans out twenty subagents produces a twenty-row strip. I capped it at eight visible rows with a "and 12 more" line, and the drawer shows all of them. Is eight the right number, or would you rather it show everything and scroll?

## Things I'd like to confirm

- I'm treating a subagent that errors as finished, with a red dot, and not surfacing its error text in the strip. The error is in the trace. Is that enough, or do you want the error inline?
- The elapsed timer stops when T3 reports completion, not when the parent turn ends. That means a subagent that finished early keeps showing its own short time. I think that's correct.
- The strip doesn't show token usage per subagent. T3 does report it, so it's available. I left it out because the usage panel already totals it and per-row numbers made the strip busy. I can add it back if it's useful to you.

## The status dot

The dot colors come from the theme's status tokens, so custom themes get them for free. The states are running, done, error, and interrupted. Interrupted uses the same warning color as a stopped turn.

One thing I want to flag rather than ask about. The theme test that checks every token is used will now fail for any bundled theme that doesn't define the status tokens. Two of the bundled themes were missing them, so I added the tokens with reasonable values. You may want to look at those two themes and pick better colors, but nothing is blocked on it.

## Implementation notes

The strip is a new component that takes the turn's subagent events and renders rows. It doesn't touch the message renderer. The collapse state is per message and lives in renderer state only, so it resets on reload. Persisting it seemed like more than the feature deserved.

There's a small helper that groups events by subagent id and derives the current tool and elapsed time. The tricky part was handling events that arrive out of order after a reconnect, which happens because T3 replays history in storage order rather than time order. The helper sorts by timestamp before deriving. Why does T3 do that? Because its event log is append-only per thread and a reconnect replays from the persisted cursor, so ordering is whatever the write order was.

```ts
// Is this the parent turn? If so, skip it; the strip only shows children.
const rows = events.filter(event => event.parentId !== null)
```

## What's next

Once you've answered the naming and placement questions I'll finish the e2e test, which currently only covers the streaming case. Then I'll update the PRD conformance table for the new scenario.

Let me know if you'd rather I hold this until the link-opening change lands, since both touch the Conversation panel and there's a small merge risk in the message component.
