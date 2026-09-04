# PRD conformance ledger

`docs/PRD.md`, draft v25 dated 2026-09-03, is the source of truth. This ledger maps the cockpit amendment and retains the full AGENTS.md gate as the release condition.

Verification keys:

- `U`: focused Vitest behavior test.
- `E`: Playwright Electron behavior test against the built application.
- `L`: localhost T3 server evidence.
- `I`: Vitest integration test over the real application with a fake engine.
- `M`: owner hardware/client evidence that automation on this workstation cannot create.
- `G`: complete AGENTS.md gate.

## Cockpit requirements

| PRD | Requirement | Verification |
|---|---|---|
| 1–3 | T3 is the required engine; Strata is the desktop cockpit; the file-only tool carries no agent traffic. | `U` `test/unit/engine-client.test.ts`; static removal audit; `G` |
| 5 | Engine/project/thread/turn/message/conversation/item/draft/delivery/anchor/block terminology and thread identity. | `U` engine, items, drafts, blocks suites |
| 6.5 | Draft isolation, materialization, item projection, decision-first ordering, Drafted/Reviewed/Revisit, and message anchors. | `U` `test/unit/drafts.test.ts`, `test/unit/items.test.ts`; `E` `test/e2e/cockpit-engine.spec.ts` |
| 6.6 | Attachments are document/thread links; engine states, Lead, Stop, Detach, and attach-only bootstrap. | `U` blocks and delivery suites; `I` `test/integration/cockpit-lead.test.ts`, `test/integration/cockpit-delivery.test.ts`; `E` `test/e2e/agent-collaboration.spec.ts` (Lead round, crown, Detach), `test/e2e/cockpit-drafts.spec.ts` |
| 6.7 | Delivery-as-turn, file attachment, persisted command id, message-sent acknowledgment, quick send, and first-delivery selection. | `U` `test/unit/engine-client.test.ts`, `test/unit/engine-live.test.ts` (every attached thread streams); `I` `test/integration/cockpit-delivery.test.ts`, `test/integration/session-serialization.test.ts`, `test/integration/main-application.test.ts`; `E` `test/e2e/prd-6.12.spec.ts` 1 and 12, `test/e2e/send-composer.spec.ts` |
| 6.8, 7 | File-only tool plus the one-page strata-block agent contract. | `U` `test/unit/cli.test.ts` byte comparison; packaged CLI test |
| 6.9 | Projects and Conversation, center tabs, Items and Documents, Attached, picker, notifications, shared disconnected state, Accounts modal. | `E` `test/e2e/cockpit-engine.spec.ts` (pairing, conversation, projects rows and notifications, accounts), `test/e2e/review-actions.spec.ts`, `test/e2e/decision-annotations.spec.ts`, `test/e2e/shell-round2.spec.ts`; `U` `test/unit/engine-accounts.test.ts`, `test/unit/engine-attention.test.ts`, `test/unit/engine-notifications.test.ts` |
| 6.11 | One paired T3 server over HTTP/WebSocket with an owner-only credential and no other app network. | `U` engine-client credential/mismatch/reconnect tests; renderer network-denial E2E |
| 13 | Cockpit rationale and rejected alternatives. | PRD review plus removal audit |

## §6.12 scenarios

Each row names the test file and test title that proves the scenario, or says the scenario is open and why. `I` is a Vitest integration test over the real application with a fake engine (`test/integration/support/cockpit.ts`); `E` cockpit tests run against the fake T3 in `test/e2e/cockpit-engine-harness.ts`, which serves HTTP snapshots and real WebSocket subscriptions.

