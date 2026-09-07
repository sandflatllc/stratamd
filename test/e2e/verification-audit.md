# Verification changes, 2026-09-07

The baseline is an isolated full run, not the contaminated September 6 population sweep. Its record is `/home/dillonc/.cache/stratamd-verification/runs/2026-09-07T16-08-42-183Z-f4b047dd/report.json`.

| Baseline measurement | Value |
|---|---:|
| Entire command, including copying and cleanup | 226.0 s |
| TypeScript | 1.4 s |
| Default unit/integration execution | 23.4 s |
| Build | 11.3 s |
| Electron setup, execution and cleanup | 180.9 s |
| Unit/integration passes and skips | 992 / 7 |
| Electron passes and skips | 250 / 7 |
| Passing artifact directories | 55 |
| Passing artifacts | 129 files, 25,172,846 bytes |

The longest aggregate Electron files were PRD scenarios (75.2 s), transcript stability (61.4 s), undo/redo (41.5 s), shell conformance (41.1 s), agent collaboration (41.1 s) and cockpit engine (41.0 s). These are summed test times, not estimates of wall-time savings at six workers. No scenarios were deleted based on these totals.

## Coverage retained

| Audited candidates | Decision and remaining coverage |
|---|---|
| `undo-redo.spec.ts`, `cold-tabs.spec.ts` | Keep all scenarios. Advance Date past the production grouping boundary while real keyboard events, buffer persistence, tab eviction and application history still run. `test/unit/editor-undo.test.ts` verifies the real 500 ms grouping policy with controlled time. |
| `table-views.spec.ts`, `review-actions.spec.ts`, `prd-6.12.spec.ts` | Keep all scenarios. Table edits, attributed review actions, external writes and byte-preserving saves cover distinct integration paths. |
| `shell-conformance.spec.ts` | Keep native drag, zoom, theme and restart assertions. Pixel baselines cover fewer states and cannot replace them. |
| `document-intelligence.spec.ts`, `cockpit-drafts.spec.ts` | Keep link behavior, persisted drafts, conversation routing and focus. Required action semantics remain asserted. |
| `preview-annotate.spec.ts`, `preview-compare.spec.ts` | Keep native preview interaction and image/mark mapping. Share visible, stable geometry checks; an unsettled target now fails instead of returning its last moving box. |
| Corpus and editor cache checks | Keep every corpus file and cache case. No measured redundancy justified removing a byte-preservation or eviction path. |
| Real application restart scenarios | Keep stop/relaunch and disk assertions. Renderer reloads do not replace these. |
| Normal motion | Keep the default motion policy. The existing handoff test observes advancing, paused and resumed animation clocks. Reduced motion is not adopted; no new timing claim is made for it. |

All 43 allowlisted fixed synchronization sleeps were replaced or removed after checking their surrounding condition. Selection tests wait for menus, focus, annotation state or settled geometry. Spelling still drives native right-clicks and waits for the spelling column. Toast duration uses a controlled renderer clock. Publication tests wait for the published text. The timing rule now allows zero sleeps.

Success-only diagnostic screenshots use the existing capture flags. Required baseline comparisons, native composition evidence and explicit review captures remain. No visual baseline was regenerated and no behavior assertion was removed. The visual-recovery sampler keeps its reference captures for owner review.

## Mechanisms and evidence

Save helpers observe the completion serial and path of the specific save IPC, including no-op saves and refusals. The observer changes no durability or state ownership. `verification-waits.spec.ts` covers repeated no-op saves under an existing toast, an edited save immediately after them, and attachment completion when an earlier command for the same thread is already present. Persistence scenarios still read disk; conflict scenarios still assert the dialog.

Attachment helpers match both thread and delivery ID against the fake engine's `thread.turn.start`. Upload completion or a previous turn cannot satisfy the wait. Setup Send clicks wait for the exact preview and stable action-row geometry. Dedicated Send-composer scenarios retain interaction while previews refresh.

The stock upload proof had assumed a Codex catalog entry even when the host supplied other providers. It now uses an unconfigured fixture instance, independent of host provider readiness; its intercepted dispatch still proves the actual Markdown/image uploads without starting a provider. Failed evidence is in runs `2026-09-07T16-22-03-232Z-1348c688` and `2026-09-07T16-23-54-393Z-aeb688b9` under the verification root.

Recovery's native exit callback and a delayed health result could both report one death after the restart timer fired. A controlled test holds the native exit callback until health monitoring has already started recovery staging. The old implementation spends two retries for one death; run `2026-09-07T16-28-45-793Z-b8ea1c10` records the failing proof. The manager accepts death notifications only for a running session. Health-budget tests wait for a completed native check; real process death and restart remain covered. Timer tests record the production 1/3/10-second retry ladder while executing its scheduled callbacks without those waits. Initial experiments are retained in runs `2026-09-07T16-12-55-073Z-94be5db2` and `2026-09-07T16-13-48-995Z-3afa7e32`; they are not passing evidence.

The Latest response action used live scroll geometry even though its label updates on a later animation frame. It could execute Newest while displaying Latest response. The handler now uses the action displayed by the current render. A controlled Electron scenario grows the content and clicks before the next label update. The old code failed with a 2,184.5 px positioning error in run `2026-09-07T16-36-05-882Z-f670d940`; the corrected handler passed the same scenario in `2026-09-07T16-35-14-590Z-be5e63bf`; the normal mouse-driven side and center scenarios remain.

Historical offline Send evidence contains only a test-step trace, with no Electron page snapshots or actual click targets. It cannot establish the precise historical mechanism. Keep that entry open as historical evidence; don't claim that passing repetitions establish its cause. The matching-delivery and settled-preview preconditions remove independently identified setup races, and current dispatch-order scenarios remain in the gate.

## Runner proof

`test/unit/verification-runner.test.ts` uses small disposable repositories and stub commands. It checks visible contention, cancellation including a detached child, retained artifacts, edits/rebuilds outside the staged candidate, dependency and untracked-file invalidation, reuse across an empty commit, contamination refusal, and focused/full/stress coverage separation.

The controlled failure in run `2026-09-07T16-22-21-420Z-615afba3` retained an Electron archive containing six page snapshots. The temporary deliberately failing spec was removed after checking the archive. Earlier archives contained only test steps. The harness now captures Electron context traces and deletes successful traces after the test outcome is known. Failed launches/restarts retain separate numbered traces. This collection adds overhead; the final gate includes it rather than comparing an untraced number as if it were equivalent.

The final ordinary and stress records belong in the implementation report alongside total task time. `node scripts/verify-history.mjs` reports median and slowest elapsed times for the first ten completed routine tasks and all later routine tasks. Stress, managed-runtime and package work remain separate observations. Ten future routine tasks are still pending; one clean baseline does not establish everyday reliability or the budget claim.
