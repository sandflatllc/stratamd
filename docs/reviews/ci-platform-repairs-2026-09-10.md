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

## Preview navigation supersedes older thread actions

The macOS full suite in run 34424475924 passed 327 desktop checks, but failed two attachment previews and retried a third. The first-attempt trace shows the preview counter increasing while an older delayed thread navigation restores the conversation to the center. Opening any preview now cancels the pending thread-navigation intent.

The existing PDF scenario holds the thread-open IPC acknowledgment, opens the attachment, then releases the older action and advances the renderer clock. Before the fix, this controlled ordering reproduced preview loss at the post-release assertion in `2026-09-10T01-50-29-215Z-295f2965`. The original macOS log/archive and extracted document-preview traces remain under the CI evidence directory.

## Windows runtime copy cost

Windows run 34425660842 successfully prepared the native stock runtime, then timed out 11 of 13 managed integration cases. Phase logs show the first official bundle copy taking 106 seconds; retries and later cases overlap the unfinished work and later copies take 118–192 seconds. This is setup work exceeding the whole-test budget, not an established server-start failure.

Windows runtime copying now uses native Robocopy with eight copy threads, zero retries, explicit link preservation and checked return codes. This also reduces product cold-start and backup copy work. The focused Windows stage includes real copy tests for independent bytes, relative links, empty directories, paths with spaces and a missing-source failure. No test worker count, timeout or retry policy changes. [Microsoft documents the copy options and return codes](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/robocopy).

Run 34427552364 passed native copying and all 16 document scenarios, but managed integration still timed out 11 cases. Its first copy improved to 49 seconds; concurrent runtime creation and unfinished retries drove subsequent copies to 109–199 seconds. Managed integration now uses the same one-worker cap already reported for managed Electron checks. Ordinary unit and desktop worker counts, deadlines and retries remain unchanged. The native run must verify whether serial disk preparation fits those deadlines; the copy change alone did not establish that.

Run 34429163051 reduced the first copy to 14 seconds and passed nine managed cases. Four upgrade cases still included preparing the prior installation inside their transition deadline. Their suite fixtures now prepare that installation before the transition test, with separate one-minute preparation and cleanup bounds. The transition bodies retain their existing one-minute limit and all identity, settings, backup and restored-runtime assertions. The independent managed-engine case still tests cold startup.

Linux run 34429162969 failed clean signoff after its first three simultaneous app launches left their state IPC requests pending. The HTML, CSS and JavaScript loaded, but the initial state never arrived before the five-second assertion deadline. All three retries passed; the cause remains open in the Electron README. Original traces and logs are retained, without a speculative product fix or a longer assertion deadline.

## Reading controls and closed-client evidence

Local stress record 2026-09-10T03-12-22-134Z-92c14063 exposed a reading-controls test that combined live edits, disk persistence, placement changes, screenshots, a second app launch and restored controls within one 30-second deadline. The trace progressed through its checks and ran out of time after the second launch. Live editing/persistence and fresh-app restoration now run independently, with the same deadlines and assertions.

The timeout also exposed an evidence-cleanup TypeError because Playwright had disposed the client behind ElectronApplication.process(). A focused closed-client regression reproduced that exact failure in 2026-09-10T03-19-01-511Z-739d2a50. The scenario now captures the child handle at launch and uses that retained handle for cleanup, even after the Playwright client closes.

## Windows installed-runtime fixtures

Windows run 34431301533 passed all 13 managed integration checks, including cold installation and upgrade transitions. Its first three desktop checks exhausted their 20-second readiness predicate in the starting state on every attempt. Successful serial integration startup measurements were about 26 seconds. The UI checks had included installation of the stock runtime inside the readiness interval.

Managed desktop fixtures now install and verify the runtime in a separately bounded 30-second setup step. Settings and tray checks can also begin with a running engine in a separate 30-second fixture. The UI deadlines stay unchanged. A dedicated cold-profile check edits and saves before waiting for the engine, and integration coverage still proves cold startup and native pairing. Surviving-process adoption waits for the existing connection-readiness condition before its five-second durable-state check. Startup logs from isolated test profiles are attached before teardown, so subsequent failures retain stage timings.

The packaged-launcher test now checks Unix execute bits only on Unix. Windows execution is proved by launching the packaged executable and CLI; the binary must still be a regular file on every platform.

