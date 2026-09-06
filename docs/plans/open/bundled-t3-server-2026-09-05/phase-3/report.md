# Phase 3 report

Status: complete; repository gate passed. September 6, 2026. Work is isolated on `bundled-t3-server` in the authorized worktree.

Settings now controls the engine defaults in the audit. Accounts retains provider management and adds the missing fields, model order, custom IDs, and official provider setup. Strata reads subscription usage itself against the unmodified stock server.

| Area | Result and evidence |
| --- | --- |
| General settings | Local/worktree default, conditional origin, engine-side starting folder validation, settlement switches and days, manual generated model/options, provider update checks. New drafts use the engine default; saved drafts and existing conversations retain their choices. `test/e2e/engine-settings.spec.ts`. |
| Background and source control | Shared profile, four intervals, four pause controls, source-control writing style/instructions/templates, separate writer and model options, Git/service readiness. Window and host signals feed actual stock RPCs. `test/integration/managed-settings.test.ts` verifies lock, battery and low-power policy and restart persistence. |
| Provider settings | Edited-field saves preserve unknown fields, other accounts and masked secrets. Same-field conflicts retain the form and name the conflict. Legacy provider maps materialize every account on first edit. Codex paths/arguments, Claude auto-compaction, Cursor endpoint, OpenCode URL/plain-text password, accent and environment bindings are exercised in `test/e2e/provider-settings-fields.spec.ts`. |
| Models | Favorites, hidden models and order persist in Strata; custom IDs persist in T3. A Claude-only account can choose Claude for generated text through the Accounts pointer. No Automatic choice or silent fallback was introduced. |
| Provider setup | Official pinned npm packages install into Strata's provider folder, using bundled Node/npm. A valid existing tool is preferred. Official login runs with cancellation, bounded lifetime, progress and optional code input. Setup drains current dispatch and refuses active conversations; new turns wait for setup to finish. No global tool is replaced. Unit tests exercise existing-tool preference and owned-child cancellation. Release npm staging is completed in phase 6. |
| Local usage | Real Linux stock-server integration returned Codex weekly 91%, Claude session 0% and weekly 9%. [Exact readings](usage-proof.json), [reproducible probe](usage-proof.ts). The readings have provider reset times and measurement timestamps. No active conversation was started by the probe. |
| Usage isolation | External connections show unavailable usage. Hidden environment bindings are not guessed or read. Measured limits bind to the account identity and configured home; changing account paths clears old limits. `test/unit/local-usage.test.ts` checks normalization, identity mismatch and cancellation. `test/unit/engine-accounts.test.ts` proves busy Codex accounts are skipped and cancellation finishes before dispatch. A turn started by another client also cancels a pending Codex usage reader. |

## Decisions clarified

Stock T3 does not own model ordering or hidden-model preferences. The audit's server keys were corrected; only custom model IDs are server settings. T3 resolves the provider-health interval from its background policy. Its host-state endpoint rejects observations older than the last accepted observation. The runtime reporter retains actual sample timestamps.

T3's settings API has no compare-and-swap revision. Strata serializes its own saves, refetches before replacing collections, and rejects conflicts in edited fields against the displayed snapshot. A write by another client between that refetch and the upstream write is not atomically preventable with this API.

The obsolete whole-provider-map renderer write was removed. All UI writes use the validated edit contract. Failed saves retain entered values; hidden saved secrets never become empty replacements.

## Verification and failures

Final gate passed in order. TypeScript passed; Vitest passed 848 tests with one intentional skip across 107 files; the Electron build passed; all 196 Playwright tests passed at the default worker count. Logs are `typecheck-final.log`, `unit-final-gate.log`, `build-final-gate.log`, and `playwright-final-gate.log`. [Settings capture](captures/settings.png) and [background capture](captures/background.png) were inspected; controls scroll inside the dialog and the action footer stays visible. Gates use the repository binaries directly and an isolated stock runtime supplied by `STRATAMD_ENGINE_BUNDLE`.

The first complete Electron run passed 194 tests and failed only `frameless-window.spec.ts:10`, whose exact menu assertion omitted Settings. A first correction put the item in the wrong order and failed all ten repeats. The corrected order passed ten repeats. Artifacts are saved in `failed-full-1/` and `failed-menu-repeat/`; `repeat-menu-fixed.log` records the clean repeats. This is deterministic assertion drift, recorded under Known flakes as the repository requires.

One concurrent unit run exposed a race in the existing persist-cache fixture: it wrote an agent buffer while the editor's debounced mirror could still be writing. The fixture now waits for the acknowledged buffer and reads it before the next simulated edit. It still checks every persisted object reference across mixed edits, undo/redo and save. A subsequent assertion type mistake compared bytes to text; that was corrected to decode the buffer. These failures are preserved in `unit-fourth.log` and `unit-final.log`.

The second complete Electron run passed 194 tests and found two diagnosed test errors. The generated-model test matched both its outer disclosure and the nested model disclosure; its selector now names the direct child. The existing view-sync test started in Source because its `setSource` helper leaves that view open. Its first Source visibility check could acknowledge the old DOM before either shortcut completed. It now establishes Visual before testing a Source → Visual round trip. Saved artifacts are in `failed-full-2/`. Repeats then exposed the delayed main-process mode acknowledgement; the test now waits for both that acknowledgement and settled renderer layout. Ten exact-line repeats passed before two clean full runs. Artifacts are in `failed-second-repeat/` and `repeat-view-acknowledged.log`.

A real-engine unit run also exposed a reconnect timer firing during the connection switch. The periodic reconnect and config-refresh callbacks now wait for the switch and handle their rejected promises. The failure is preserved in `unit-signoff.log`.

## Blocked proofs

Successful new Codex/Claude login requires the owner's authorization in the provider's browser. No new owner account was signed in by automation. macOS x64/arm64 and Claude Keychain behavior require a Mac. The concurrent-busy Codex query remains unproven; production skips it and preserves the last reading. T3 hosted sign-in and Android turn/reconnect remain phase 1 release blockers and continue into phases 4 and 6.

The owner's T3 and Strata processes, their data, and installed skills were not changed. This phase does not merge the branch.
