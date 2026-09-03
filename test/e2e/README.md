# PRD acceptance suite

`prd-6.12.spec.ts` has one black-box test for each scenario in PRD §6.12. The tests launch the built Electron main process, invoke the repository's `bin/stratamd`, and inspect only visible UI, CLI JSON, clipboard output, and document/buffer files.

Each test gets separate `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_RUNTIME_DIR` paths in its own temporary directory outside the repository — deliberately not under Playwright's output directory, which Playwright deletes at the start of every run and would yank a running app's store out from under a concurrent run. It never opens or changes the corpus originals or the owner's normal StrataMD store.

The suite runs on Linux and macOS. On Linux, run it under `xvfb-run` so app windows do not steal focus; on macOS it runs directly — no display layer exists or is needed. The harness handles the platform differences: it passes X11/ozone launch arguments only on Linux, sets `STRATAMD_USER_DATA` so each scenario gets its own Electron profile and single-instance lock (Electron only derives these from `XDG_CONFIG_HOME` on Linux), and exports key helpers (`primaryKey`, `documentStartKey`/`documentEndKey`, `lineStartKey`/`lineEndKey`, `selectToLineEndKey`) that map to Ctrl/Home/End on Linux and the Command-key equivalents on a Mac. Specs use the helpers instead of literal `Control+...` or `Home`/`End` presses, which do not move the caret on macOS.

The UI contract used by the suite is semantic:

- source textbox: `Source editor`
- visual contenteditable: `Document editor`
- dialogs named by their visible headings
- real buttons for Save, Send, Copy for agent, Keep, Revert, Accept, close-tab, recovery, and conflict actions
- per-item checkboxes under the heading `Changes not made by you`

These names follow the PRD and design handoff and make the same controls available to keyboard and assistive-technology users.

## Scheduling

`playwright.config.ts` splits the suite into two projects that run in one invocation:

- `ordinary` runs every untagged test, in parallel at the individual-test level, on four workers locally and two in CI.
- `clipboard` runs the tests tagged `@clipboard` one at a time on a single worker.

Every Electron app on the display shares one operating-system clipboard; separate profiles do not isolate it. Any test that reads or writes the native clipboard carries the tag, including a test that only copies and never reads the result: Electron's `clipboard` module, `copyForAgent`, Ctrl/Command+C, X, or V, the editor's Copy, Cut, and Paste menu items, Copy full path, and the attach-prompt copy button. Put it next to the title:

```ts
test('explorer tabs copy full paths', { tag: '@clipboard' }, async ({}, testInfo) => {
```

`test/unit/e2e-clipboard-tags.test.ts` fails when a test touches the clipboard without the tag, or carries the tag without touching it. The `@` in the config's grep pattern is load-bearing: Playwright matches the project name too, so a bare `clipboard` pattern would select every test in that project.

The total worker count is the ordinary count plus one, so the clipboard project keeps moving beside the ordinary one. `STRATAMD_E2E_WORKERS=<positive integer>` changes the ordinary count for measurements or unusual machines; `--workers 1` on the command line caps the whole run and restores a serial pass. Do not raise a test timeout to absorb contention; lower the worker count instead.

Screenshot baselines keep their project-free names (`<name>-linux.png`) through an explicit `snapshotPathTemplate`, so `--update-snapshots` writes the same files as before.

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
