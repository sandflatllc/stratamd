# Phase 1 integration report

Status: Linux proofs passed, device and hosted authorization proofs blocked. September 5, 2026 local time.

## Proven

The official `t3` 0.0.38 server ran a Codex conversation with its own Node 24.20.0 and data directory. Strata's existing `T3EngineClient.pair` exchanged the bootstrap token and connected. The Linux unpacked Strata displayed the reply `STRATA_BUNDLED_OK`. See [conversation](packaged-conversation.png) and [accounts](packaged-accounts.png). The owner's T3 and Strata were left running and unchanged. Closing the disposable Strata stopped only the spike's processes.

The staged runtime is 711 MB; the unpacked Strata folder with it is 1.2 GB. Native `node-pty` 1.1.0, `@ff-labs/fff-node` 0.9.4 and `msgpackr-extract` 3.0.4 load. The full production tree and pinned Node are in `runtime/0.0.38/`, with npm's resolved dependency lock. The package includes the upstream web client and resource helpers.

Desktop mode needed no telemetry descriptor or custom helper path. It did not create a project automatically, open a browser, or offer a service. The bootstrap envelope requires `mode`, `noBrowser`, `port`, `host`, `desktopBootstrapToken`, `tailscaleServeEnabled`, and `tailscaleServePort`; `t3Home` supplies the base directory. Keep this route. The seed stayed in memory and the inherited descriptor. A session credential persisted through Strata's existing private credential writer.

T3 rejects port 0. Reserve a free loopback port, release the reservation immediately before spawn, then read `userdata/server-runtime.json` and verify the pid and actual address. A bind race must retry rather than adopt the competing listener.

The server created its own environment id and `userdata/state.sqlite` below the spike. Its runtime record named its actual child pid and loopback port. No owner's database was opened for inspection or writes. Both Claude and Codex became authenticated after `server.refreshProviders`; the initial config can carry provisional unchecked status, so it must not trigger installation immediately.

## Usage readers

The plain Node probe used Codex `initialize`, `initialized`, `account/rateLimits/read`, and `account/read` with token refresh disabled. The provider returned Pro, 78% of a 10,080-minute weekly window. Its primary slot is weekly here, with no session window. Classify windows by duration, never by primary versus secondary position.

Claude Agent SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` returned Max, 6% five-hour and 9% seven-day usage with reset timestamps. It ran an empty streaming query with session persistence disabled and no prompt or tool calls. No credential file was read by Strata. This is explicitly an experimental SDK method; absence or changed output must become unavailable usage.

These are the providers' own structured reporting paths, not an independent screenshot comparison against their UIs. macOS Keychain is untested. Concurrent Codex probing was not established safe, so keep the planned idle-only rule.

## Clean provider setup

Official npm distributions installed into `clean-tools/`: `@openai/codex@0.153.4` and `@anthropic-ai/claude-code@2.1.263`. Both execute and report their versions. An isolated home shows Claude signed out. Codex requires its configured home to exist before even checking login; create the managed home first. Completing either new sign-in requires the owner, and is blocked. This is an isolated-home proof on the Linux host, not a fresh OS/container proof.

## T3 Connect

`connect status --json` reported signed out, unlinked, publishing off, and relay client missing at version 2026.5.2. `login --headless` produced the official `https://app.t3.codes/connect` authorization flow and requested the browser's returned code. Cancellation exited 130. `link --headless` prompted to download the relay client; declining exited cleanly without changing local access. `publish` persisted its separate opt-in even while signed out. `unlink` and `logout` cleared desired remote access and publishing. Status confirmed the final signed-out state. [Sanitized command evidence](connect-result.json).

Only status supports JSON in 0.0.38. Login and link are interactive CLI workflows, not structured event streams. Their terminal text must not be treated as authoritative connection state. For implementation, host the unmodified interaction and obtain resulting state through JSON status and authenticated server relay APIs. Never show Connected from CLI exit or persisted status alone.

Hosted authorization, relay acquisition success, environment naming after link, Android discovery/turn/reconnect/revocation, and a Mac are blocked by absent owner sign-in or devices. No failed hosted authorization has established a package restriction; its outcome remains unknown. Continue local work under the owner's explicit instruction, and retain these as release blockers.

## Commands and repeatability

All commands ran from `/home/dillonc/Projects/StrataMD-wt/bundled-t3-server`.

- Install runtime: `npm install --prefix docs/plans/open/bundled-t3-server-2026-09-05/phase-1/runtime/0.0.38 --omit=dev --no-audit --no-fund --save-exact t3@0.0.38 node@24.20.0`.
- Probe: `node docs/plans/open/bundled-t3-server-2026-09-05/phase-1/probe.mjs`.
- Packaged conversation: run that probe with the repository TypeScript loader and `--packaged`. The source client is imported only by this throwaway spike.
- Package: `./node_modules/.bin/electron-builder --linux dir --config.npmRebuild=false --config.directories.output=docs/plans/open/bundled-t3-server-2026-09-05/phase-1/package`, then copy the staged runtime into its resources. Rebuild was disabled to preserve the shared node_modules.
- Usage and Connect: `node` with `phase-1/usage-probe.mjs` and `phase-1/connect-probe.mjs`.
- Browser inspection used a named agent-browser session against CDP 19385 on the disposable packaged app.

## Gate

Run in order: TypeScript passed; Vitest 98 files passed, 831 tests passed and one skipped; Electron build passed; Playwright 187 passed in 1.9 minutes. No failures or retries. Logs remain here as `typecheck.log`, `vitest.log`, `build.log`, and `playwright.log`.

## Findings carried into the plan

Use an allocated nonzero port. Read reported runtime state. Refresh provisional provider status. Classify Codex usage windows by duration. Treat Claude's SDK method as optional and experimental. Host upstream interactive Connect commands while JSON status and live relay state remain authoritative. Remote and macOS results remain explicit release blockers; phase 2 proceeds under the owner's exception.
