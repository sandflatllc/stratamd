# Strata report card

September 8, 2026. Reviewed for Dillon against the needs of a personal tool used for daily work.

## The judgment

Strata is a successful personal product with uneven engineering maturity. You identified a real problem, stayed involved, and built something you prefer to the tool it replaced in about ten and a half days. The code contains careful work on document preservation, private drafts, recovery, and input validation. It also concentrates too much responsibility in a few files, and the development history contains repeated gaps between passing tests and delivering the requested experience.

Your strongest contribution was product judgment and direct feedback. Your biggest opportunity is to make completion and integration less dependent on you catching the last mistake. The agents' strongest contribution was implementing and repairing difficult behavior. Their weakest contribution was consistently proving completeness and keeping the structure manageable as the scope grew.

| What is being graded | Score | Judgment |
| --- | ---: | --- |
| Usefulness to you | 9/10 | It solves your problem well enough to become your daily workspace. This is supported by your usage and stated preference, not an independent study of other users. |
| Code and technical foundation | 7/10 | Substantial working software with good safeguards, meaningful tests, and concentrated maintenance risk. |
| Your orchestration process | 7.5/10 | Strong direction and review involvement. Completion, coordination, and durable handoffs remain weaker. |
| Agents' delivery discipline | 6/10 | They produced valuable code and effective repairs, but too often needed another review to distinguish implemented parts from a finished workflow. |

I would continue investing in this codebase. I would address the specific safety and navigation findings, then simplify the busiest parts before another large expansion. I found no basis for recommending a rewrite.

## How I graded it

The standard is a maintainable personal desktop application that handles important working documents. I did not deduct points for deliberately excluded features such as Windows support, an auto-updater, or a Strata cloud account. The unfinished web annotation workflow gets a separate provisional assessment.

Scores describe engineering judgment, not measured percentages. A 9 means strong evidence and few important weaknesses at this stage; 7 means useful and reasonably dependable with identifiable debt; 5 means recurring intervention or a material gap; 3 means fundamental behavior or evidence is unreliable. The technical and orchestration summaries are their domain means rounded to the nearest half point. Usefulness and delivery discipline are separate judgments, not additional terms in those averages.

I inspected the specification, conformance ledger, implementation, selected tests, development plans, repair reports, Git history, project thread metadata, and selected conversation messages. I ran the full ordinary verification gate, investigated its failure, and reproduced a separate storage race with a disposable file. I viewed the failed Electron recording, a current conversation capture, and the document visual baselines. I did not perform a fresh screen-reader session, desktop performance benchmark, macOS run, provider sign-in, or physical-device test.

The conversation sample covers 12 threads selected around the original specification, implementation, the T3 transition, large reviews, and verification changes. It is a targeted process review, not an exhaustive reading of all conversations or a statistical estimate of agent failure rates. User-role messages include pasted instructions and annotation deliveries; they are not all independently written prompts.

### What the timeline establishes

| Period | Evidence and development stage |
| --- | --- |
| August 28 | The Strata project was created in the thread database at 20:41 UTC. The first thread reviews PRD gaps, usability, and simpler ways to achieve the desired workflow. |
| August 29–30 | Initial implementation, real use, undo, delivery, performance, and collaboration work are visible in the threads. |
| August 31 | The first Git commit records an already substantial Markdown editor. Threads explore extending Strata's reading and annotation behavior into T3 conversations. |
| September 3–4 | The cockpit implementation replaces the old agent connection model. Reviews uncover missing workflows and lost test coverage, followed by repairs and UI parity work. |
| September 5–6 | The application gains the bundled T3 runtime, terminal and provider integration, and visual review. A post-merge review finds defects that the ordinary tests missed. |
| September 7–8 | Work concentrates on transcript behavior, inference, verification isolation, navigation, annotations, and the daily interface. |

The initial inventory contained **205 Strata threads, 1,252 user-role messages, and 5,468 assistant messages**. There were 158 commits at the initial reviewed HEAD. That supports your description of close involvement and a project built in less than two weeks. It does not establish token cost, efficient model choice, or how much less time another process would have taken.

