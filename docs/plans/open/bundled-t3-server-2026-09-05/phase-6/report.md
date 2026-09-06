# Phase 6 report

Status: implementation complete. Repository gate, eight-worker stress run and rebuilt Linux package checks passed. Hosted/device release proofs remain blocked as listed below. September 6, 2026.

The Linux unpacked build includes official T3 0.0.38, Node 24.20.0 with npm, production dependencies, native modules, helper binaries, the web client, license notices and a file integrity inventory. The inventory contains 342 package records and 19,230 file/symlink entries. The staged runtime occupies 732 MiB and the Linux unpacked folder about 1.2 GiB. The two packages without a manifest license field, T3 and npm's qrcode-terminal, retain their included LICENSE files in the notices. The runtime stays outside ASAR and is copied into a private versioned data directory. The packaging script uses repository binaries directly and leaves the shared node_modules and native build intact.

Folder replacement verifies the new runtime before reserving the transition. Active turns or unfinished sends defer it. Strata drains writes, pauses document mutations during the snapshot, stops the verified owned process while retaining the lock, and copies the complete T3 base plus engine-scoped Strata state. The backup includes document conversation bindings, Lead and referenced payload objects. A transition journal supports recovery after interruption. Failed updates preserve their data and return to the matching previous runtime.

Restore shows the backup time and requires an explicit choice to archive newer work. It first takes a current backup, then restores matching engine history and Strata records. Markdown, review history and unsent text are not rewound. Newer staged image bytes stay available to unsent drafts. A restored runtime remains selected until a new bundle arrives or the owner chooses Use bundled engine. Project files and worktrees are not rolled back.

## Evidence

- `test/integration/engine-upgrade.test.ts` launches stock T3 across release-manifest changes, verifies settings and environment identity, restores a backup, preserves newer work, keeps the selected old runtime after restart, recovers a failed entry point, and archives interrupted-transition data before recovery.
- `test/unit/strata-engine-backup.test.ts` checks matching account/command records, conversation payload recovery after garbage collection, and preservation of newer Markdown, editor buffers and staged images.
- `test/unit/connection-maintenance.test.ts` checks write draining and suspension while allowing the owned reconnect.
- `test/e2e/engine-recovery.spec.ts` uses This computer to select and confirm an actual stock backup. Account preferences return to their saved value while newer editor text and unsent renderer text remain.
- `test/e2e/engine-recovery-bindings.spec.ts` verifies document conversation links and Lead against a real server thread fixture without starting an agent turn.
- The packaged proof starts a fresh profile with no system Node on PATH, verifies the staged executable, and checks that Quit stops the owned engine. Its final result, installer checks and screenshot are recorded beside this report.

The transition fixtures use the same official T3 version with distinct release manifests. They prove update/rollback mechanics, not a future upstream schema migration. Each future release needs the same checks against its actual server artifact.

## Findings and corrections

Electron Builder's normal resource filter removed much of the engine's dependency tree. The first fresh-profile package correctly failed its integrity check. A packaging hook now copies the entire independent runtime after Electron Builder finishes and verifies each file and symlink. The original failure is preserved in `packaged-first-failure.log`.

The first proof script invoked Quit through an unsupported dynamic import in Playwright's Electron evaluation context. It reached Connected but did not call Quit. The script now uses Playwright's supplied app handle and records success only after the owned engine exits. `packaged-quit-fixture-failure.log` preserves that fixture error.

The successful startup screenshot exposed a real attachment-cleanup race during automatic pairing. Cleanup now waits for a connected managed engine and skips a sweep during a connection transition. The owned process incarnation is recorded before bootstrap, so an app crash during pairing does not leave an unrecorded database writer.

A stock provider probe can report installed while its actual readiness is unknown. Accounts therefore also offers Check or install on an unusable account, so a failed Sign in never hides the managed installer. Existing valid tools remain preferred and are not replaced.

The first full phase 6 Electron run passed 197 tests and failed the new backup selector. Its implicit label included option text, so the exact label lookup could not resolve it. An explicit accessible name fixes the control. Results are saved in `failed-full-1/`; the required repeats and subsequent full gate are recorded below. A prior targeted readiness poll crossed the intentional identity reload and now retries that navigation.

