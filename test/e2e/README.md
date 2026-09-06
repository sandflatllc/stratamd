# PRD acceptance suite

`prd-6.12.spec.ts` has one black-box test for each document scenario in PRD §6.12; `cockpit-engine.spec.ts` and `cockpit-drafts.spec.ts` cover the engine scenarios. The tests launch the built Electron main process and inspect only visible UI, `window.strata.getState()`, document/buffer files, and what the fake engine received. Agents are T3 threads served by `cockpit-engine-harness.ts` (HTTP snapshots plus a real WebSocket subscription server); a test attaches a thread by sending the document to it and drives agent actions by posting an assistant message with a strata block through `postAssistant` (helpers in `cockpit-agent.ts`). A delivery is a `thread.turn.start` command whose uploaded attachment the harness keeps by id.

Each test gets separate `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_RUNTIME_DIR` paths in its own temporary directory outside the repository — deliberately not under Playwright's output directory, which Playwright deletes at the start of every run and would yank a running app's store out from under a concurrent run. It never opens or changes the corpus originals or the owner's normal StrataMD store.

The suite runs on Linux and macOS. On Linux, run it under `xvfb-run` so app windows do not steal focus; on macOS it runs directly — no display layer exists or is needed. The harness handles the platform differences: it passes X11/ozone launch arguments only on Linux, sets `STRATAMD_USER_DATA` so each scenario gets its own Electron profile and single-instance lock (Electron only derives these from `XDG_CONFIG_HOME` on Linux), and exports key helpers (`primaryKey`, `documentStartKey`/`documentEndKey`, `lineStartKey`/`lineEndKey`, `selectToLineEndKey`) that map to Ctrl/Home/End on Linux and the Command-key equivalents on a Mac. Specs use the helpers instead of literal `Control+...` or `Home`/`End` presses, which do not move the caret on macOS.

The UI contract used by the suite is semantic:

- source textbox: `Source editor`
- visual contenteditable: `Document editor`
- dialogs named by their visible headings
- real buttons for Save, Send, Start thread, Keep, Revert, Accept, close-tab, recovery, and conflict actions
- per-item checkboxes under the heading `Changes not made by you`

These names follow the PRD and design handoff and make the same controls available to keyboard and assistive-technology users.

## Scheduling

`playwright.config.ts` splits the suite into two projects that run in one invocation:

- `ordinary` runs every untagged test, in parallel at the individual-test level: six workers on a Linux workstation, two on Linux CI.
- `clipboard` runs the tests tagged `@clipboard` one at a time on a single worker.

On a Mac the global worker count is one, so the two projects run one after the other: a Mac has one desktop, one focus, and one clipboard, and two Electron apps on it would compete for both.

### One X display per worker

Every launch of the app ends with the main process focusing its window. On one X display with no window manager that takes focus from every other Electron window; the top bar and path context menus close on `blur`, so a test with a menu open loses it the moment another worker's app appears. That, not pointer clamping, was behind the "pointer and hover" flakes that led to the suite being run serially on 2026-09-03.

`test/e2e/display.ts` is the Playwright global setup. On Linux with more than one worker it starts one `Xvfb` per worker slot at 2560x1600 (larger than any window a spec asks for), publishes the display list in `STRATAMD_E2E_DISPLAYS`, and stops the servers at teardown. `Scenario.create` sets `DISPLAY` for its app from that list by the worker's `parallelIndex`, so at most one app window exists on any display. The outer `xvfb-run -a` in the gate command stays; it keeps the command shape and costs one idle server.

Setup never falls back to the shared display: if Xvfb cannot start, the run fails naming the serial command. A supplied `STRATAMD_E2E_DISPLAYS` must list at least one display per worker, and the harness refuses a multi-worker run without a list. Because X selections belong to a display, the isolation also separates the clipboard on Linux; the `@clipboard` tag stays because macOS still shares one.

