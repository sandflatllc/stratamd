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

Commands, from the repository root:

```sh
./node_modules/.bin/playwright test --list
./node_modules/.bin/electron-vite build && xvfb-run -a ./node_modules/.bin/playwright test
```

The first command compiles and enumerates the tests without a working app build. The second is the E2E step of the gate in `AGENTS.md`, which also lists the xvfb, chrome-sandbox, and spell-dictionary setup a headless box needs. Call the binaries directly; `pnpm <script>` is for CI and fresh clones, not the owner's checkout.
