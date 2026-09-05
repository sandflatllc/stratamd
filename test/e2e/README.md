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

## Known flakes

A test that fails in a full run and then passes ten explicit repeats is recorded here, not cleared. A test listed twice is fixed or rewritten before the next feature. Keep the saved `test-results/` copy for each entry until it is closed.

| Test | Seen | Evidence | Status |
|---|---|---|---|
| `shell-keyboard.spec.ts` tabs cycle from the keyboard | 2026-09-03 twice (cockpit-v1 gate runs), 2026-09-04 (serial run beside the clipboard worker), 2026-09-05 twice (full runs at four workers on isolated displays) | Passed 20 of 20 alone and 20 of 20 inside a four-worker run, then failed in two of three full runs. Traces showed the app still on the previous tab after a shortcut sent right after a switch: the tab list read by the keydown listener was the one from before the switch, because the listener re-registered in a passive effect after the DOM had already updated, and cycling from the stale list landed on the tab that was already active. `App.tsx` now reads the tab list through a ref kept current in a layout effect. | Fixed 2026-09-05 |
| `table-views.spec.ts` a blank header cell accepts table state and survives reopen | 2026-09-03 (cockpit-v1 gate run) | Hover to leave the table. Passed 20 of 20 inside a four-worker run and nine full runs on isolated displays on 2026-09-05. | Open; watching after display isolation |
| `workspace-restore.spec.ts` losing the layout preference returns to the centered default, and a file named on launch takes focus once | 2026-09-04 (the chained form, serial run), 2026-09-05 (one of three full runs at four workers) | The chained test hit the 30 s timeout; the split test hung on the Open in center button after launching with a file. Its screenshot shows the file's editor came up first and the restored centered conversation then replaced it, so the button no longer existed. That is an ordering race between workspace restore and an explicit file on launch, in the product, not the test. Results kept under `/tmp/stratamd-e2e-timing/results-2-w4/`. | Open; product race to fix |
| `conversation-comments.spec.ts` owner holds and sends a rich message passage in center | 2026-09-05 (two of four full runs, then 2 of 10 and 2 of 10 targeted repeats at six workers, with and without the day's renderer change) | After Back to reading, the anchored message sits a constant 34 px from where it was, and stays there; the side variant never fails. A fixed offset that persists means the return-to-reading scroll restore in the center placement lands against a different layout about one time in five, not a transient. Pre-existing; not related to display isolation. | Open; product race to fix |
| `shell-round2.spec.ts` an item focuses its reply and hands focus back on close | 2026-09-05 (one of four full runs at six workers) | The Reply textbox resolved but was not focused within 5 s after the jump. Passed 10 of 10 in a targeted repeat at six workers. | Open; watching |

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