### Clipboard tag

Every Electron app on the display shares one operating-system clipboard; separate profiles do not isolate it. Any test that reads or writes the native clipboard carries the tag, including Electron's `clipboard` module, Ctrl/Command+C, X, or V, the editor's Copy, Cut, and Paste menu items, and Copy full path. Put it next to the title:

```ts
test('explorer tabs copy full paths', { tag: '@clipboard' }, async ({}, testInfo) => {
```

`test/unit/e2e-clipboard-tags.test.ts` fails when a test touches the clipboard without the tag, or carries the tag without touching it. The `@` in the config's grep pattern is load-bearing: Playwright matches the project name too, so a bare `clipboard` pattern would select every test in that project.

### Worker counts and what "serial" means

The total worker count is the ordinary count plus one, so the clipboard project keeps moving beside the ordinary one. `STRATAMD_E2E_WORKERS=<positive integer>` changes the ordinary count for measurements or unusual machines; it is not a serial run, because the clipboard worker still runs beside it. `--workers 1` on the command line caps the whole run and is the serial pass; it keeps the caller's display and needs no isolation. Do not raise a test timeout to absorb contention; lower the worker count instead.

Screenshot baselines keep their project-free names (`<name>-linux.png`) through an explicit `snapshotPathTemplate`, so `--update-snapshots` writes the same files as before.

## Writing a spec that holds up

Every flake traced on 2026-09-05 had a mechanism, and they fell into three kinds. Write against all three.

- **Stale closures behind window listeners.** `App.tsx` registers its keydown handler in an effect whose dependencies include the view. After a state change React commits the DOM first and re-registers the listener in a passive effect later, so a key that lands in between runs the previous closure: tab cycling stopped on the tab that was already active, and the source toggle flipped back to the old mode. A spec that presses a shortcut right after asserting the result of the last one is the exact shape that finds this. The product reads such state through refs kept current in `useLayoutEffect`; if a new shortcut misbehaves only under load, look there first.
- **Reading a layout that is still settling.** The history keeps the reading position stable from a `ResizeObserver` when content above the anchored row grows, which fires a frame after the growth. A baseline read in that frame is off by exactly the growth (34 px in the case that failed). Read a position twice across two animation frames and accept it only when it holds; `conversation-comments.spec.ts` shows the shape. Never replace this with a sleep.
- **Hangs that hide inside a budget.** A launch that never comes up or a close the app declines used to run out a two-minute budget in silence. Budgets stay at one minute or under and the harness bounds every close at five seconds, verifies the process exited, and kills it otherwise, so a hang costs seconds and leaves a trace.

Shared setup helpers wait for their result: `selectNavigationTab` waits for the selected tab and visible panel after the reading-state IPC update; `openThread` waits for the requested conversation to be visible after delayed navigation. Use these helpers before reading coordinates or acting on the opened conversation. An upload completing does not mean its turn was dispatched; assert the command separately before posting a fake reply.

Rules the unit tests enforce: `test/unit/e2e-timing-rules.test.ts` fails on a fixed sleep beyond the per-file allowance and on a budget above one minute; `test/unit/e2e-clipboard-tags.test.ts` keeps the clipboard tag honest. When you remove a sleep, lower the allowance in the same change.

A stress pass before a merge that touched the shell or the harness: `STRATAMD_E2E_WORKERS=8 xvfb-run -a ./node_modules/.bin/playwright test --repeat-each 2`. Local retries stay at zero so a race is seen, not absorbed.

## Known flakes

Bundled-engine login-file polling, 2026-09-06: the interrupted phase 6 startup repeat run passed 57 of 60 checks. Three failures in `computer-controls.spec.ts:6` were immediate `ENOENT` errors at the start-at-login file read, before the asynchronous save created it. `expect.poll` does not retry a throwing callback. The callback now returns an empty value for `ENOENT` while preserving other errors. Artifacts are saved in `docs/plans/open/bundled-t3-server-2026-09-05/phase-6/failed-startup-repeats/`; exact-line repeats and subsequent gate results are recorded in the phase 6 report.

