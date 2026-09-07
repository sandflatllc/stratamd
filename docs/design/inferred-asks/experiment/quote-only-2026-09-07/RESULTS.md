# Quote-only ask selection, 2026-09-07

The second quote-only prompt found all 38 labeled request opportunities in 28 calls and returned no extra requests. Median elapsed time was 4.49 seconds, with an 11.75-second slowest call. This small development set informed the implementation; it is not a production accuracy guarantee.

| Prompt | Calls | Intended requests found | Extra requests | Precision | Recall | Mean | Median | Slowest |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Earlier two-field candidate | 28 | 38 / 38 | 2 | 95.0% | 100% | 4.89 s | 4.40 s | 7.94 s |
| Quote-only v1 | 28 | 38 / 38 | 4 | 90.5% | 100% | 4.53 s | 4.31 s | 7.41 s |
| Quote-only v2, selected | 28 | 38 / 38 | 0 | 100% | 100% | 5.14 s | 4.49 s | 11.75 s |

The 14 cases contain 19 distinct labeled requests and are repeated twice. They combine the earlier main case set with two distinct follow-up cases. Unlike the older 72-call review, every row here uses the same 14 cases. Case ids and expectations are frozen in [cases.json](cases.json). This is a development set seen during prompt revision, not a blinded holdout.

The first comparison alternated baseline/v1 order by case and repetition, serially. V1 averaged 0.36 seconds faster in paired comparisons; median paired difference was -0.26 seconds, with a range of -2.00 to +1.16 seconds. V1 also added unwanted generic sign-off questions, so that speed result does not establish a useful improvement. V2 adds explicit exclusions for generic sign-offs and invitations to object to an already chosen default. V2 ran afterward, not interleaved with baseline. Its median is 0.09 seconds higher, but this is not a paired estimate of added latency. No production latency threshold was agreed.

## Placement and execution

All 38 accepted v2 requests were manually checked against the labeled intent and their resolved source passages. All 38 marked the request itself, with no missing or ambiguous placement. A substring overlap scorer in [score.mjs](score.mjs) supports that inspection; overlap alone is not a semantic accuracy test. Ambiguous repeated quotes are separately rejected by core tests rather than attached arbitrarily. Baseline restatement quality is not an acceptance criterion for this UI.

Every call used `gpt-5.6-luna`, low reasoning effort, and fast requested through the local Codex account used for the earlier comparison. Requested fast service does not prove the actual server tier. Timings measure subprocess startup through process close, including the model call. They exclude application queue delay. The production queue remains at one active subprocess and one replaceable queued job per thread; concurrent completions can wait behind earlier scans. No latency improvement under such backlog is claimed.

All calls used an ephemeral invocation, ignored user configuration and repository instructions, ran in a private temporary directory, and disabled tools through the installed CLI feature flags. No actual tool events occurred. The CLI emits a Code Mode-unavailable diagnostic even with both Code Mode and its host disabled. The initial event guard misclassified that diagnostic as tool use and stopped after the first otherwise successful baseline call. The classifier was corrected and the run resumed without repeating that call. That original raw record retains its `tools: ["error"]` field and lacks stdout; later records retain stdout. No calls timed out or failed to produce schema-valid results.

An audit found that the first 84 calls passed an empty registered-request list because the experiment read the wrong parser field. Only `mixed-explicit` contains a registered item; its prose still excluded the action block, and it found the additional prose question in every run. After fixing the experiment, two production-shaped v2 calls explicitly supplied that registered request. Both returned only the separate prose request, in 3.94 and 3.57 seconds. These two checks are in [registry.jsonl](registry.jsonl) and are not pooled into the table.

The largest saved source is 5,411 characters. Production refuses sources or registered-request text over 120,000 UTF-16 code units, stdout/stderr over 2 MB, a final result over 1 MB, more than 64 asks, or a quote over 12,000 code units. The 120,000-character ceiling leaves room for long replies but is an operational guard, not a claim of measured long-input accuracy. A 60-second deadline and process-group cleanup bound each invocation. Oversize and failed scans remain Cancelled with a reason, never successful No asks.

## Reproduction

[run.mjs](run.mjs) uses the installed Codex CLI and account selected through `ASK_EVAL_HOME` or `CODEX_HOME`. Build its local imports with `node docs/design/inferred-asks/experiment/quote-only-2026-09-07/build.mjs`. Then run that directory's `run.mjs` from the repository root. `ASK_EVAL_FOLLOWUP=1` selects v2, and `ASK_EVAL_REGISTRY=1` selects the two mixed-request checks. The runner skips existing case/repetition/variant rows. Copy the evidence directory before clearing result files for a fresh run. These commands make real generation calls.

[quote-v1.txt](quote-v1.txt) and [quote-v2.txt](quote-v2.txt) freeze the prompts. The two-field baseline and schema remain in the preceding review folder. Raw prompts, outputs, timings, event logs and source anchors are in [runs.jsonl](runs.jsonl), [follow-up.jsonl](follow-up.jsonl), and [registry.jsonl](registry.jsonl). The experiment does not write conversation state or send anything to project threads.
