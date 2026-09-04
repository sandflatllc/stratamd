# PRD conformance ledger

`docs/PRD.md`, draft v25 dated 2026-09-03, is the source of truth. This ledger maps the cockpit amendment and retains the full AGENTS.md gate as the release condition.

Verification keys:

- `U`: focused Vitest behavior test.
- `E`: Playwright Electron behavior test against the built application.
- `L`: localhost T3 server evidence.
- `M`: owner hardware/client evidence that automation on this workstation cannot create.
- `G`: complete AGENTS.md gate.

## Cockpit requirements

| PRD | Requirement | Verification |
|---|---|---|
| 1–3 | T3 is the required engine; Strata is the desktop cockpit; the file-only tool carries no agent traffic. | `U` `test/unit/engine-client.test.ts`; static removal audit; `G` |
| 5 | Engine/project/thread/turn/message/conversation/item/draft/delivery/anchor/block terminology and thread identity. | `U` engine, items, drafts, blocks suites |
| 6.5 | Draft isolation, materialization, item projection, decision-first ordering, Drafted/Reviewed/Revisit, and message anchors. | `U` `test/unit/drafts.test.ts`, `test/unit/items.test.ts`; `E` `test/e2e/cockpit-engine.spec.ts` |
| 6.6 | Attachments are document/thread links; engine states, Lead, Stop, Detach, and attach-only bootstrap. | `U` blocks and delivery suites; `E` cockpit suite |
| 6.7 | Delivery-as-turn, file attachment, persisted command id, message-sent acknowledgment, quick send, and first-delivery selection. | `U` `test/unit/engine-client.test.ts`, delivery and application integration suites |
| 6.8, 7 | File-only tool plus the one-page strata-block agent contract. | `U` `test/unit/cli.test.ts` byte comparison; packaged CLI test |
| 6.9 | Projects and Conversation, center tabs, Items and Documents, Attached, picker, notifications, shared disconnected state, Accounts modal. | `E` `test/e2e/cockpit-engine.spec.ts`; existing shell suites |
| 6.11 | One paired T3 server over HTTP/WebSocket with an owner-only credential and no other app network. | `U` engine-client credential/mismatch/reconnect tests; renderer network-denial E2E |
| 13 | Cockpit rationale and rejected alternatives. | PRD review plus removal audit |

## §6.12 scenarios

| Scenario | Verification |
|---|---|
| 1–2 | `E` cockpit tests “read side” and “conversation”; `U` reconnect/dispatch tests |
| 3 | `U` items decision-first action projection; application strata-block integration |
| 4 | `U` seven-question corpus and keyed inference; `E` cockpit inference flow |
| 5–7 | `U` draft store, quick-send, recipient-selection and application integration tests |
| 8–9 | `U` engine create/files tests; `E` cockpit Projects/Documents test |
| 10 | `U` persisted command-id retry test and application acknowledgment integration |
| 11 | `M` recorded in `docs/internals/cockpit-v1-scenarios.md`; requires unchanged T3 mobile and a published-server process |
| 12 | `U` `test/unit/agent-chat-contract.test.ts` against `test/corpus/messages/action-summary.md` |
| 13 | `L` recorded in `docs/internals/cockpit-v1-scenarios.md`; requires paired localhost access and a controlled server restart |
| 14 | `U` `test/unit/blocks.test.ts`; application block-outcome integration |
| 15–16 | `U` first-delivery and certain/uncertain attribution tests |
| 17 | `U` engine user-input dispatch; `E` Conversation user-input action |
| 18–24 | Existing parser, serializer, save, recovery, rename, annotation, and mirror-write suites |

## Release use

From the repository root run exactly:

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/electron-vite build && xvfb-run -a ./node_modules/.bin/playwright test
```

Then run the cockpit removal audit and build the launcher target with `./node_modules/.bin/electron-builder --linux dir`. Open `M` or `L` rows are not converted into automated evidence by a green local gate.
