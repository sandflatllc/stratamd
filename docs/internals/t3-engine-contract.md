# T3 engine contract for cockpit v1

Status: Phase 1 verified on 2026-09-03. September 9 runtime foundation updates below.

Strata is pinned to T3 source revision `fe96f7f2b7cb07da4fc7585f5869d58d2e592fd3` for the first cockpit integration. The vendored runtime-neutral schema slice is in `src/main/engine/t3-contract.ts`. It uses Strata's Zod dependency and imports no private T3 workspace package.

## Assumption results

| # | Plan assumption | Result | Evidence and consequence |
|---:|---|---|---|
| 1 | Turn events name changed files by path. Checkpoints use the thread worktree, the project folder in root mode, and no folder outside git. | Confirmed | `ThreadTurnDiffCompletedPayload.files` carries `path`, `kind`, `additions`, and `deletions`. `CheckpointReactor.resolveCheckpointCwd` calls `resolveThreadWorkspaceCwd`, which chooses `worktreePath` then `workspaceRoot`, and returns no checkpoint directory when `isGitRepository` fails. The worktree and project-root checkpoint tests passed. |
| 2 | Strata can choose the turn's message id and receive it back. | Confirmed | `ThreadTurnStartCommand.message.messageId` is client supplied. `ThreadMessageSentPayload.messageId` returns it. Dispatch receipts are keyed by `commandId`; replaying one `project.create` command returned the same sequence. |
| 3 | A message can carry a file attachment and providers can read its injected path. | Confirmed | `ChatFileAttachment` is accepted by `thread.turn.start`. `ProviderService.sendTurn` resolves every attachment into the server attachment directory and appends its absolute path to provider input. Adapters receive the attachment list too. The provider attachment-path test passed. No inline fallback is needed for the current provider set. |
| 4 | Completed agent messages have a stable message id. | Confirmed | Provider ingestion keys buffered assistant text by `messageId`, writes deltas with that id, and completes the same id. The canonical assistant-message completion test passed. `OrchestrationMessage` retains the id with `streaming: false`. |
| 5 | Live rate-limit fields appear in the thread stream. | Corrected | The raw `account.rate-limits.updated` event is consumed by `ProviderRuntimeIngestion` and deliberately does not append thread activity. It patches `ServerProvider.usage`, with `session` and `weekly` windows carrying `usedPercent`, `resetsAt`, `measuredAt`, and `source`. Phase 10 must read `server.getConfig` and `subscribeServerConfig`, not the thread stream. Those methods and the normalized usage schemas are included in the vendored slice. |
| 6 | T3 contracts cannot be installed after the fork is removed, so Strata must vendor a small slice. | Confirmed | `@t3tools/contracts` and `@t3tools/client-runtime` are private workspace packages. The vendored slice is one source file. It covers authentication, HTTP paths, orchestration snapshots and streams, cockpit commands and receipts, checkpoint files, attachments, and provider usage. Its contract tests and the Strata typecheck pass. |

## Calls exercised

The live HTTP calls used an isolated server on `127.0.0.1`, an external temporary data directory, and the cockpit worktree as its project. They did not read or change the owner's running T3 store.

| # | Call | Result |
|---:|---|---|
| 1 | `POST /oauth/token` with the server's one-time bootstrap credential | `200`; returned a scoped bearer session. |
| 2 | `POST /api/auth/pairing-token` with `orchestration:read` and `orchestration:operate` | `200`; returned a second one-time pairing credential. |
| 3 | `POST /api/auth/websocket-ticket` | `200`; returned a short-lived ticket for `/ws`. |
| 4 | `GET /api/orchestration/shell` before and after creating data | Both returned `200`; the second snapshot contained one project and one thread. |
| 5 | `POST /api/orchestration/dispatch` with `project.create` | `200`; returned a sequence receipt. Repeating the same `commandId` returned the same sequence. |
| 6 | `POST /api/orchestration/dispatch` with `thread.create` | `200`; the thread appeared in the shell snapshot. |
| 7 | `GET /api/orchestration/threads/strata-phase1-thread` | `200`; returned that thread's detail snapshot. |
| 8 | `/ws` `orchestration.dispatchCommand` and diff queries | Passed against the real Effect RPC server in `server.test.ts`. |
| 9 | `/ws` `orchestration.subscribeShell` with a completion marker | Passed; returned `synchronized` after catch-up. |
| 10 | `/ws` `orchestration.subscribeThread` with a completion marker | Passed; returned the snapshot followed by `synchronized`. |
| 11 | `/ws` `server.getConfig` | Passed; returned the server configuration used by the cockpit account surface. |
| 12 | `/ws` `subscribeServerConfig` | Passed; returned a snapshot and then the published provider update. |

## Focused engine evidence

This command passed 12 focused tests in four server suites:

```sh
env -u CLAUDE_CONFIG_DIR ./node_modules/.bin/vp test run \
  apps/server/src/server.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/orchestration/Layers/CheckpointReactor.test.ts \
  -t "serves snapshots for MCP handoff|persists token exchange client|issues short-lived websocket tickets|issues authenticated one-time pairing|routes websocket rpc orchestration methods|marks an empty shell catch-up|marks a socket thread snapshot|appends attachment file paths|patches Codex usage|maps canonical content delta|captures pre-turn baseline on turn.started|captures pre-turn baseline from project workspace root"
```

Two focused server-configuration checks also passed:

```sh
env -u CLAUDE_CONFIG_DIR ./node_modules/.bin/vp test run apps/server/src/server.test.ts \
  -t "accepts websocket rpc handshake with a bootstrapped browser session cookie|routes websocket rpc subscribeServerConfig streams snapshot then update"
```

The contract slice has its own parsing and correlation checks in `test/unit/t3-contract.test.ts`, including the exact shell projection returned by the exercised HTTP snapshot.


## September 9 runtime compatibility

The distribution now pins `0.0.41-nightly.20260909.1426` plus upstream replay fix #10777. Exact origin, transformation hashes and licenses live in `packaging/engine/`. The legacy phase 1 source revision above describes the original audit, not the current package.

The selected-thread subscription contract remains unchanged. Strata subscribes only to the selected conversation, threads attached to open documents, and active Ask work. Selection changes interrupt unused streams; reconnect restores only followed threads. `engine-live.test.ts` covers selection switching, document detachment, reconnect, streaming message accumulation and duplicate events. No broad all-thread subscription or renderer optimization was added.

New optional provider/command fields remain passthrough until their respective features consume them. Rich custom model objects affect provider patch validation and editor behavior, not settings reads; that belongs to the custom-model feature. Existing shell/thread/config parsers and the baseline client need no schema change for startup on this artifact.