Bundled-engine phase 6 startup, 2026-09-06: a full run passed 193 ordinary/clipboard tests and timed out all six managed checks during runtime staging (`computer-controls.spec.ts:6`, `engine-recovery-bindings.spec.ts:9`, `engine-recovery.spec.ts:7`, `managed-engine.spec.ts:9`, `:36`, `:60`). A concurrent full package build and fresh-profile proof competed for filesystem work. Its package startup also exceeded the unchanged bound, then passed alone. Saved results are `docs/plans/open/bundled-t3-server-2026-09-05/phase-6/failed-full-2/`. Integrity verification issued 19,230 sequential filesystem reads; bounded concurrency of eight reduced the isolated verification sample from 3.8 seconds to 1.2 seconds without skipping checks. Corrupt-file and escaping-link regression tests cover refusal. Exact-line repeats and subsequent full/stress results are in the phase 6 report. Package building/probing is now separate from Electron runs.

Bundled-engine phase 6, 2026-09-06: the first full run passed 197 tests and failed `engine-recovery.spec.ts:7` at backup selection. The implicit label included its select-option text, so the exact label lookup never resolved. The control now has an explicit accessible name. Saved results are `docs/plans/open/bundled-t3-server-2026-09-05/phase-6/failed-full-1/`. A prior targeted run caught the test polling across the intentional engine-identity renderer reload; readiness polling now retries that navigation. Exact-line repeats and a new full run are required before signoff.

- 2026-09-06, bundled-server phase 3: `provider-settings-fields.spec.ts:77` used an ambiguous `summary` locator that matched the generated-model disclosure and its nested Other models disclosure. The selector now names the direct disclosure. In the same run `view-sync.spec.ts:5` recurred: `setSource` had left Source open, so the first visibility check could pass before either asynchronous shortcut completed. The test now establishes Visual before testing Source → Visual. Two subsequent repeats reached the next fill before the asynchronous main-process mode echo finished; it now waits for the acknowledged mode and DOM across two animation frames. Those artifacts are in `phase-3/failed-second-repeat/`. These mechanisms were diagnosed; saved artifacts are in `docs/plans/open/bundled-t3-server-2026-09-05/phase-3/failed-full-2/`. Repeat and full-run evidence is in the phase 3 report.

- 2026-09-06, bundled-server phase 3: `frameless-window.spec.ts:10` failed because its exact menu list omitted the new Settings item. The first correction also placed Settings after Accounts, while the actual menu places it before Accounts. Both failures were deterministic assertion drift. Saved artifacts: `docs/plans/open/bundled-t3-server-2026-09-05/phase-3/failed-full-1/` and `failed-menu-repeat/`. The final assertion matches the implemented order; repeat and full-run results are in the phase 3 report.

A test that fails in a full run and then passes ten explicit repeats is recorded here, not cleared. A test listed twice is fixed or rewritten before the next feature. Keep the saved `test-results/` copy for each entry until it is closed.

