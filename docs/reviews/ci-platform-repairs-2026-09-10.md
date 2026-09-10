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