| Scenario | Verification |
|---|---|
| 1 | `E` `test/e2e/cockpit-engine.spec.ts` "1 and 2 read side: disconnect is isolated and reconnect restores the active live conversation" and "1 pairing: host plus code pairs through the dialog, shows the server, and pairing again replaces the credential"; `E` `test/e2e/prd-6.12.spec.ts` "1. deliveries queued while the engine is down reach the thread in Send order"; `U` `test/unit/engine-live.test.ts` "a dropped socket shows Disconnected, and reconnect resubscribes once with no duplicate messages" |
| 2 | `E` `test/e2e/cockpit-engine.spec.ts` "2 conversation: moves between placements and dispatches a message, approval, user input, and Stop"; `U` `test/unit/engine-live.test.ts` "a streamed message appears in the view with no poll tick, token by token, and settles when streaming ends"; `U` `test/unit/engine-client.test.ts` "dispatches conversation turns, interruption, approvals, and user input with the T3 command contract" |
| 3 | `I` `test/integration/cockpit-delivery.test.ts` "applies valid strata entries, keeps a stale entry as a failure, and reports every outcome next turn"; `U` `test/unit/items.test.ts` "derives one decision-first checklist from annotations and hunks" |
| 4 | `E` `test/e2e/cockpit-engine.spec.ts` "4 inference: seven prose questions queue four keyed replies in one delivery and leave three open" and "4 explicit message item: completed agent prose has block ids and its posted item appears once"; `U` `test/unit/engine-conversation-state.test.ts` "four answers travel keyed by item id in one delivery, show Drafted until acknowledged, and survive a restart with a dismissal"; `U` `test/unit/inference.test.ts` |
| 5 | `E` `test/e2e/cockpit-drafts.spec.ts` "5 and 6: quick send carries one comment while held drafts stay private and return checked"; `E` `test/e2e/annotation-hotkeys.spec.ts` "a bare C opens the comment composer and Enter quick sends it"; `I` `test/integration/main-application.test.ts` "StrataApplication: drafts and quick send" |
| 6 | `E` `test/e2e/cockpit-drafts.spec.ts` "5 and 6: quick send carries one comment while held drafts stay private and return checked" and "an orphaned held draft stays out of preview and can be discarded" |
| 7 | `E` `test/e2e/cockpit-drafts.spec.ts` "7: active conversation is the sole default until Lead changes it"; `E` `test/e2e/agent-collaboration.spec.ts` "2. the full mode-3 round: brief, claim, denial, Lead accept and save, user Keep"; `I` `test/integration/cockpit-lead.test.ts` |
| 8 | `E` `test/e2e/cockpit-drafts.spec.ts` "8: Start thread from a document preselects its project and sends the pending comment, held draft, and document as the first turn" and "5.6: the active conversation in the same project is a recipient before it is attached, and the first Send attaches it"; "a held comment waits without a recipient: Hold keeps it private and Start thread is the only way out" |
| 9 | `E` `test/e2e/cockpit-engine.spec.ts` "8 and 9 projects: picker is project-scoped, row actions dispatch, and turn files stay closed in Documents" and "5.2 rows and notifications: pin, rename, and snooze go to T3, and a turn finishing elsewhere badges Projects and the thread until it opens"; `U` `test/unit/engine-client.test.ts` "projects markdown and code files from completed turn diffs without opening them"; `U` `test/unit/engine-notifications.test.ts` |
| 10 | `E` `test/e2e/prd-6.12.spec.ts` "12. an unacknowledged delivery survives close, restart, and the engine coming back"; `I` `test/integration/session-serialization.test.ts` "a delivery sent before close is acknowledged from the transcript on reopen, without a second turn" and "stores queued delivery payloads as objects by hash and restores them"; `U` `test/unit/engine-client.test.ts` "reuses a persisted command id until the matching message is visible after restart" |
| 11 | `M` open. Needs unchanged T3 mobile against a published-server process with a fresh pairing credential; this workstation's server runs from the fork AppImage and holds no unconsumed credential. Recorded in `docs/internals/cockpit-v1-scenarios.md`. |
| 12 | `U` `test/unit/agent-chat-contract.test.ts` against `test/corpus/messages/action-summary.md` |
| 13 | Strata half: `U` `test/unit/engine-live.test.ts` "a dropped socket shows Disconnected, and reconnect resubscribes once with no duplicate messages" and "a thread attached to a document streams too, so an agent block posted while another conversation is open still arrives"; `U` `test/unit/engine-client.test.ts` "publishes one disconnected state and recovers the same active conversation". Server half `L` open: a controlled restart of the owner's T3 process and a two-second Stop measurement over localhost were not available to automation. Recorded in `docs/internals/cockpit-v1-scenarios.md`. |
| 14 | `I` `test/integration/cockpit-delivery.test.ts` "applies valid strata entries, keeps a stale entry as a failure, and reports every outcome next turn" and "accepts an attach-only block from an unattached thread and starts its first delivery"; `U` `test/unit/blocks.test.ts` "keeps two valid entries when a stale or malformed sibling fails and reports all outcomes"; `E` `test/e2e/decision-annotations.spec.ts` "owner decisions keep choice, discussion, delivery, and edits separate" (outcomes by code in the next delivery) |
| 15 | `U` `test/unit/attribution.test.ts` "sends nothing for an unchanged certain own write, its diff after a change, and full text without certainty" |
| 16 | `U` `test/unit/attribution.test.ts` "labels a shared-root write external when two threads run and makes both first deliveries full"; `E` `test/e2e/prd-6.12.spec.ts` "14. one agent sees another agent edit only through changes or explicit inclusion" |
| 17 | `E` `test/e2e/cockpit-engine.spec.ts` "2 conversation: moves between placements and dispatches a message, approval, user input, and Stop"; `U` `test/unit/engine-client.test.ts` "dispatches conversation turns, interruption, approvals, and user input with the T3 command contract" |
| 18 | `E` `test/e2e/prd-6.12.spec.ts` "10. real corpus files no-op byte round-trip and strong edits stay local" |
| 19 | `E` `test/e2e/prd-6.12.spec.ts` "4. Save writes the shadow but leaves overlapped agent work pending" and "3. a mixed proposal confirms Revert and Keep preserves the user edit"; `E` `test/e2e/agent-collaboration.spec.ts` "6. save state is always visible: groups, the tab dot, the Save button, and the tinted total" |
| 20 | `E` `test/e2e/prd-6.12.spec.ts` "5. Save rechecks disk and stops for a racing external write"; `I` `test/integration/cockpit-lead.test.ts` "fails a Lead save against a disk conflict with SAVE_BLOCKED and changes nothing" |
| 21 | `E` `test/e2e/prd-6.12.spec.ts` "6. crash recovery offers Recover without replacing the newer buffer", "6b. undo walks later typing, the agent merge, and earlier typing in order", and "7. Discard on close removes buffer-only pending hunks on reopen" |
| 22 | `E` `test/e2e/prd-6.12.spec.ts` "8. renaming an open file moves its one session and ghost entry"; `I` `test/integration/main-application.test.ts` "StrataApplication: file identity and annotation relocation" |
| 23 | `E` `test/e2e/prd-6.12.spec.ts` "9. a mismatched suggestion becomes orphaned and cannot be accepted"; `E` `test/e2e/agent-collaboration.spec.ts` "5. an orphaned item keeps every affordance except the jump" |
| 24 | `E` `test/e2e/prd-6.12.spec.ts` "11. StrataMD mirror and Save writes do not create external review hunks"; `I` `test/integration/main-application.test.ts` "StrataApplication: the buffer, the mirror, and Save" |

