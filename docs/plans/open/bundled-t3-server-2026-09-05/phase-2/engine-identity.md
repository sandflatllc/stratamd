# Engine identity inventory

Status: implemented. Unit, document integration, and managed Electron switching checks cover the boundaries below; final gate results are recorded in the phase report.

| Record | Location | Isolation rule |
| --- | --- | --- |
| Session credential and selected connection | engine-credential.json | Credential carries connection identity; each connection retains its credential. Root file selects the current one. |
| Pending commands and acknowledgments | engine-commands.json | Connection directory. Stop and drain the old client before switching. |
| Conversation comments, replies, preparations, dispatch receipts | engine-conversations.json | Connection directory. |
| Accounts, usage measurements, parking, favorites, hidden models, terminal selections | engine-accounts.json | Connection directory; no automatic carry-forward without signed-in identity matching. |
| Active thread, attention badges, visits | engine-reading.json | Connection directory. |
| Staged composer images | composer-attachments | Connection directory and matching renderer draft storage. |
| Document thread attachments, deliveries, processed messages, block maps, Lead | application sessions and document metadata | Archive attachments and Lead by connection; restore only the selected connection. Keep archived payload objects reachable by garbage collection. |
| Document annotations and edit attribution | annotation and segment history | Preserve document history. Stamp historical references with their original identity and omit navigation links when another engine is selected. |
| Composer drafts, selections, new-conversation target | conversationDrafts.ts localStorage and memory | Connection-prefixed storage; reload renderer on connection change before initializing the new storage scope. |
| Conversation reading positions | conversationReading.ts | Connection-prefixed storage. |
| Project order and collapsed/archive preferences | ProjectsPanel.tsx | Connection-prefixed storage. |
| Open conversation tabs, layout and top-bar pins | workspaceState.ts, topbarPins.ts | Connection-prefixed storage. |
| Held document comments | drafts.json | Shared document content with no recipient or engine id. A send requires a recipient selected in the current engine. |
| Socket, subscriptions, cursors, pending requests, provider models, command caches | T3EngineClient | Stop/drain and clear before loading another connection. |
| Document review undo and redo | application sessions | Clear on switch so an old annotation inverse cannot restore an unscoped conversation reference. |
| Document dispatch keys and followed-thread cache | StrataApplication | Clear only after outstanding document turns finish; include selected identity. |
| Terminal attachment and generated launchers | T3EngineClient and account-shims | Detach old stream; regenerate launchers only from selected connection. |

Managed identity uses the server's persisted environment id, which survives port changes. External identity uses the authenticated environment descriptor when supported. Older servers initially use origin; renewal retains that identity only if the prior credential still authenticates. An unrecognized replacement at the same origin receives a fresh identity. Legacy records remain with their original connection. Missing identity must never mean permission to replay old work on a managed engine.

Verification: `engine-identity.test.ts` proves queued command separation; `engine-document-identity.test.ts` proves queued document delivery and Lead isolation through a restart and return; `conversation-drafts.test.ts` proves colliding thread/project draft isolation. `managed-engine.spec.ts` verifies automatic startup, crash recovery, external switching with credential retention, and app-crash adoption. `managed-process.test.ts` verifies exclusive ownership and competing stale-lock recovery. Archived attachment payloads remain referenced by the document store garbage collector.
