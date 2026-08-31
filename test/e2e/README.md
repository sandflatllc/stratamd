# PRD acceptance suite

`prd-6.12.spec.ts` has one black-box test for each scenario in PRD §6.12. The tests launch the built Electron main process, invoke the repository's `bin/stratamd`, and inspect only visible UI, CLI JSON, clipboard output, and document/buffer files.

Each test gets separate `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_RUNTIME_DIR` paths in its own temporary directory outside the repository — deliberately not under Playwright's output directory, which Playwright deletes at the start of every run and would yank a running app's store out from under a concurrent run. It never opens or changes the corpus originals or the owner's normal StrataMD store.

The UI contract used by the suite is semantic:

- source textbox: `Source editor`
- visual contenteditable: `Document editor`
- dialogs named by their visible headings
- real buttons for Save, Send, Copy for agent, Keep, Revert, Accept, close-tab, recovery, and conflict actions
- a labeled checkbox named `Include changes not made by me`

These names follow the PRD and design handoff and make the same controls available to keyboard and assistive-technology users.

Commands:

```sh
pnpm exec playwright test --list
pnpm build
pnpm exec playwright test
```

The first command compiles and enumerates the tests without requiring a working app build. The other two are the release checks.