| Test | Seen | Evidence | Status |
|---|---|---|---|
| `shell-keyboard.spec.ts` tabs cycle from the keyboard | 2026-09-03 twice (cockpit-v1 gate runs), 2026-09-04 (serial run beside the clipboard worker), 2026-09-05 twice (full runs at four workers on isolated displays) | Passed 20 of 20 alone and 20 of 20 inside a four-worker run, then failed in two of three full runs. Traces showed the app still on the previous tab after a shortcut sent right after a switch: the tab list read by the keydown listener was the one from before the switch, because the listener re-registered in a passive effect after the DOM had already updated, and cycling from the stale list landed on the tab that was already active. `App.tsx` now reads the tab list through a ref kept current in a layout effect. | Fixed 2026-09-05 |
| `table-views.spec.ts` a blank header cell accepts table state and survives reopen | 2026-09-03 (cockpit-v1 gate run) | Hover to leave the table. Passed 20 of 20 inside a four-worker run and nine full runs on isolated displays on 2026-09-05. | Open; watching after display isolation |
| `workspace-restore.spec.ts` losing the layout preference returns to the centered default, and a file named on launch takes focus once | 2026-09-04 (the chained form), 2026-09-05 (four-worker full run and parity eight-worker stress run) | Close was previously bounded in the harness. The stress recurrence hung on Open in center after launch. Its screenshot shows the document correctly restored with Projects selected; that button lives in the hidden Conversation panel. The spec had waited for thread text, which also exists while hidden, before stopping during delayed navigation. It now waits for the side panel to become visible and explicitly selects Conversation before using its control after launch. Earlier artifacts: `/tmp/stratamd-e2e-timing/results-2-w4/`; recurrence: `/tmp/strata-parity-results-stress-20260905/`. | Fixed 2026-09-05; clean full suite |
| `conversation-comments.spec.ts` owner holds and sends a rich message passage in center | 2026-09-05 (two of four full runs, then 2 to 3 of 10 targeted repeats at six workers, 7 of 15 with scroll hooks installed) | Hooking every scroll write on the viewport showed the sequence: the spec read its baseline, and 30 ms later the history's ResizeObserver moved the viewport 34 px to keep the anchored row stable after content above it grew. Back to reading then restored that later position correctly. The product was right; the spec measured a transient. The baseline is now read only once it holds across two frames. Separately, each rich message re-ran its jump-to-target layout effect on every editor mount while the target outlived the navigation, so a remount could re-center the passage; `ConversationMessage.tsx` now jumps once per navigation serial. 20 of 20 after both. | Fixed 2026-09-05 |
| `shell-round2.spec.ts` an item focuses its reply and hands focus back on close | 2026-09-05 (six-worker full runs, then 1 of 10 instrumented repeats) | The item mounts before the Conversation tab selection returns over IPC. A focus probe captured the failed Reply focus with `hidden: true` and height 0; its one-shot frame never tried again after the tab appeared. `ItemPanel.tsx` now focuses when the panel becomes visible, with opener restoration kept separate. Original recurrence: `/tmp/strata-parity-results-reply-focus-20260905/`; probe trace: `/tmp/strata-parity-results-focus-probe-20260905/`; focus calls: `/tmp/strata-parity-focus-probe.log`. | Fixed 2026-09-05; clean full suite |
| `view-sync.spec.ts` a busy session merges every update without divergence | 2026-09-05 (one of three full runs, then 1 of 10 alone) | The document editor never came back after two source toggles. The toggle shortcut read the document from the keydown listener's previous closure and toggled from the old mode, the same passive-effect gap as tab cycling. `App.tsx` reads the active document through a layout-effect ref. 20 of 20 after the fix. | Fixed 2026-09-05 |
| `cold-tabs.spec.ts` 3. scroll position is restored after a switch | 2026-09-05 (one of three full runs at six workers, then the parity full run) | The restored offset was 0 after a cold switch. The old document's passive scroll listener can outlive the tab commit and record a collapsed pane against that document. `EditorPane.tsx` now guards recording with the current document path, updated in a layout effect. Ten explicit repeats passed. Original results: `/tmp/stratamd-e2e-timing/results-d1-w6/`; recurrence: `/tmp/strata-parity-results-reading-races-20260905/`. | Fixed 2026-09-05; clean full suite |
| `spellcheck.spec.ts` right-click corrects a misspelling through the annotate menu and learns new words | 2026-09-05 (one of three full runs at six workers) | A column expected hidden after a fixed 1 s sleep was still visible. The spec has six fixed sleeps; replacing them with condition waits is the first thing to try. Results under `/tmp/stratamd-e2e-timing/results-d1-w6/`. | Open |
| `conversation-comments.spec.ts:6` owner holds and sends a rich message passage in side (missing completed turn) | 2026-09-05 parity full run | The fixture waited for attachment upload, then finished the reply before the later `thread.turn.start` dispatch could arrive. That dispatch changed the stopped session back to running, hiding the completed-turn toggle. The spec now waits for dispatch before posting the fake reply. Ten repeats each in side and center passed. Results: `/tmp/strata-parity-results-reading-races-20260905/`. | Fixed 2026-09-05; clean full suite |
| `projects-order.spec.ts:5` project folders reorder by drag and keyboard | 2026-09-05 parity eight-worker stress run | `boundingBox()` returned null while the Projects tab selection was still travelling through IPC. The preceding text and attribute assertions also pass on hidden panels. The shared `selectNavigationTab` harness helper now waits for the selected state and visible panel before the spec reads drag coordinates. Results: `/tmp/strata-parity-results-stress-20260905/`. | Fixed 2026-09-05; clean full suite |
| `cockpit-drafts.spec.ts:163` the first Send attaches the active conversation | 2026-09-05 parity eight-worker stress run | The turn command was still undefined after upload finished: upload precedes dispatch. The command assertion now polls for the actual turn. Results: `/tmp/strata-parity-results-stress-20260905/`. | Fixed 2026-09-05; clean full suite |

