# Bundled engine release checks

Status: repair implemented and required local gates passed, September 6, 2026. The investigation and real-environment checks below remain open. No package installation or owner-app restart was performed.

The bundled-engine implementation merged before this repair. Migration remains deferred. Working plans are ignored local material; the exact 38 previously tracked artifacts were preserved with hashes before removal from tracking. The local archive is outside the repository at `~/.local/share/stratamd-repair-archives/2026-09-06-1788714208`. Its inventory and move record retain original paths and permissions. The phase-1 package stayed in place because a process used it.

## Repair behavior

- Unreadable comment records preserve their original bytes and captured images. Active sessions retain their own durable evidence references.
- Engine recovery has a bounded retry budget, process ownership that survives parent death, and conservative backup retention. Closing without tray mode waits for the owned engine to stop.
- Background previews keep form state, scroll and fresh captures in a separate native window outside the display. They no longer cover Strata's controls.
- Annotation sessions survive navigation. Correctable Send refusals keep editing open; Retry uses the frozen revision. Each reply retains its own comparison and agent attribution.
- Settings preserve deliberate edits during refresh and tool installation. Connect verifies the actual HTTPS forwarding before offering a tailnet link.
- This computer and Settings use fixed headers and footers with scrolling bodies. Small-window checks cover provider tabs, swatches and populated attachment rows.

## Final local verification

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Stock unit/integration suite | 917 passed; one packaged check skipped in the normal suite |
| Full Electron suite | 220 passed at the default worker count |
| Eight workers, each Electron test twice | 440 passed |
| Fresh Linux package and CLI | Connected, refused unsafe outputs, stopped its engine on window close; both CLI checks passed |

The final gate used unchanged timeout and retry settings. The separate packaged run covered the normal suite's skipped check. The known test failures and their evidence remain in `test/e2e/README.md`.

## Required release environments

| Check | Status |
| --- | --- |
| Linux package in fresh output and fresh profile | Passed in `release/build-AjBPUF/linux-unpacked`: connected to its bundled engine; existing-output, symlink-alias and direct-builder refusals left sentinel hashes unchanged; window close stopped its owned engine; both packaged CLI checks passed. |
| Stock preview tools through a signed-in provider in a disposable thread | Passed with stock T3 0.0.38 and signed-in Codex, gpt-6-astra. Open and screenshot snapshot succeeded; the provider returned the page's random proof text. |
| Two independently staged Linux artifacts | 19,196 file/link entries identical after removing Python bytecode and node-gyp build metadata |
| Native terminal smoke | Passed spawn, output and exit using the pinned runtime and compiled PTY module |
| Second-host native reproducibility | Open; same-host equality does not establish this |
| Hosted Connect sign-in, relay and actual tailnet pairing | Open |
| Android discovery, conversation, reconnect | Open |
| macOS Intel and Apple Silicon packages, Keychain and login items | Open |
| Fresh provider sign-ins | Open |
| Physical-device sleep/wake and offline recovery | Open |

## Build evidence

Linux staging pins GCC 16.2.1, Python 3.14.7 and Make 4.4.1. The Node 24.20.0 archive SHA-256 in `packaging/engine/runtime-source.json` authenticates the runtime, headers and bundled npm/node-gyp. npm dependency integrity remains locked. PTY compilation uses those headers explicitly; build-only machine paths and Python bytecode are omitted. Every staged and packaged runtime still receives its own full integrity verification.

A package build reserves a fresh output before staging starts and refuses existing outputs or aliases into installation/runtime directories. `build/latest-package.json` records the completed output. Building does not install it or restart the owner's app.

The [fresh package capture](captures/package-this-computer.png) shows its connected bundled engine. The two independent staging inventories, final staging inventory and packaged inventory match exactly. Their SHA-256 is `746b5e352ea0b2a53870f29e8f409bbcf461687700a94758462667a734ebf232`. [The sanitized result record](repair-evidence-2026-09-06.json) retains the package's sentinel hashes and verification results.

The real provider proof found that stock T3 sends `tabId: null` for the first unassigned browser request, despite its optional-field schema. Strata normalizes that value and supplies authentication for the environment descriptor. Snapshot results include the required loading state. Both the stock encoding probe and the real provider workflow cover the repaired boundary.

Native desktop composition and guest pixels are recorded in [the desktop capture](captures/background-preview-desktop.png) and [the background page capture](captures/background-preview-capture.png). These come from an isolated Linux display with a disposable page. The same fixture covers two tabs, document navigation, annotation/menus, device sizing, tray reopening, window reattachment and scratch comparisons.

CI selects the separately pinned `ubuntu-24.04` profile with GCC 13.3.0, Python 3.12.3 and Make 4.3, matching [the runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md). Every staging run checks its selected versions and records that profile in the artifact. The two-artifact equality proof above applies to the default local profile; it does not claim equality between different toolchains. The Ubuntu workflow itself has not been run here.

## Open test investigation

One eight-worker run passed 439 checks and failed `prd-6.12.spec.ts:92` while waiting for the second offline Send dialog to close. It did not reach its delivery-order assertions. Ten original exact-line repeats and 80 diagnostic repeats at eight workers passed. The cause remains undetermined; those repeats do not clear the failure. The test now attaches actual click targets and document state if it recurs. `test/e2e/README.md` retains the issue and saved artifact path. The subsequent default full run passed all 220 tests, and the eight-worker repeat-two run passed all 440 checks. The investigation remains open.