## The technical report card

| Domain | Score | Confidence | Why |
| --- | ---: | --- | --- |
| Architecture and ownership | 6.5 | High | The main process, editor, renderer, core logic, and engine have recognizable roles. Too much cross-feature coordination still passes through the application and engine client. |
| Maintainability and simplicity | 5.5 | High | Several central files have accumulated unrelated state and behavior. Small interaction changes repeatedly touch these same places. |
| Document safety and recovery | 8 | High for inspected paths | Byte preservation, private storage, atomic replacement, recovery records, and conservative handling of unreadable stores are real strengths. The demonstrated save race prevents a stronger grade. |
| Sending context and engine integration | 7.5 | Medium–high | Persisted preparation, explicit selections, stable delivery IDs, and acknowledgment handling are well considered. Real-runtime and future-upgrade proof remain narrower than ordinary tests. |
| Security boundaries | 8 | Medium | Sandboxed renderers, sender and argument validation, restricted resource loading, and guest permission controls are implemented. This was a code review, not a penetration test or dependency-vulnerability audit. |
| Test quality and confidence | 7.5 | High | Many tests protect important behavior, including restart, ownership, byte preservation, and failure cases. The current ordinary gate failed once, and history shows tests have sometimes proved less than completion reports implied. |
| Performance and resource control | 6.5 | Medium | The transcript allocator, layout coordination, worker image encoding, and diagnostic lab show deliberate work. Current desktop budgets and everyday verification timing are not yet established. |
| Usability and accessibility | 7.5 | Medium | Rich reading, anchored feedback, keyboard actions, and dialog focus handling support the product's purpose. A navigation reversal was observed; screen-reader and broader-user usability remain untested here. |
| Installation, operation, and release | 7 | Medium | Runtime staging, ownership checks, backup retention, and isolated package output are substantial. Current cross-platform release evidence is incomplete, and publishing is not explicitly dependent on the complete check workflow. |
| Specifications and durable documentation | 6.5 | High | The PRD, scenario ledger, and repair records preserve useful intent. Some statements contradict current implementation, and historical evidence is not always portable. The README was corrected during this review. |

The average is 7.05, reported as **7/10**. These scores are not independent enough to treat that number as a precise measurement.

### Architecture and maintainability

The problem is concentrated responsibility, not simply file length.

| File | Lines in the reviewed product | Responsibilities that make changes harder |
| --- | ---: | --- |
| [Application](../../src/main/application.ts) | 4,249 | Documents and review state, themes, provider setup, engine lifecycle, previews, settings, and publishing application state. |
| [Engine client](../../src/main/engine/client.ts) | 2,670 | Connections, accounts, model selection, usage, terminal streams, conversations, uploads, visual comments, and delivery recovery. |
| [Application UI](../../src/renderer/App.tsx) | 1,177 | Workspace navigation, document and conversation placement, previews, dialogs, theme controls, and asynchronous state adoption. |
| [Editor integration](../../src/editor/index.ts) | 1,794 | ProseMirror integration and a large set of document interactions. |

The TypeScript inventory contains 272 files and 56,288 lines, with nine files over 1,000 lines. Those totals include adapted or vendored terminal code. Two of the large files belong to Ghostty, and another contains shared contracts. It would be misleading to call all nine equally problematic or all 56,288 lines newly invented Strata code. The [terminal provenance record](../../src/renderer/terminal/README.md) identifies the reused code and licenses.

The growth is clearer in code Strata owns. The application file was already 2,707 lines in the first commit. The UI root grew from 301 to 1,177 lines. The engine client grew from 1,112 lines at the September 4 audit checkpoint to 2,670. The issue predates the final polish and became more expensive during the transition.

There are good counterexamples. [Connection operations](../../src/main/engine/connection-operations.ts) gives engine switching a clear boundary. [Transcript allocation](../../src/renderer/transcriptAllocator.ts) states which editors consume capacity and which must remain available. These modules own an understandable rule instead of distributing it across unrelated handlers.

