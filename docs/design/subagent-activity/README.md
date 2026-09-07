# Subagent activity clusters

Approved and implemented 2026-09-06 as PRD §6.9 Agents (`src/core/agent-activity.ts`, `src/renderer/components/AgentClusters.tsx`). This folder is the design reference; the cluster design is the owner's and Astra's, the depth-by-arc-length rule was added here. `prototype.html` is a static page; `capture.mjs` renders it to `captures/` with Playwright's Chromium (run from the repository root: `node docs/design/subagent-activity/capture.mjs`).

## What it is

Clusters in the conversation title row, right of the title and left of Find. Each cluster is a bot glyph ringed by up to six arc segments, one per agent, coloured by state. A seventh agent starts the next cluster. Arcs fill clockwise from the top in start order, with a parent's children right after it. A chevron after the clusters collapses them to one summary bot and expands them again. Clicking any cluster opens the Agents modal, which lists every agent as a tree with role, model, effort, elapsed time, tokens, tool uses, what it is doing now, and each finished agent's report.

## Implementation captures

`captures/implementation/` holds real Electron captures from the e2e harness with seven seeded agents: `header.png` and `header-zoom.png` show the two clusters in the center placement, `dialog.png` the Agents dialog with the inferred child indented under its parent, a failed run, and the reports. The elapsed times in them come from fixture timestamps, not real runs.

## States in `prototype.html`

| `?state=` | Shows |
| --- | --- |
| `clusters` | Six agents, one full cluster. Default. |
| `many` | A research run: 34 agents, six clusters, five full and one with four. |
| `hidden` | Collapsed by the chevron: one bot with a single breathing arc while work is alive. |
| `modal` | The modal open from a click on a cluster, with one agent highlighted. |
| `modal-many` | The modal over the 34-agent run, with the filter row. |
| `done` | Every agent finished. |
| `failed` | One agent failed. |
| `legend` | Arc colours, depth by arc length, the six main agents in slots, the collapsed form, the 34-agent row. |

## Arc vocabulary

- Working: grape, slow breathe.
- Done: teal.
- Waiting on you: amber. Only when the agent raised a question or an approval.
- Failed: pink. Stays until the next message you send.
- Depth is arc length, an addition for the owner to confirm: a level 1 agent fills its slot at 40 degrees, level 2 is 26, level 3 and deeper 14. The modal always states the level in words.

## Capacity

Each cluster is 30 pixels. Fifty agents take nine clusters and about 360 pixels of title row, which is what the row has before it crowds Find at the default window width. Past that the clusters collapse to the summary bot on their own and the modal carries the detail. In the side placement the row is narrower, so the collapse threshold is lower.

## Toggle

The chevron at the right end of the clusters. Open shows every cluster. Closed leaves one bot with a single breathing arc while any agent is working, and a plain bot when none is. The choice persists per window.

## Lifecycle

Clusters appear on the first agent start in a turn, their arcs turn teal as agents finish, and they clear when the next user message is sent. Threads without agents never show them.

## Where the data comes from

T3 records every subagent as `task.*` activities on the thread. StrataMD already receives them and turns them into the bot rows in the transcript (`src/core/work-log.ts`). The rail and modal read the same activities; no engine contract change is needed.

| UI element | T3 field on the `task.*` activity payload |
| --- | --- |
| Dot exists | `task.started` with `agentKind: "agent"` and `taskType: "local_agent"` |
| Working / done / failed | `status` on `task.updated` and `task.completed`: `running`, `idle`, `completed`, `failed`, `stopped`, `cancelled` |
| Title | `title` |
| Role chip | `role` |
| Model chip | `model` |
| Effort chip | `effort` |
| Running line | `detail` on `task.progress` plus `lastToolName` |
| Elapsed, tokens, tool uses | `usage.duration_ms`, `usage.total_tokens`, `usage.tool_uses`, or `typedUsage` |
| Report text | `summary` on `task.completed` |
| Error text | `error` or `summary` on a failed `task.completed` |
| Show in transcript | `toolUseId`, the id of the `Agent` tool call row already in the transcript |
| Background commands section | the same activities with `taskType: "local_bash"` |

## Depth is the one soft spot

Codex threads carry an `agentPath` such as `/root/diagnose_image_rendering`, so depth is exact there. Claude threads carry no parent id on the task activity. Depth has to be inferred: a `task.started` that arrives while a level 1 agent is running, and whose `toolUseId` is not one of the main thread's own tool calls, belongs to that agent. An agent the inference cannot place draws at level 1 and the modal says so. The local T3 database holds no nested Claude agents yet, so this needs one real nested run to confirm before implementation.
