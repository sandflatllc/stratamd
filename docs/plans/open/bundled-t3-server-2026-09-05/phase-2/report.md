# Phase 2 implementation

Status: phase 2 complete. Repository gate and eight-worker verification passed.

Strata now launches its own staged stock server and pairs automatically. Existing external credentials preserve external mode. The managed process has an exclusive ownership lock, verified pid incarnation and executable, a dedicated data directory, private bootstrap pipe, authenticated readiness, bounded recovery, rotated logs, and explicit shutdown. The shell remains available during startup and failure. Closing a managed window keeps its engine in the tray; quitting stops it. Runtime staging preserves relative dependency symlinks.

The [identity inventory](engine-identity.md) records each store and its isolation rule. Connection changes preserve the previous credential, queues, account preferences, document thread attachments and Lead, drafts, and project defaults. A renderer reload initializes the selected storage scope before rendering conversations. History stays in the document, while historical conversation links are suppressed for another engine. Active turns prevent engine changes.

The Electron harness remains external by default. Managed specifications run serially with `STRATAMD_ENGINE_BUNDLE` pointing at the stock runtime from phase 1. The normal scenarios use disposable profiles. Recovery scenarios now quit cleanly before cleanup because deliberately killing Strata leaves its detached engine available for adoption.

## Verification

Current revision: typecheck passed; Vitest 103 files, 840 tests passed and one existing skip; full Playwright 190 passed in 2.4 minutes at the four-worker default. Logs are `types-reply.log`, `unit-reply.log`, `build-reply.log`, and `playwright-reply.log`. The eight-worker, twice-repeated run passed all 380 checks in 4.2 minutes (`stress-reply.log`).

Failed runs are preserved and listed in `test/e2e/README.md`. Pairing reload, legacy credential renewal, ambiguous selectors, staging cost, and fixture cleanup were diagnosed and corrected. The failed stress run overlapped another worktree's full Electron suite; the host reached load 49 on 16 CPUs. Repeated load failures prompted the required worker reduction from six to four, without changing timeouts. Native modules are verified once before the staged runtime's atomic rename.

A later inference test exposed an actual reply-composer race: completion of an earlier save cleared a subsequently opened draft. The composer now clears only the exact draft object it submitted. Ten explicit repeats passed after that fix. The original three regressions passed 30 repeats. The later switching assertion passed ten repeats after its navigation fix; adoption passed ten. The stress failures passed 30 repeats, and the later load failures passed 40 repeats. The isolated visual save observation remains an open bug with saved evidence; it has not recurred in explicit repeats or the latest clean full run.

macOS native launch, menu-bar behavior, and device-dependent checks remain blocked by unavailable hardware, as recorded in phase 1. No owner app was restarted or stopped, and this work did not change the owner's application data or master checkout. Phase 3 settings, phase 4 remote access controls, and phase 6 distribution/rollback remain separate work.