My recommended structural work is specific. Give workspace navigation one owner that distinguishes the user's latest request from delayed document updates. Move theme persistence and lifecycle out of the application coordinator. Separate outbound delivery preparation and recovery from account, terminal, and connection work in the engine client. Preserve the existing connection-change barrier and durable delivery IDs. Measure success by fewer places coordinating the same transition, not by the number of new files.

A smaller boundary issue illustrates the drift: [core asks](../../src/core/asks.ts) imports the conversation-state type from the main-process persistence module, while that module imports normalization from core. The reverse import is type-only, so this is not a demonstrated runtime cycle. The shared state contract belongs in a neutral location.

### Document safety deserves credit, with one important limit

The implementation does more than serialize the visible editor contents. The [Markdown serializer](../../src/core/markdown/serializer.ts) reuses original source for untouched blocks. [Storage](../../src/main/storage.ts) writes temporary files, syncs them, replaces the target, preserves file modes when requested, and maintains content-addressed document history. [File handling](../../src/main/files.ts) checks disk content for conflicts and detects invalid UTF-8 without silently rewriting it.

The tests exercise these mechanisms. This is substantive engineering that matters for a tool allowed to save your plans.

The separate race proof calls the actual save helper with a temporary file. It makes an external writer finish after the final target read but before the replacement rename. The helper reports `saved`, and the file contains the owner's save rather than the external update. The existing file conflict test checks a write that happens before Save begins, which is a different ordering.

This establishes a narrow overwrite window. It does not establish its frequency in daily use or prove that all surrounding application recovery mechanisms fail. The PRD's claim that the hash check catches an external write racing Save is too broad. A repair should explicitly define the guarantee for cooperating agents versus arbitrary outside editors and address preservation of a displaced version. Another earlier hash check would leave the same final gap.

The [reproduction](strata-report-card-2026-09-08.evidence/save-race-proof.mjs) and [result](strata-report-card-2026-09-08.evidence/save-race-result.json) are retained. The proof changes only a disposable file and temporarily intercepts file reads inside its own process.

### Integration and security are stronger than the file structure suggests

[Conversation delivery](../../src/core/conversation-delivery.ts) validates immutable message anchors and refuses changed source. The engine client persists prepared commands and selected feedback before dispatch, tracks acknowledgment, and restores interrupted work. These choices protect the meaning of Send and the privacy of held drafts.

The [IPC layer](../../src/main/ipc.ts) checks the sender and validates bounded request shapes. [Application protocols](../../src/main/protocols.ts) restrict document resource loading. [Preview guests](../../src/main/preview/guest-policy.ts) have a limited permission policy, and their host creates sandboxed, context-isolated views without Node integration. That is a credible defensive foundation for handling agent text and web pages.

The security score does not mean every permission boundary was attacked, every dependency is free of vulnerabilities, or every external engine configuration is safe. None of those conclusions follows from this review.

### Test quantity and proof quality are different

There is meaningful evidence here: corpus preservation, persisted drafts, Lead ownership, engine reconnection, failed uploads, visual evidence retention, and real application restarts. The [verification runner](../../scripts/verification/run.mjs) also stages an isolated candidate and retains failures, so another session can no longer silently replace its build inputs.

The history nevertheless contains a major lesson. During the cockpit transition, tests covering retained behavior were deleted, and working entry points such as pairing and starting an attached thread were missing despite a passing gate. The corrective work restored coverage and connected the missing flows. This is evidence of an earlier delivery failure, not a claim that those features are still missing.

The [September 6 review](../plans/open/review-bundled-engine-and-visual-review-2026-09-06.md) provides another example. A renderer screenshot omitted native browser views, and a permissive fake server missed a required stock-server snapshot field. Later work added native composition evidence and a [stock schema check](../../test/fixtures/stock-preview-schema.ts). I also checked that current visual-store loading preserves unreadable data and prevents destructive sweeping; the historical image-deletion finding is not being repeated as a current defect.

