# T3 additions in Strata

Status: all 15 features integrated; full verification and installation in progress. This report is not a release signoff yet.

All 15 additions from the [ranked report](../reviews/t3-recent-additions-ranked-2026-09-08.md) are in scope. The [implementation task list](../plans/open/t3-additions/implementation-task-list.md) records each feature, dependency, source reference and acceptance check. Astra agents implemented independent work in detached worktrees; shared behavior was combined serially on the existing master checkout.

## Implementation record

| # | Addition | Feature commit | Focused evidence |
| --- | --- | --- | --- |
| 1 | Engine-reported usage windows and reset credits | `49a52f5` | [Usage](../plans/open/t3-additions/evidence/feature01/) |
| 2 | Native asynchronous questions and dismissal | `fd5f92c` | [Questions](../plans/open/t3-additions/evidence/feature02/) |
| 3 | Original binary attachments and durable retry | `34b98ee` | [Attachments](../plans/open/t3-additions/evidence/feature03/) |
| 4 | Updated engine, streaming, replay and terminal bounds | `c793d31` | [Runtime migration](../plans/open/t3-additions/evidence/feature04/migration-verification.md) |
| 5 | Opt-in continuation after managed restart | `3876261` | [Recovery](../plans/open/t3-additions/evidence/feature05/) |
| 6 | Native context compaction | `521a93f` | [Compaction](../plans/open/t3-additions/evidence/feature06/) |
| 7 | Separate files and screenshot markup per answer | `8038f94` | [Answer files](../plans/open/t3-additions/evidence/feature07/README.md) |
| 8 | Browser screenshot and recording delivery | `caf7619` | [Browser evidence](../plans/open/t3-additions/evidence/feature08/) |
| 9 | Searchable commands and skills | `fdf8380` | [Commands](../plans/open/t3-additions/evidence/feature09/) |
| 10 | Computer and project defaults with inheritance | `1e4a1b9` | [Defaults](../plans/open/t3-additions/evidence/feature10/) |
| 11 | Unsent draft markers and scoped discard | `496328e` | [Drafts](../plans/open/t3-additions/evidence/feature11/) |
| 12 | Native Codex and Claude history import | `d040332` | [Import](../plans/open/t3-additions/evidence/feature12/) |
| 13 | PDF and isolated HTML previews | `d195588` | [Documents](../plans/open/t3-additions/evidence/feature13/README.md) |
| 14 | External window capture and optional accessibility text | `7d6113a` | [Capture evidence](../plans/open/t3-additions/evidence/feature14/) |
| 15 | Structured custom models and supported options | `3c75ea6` | [Models](../plans/open/t3-additions/evidence/feature15/) |

Each visual implementation uses the [revision 2 benchmarks](../design/t3-additions-2026-09-08/v2/benchmark-guide.md), existing Strata components and the default Strata theme. Historical owner approvals remain intact. Corrections to impossible or misleading fixture behavior are recorded separately in that guide. Actual screenshots distinguish changed controls from native page/file contents. Screenshot comparison does not substitute for protocol and delivery checks.

## Comparison with T3

The [upstream contract audit](../reviews/t3-additions-upstream-contracts-2026-09-08.md) uses pinned source `08463e2c401ce87858aaaebcb70ed86fb002fb5f`. The bundled engine is the official `0.0.41-nightly.20260909.1426` artifact with the authenticated upstream #10777 replay-memory backport. The package lock and source metadata identify the exact artifact and patch.

Strata calls T3's existing question, file-upload, compaction, settings, history-import and browser-host contracts. It retains its own document, draft, visual review and delivery behavior. Native server claims were checked separately where a fixture could conceal a mismatch:

- Actual old-runtime migration changed schema 43 to 49 while preserving synthetic messages, settings and a pending native question. Backup restore reopened the old runtime and matching records.
- Managed continuation was tested both off and on with the actual bundled server and a synthetic provider peer. Repeated reconnects did not create additional continuation turns.
- Native Codex and Claude history import preserved four UTF-8 messages and original source bytes. Repeating import added no events or provider turns. The result exposed that T3's successful count includes already-present conversations; Strata's copy and retry totals were repaired.
- [Real browser MCP calls](../plans/open/t3-additions/evidence/feature08/upstream-smoke/README.md) saved a PNG in the engine's directory and claimed a byte-identical WebM into the thread's attachments through Strata's registered browser host.

These proofs use disposable accounts, source files and app profiles. They do not claim a paid provider turn, reset-credit redemption, hosted sign-in, phone pairing or native macOS execution.

## Integration repairs

Repairs have separate commits from their feature implementations:

| Commit | Result |
| --- | --- |
| `e640626` | Binary upload recovery appears above the composer, matching the benchmark. |
| `217efd1` | Defaults tabs use Strata's defined primary theme color. |
| `725d854` | Browser evidence card text follows conversation zoom. |
| `ba10e78` | Compaction popup and notice text follow pane zoom. |
| `7604786` | Import totals match actual T3 outcomes; Import lives in Add project and the narrow header remains usable. |
| `b35a3d7` | Document preview uses the existing inset toolbar and benchmark error spacing. |
| `3691eb5` | Private and submitted answer files open the actual PDF/HTML preview; the source view uses the defined font token. |
| `d617c24` | Matching T3 answer history confirms a lost receipt and clears the maintenance block without resending. |
| `4d74fe4` | Held answers use the benchmark count and Review row; removal preserves the private draft. |
| `12e24d0` | Exactly eight combined files can send; visual comments do not consume a nonexistent context-file slot. |
| `036f28a` | Capture chips match the benchmark; preview panels use theme tokens and test imports follow the shared fixture. |

All feature commits and behavior repairs are integrated. Final verification remains pending.

## Final verification and installation

Pending the complete candidate: full TypeScript, default unit/integration tests, production build and default Electron tests; lifecycle stress; managed runtime checks; packaged checks; isolated package launch; then launcher update. Each run retains failures, diagnosis, skipped test names, input identity and timing. Focused checks are not a substitute for this final gate.

The existing installation stays available until the replacement package passes. The owner’s running app is not restarted during this work.
