# Cockpit phase 2 evidence

Status: Phase 2 complete on 2026-09-03.

Held comments are private drafts in `drafts.json`, an owner-only atomic file beside the existing ghost files. They do not enter `reading.json`, `meta.json`, the buffer, command state, or a delivery until Send materializes a selected draft as an annotation.

## Acceptance scenarios

| # | Scenario | Evidence |
|---:|---|---|
| 5 | Enter quick sends one comment. Two held drafts remain private and render dashed. Unsent edits and events survive a quick send. | `test/integration/main-application.test.ts` closes and reopens between quick send and preview, then proves the pending edit and earlier event remain while the quick comment does not return. `test/e2e/cockpit-drafts.spec.ts` covers the batching case and also verifies the one-comment delivery, no delivery to the unselected thread, no held text in command state or the buffer, two dashed highlights with `draft` chips, and the Contents count. |
| 6 | An unchecked draft remains a draft and returns checked next time. | The same browser test unchecks one of two drafts, sends the other, reopens Send, and finds the remaining draft checked. The integration test closes and reopens the document before checking the remaining draft. |
| 7 | The Lead is the only default, otherwise the active conversation is. A second recipient takes a deliberate click. | The browser test checks both popover states, promotes the other thread to Lead, opens Send with only the Lead selected, clicks the second pill, and confirms both deliveries. Recipient selection has focused unit coverage in `test/unit/send-composer.test.ts`. |

## Storage and interaction checks

| # | Check | Evidence |
|---:|---|---|
| 1 | Draft anchors relocate and orphan without mutating text. | `test/unit/drafts.test.ts` |
| 2 | The draft file is atomic and mode `0600`. | `test/unit/drafts.test.ts` |
| 3 | Malformed reading state cannot discard drafts. | `test/integration/main-application.test.ts` |
| 4 | IPC validates Hold, discard, quick send, and selected draft ids. | `test/integration/main-ipc.test.ts` |
| 5 | The stale-preview token still guards Send after draft materialization. | Draft preview and Send use the existing document token path in `StrataApplication`; the integration scenario sends with the returned token. |
