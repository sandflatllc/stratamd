# Phase 4 report

Status: complete with the explicit hosted/device capability blockers below; full repository gate passed. September 6, 2026.

This computer now manages official T3 Connect authorization, separate remote-access and publishing choices, tray behavior, start at login, network listeners, pairing links and paired devices. The original external pairing path remains available.

Connect uses only login, link, status, publish, unlink and logout against Strata's own base directory. It never invokes the service-installing onboarding command. Authorization output and codes stay in memory, with browser opening, manual code entry, cancellation and bounded process cleanup. Status uses the CLI's JSON, not terminal-text inference. Restarting changes drain local dispatch and refetch active work before stopping the verified owned engine. Queued sends remain withheld during maintenance, then resume through the existing dispatch queue.

Remote access and publishing are separate. The stock unlink command clears publishing too, so switching remote access off restores a previously enabled publishing choice through the official publish command. Sign-out clears both locally. Upstream output remains visible when remote revocation cannot finish offline; the website may retain its own login. Tailscale availability uses its read-only status command. LAN is off by default, and an explicit listener change rolls back its settings if startup fails.

Pairing-link and device APIs are verified against stock T3. The UI exposes endpoint and permission selection, returned expiry, link revocation and independent session revocation. It does not offer an invented expiry parameter, and it protects the current Strata session from accidental revocation through the dialog. Linux start at login writes only the selected XDG autostart entry; macOS delegates to Electron login-item settings. The tray preference survives an app restart.

## Verification

- `test/unit/t3-connect.test.ts` proves owned-child cancellation, failed authorization, ephemeral output, and isolated Linux/macOS login-setting adapters.
- `test/integration/managed-connections.test.ts` runs the real stock server and proves signed-out Connect status, pairing creation/exchange, separate link/device revocation, and LAN → loopback restarts with stable environment identity.
- `test/e2e/computer-controls.spec.ts` exercises the real dialog against stock T3, including pairing revocation, login-entry creation/removal, and persisted tray choice.
- Existing managed-engine Electron checks cover automatic startup, engine crash, Strata crash/adoption and external switching.

The first unit gate found a platform-boundary violation in the login adapter call. It now uses the existing platform abstraction. The first targeted Electron run exposed a real checkbox race: a pending status read could overwrite the local preference while an asynchronous save completed. Preference changes now update the visible checkbox immediately, retain the previous value on failure, and ignore stale reads during a save. Saved artifacts are `failed-targeted/`; the full run includes this scenario.

The gate passed in order: TypeScript, 851 unit/integration tests with one intentional skip across 109 files, Electron build, and 197 Playwright tests at the default worker count. Logs are `typecheck.log`, `unit-final.log`, `build.log` and `playwright.log`.

## Blocked and unsupported proofs

The hosted T3 sign-in, successful relay acquisition/linking, actual offline hosted revocation, Android environment discovery/turn/reconnect, physical sleep/wake with a phone, and macOS native login behavior require the owner's sign-in or devices. No owner app, data or account was restarted or changed. Failed authorization and cancellation are automated with an isolated CLI fixture; they are not represented as completed hosted authorization.

Stock 0.0.38 computes the environment label from the OS computer name and has no supported label override. The proposed “Strata on [computer name]” mobile label is blocked by that upstream capability. Strata neither renames the OS nor modifies the server.

The available stock status methods report stored credentials and link configuration. They do not prove a tunnel is reachable. The dialog says the linked environment's reachability is unverified, rather than claiming Connected. Successful hosted health remains a release blocker. Tailscale installation and HTTPS reachability were not available on this machine; prerequisite detection and listener failure recovery are implemented.

The stock server has no exclusive maintenance reservation across clients. Strata drains its own sends and performs a fresh active-work check; another already authorized client can still race that check. No stronger cross-client guarantee is claimed.