| `cockpit-engine.spec.ts:8`, `engine-dialog.spec.ts:5`, `managed-engine.spec.ts:9` | 2026-09-05 bundled-engine first full run | Identity reload lost the pairing dialog; renewal was incorrectly treated as switching; a summary selector became ambiguous; the crash assertion preceded durable manager readiness and clicked behind the recovery dialog. Each mechanism is corrected. Thirty targeted repeats passed. Saved artifacts: `/home/dillonc/Projects/StrataMD-wt/bundled-t3-server/docs/plans/open/bundled-t3-server-2026-09-05/phase-2/failed-full-1/`. | 190-test full gate and 380-check stress pass |
| `managed-engine.spec.ts:35`, `managed-engine.spec.ts:59` | 2026-09-05 bundled-engine second full run | Managed startup exceeded its existing bound under filesystem load. Staging now uses the platform directory-copy command while retaining relative symlinks. Saved artifacts: `/home/dillonc/Projects/StrataMD-wt/bundled-t3-server/docs/plans/open/bundled-t3-server-2026-09-05/phase-2/failed-full-2/`. | Adoption and corrected switching each passed ten repeats; full 190 and stress 380 pass |
| `edge-cases.spec.ts:92`, `visual-components.spec.ts:62`, `send-composer.spec.ts:136` | 2026-09-05 bundled-engine stress run | Saved artifacts: `docs/plans/open/bundled-t3-server-2026-09-05/phase-2/failed-stress-1/`. Another worktree ran its full Electron suite concurrently; host load reached 49 on 16 CPUs. Large-document readiness and the visual save observation timed out. The save failure remains an open bug until reproduced with diagnostic evidence. Send-composer had a diagnosed ambiguous recipient selector matching review rows; it now uses an exact accessible name. | Thirty repeats, full 190, and stress 380 pass; save observation remains recorded as an open bug |
| `annotation-table-comment.spec.ts:10`, `managed-engine.spec.ts:9`, `:35`, `:59` | 2026-09-05 bundled-engine third full run | Concurrent worktree full suites again saturated the 16-CPU host. All managed assertions passed before their cleanup exceeded the test budget; the table selection menu timed out. Saved artifacts: `docs/plans/open/bundled-t3-server-2026-09-05/phase-2/failed-full-3/`. Lowered ordinary worker default from six to four per the load rule. Cold runtime staging also avoids loading native modules twice after an atomic rename. | Forty repeats, full 190 at four ordinary workers, and stress 380 at eight pass |
| `cockpit-engine.spec.ts:155` | 2026-09-05 bundled-engine four-worker run | A reply save completed after the next item composer opened and unconditionally cleared its target/text. The reply draft is now one state object; completion only clears the exact submitted object, preserving any subsequently opened or edited draft. Saved artifacts: `docs/plans/open/bundled-t3-server-2026-09-05/phase-2/failed-full-4/`. | Ten repeats, full 190, and stress 380 pass |

