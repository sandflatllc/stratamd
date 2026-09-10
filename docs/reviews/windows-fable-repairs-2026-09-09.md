# Windows review repairs

Implementation and review decisions for the Windows repair pass. Verification results are retained in the task record below.

Review source: Strata thread `e02d4d20-2291-46bc-be67-40a66c6ad79b`, “Windows Support Merge Review”, final findings at 2026-09-09 23:25 UTC. This repair starts from `f4c073e` on master. Dillon authorized useful fixes, committing all project changes, pushing origin, rebuilding and updating the launcher.

## Findings and decisions

| Finding | Decision and evidence |
|---|---|
| Configured provider paths lost leading tilde expansion | Fixed in the shared executable resolver for Unix and Windows paths. The regression resolves an actual executable through a home-relative setting. |
| Windows npm PATH lookup selected a bare POSIX shell script | Fixed. Windows candidates use runnable suffixes and preserve explicit JavaScript entries. Both npm shim parsing and argument preservation have coverage. |
| Claude usage handed a cmd launcher to an SDK that spawns directly | Fixed. The same launcher resolution used by Codex supplies the JavaScript entry to the Claude SDK. A helper-process regression rejects the old cmd path and requires that entry. |
| Every Windows engine health check spawned a PowerShell/WMI query | Fixed. Ownership uses native process creation time plus the canonical executable. The manager separately validates the recorded data folder and authenticates engine adoption. Tests verify shell-free health checks and reject recycled process identities. |
| Adopted Windows engine cannot use its former parent's private shutdown channel | Kept the documented forced shutdown with recovery files preserved. Reconnection would require a new authenticated cross-instance shutdown protocol. This is a known limitation, not a new claim of graceful adoption shutdown. |
| Drive breadcrumb sends a bare drive | The finding missed Browse's existing trailing slash, so the drive request was already rooted. Breadcrumb construction now explicitly preserves drive and UNC share roots and avoids unusable partial network roots. Pure path tests and the existing folder workflow cover the change. |
| Windows verification can leave detached processes alive | Fixed with an unnamed native job using kill-on-close. A bootstrap waits for IPC until it has been assigned to the job, avoiding the spawn-before-assignment race. Command exit closes the job before inherited output pipes can hang; cancellation closes it immediately. Windows-only tests cover exit and cancellation, detached descendants, and an unrelated process that must survive. |
| Windows PTY bundle retains compiler/debug products | Fixed the pruning rule to retain native modules, DLL/EXE runtime helpers, and the ConPTY runtime pair while removing PDB, object and build metadata. This does not claim reproducible Windows binaries; native build reproducibility remains unverified. |
| Terminal account launcher selects itself when first on PATH | Fixed by resolving the actual provider outside the launcher before writing an absolute target. An executable regression puts the launcher first on PATH, refreshes it twice and checks the selected account home and literal arguments. |
| PRD still described only Linux/macOS | Updated the summary and kept Windows release readiness conditional on native verification. |
| Windows font query lacked coverage | Added Unicode, single/multiple/empty, malformed and failed-command cases and a conformance row. |
| Two Known flakes rows lacked full artifact paths | Added direct links to the exact run records. No failure evidence was deleted. |
| Repeated basename and PATH construction cleanups | Deferred broad style consolidation. The repair reuses the executable resolver where behavior was duplicated, without changing unrelated display code. |

The Windows cleanup implementation follows Microsoft's [job creation and close semantics](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw) and [process assignment and child inheritance](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

## Verification and delivery

Task record: `windows-fable-repairs-20260909` under `/home/dillonc/.cache/stratamd-verification/`. The task record retains focused, full, stress, managed and packaged invocations, including failures and skips.

The owner's existing uncommitted test-history row and 49 project review/release files are included by the explicit “commit all changes” instruction. The running Strata process will not be restarted; launcher installation selects the new package for the next launch.