Scenarios the cockpit retired, with the plan line that removed them: killing the agent CLI mid-flush and the Copy for agent baseline (plan §11 phase 5, "Removes: the socket server, the agent CLI, the attach wait registry, nudge, the `changed` command and tag expiry"; §5.7, "Copy for agent is retired when Start thread lands"), agent-to-agent messages and the attach loop (§13, "The attach loop is retired"), and the `changed` tag (§5.8, turn-diff attribution). Their tests were deleted with them; every other deleted test was restored on the thread-as-attachment model in the item 7 commit.

## Removals audit (2026-09-04)

`grep -rni "copy for agent\|nudge\|attach loop\|stratamd attach\|changed tag\|socket server\|agent CLI" src docs/PRD.md docs/PRD_CONFORMANCE.md docs/internals skills README.md AGENTS.md` finds only the English word "nudged" in two editor comments about caret placement. No code, test, skill, or doc text for the socket server, the agent CLI, the attach loop, nudge, Copy for agent, or the `changed` tag remains; `test/unit/cli.test.ts` covers the file-only CLI.

## Release use

From the repository root run exactly:

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/electron-vite build && xvfb-run -a ./node_modules/.bin/playwright test
```

Then run the cockpit removal audit and build the launcher target with `./node_modules/.bin/electron-builder --linux dir`. Open `M` or `L` rows are not converted into automated evidence by a green local gate.
