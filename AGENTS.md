# Working in StrataMD

StrataMD is an Electron + TypeScript Markdown editor with a CLI (`bin/stratamd`) that agents use to attach to open documents. Product behavior is specified in `docs/PRD.md`; `docs/PRD_CONFORMANCE.md` maps each requirement to its tests.

## Gate

Run these from the repository root, in this order, before calling work done:

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/electron-vite build && xvfb-run -a ./node_modules/.bin/playwright test
```

Call the binaries under `./node_modules/.bin` directly. `pnpm <script>` in this checkout runs a dependency check that tries to purge `node_modules`; CI runs `pnpm check` in a fresh install, where that is fine. `scripts/install.sh` also runs pnpm scripts and is for fresh clones, not this checkout.

Unit and integration tests load `native/unix-support/build/Release/unix_support.node`. If it is missing (fresh clone, Node or Electron upgrade), build it with `npx node-gyp rebuild --directory native/unix-support`.

## E2E on a headless box

- The Playwright suite launches the built app; on Linux run it under `xvfb-run -a` so windows never take focus.
- Ubuntu 24.04 and other kernels that restrict unprivileged user namespaces kill any Electron started outside Playwright with the SUID sandbox error. Fix once: `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
- The spellcheck spec expects an en-US Hunspell dictionary in the profile. A fresh machine has none: `xvfb-run -a npx electron scripts/fetch-spell-dictionary.mjs`.
- Each spec gets its own `XDG_*` directories in a temp dir, so the suite never touches the owner's StrataMD store or running app. Keep it that way.
- `test/e2e/visual-recovery.spec.ts` compares pixel baselines under `test/e2e/visual-recovery.spec.ts-snapshots/` for the shell, Contents, the table header, and the component sampler. After an intended visual change, rerun it with `--update-snapshots` and look at the new images against `docs/design/structured-reading/captures/prototype/` before committing them. `docs/design/structured-reading/README.md` has the capture commands.

## Rules that tests enforce

- `stratamd --agent-help` prints PRD §7 verbatim. `docs/PRD.md` §7, `src/cli/agent-help.ts`, and the relevant rows of `docs/PRD_CONFORMANCE.md` change together; `test/unit/cli.test.ts` fails when §7 and `agent-help.ts` drift.
- `skills/` holds independent distribution copies of the collaboration skill, the optional review skill, and suggested global instructions. `stratamd setup --skill` explicitly installs `skills/stratamd/`, including its component reference. Repository work changes distribution files only. The owner's active skills remain canonical under `~/.agents/skills/` with harness symlinks, and may differ from the distribution. Never link distribution files to the owner's canonical directories or automatically synchronize them. Updating the owner's installation requires an explicit owner request.
- Save is byte-preserving: untouched blocks are written from their original bytes. Serializer changes need a corpus round-trip test.
- CLI errors are `CommandFailure(message, exitCode, CODE, detail)` with SCREAMING_CASE codes and exit codes 1 usage, 2 not found, 3 refused by the document's state, 4 app unreachable. Every command prints one JSON object on stdout; notices go to stderr.

## Copy

User-facing text is plain words: say what happened and what to do next. Error messages name the path or id involved. Sentence-case headings.

## Where things live

- `src/main` Electron main process, `src/renderer` React UI, `src/editor` ProseMirror, `src/cli` the command line, `src/core` shared logic, `native/unix-support` the socket helper.
- `test/unit`, `test/integration` (vitest), `test/e2e` (Playwright, see its README), `test/performance` (see its README).
- `docs/plans/` holds working plans and is gitignored: `open/` for in-progress, `completed/` for shipped. Tracked files may cite a plan; the PRD is the durable spec. A shipped plan moves to `completed/` with its status line updated.
- The owner's running app and installed skill copies are theirs. Do not restart the app or rewrite `~/.claude/skills` or `~/.agents/skills` during a task; report that a restart is needed instead.
