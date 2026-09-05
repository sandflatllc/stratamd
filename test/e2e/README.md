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

Rules the unit tests enforce: `test/unit/e2e-timing-rules.test.ts` fails on a fixed sleep beyond the per-file allowance and on a budget above one minute; `test/unit/e2e-clipboard-tags.test.ts` keeps the clipboard tag honest. When you remove a sleep, lower the allowance in the same change.

A stress pass before a merge that touched the shell or the harness: `STRATAMD_E2E_WORKERS=8 xvfb-run -a ./node_modules/.bin/playwright test --repeat-each 2`. Local retries stay at zero so a race is seen, not absorbed.

## Known flakes

A test that fails in a full run and then passes ten explicit repeats is recorded here, not cleared. A test listed twice is fixed or rewritten before the next feature. Keep the saved `test-results/` copy for each entry until it is closed.

| Test | Seen | Evidence | Status |
|---|---|---|---|
| `shell-keyboard.spec.ts` tabs cycle from the keyboard | 2026-09-03 twice (cockpit-v1 gate runs), 2026-09-04 (serial run beside the clipboard worker), 2026-09-05 twice (full runs at four workers on isolated displays) | Passed 20 of 20 alone and 20 of 20 inside a four-worker run, then failed in two of three full runs. Traces showed the app still on the previous tab after a shortcut sent right after a switch: the tab list read by the keydown listener was the one from before the switch, because the listener re-registered in a passive effect after the DOM had already updated, and cycling from the stale list landed on the tab that was already active. `App.tsx` now reads the tab list through a ref kept current in a layout effect. | Fixed 2026-09-05 |
| `table-views.spec.ts` a blank header cell accepts table state and survives reopen | 2026-09-03 (cockpit-v1 gate run) | Hover to leave the table. Passed 20 of 20 inside a four-worker run and nine full runs on isolated displays on 2026-09-05. | Open; watching after display isolation |
| `workspace-restore.spec.ts` losing the layout preference returns to the centered default, and a file named on launch takes focus once | 2026-09-04 (the chained form, serial run), 2026-09-05 (one of three full runs at four workers) | The chained test hit the 30 s timeout; the split test hung on the Open in center button after launching with a file, and Playwright captured three live app windows at the failure although the test stops each app before the next launch. The harness awaited the app's close with no bound and could not tell a declined or stalled quit from success; it now bounds the close at 5 s, verifies the process exited, and kills it otherwise. The main-process order (restore, window, then launch documents) is correct. Results kept under `/tmp/stratamd-e2e-timing/results-2-w4/`. | Harness hardened 2026-09-05; watching |
| `conversation-comments.spec.ts` owner holds and sends a rich message passage in center | 2026-09-05 (two of four full runs, then 2 to 3 of 10 targeted repeats at six workers, 7 of 15 with scroll hooks installed) | Hooking every scroll write on the viewport showed the sequence: the spec read its baseline, and 30 ms later the history's ResizeObserver moved the viewport 34 px to keep the anchored row stable after content above it grew. Back to reading then restored that later position correctly. The product was right; the spec measured a transient. The baseline is now read only once it holds across two frames. Separately, each rich message re-ran its jump-to-target layout effect on every editor mount while the target outlived the navigation, so a remount could re-center the passage; `ConversationMessage.tsx` now jumps once per navigation serial. 20 of 20 after both. | Fixed 2026-09-05 |
| `shell-round2.spec.ts` an item focuses its reply and hands focus back on close | 2026-09-05 (one of four full runs at six workers) | The Reply textbox resolved but was not focused within 5 s after the jump. Passed 10 of 10 in a targeted repeat at six workers. | Open; watching |
| `view-sync.spec.ts` a busy session merges every update without divergence | 2026-09-05 (one of three full runs, then 1 of 10 alone) | The document editor never came back after two source toggles. The toggle shortcut read the document from the keydown listener's previous closure and toggled from the old mode, the same passive-effect gap as tab cycling. `App.tsx` reads the active document through a layout-effect ref. 20 of 20 after the fix. | Fixed 2026-09-05 |
| `cold-tabs.spec.ts` 3. scroll position is restored after a switch | 2026-09-05 (one of three full runs at six workers) | The restored scroll offset polled at 0 for 5 s after a tab switch with the editor cache off. Not yet diagnosed; results under `/tmp/stratamd-e2e-timing/results-d1-w6/`. | Open |
| `spellcheck.spec.ts` right-click corrects a misspelling through the annotate menu and learns new words | 2026-09-05 (one of three full runs at six workers) | A column expected hidden after a fixed 1 s sleep was still visible. The spec has six fixed sleeps; replacing them with condition waits is the first thing to try. Results under `/tmp/stratamd-e2e-timing/results-d1-w6/`. | Open |

## Commands

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
