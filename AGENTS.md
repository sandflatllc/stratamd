# Working in StrataMD

StrataMD is an Electron + TypeScript Markdown editor with a CLI (`bin/stratamd`) that agents use to attach to open documents. Product behavior is specified in `docs/PRD.md`; `docs/PRD_CONFORMANCE.md` maps each requirement to its tests.

## Gate

Run these from the repository root, in this order, before calling work done:

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/electron-vite build && xvfb-run -a ./node_modules/.bin/playwright test
```

While iterating on a small change, run the first two commands, rebuild with `./node_modules/.bin/electron-vite build` whenever product code changed (the Playwright harness launches `out/main/index.js`; neither the typecheck nor Vitest refreshes it), and then only the spec files that cover the change, named explicitly: `xvfb-run -a ./node_modules/.bin/playwright test topbar-dropdowns shell-keyboard`. The full Playwright suite runs before calling work done.

After a failed full run, copy `test-results/` aside, then rerun the failed tests by file and line: `xvfb-run -a ./node_modules/.bin/playwright test test/e2e/<file>.spec.ts:<line> --repeat-each 10`. Do not combine `--last-failed` with `--repeat-each`; the repeats carry other test ids and the filter drops them, so the test runs once. Ten passes do not clear the failure: record it under Known flakes in `test/e2e/README.md` with the date and the saved results path. A test already on that list may proceed; a new one needs one clean full run at the default worker count first, and a recurrence blocks the commit until it is diagnosed. Timeouts across unrelated specs in one run suggest load; rerun the full suite once, and if it recurs lower the worker default rather than any timeout. A change to `test/e2e/harness.ts`, `test/e2e/display.ts`, `playwright.config.ts`, or the main-process launch path always gets a full rerun. Never raise a timeout to absorb load, and never set local retries above zero.

Call the binaries under `./node_modules/.bin` directly. `pnpm <script>` in this checkout runs a dependency check that tries to purge `node_modules`; CI runs `pnpm check` in a fresh install, where that is fine. `scripts/install.sh` also runs pnpm scripts and is for fresh clones, not this checkout.

Unit and integration tests load `native/unix-support/build/Release/unix_support.node`. If it is missing (fresh clone, Node or Electron upgrade), build it with `npx node-gyp rebuild --directory native/unix-support`.

## E2E on a headless box

- The Playwright suite launches the built app; on Linux run it under `xvfb-run -a` so windows never take focus. With more than one worker the suite also starts one Xvfb per worker (`test/e2e/display.ts`), because apps on one shared display steal focus from each other and close each other's menus; a run that cannot start them fails and names the serial command, `--workers 1`.
- Ubuntu 24.04 and other kernels that restrict unprivileged user namespaces kill any Electron started outside Playwright with the SUID sandbox error. Fix once: `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
- The spellcheck spec expects an en-US Hunspell dictionary in the profile. A fresh machine has none: `xvfb-run -a npx electron scripts/fetch-spell-dictionary.mjs`.
- Each spec gets its own `XDG_*` directories in a temp dir, so the suite never touches the owner's StrataMD store or running app. Keep it that way.
- `test/e2e/visual-recovery.spec.ts` compares pixel baselines under `test/e2e/visual-recovery.spec.ts-snapshots/` for the shell, Contents, the table header, and the component sampler. After an intended visual change, rerun it with `--update-snapshots` and look at the new images against `docs/design/structured-reading/captures/prototype/` before committing them. `docs/design/structured-reading/README.md` has the capture commands.

## Rules that tests enforce

- `stratamd --agent-help` prints PRD §7 verbatim. `docs/PRD.md` §7, `src/cli/agent-help.ts`, and the relevant rows of `docs/PRD_CONFORMANCE.md` change together; `test/unit/cli.test.ts` fails when §7 and `agent-help.ts` drift.
- `skills/` holds independent distribution copies of the collaboration skill, the optional review skill, and suggested global instructions. `stratamd setup --skill` explicitly installs `skills/stratamd/`, including its component reference. Repository work changes distribution files only. The owner's active skills remain canonical under `~/.agents/skills/` with harness symlinks, and may differ from the distribution. Never link distribution files to the owner's canonical directories or automatically synchronize them. Updating the owner's installation requires an explicit owner request.
- Save is byte-preserving: untouched blocks are written from their original bytes. Serializer changes need a corpus round-trip test.
- CLI errors are `CommandFailure(message, exitCode, CODE, detail)` with SCREAMING_CASE codes and exit codes 1 usage, 2 not found, 3 refused by the document's state, 4 app unreachable. Every command prints one JSON object on stdout; notices go to stderr.

## Writing tests that hold up

`test/e2e/README.md` explains each of these; `test/unit/e2e-timing-rules.test.ts` enforces the first two.

- No new fixed sleeps in Electron specs. Wait for the condition: an element, an attribute, a polled state read, or a value that holds across two animation frames when layout is still settling. Removing a sleep is always allowed; add one and the scan fails.
- A per-test budget stays at one minute or under. A test that needs more is several tests; split it so a late step fails alone.
- A window-level listener in the renderer reads the latest state through a ref kept current in a layout effect, never from its closure. The keydown listener re-registers in a passive effect after a commit, and a key that lands in that gap acts on the previous state.
- A failure with no mechanism is not a flake, it is an open bug: record it under Known flakes with the saved results path, and find the mechanism before the test is listed twice.
- Before a merge that touched the renderer's shell or the harness, run the suite once at eight workers with `--repeat-each 2`; one-percent races surface there in one sitting.

## Copy

User-facing text is plain words: say what happened and what to do next. Error messages name the path or id involved. Sentence-case headings.

## Where things live

- `src/main` Electron main process, `src/renderer` React UI, `src/editor` ProseMirror, `src/cli` the command line, `src/core` shared logic, `native/unix-support` the socket helper.
- `test/unit`, `test/integration` (vitest), `test/e2e` (Playwright, see its README), `test/performance` (see its README).
- `docs/plans/` holds working plans and is gitignored: `open/` for in-progress, `completed/` for shipped. Tracked files may cite a plan; the PRD is the durable spec. A shipped plan moves to `completed/` with its status line updated.
- The owner's running app and installed skill copies are theirs. Do not restart the app or rewrite `~/.claude/skills` or `~/.agents/skills` during a task; report that a restart is needed instead.