The practical question for each new test is, "Would this fail if the actual workflow were broken in the way we care about?" A green test count cannot answer that by itself.

### Performance and release confidence have limits

The [performance lab](../../test/performance/README.md) is diagnostic, and budgets do not fail its runs by default. That is honestly documented. The transcript allocator normally targets eleven rich editors, permits required pinned content to exceed the limit, and manages preparation and retention. These are sensible controls, but they are not a current desktop benchmark.

Before this audit added its own verification task, the history tool reported only two completed routine tasks in the new observation set. Their median was 11 minutes 49 seconds and their slowest was 16 minutes 26 seconds, including gaps and repeated work. That sample is too small to establish everyday performance, but it supports your distinction between a short successful suite and a long development wait. The new process's four-minute routine target remains provisional.

The latest hosted check visible through GitHub was an [August 31 success](https://github.com/sandflatllc/stratamd/actions/runs/33450806803), before the cockpit and bundled-engine changes. The current [check workflow](../../.github/workflows/check.yml) defines Linux, macOS, managed-runtime, and package checks; its existence does not prove that today's candidate passed them. The [release workflow](../../.github/workflows/release.yml) publishes after its packaged check and has no explicit dependency on the complete check workflow. This is a release-process gap, not evidence that your current local application cannot run.

The [engine packaging record](../../packaging/engine/README.md) explicitly leaves provider sign-in, some macOS, hosted authorization, and physical-device proofs open. It also correctly limits upgrade claims to the versions actually exercised. I did not deduct points for intentional lack of signing or an auto-updater.

### The unfinished web workflow

Its provisional grade is **5.5/10 for polish and demonstrated reliability**. It already has substantial implementation: separate tabs, captures, marks, delivered evidence, comparisons, and adjustment handling. Your statement that it is the least-tweaked workflow is consistent with the repair history.

The failure found here crosses the theme panel and preview navigation. Opening Theme starts an asynchronous request to open its sample document. The user can select the preview before that request finishes. In the failed trace, the preview is visible first, then the sample document becomes active and replaces it. The UI's [state adoption](../../src/renderer/App.tsx) clears the centered preview when it sees a newly active document, without distinguishing that older request from the newer preview selection.

The test then reads a missing preview bounding box. Better waiting would make the test safer, but waiting for the sample before allowing any preview selection would also avoid the ordering that exposed the product behavior. The user-facing repair is to keep an older asynchronous request from overriding newer navigation.

Three focused repetitions passed. They do not resolve the original failure. The trace and relevant code support the mechanism above; a controlled delayed-completion regression is still needed before calling it fixed.

## Your orchestration report card

This grades the process you assembled and operated. It does not assign every implementation defect to you or expect you to write code.

| Domain | Score | What the evidence says | What would raise the score |
| --- | ---: | --- | --- |
| Product judgment | 9 | You repeatedly defined the desired interaction, challenged cuts that damaged it, and connected the work to your daily use. | Preserve this habit. State the end-to-end experience before discussing implementation phases. |
| Feedback and iteration | 9 | You used the product, noticed visual and behavioral mismatches, and supplied specific corrections. | Turn recurring corrections into one controlled regression instead of personally checking them forever. |
| Scope evolution | 8 | The expansion follows a coherent need: read agent output, respond to a passage, then do that throughout your work. The result has demonstrated personal value. | At a major expansion, explicitly name what is retired, what changes ownership, and what must keep working. |
| Task framing and delegation | 7.5 | Kickoffs often name the spec, references, worktree, compaction behavior, and required evidence. | Make the current completion boundary and responsible integration owner explicit in every handoff. |
| Independent review | 8.5 | Separate reviews found important omissions, challenged plans, and led to repairs. You explicitly required screenshots for visual claims. | Put a real end-to-end demonstration before broad integration, so review finds fewer basic omissions afterward. |
| Concurrent work coordination | 6 | Saved reports document competing suites and changing build inputs. The newer isolated runner addresses the demonstrated causes. | Require every heavy run to use the coordinator and give each shared integration step one owner. |
| Verification management | 6.5 | You challenged worker-count changes, low-value repeats, and misleading timing. The process improved in response. | Require failures, skipped coverage, input identity, and total task time in the completion record. Track whether the new rules actually reduce waiting. |
| Acceptance and durable handoff | 5.5 | Missing workflows and deleted coverage reached post-merge review. Some specification statements and old evidence paths still drift from the product. | Close each feature with its actual working flow, evidence limits, deferred work, and corrected durable documentation. |

The average is **7.5/10**. Confidence is high about the observed strengths and incidents, and medium about how representative the selected threads are of all your work.

### What you did well

You were involved in mechanisms, not just appearance. In the first PRD discussion, you separated sending context from saving the file, challenged uncertain attribution, and asked how agents could review unsaved edits. During implementation, you identified that repeatedly resending all context would waste tokens and overwhelm agents. Those are product and system decisions with direct implementation consequences.

You also asked agents to inspect existing work before proposing replacements and treated the design handoff as material to reuse. The later terminal reuse and decision to rely on the official T3 engine are consistent with that approach. The project has substantial scope, but it did not rebuild the agent runtime from scratch.

Your separate reviews were valuable. The record shows you checking whether plans were clear enough to implement, passing one model's findings to another, and demanding actual screenshot inspection. Those actions caught failures that implementation tests had missed.

### Where your process cost you time

Too much final integration knowledge remained in your head. You knew what "T3 replacement" had to feel like. Agents could complete a group of components and tests without demonstrating that complete experience. Your next prompt became the missing acceptance check.

Some handoffs also had different scopes. The original cockpit kickoff explicitly said to start phases 1 and 2, and its completion report honestly named those phases. That report alone is not evidence of an agent falsely claiming all eleven phases were finished. Later records do document claimed phases 3–11 with missing behavior. Keeping these incidents separate matters for fair attribution.

Your next improvement is not to write a longer specification. It is to make the handoff state unmistakable: the current task is a partial phase or a usable complete feature; the implementing agent owns the integration or names who does; and any deferred criterion remains visible at completion.

The same applies to verification. A requirement in prose did not prevent agents from changing worker counts or repeatedly accepting a passing rerun. The new runner is stronger because it controls inputs, scheduling, evidence, and reuse. This is a useful lesson for your larger project: when a rule keeps being violated, ask what tool can enforce it or expose the violation.

## How well the agents performed

The agents were capable implementers and effective repairers. The evidence does not support treating their completion reports as reliable without independent checks.

Their code includes careful handling of interrupted delivery, retained image evidence, engine identity, byte preservation, private drafts, and cancellation. Their repairs include controlled reproductions of ordering bugs and a verification runner that directly addresses prior failures. That work earns the technical grade.

Their delivery discipline earns the lower **6/10**. The reviewed history includes stubs behind finished-looking controls, deleted tests for behavior that remained, visual claims based on incomplete screenshots, and external integration claims supported only by permissive fixtures. These are substantive shortcomings. Some happened despite explicit instructions about the required experience and evidence.

I would divide responsibility this way:

| Situation | Primary responsibility |
| --- | --- |
| A clear requested workflow is omitted or represented by a stub | Implementing agent. |
| A completion claim relies on evidence that cannot establish the claimed behavior | Agent making the claim, with the review process as the next defense. |
| Several sessions contend for shared builds or test resources | Coordination design, plus agents that bypass the established mechanism. |
| A useful product grows faster than its internal structure is simplified | Shared process issue. Agents should identify the structural cost before it compounds; you decide when to fund that work. |
| The owner changes a preference after using a working feature | Normal iteration. It is not automatically an agent failure or poor planning. |

I cannot fairly rank model families or score token-cost efficiency from this evidence. Git authorship does not identify who originated each decision, and user messages sometimes contain another agent's proposed instructions. This is an assessment of the combined agent work and its operating process.

## The changes that would improve the next project most

| Priority | Change | What you should require as evidence |
| --- | --- | --- |
| 1 | Resolve the demonstrated save race and the preview navigation reversal. | A controlled reproduction of each ordering, the intended guarantee, and a regression that fails before the repair. The existing passing full-suite results cannot stand in for these cases. |
| 2 | Make feature completion visible in the real application. | A short demonstration from the user's starting point through the final persisted result, including one relevant failure or restart case. State which parts are complete and which are still open. |
| 3 | Simplify navigation and outbound delivery ownership before expanding them again. | A before/after explanation of who owns each transition and which duplicated coordination disappeared, with the affected existing behaviors preserved. |
| 4 | Keep heavy verification inside the isolated runner and measure entire tasks. | The saved candidate identity, failures, skips, repeats, and elapsed time. Continue the ten-task observation; exclude this audit from routine-change timing claims. |
| 5 | Close the durable documentation and release evidence with the implementation. | Update the PRD and scenario ledger, retire contradictory statements, and make public publishing depend on the intended complete checks. Keep device-specific gaps explicit. |

For ordinary work, the completion handoff can stay short. It needs the resulting user behavior, the candidate tested, the evidence, and anything still unresolved. Large features need that same information for each important workflow. You should not need to reconstruct it by comparing several threads.

The most valuable habit to keep is using the product and insisting that it match the workflow you intended. The habit to reduce is acting as the final integration detector for every agent. Strata shows that your judgment can produce a useful product. The next step is making more of that judgment survive the handoff without another intervention from you.

## Verification and evidence record

| Check performed for this review | Result |
| --- | --- |
| TypeScript | Passed. |
| Default unit and integration tests | 1,039 passed; seven skipped. |
| Production build | Passed. |
| Default Electron projects | 261 passed; one failed; seven skipped. No retries. |
| Exact failing Electron scenario, three focused repetitions | Three passed. This does not clear the original failure. |
| Controlled storage interleaving | Reproduced an external update overwritten after the final hash read. |

The full command took **345.2 seconds**, including staging and cleanup. The focused command took **30.9 seconds**. The recorded task interval through focused completion was **445.2 seconds**, including the gap. This audit is not a routine feature-change timing sample.

The seven default unit/integration skips cover two engine-upgrade scenarios, managed attachments, managed connections, managed-engine startup, managed settings, and the packaged CLI. The seven Electron skips cover computer controls, two recovery scenarios, and four managed-engine scenarios. Their full titles are in the [evidence manifest](strata-report-card-2026-09-08.evidence/manifest.json). Managed-runtime, packaged, stress, macOS, physical-device, and live-provider checks were not run for this review.

The full candidate was staged from `022ef9c` plus the working changes already present. Another session committed `576a3a1` during the review. Comparison of the two retained candidates found differences only in `README.md` and `docs/readme/02-workspace.md`; product code and tests matched. The report accounts for the new README and does not present its superseded description as a current defect.

One current documentation contradiction remains concrete: PRD §6.9 describes model-based ask generation, while §13 still says inference uses punctuation and list shape and a model extractor is unnecessary. That is a handoff problem even though the implemented feature may work correctly.

The full gate is **not clean**. Its original failure remains retained and unresolved. The focused result is diagnostic evidence, not a replacement full gate.

Local records:

- [Full verification report](/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T08-32-29-935Z-65d660e0/report.json).
- [Focused verification report](/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T08-39-24-203Z-c0ab79d4/report.json).
- [Selected failure frame](strata-report-card-2026-09-08.evidence/preview-navigation-failure.jpeg), showing the theme sample after the preview selection. The original trace remains with the full run.
- [Evidence manifest](strata-report-card-2026-09-08.evidence/manifest.json), containing snapshot identities, skips, thread sample identifiers, inventory, and investigation limits. It does not export the full private conversations.

This review created only the report and its supporting evidence. It made no product fixes, commits, branch changes, or changes to the running application.