The two rollback desktop checks now prepare the old installation, linked document/account state, and installed update in separate bounded fixtures. Each setup phase remains capped at 30 seconds. The test body checks restoration from that prepared update; real upgrade transitions are still asserted in setup and in the managed integration suite. This follows the same installed-state boundary as the integration repair and avoids combining multiple native runtime copies with an entire recovery workflow in one UI budget.

## Connection checks during Windows recovery

Windows run 34434314176 reached restoration but left the engine stopped with EBUSY while removing its t3 data directory. The Connections dialog polls a subprocess whose cwd was that directory. Windows retains a working-directory lock until the subprocess exits. Connect commands now run from the immutable runtime directory and still receive the explicit data path through --base-dir. A controlled regression keeps the status child alive while replacing its data directory. The old implementation failed in record 2026-09-10T04-32-45-717Z-e7c300e5; the corrected implementation passed in 2026-09-10T04-34-29-391Z-45e2fc42. Windows CI includes that regression explicitly.

Windows run 34435062603 also reported EPERM publishing a verified staging directory immediately after its native probe. Runtime publication now retries only Windows sharing/access errors, for at most 1.5 seconds, then preserves the failure. A native test holds a real process cwd lock, proves ordinary rename refuses it, and checks publication after release. The original runner's lock owner is not established. Its original log and archive remain saved. Recovery setup separates old-runtime installation from launch and new-runtime preparation from switching the engine; every phase retains its 30-second bound.

## External-edit ordering and desktop fixture work

Linux run 34435062605 passed every desktop test but retried the walkthrough integration case. The fixture's 100 ms sleep did not await its queued mirror write. A delayed owned write could replace the external edit before the focus check. Record 2026-09-10T04-24-10-314Z-69c2dd27 forces that order and reproduces the exact expected-revisit/received-reviewed assertion. Waiting for Save to flush the mirror passes the same controlled ordering in 2026-09-10T04-24-57-058Z-db8617c9. Diagnostic delays were removed; the Save barrier remains.

Stress record 2026-09-10T04-01-30-905Z-9106ad35 passed 668 desktop cases and failed six. Four menu fixtures spent nearly their whole deadline opening 24 documents sequentially through a live renderer. They now pass those files through the application's existing multi-document startup path. Three focused repetitions passed all 15 menu cases in 2026-09-10T04-26-02-413Z-0558f083.

The other two failures exhausted their whole-test budget in visual-comment workflows. The native-answer delivery completed its assertions before cleanup exhausted the budget; the two-revision workflow had only 104 ms left for its second dispatch poll. Startup and teardown now belong to a bounded live-conversation fixture, and acceptance and revision/stale-reply behavior run independently from a sent-comment fixture. All original delivery, revision, image and no-extra-turn assertions remain. The workstation's 16 CPUs averaged 3.5% idle with 35 runnable tasks during the failure window; resource pressure compounded the fixture cost. Existing unresolved initial-IPC and preview-navigation failures remain recorded in the Electron README.

## Initial window loading and failed upgrade-fixture ownership

Linux run 34438410556 repeated the three first-launch state timeouts. Its trace shows the state predicate beginning while initial font requests and the window load were still unfinished. The harness previously waited only for DOMContentLoaded. A controlled route holds the initial font responses: the old harness declares launch complete before the load event, reproducing the readiness defect in 2026-09-10T05-14-52-607Z-e1c47cf7. Launch now waits for the window load before applying its existing five-second state predicate. The controlled check and three repetitions of account-quota/annotation-hotkeys pass in 2026-09-10T05-18-15-765Z-05797acd. This establishes the missing readiness boundary; the original trace does not identify the internal IPC stall by itself. Native CI remains required.

Windows run 34438410546 passed the new native lock tests but failed the selected-runtime integration case because start returned recovering. Its old assertion discarded the engine's problem message. A retry then replaced the fixture's manager handle without stopping its scheduled recovery, and cleanup failed with ENOTEMPTY. The fixture now closes the previous manager/client before replacement, closes failed starts, and includes the complete managed state in the failure. The original startup cause remains under investigation, with subsequent CI retaining the reason.

## Native composition probe scheduling

Stress record 2026-09-10T05-30-20-754Z-53960e6f retained a desktop screenshot with the old green guest still visible after switching back to the blue document shell. The composition fixture ran ImageMagick synchronously on Electron's main thread inside the repaint polling loop. That blocks the native event processing whose result the probe is waiting to observe. Desktop capture now awaits an asynchronous child process, leaving Electron free to process the view transfer and repaint. The five-second composition predicate, 25-second fixture process bound and test budget remain unchanged. The failed screenshot and process log remain attached to the original record.
