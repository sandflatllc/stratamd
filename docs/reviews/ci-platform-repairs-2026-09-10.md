# CI platform repairs

This follows Dillon's report of the failed CI email after revision `83e1d1c`.

## Windows temporary paths

[Windows run 34422348401](https://github.com/sandflatllc/stratamd/actions/runs/34422348401) passed the selected native unit tests but failed document startup assertions. The app opened the correct document through the full `runneradmin` path; the fixture expected the Windows 8.3 name `RUNNER~1`. Setting TEMP was insufficient because the JavaScript `realpathSync` implementation preserved that spelling. Both test setups now call `realpathSync.native`, matching the native resolution used by the app. The native storage test checks that tmpdir already equals its native real path before testing locks and renames.

The local focused record is `2026-09-10T00-54-44-483Z-1ab8781e`, under `/home/dillonc/.cache/stratamd-verification/runs/`. Windows skips there require native CI.

## macOS managed workflow budgets

The macOS job in [run 34422348467](https://github.com/sandflatllc/stratamd/actions/runs/34422348467) reported two first-attempt failures, even though retries passed. The traces establish exhausted whole-test budgets rather than failed final transitions:

- The tray test used about 29 seconds on two launches, engine readiness, the settings UI and the intermediate stop. Its final engine-exit assertion had almost no time remaining. Two independent tests now check writing the tray setting to disk, and loading a saved setting and stopping the owned engine. Each uses one launch.
- The recovery test copied the bundle, cold-staged its first runtime, launched, upgraded and restored in one 30-second test. The restore poll received only 2.2 seconds before the whole-test timeout, despite its 20-second poll limit. Copying and initial runtime staging are now fixture preparation with a separate 30-second bound. The UI workflow retains its original 30-second bound and all update, recovery, document and account assertions. Setup plus the UI workflow remain bounded to one minute.

No worker count, retry policy or UI test timeout was increased. Full, managed and native CI results for the final candidate belong in the delivery verification record.

## Evidence

Saved CI logs and the original macOS artifact are under `docs/plans/open/windows-fable-repairs-20260909/ci/`. The extracted macOS traces are under `ci/mac-evidence/runs/2026-09-10T00-42-15-484Z-b2cc1242/test-results/`. They retain the first attempts.

## Linux accessibility prerequisites

The Linux job in run 34422348467 passed 333 desktop checks but failed the two native window-capture scenarios because `org.a11y.Bus` was unavailable. Ubuntu CI now installs at-spi2-core and the GTK Python bindings used by the synthetic window. The test locates the registry in Ubuntu's libexec directory or the lib directory used on the workstation. Its GTK window uses system Python, which owns the distro's GI modules, rather than setup-python's separate installation. The X11-specific capture proof explicitly runs on Linux; the separate macOS permission-dialog check remains available.

## Windows replacement and forced test shutdown

Run 34423383493 passed the corrected path assertions. Its first two document scenarios completed their assertions but stalled during cleanup, because killing only Electron's main process left Chromium children holding the profile open. Forced scenario shutdown now collects Electron process IDs from app.getAppMetrics and kills those explicit processes before waiting for exit. It preserves the separately spawned engine so crash adoption remains valid. It does not target the owner's running app.

The Save scenario also exposed ordinary Windows rename refusing an open destination. Atomic document publication now uses FileRenameInfoEx with replace-existing and POSIX semantics, preserving the existing temporary-file write, sync and conflict checks. The native storage regression overwrites the destination twice while retaining an old read descriptor and verifies both the published bytes and the old reader's bytes. Filesystems without the extended API fall back to ordinary rename and retain its sharing restrictions. Microsoft documents the [rename information API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info); [Git's corresponding Windows fix](https://code.googlesource.com/git/+/391bceae4350136a05d977573caeaa07059f2136) describes the open-target restriction.

The Windows log and original archive are retained as `ci/windows-34423383493.log` and `ci/windows-34423383493.zip` under the evidence directory above.

## Remaining Windows fixture assumptions

Run 34424475929 passed native open-file replacement and the first Save scenario, then exposed two fixture assumptions. External atomic edits now use the native rename helper too, and close-tab lookup uses the platform basename instead of splitting on `/`. Forced shutdown completed without the previous afterEach hangs.

A focused local check also inserted the undo scenario's setup text at the beginning of its paragraph after an unchecked End key. Setup now selects the exact text, collapses right, and verifies the caret before typing. The failed record is `2026-09-10T01-21-46-370Z-bf363621`.

The separate unresolved preview-navigation failure is recorded in test/e2e/README.md with its original trace and diagnostic repetitions; it is not treated as resolved by a later pass.

Static review before the Windows managed checks found that taskkill /T would also kill the detached engine. Shutdown now targets only the Electron main and helper processes reported by the app, with bounded metrics collection. This retains Windows profile cleanup without turning an app-crash test into an engine crash.
