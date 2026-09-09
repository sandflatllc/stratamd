# Sent comments verification

Status: passed.

Sent messages display each saved passage and the exact response beneath it. Accompanying notes remain visible. View passage opens the frozen context, highlights the selection, and restores focus on dismissal. Earlier messages recover their comments from the matching attachment and retain the recovered copy across restart.

The centered view uses 17px conversation text; the sidebar uses 15px and its full available message width. Both scale with the pane zoom.

## Final gate

- TypeScript: passed.
- Unit/integration: 1,100 passed; 11 managed/packaged checks skipped.
- Production build: passed.
- Electron: 276 passed; 9 managed checks skipped.
- No failed or retried tests.

Full gate command: 354.6 seconds. Verification task including focused checks, the earlier full gate, visual review, corrections, and gaps: 1304.1 seconds.

[Full evidence](/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T22-32-40-353Z-14f9c448/report.json)

## Visual review

[Centered conversation](implemented/center.png) · [Sidebar](implemented/side.png) · [Original passage](implemented/passage.png)

Manual inspection caught response text inheriting the 12px message wrapper and excessive indentation in the narrow sidebar. The final stylesheet corrects both. Electron regression checks now assert the response text size in both placements. A focused capture run passed after those corrections, followed by the clean full gate above. The first manual capture script used an incorrect API method; setup was corrected to use the actual Send button. This was a capture-script error, not an app failure.

## Timing

The final ordinary Electron tests account for 1795.6 aggregate test seconds. At the required six ordinary workers, their measured work alone needs at least 299.3 seconds. This accounts for the gate exceeding the provisional four-minute target; no timeouts or retries occurred. Worker counts and test budgets were unchanged.

The routine-task sample currently contains 4 completed tasks, with a median of 733.0 seconds and a slowest total of 1304.1 seconds. Stress, managed-runtime, and packaging tasks are excluded. Six more routine observations are needed before the first-ten review.

## Skipped checks

| Suite | File | Check |
| --- | --- | --- |
| unit | engine-upgrade.test.ts | folder replacement upgrades and preserves identity and settings |
| unit | engine-upgrade.test.ts | rollback archives newer work and persists the restored runtime selection |
| unit | engine-upgrade.test.ts | a persisted runtime selection remains pinned across restart |
| unit | engine-upgrade.test.ts | a failed update recovers the previous engine and settings and archives the failed work |
| unit | engine-upgrade.test.ts | an interrupted transition archives changed data before recovering the matching backup |
| unit | managed-attachments.test.ts | uploads Markdown and an image through the stock engine before dispatch |
| unit | managed-connections.test.ts | stock pairing links and sessions revoke independently, local Connect stays signed out, and explicit LAN restart retains the environment |
| unit | managed-connections.test.ts | stock Connect exposes a loopback callback, accepts code fallback over pipes and cancels without saving authorization |
| unit | managed-engine.test.ts | starts the unmodified bundled server, pairs automatically, and stops only its owned child |
| unit | managed-settings.test.ts | stock settings survive engine restart and actual host/client signals enforce background policy |
| unit | packaged-cli.test.ts | packaged CLI runs from the packaged build and setup links that packaged executable |
| electron | computer-controls.spec.ts | This computer manages real pairing links and login choices in an isolated stock environment @managed |
| electron | computer-controls.spec.ts | This computer persists the tray choice and stops its owned engine on window close @managed |
| electron | connect-setup.spec.ts | Settings guides account authorization, download consent and device handoff while cloud readiness arrives later @managed |
| electron | engine-recovery-bindings.spec.ts | engine rollback restores an existing document conversation link and Lead without starting an agent turn @managed |
| electron | engine-recovery.spec.ts | restoring through This computer keeps newer document text and restores matching account preferences @managed |
| electron | managed-engine.spec.ts | external connection switches to the managed engine with separate drafts and a retained credential @managed |
| electron | managed-engine.spec.ts | an app crash adopts only its surviving authenticated engine @managed |
| electron | managed-engine.spec.ts | managed tray close retains a preview form and its capture @managed |
| electron | managed-engine.spec.ts | opens documents immediately, connects locally, restarts after a crash and retains identity |

The checkout production output was rebuilt after final verification. The owner installation was updated in the follow-up below; the running app was not restarted.

Final reporting at 2026-09-08T22:40:21.523623+00:00. Elapsed from first verification invocation through final reporting and the checkout rebuild: 1410.7 seconds.


## Package and launcher update

At Dillon's request, the packaged gate passed on the same product code. Both packaged CLI checks passed with no skips or retries, and package integrity passed. The command took 60.9 seconds.

[Package evidence](/home/dillonc/.cache/stratamd-verification/runs/2026-09-09T00-50-36-675Z-85a773dc/report.json)

The verified package was copied into `/home/dillonc/Projects/StrataMD/release/sent-comments-2026-09-08`. Its complete fingerprint matched the tested package before installation. Setup updated the desktop entry and `/home/dillonc/.local/bin/stratamd` to that release's `linux-unpacked/stratamd`. The installed command executed successfully. Setup reported no warnings. The previous desktop entry is saved beside the new package.

The existing running app was left open. Restart StrataMD to load this build.