The strict fresh-profile installer fixture initially removed the system shell as well as Node. Codex installed, but Claude's official npm install script failed with `spawn sh ENOENT`. The fixture now exposes only `/bin/sh` in its otherwise isolated PATH; Node and provider executables still come from Strata. `packaged-install-shell-failure.log` records the diagnosis.

A later unit gate passed all assertions but failed on an unhandled theme-file deletion race. A file vanished after directory enumeration and before loading. Theme listing now skips vanished entries, active-theme refresh retains its last value when a file disappears, and watcher failures are handled. A deterministic regression test covers the enumeration/load gap. `unit-final-gate.log` retains the failing run. Recovery also delays its in-progress flag until runtime verification succeeds, so a verification error cannot leave it permanently busy.

The next complete Electron run passed all 193 ordinary/clipboard cases but timed out all six managed cases during startup. A simultaneous package rebuild/proof competed for filesystem work; that package stayed Starting within its unchanged 45-second bound and passed when rerun alone. The runtime verified 19,230 entries through sequential filesystem round trips. Eight bounded readers retain every check and reduced an isolated measurement from 3,795 ms to 1,209 ms. These are diagnostic samples, not a performance guarantee. `runtime-integrity.test.ts` verifies corrupt-file and escaping-link refusal. Full failure artifacts are in `failed-full-2/`; packaging and Electron runs now run separately. Required exact-line repeats and clean full/stress checks follow.

## Final checks

The resumed repository gate passed in order on September 6, 2026. TypeScript passed; Vitest passed 858 tests across 113 files with one intentional packaged-test skip; the Electron build passed; all 199 Electron tests passed at the default worker count in 2.8 minutes. `STRATAMD_ENGINE_BUNDLE` selected the actual stock runtime for both test runners. Logs are [typecheck](resumed-typecheck.log), [unit/integration](resumed-unit.log), [build](resumed-build.log), and [full Electron suite](resumed-full.log).

The corrected login-file check passed all ten exact-line repeats in 2.3 minutes, recorded in [resumed-repeat-login.log](resumed-repeat-login.log). The complete suite then passed all 398 checks at eight workers with `--repeat-each 2` in 6.7 minutes, with no retries or timeout increases. See [resumed-stress.log](resumed-stress.log).

The final Linux package rebuilt successfully from the verified code. Both packaged CLI tests passed, including the check intentionally skipped by the ordinary gate. A fresh isolated profile with no system Node on PATH connected automatically, installed both official provider packages in its private Strata directory and stopped the owned engine on Quit. See [package build](resumed-package-build.log), [CLI checks](resumed-packaged-cli.log), [proof result](packaged-proof.json), [proof script](packaged-proof.mjs) and [This computer capture](packaged-this-computer.png). The unpacked artifact is `dist/linux-unpacked/` in this worktree. The capture was inspected against the supplied design; the dialog scrolls at the small test window size.

The continuation after thread `66b605f0-0617-496b-811c-a8351e8a6a1d` recovered the completed startup repeat run. It passed 57 of 60 checks; three failures were all at the login-file assertion in `computer-controls.spec.ts:20`. `expect.poll` does not retry a callback that throws, so an expected missing file could end the check before the asynchronous preference save created it. The callback now returns an empty value only for `ENOENT` and keeps other errors visible. Saved artifacts are in `failed-startup-repeats/`; `repeat-startup.log` retains the original result. The other five managed cases each passed all ten required repeats.

## Release blockers and scope

Hosted T3 sign-in, a successful relay link and health proof, Android environment discovery/turn/reconnect, successful new Codex/Claude sign-ins, macOS x64/arm64 packaging and Claude Keychain usage, and physical-device sleep/wake remain blocked by the missing owner sign-in or devices. Linux and fixture results do not substitute for them.

Stock T3 has no supported environment-name override and no local API that proves relay reachability. The UI reports its OS naming rule and unverified remote reachability. There is no promise of a “Strata on …” mobile label or verified hosted connection.

Migration was skipped as instructed. No installer/updater, server fork, merge to master, owner-app restart, owner-data rewrite or installed-skill change was performed. The owner's checkout remains on master; implementation stays in the authorized worktree and branch.