The 2026-09-05 parity run also caught a deterministic expectation mismatch in `frameless-window.spec.ts:10`: the menu assertion still listed four actions after Usage and Terminal were added. The expectation now includes both actions; ten explicit repeats passed. This was an outdated assertion, not a timing failure. Original artifacts: `/tmp/strata-parity-results-menu-expectation-20260905/`.

Parity verification on 2026-09-05: the combined code passed TypeScript, 830 unit/integration tests (one existing skip), and all 187 Electron tests at the default worker count. Each failure above received explicit repeats and a documented fix. The owner waived further stress testing after the clean full run. Final logs: `/tmp/strata-parity-harness-{types,unit,build,e2e}.log`.

## Commands

Bundled-engine phase 6 final verification, 2026-09-06: all ten corrected login-file repeats passed, followed by TypeScript, 858 unit/integration tests, a rebuilt app and a clean full run of 199 Electron tests at the default worker count. The eight-worker run with `--repeat-each 2` passed all 398 checks. No local retries or timeout increases were used. Logs and the rebuilt Linux package proof are recorded in `docs/plans/open/bundled-t3-server-2026-09-05/phase-6/report.md`.

Commands, from the repository root:

```sh
./node_modules/.bin/playwright test --list
./node_modules/.bin/electron-vite build && xvfb-run -a ./node_modules/.bin/playwright test
```

To time a change, build once and keep compilation out of the number; store the report outside the repository:

```sh
./node_modules/.bin/electron-vite build
xvfb-run -a ./node_modules/.bin/playwright test --reporter=list,json 2>&1
# repeat the clipboard tests alone, ten times each, to prove they never overlap
xvfb-run -a ./node_modules/.bin/playwright test --project clipboard --repeat-each 10
```

The first command compiles and enumerates the tests without a working app build; each test is listed under exactly one project. The second is the E2E step of the gate in `AGENTS.md`, which also lists the xvfb, chrome-sandbox, and spell-dictionary setup a headless box needs. Call the binaries directly; `pnpm <script>` is for CI and fresh clones, not the owner's checkout.

Bundled-engine phase 2 verification, 2026-09-05, in `/home/dillonc/Projects/StrataMD-wt/bundled-t3-server`: the first full run failed `cockpit-engine.spec.ts:8`, `engine-dialog.spec.ts:5`, and `managed-engine.spec.ts:8`. Saved results are `docs/plans/open/bundled-t3-server-2026-09-05/phase-2/failed-full-1/`; interrupted repeats are in `failed-repeat-1/`. Pairing lost its open dialog when the engine identity changed, and a same-origin credential renewal was incorrectly refused during active work. The dialog now reopens after the scoped renderer reload; credential renewal verifies the old grant before retaining identity. The added local-engine details also made a generic summary selector ambiguous; the assertion now names the pairing section. Managed startup copied symlink targets repeatedly; staging now preserves relative symlinks and requests copy-on-write. Its crash test waited for client connection before the manager had durably recorded ownership, then clicked behind the automatically opened recovery dialog. It now waits for manager readiness and checks the open recovery dialog directly. The managed fixture must quit cleanly before the ordinary harness removes its temporary store, because that harness intentionally kills the app and a detached engine survives an app crash. These diagnosed regressions passed their explicit repeats, a clean 190-test full run, and the 380-check eight-worker run (`phase-2/playwright-reply.log`, `phase-2/stress-reply.log`).
