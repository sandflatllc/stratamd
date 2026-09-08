# Requests for an owner answer

The selected prompt excluded the reported restart instruction and found every expected request across 52 live scans. These cover 26 examples repeated twice, with 50 expected requests in total and no extra tags. The rule is "Does this request an answer from the owner?" Information, evidence, preferences, choices, approval, and reported results qualify. Instructions that only ask the owner to perform a step do not.

The prompt distinguishes who would act before applying exclusions. "Should I restart Strata now?" requests the owner's approval for the agent to act. "Could you restart the app?" asks the owner to act without requesting an answer. Requests for screenshots and logs count as requests for evidence. A combined operating instruction and request to report back marks the request for the result.

[The 12 new examples](cases.json) cover the reported restart sentence, setup steps, polite action requests, verification without a report, a confirmation button, completed work, a mixed instruction and decision, an imperative preference, agent approval, an explicit result, requested evidence, and a result question. They run alongside the [14 earlier cases](../quote-only-2026-09-07/cases.json). All returned passages were inspected against their intended meaning and source placement; the runner's overlap check alone is not a semantic accuracy test. These are development examples seen during prompt revision, not a blinded holdout or a production accuracy guarantee.

The earlier candidates remain available because they exposed mistakes that a single successful scan would have missed. Their coverage differs where a run stopped early.

| Candidate | Completed calls | Expected requests found | Extra tags | Outcome |
|---|---:|---:|---:|---|
| [First revision](rejected-v1/runs.jsonl) | 52 | 46 / 50 | 1 | Missed the preference and screenshot requests twice each; included one invitation to object to a default. |
| [Second revision](rejected-v2/runs.jsonl) | 27 | 24 / 25 | 0 | Missed restart approval. Stopped during the next call after rejecting the candidate. |
| [Third revision](rejected-v3/runs.jsonl) | 35 | 27 / 28 | 0 | Passed the first complete round, then missed restart approval on its second occurrence. |
| [Selected revision](runs.jsonl) | 52 | 50 / 50 | 0 | All cases matched in both rounds. |

The second revision also retains one intentionally interrupted call. Its missing-answer-file error resulted from stopping that scanner and is excluded from the completed-call counts. Each candidate's directory preserves its exact prompt. The selected [prompt.txt](prompt.txt) includes the empty JSON input used to fingerprint the instruction text; each result row records the actual source, registered requests, returned quotes, resolved positions, model, and prompt fingerprint.

Calls used the production `scanAsks` path and the selected local account's `gpt-5.6-luna` model, with low reasoning effort and fast requested. Production tool restrictions, output validation, deadlines, and process cleanup applied. The selected candidate's median call took 4.37 seconds, its slowest took 8.39 seconds, and its 52 calls totaled 240.25 seconds. These measure invocation through cleanup and exclude application queue delay.

To reproduce, first run `node docs/design/inferred-asks/experiment/quote-only-2026-09-07/build.mjs` to compile the current production imports. Run this directory's `run.mjs` from the repository root with `ASK_EVAL_HOME` pointing to the chosen local account and `ASK_EVAL_OUTPUT` pointing to a fresh directory outside the checkout. `ASK_EVAL_MODEL` optionally changes the model. These commands make real generation calls. Keep output outside the checkout while mechanical verification stages its inputs. The runner stops on a missing or extra request for inspection; use a fresh evidence directory after revising the prompt.

The final code passed the [full verification gate](/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T02-58-41-378Z-e2677efc/report.json): TypeScript, 1,026 unit/integration tests, production build, and 259 Electron tests. No failures or retries occurred. Seven unit/integration tests and seven Electron tests skipped because their managed-runtime or package inputs were not supplied. The report names every skipped scenario. They comprise two engine-upgrade scenarios, stock attachment/connection/lifecycle/settings integration checks, packaged CLI, and the computer-controls, recovery-bindings, recovery, and four managed-engine Electron scenarios.

The gate took 278.1 seconds, including 244.5 seconds in Electron execution and cleanup. It exceeded the provisional four-minute target by 38.1 seconds; there was no queue delay or retry. Verification task elapsed time was 986.1 seconds, including model experiments and gaps, with 319.6 seconds inside mechanical verification commands. An earlier focused attempt refused inputs before testing because the live evaluation log changed during staging. Moving live output outside the checkout resolved that staging problem; the subsequent focused run passed in 34.5 seconds. Both attempts remain under the `ask-answer-required` verification task.

The gate tested an isolated snapshot. The prompt and its PRD/conformance requirements still match that snapshot. Unrelated concurrent explorer changes and their unit/integration tests arrived afterward and are outside this result. This report and the final evaluation artifacts were saved after the snapshot was staged.

The running installed app was not replaced or restarted. This change applies to future scans after installing the updated build; existing saved tags are not reclassified automatically.
