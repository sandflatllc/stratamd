# Inferred questions: accuracy and elapsed time

Use the narrower offer wording as the next implementation candidate, together with deduplication, finding additional prose asks beside explicit items, and a flexible question-length limit. The first revision removed extra questions without a clear latency penalty but sometimes suppressed a real direct question. The narrower wording caught those direct questions in a targeted follow-up at 0.24 seconds more per call on average. It still occasionally included a conditional offer, so it is not a perfect classifier.

All 72 calls are complete: a 48-call main comparison and a 24-call targeted follow-up. Fourteen distinct replies were used across the two stages. The two stages use different case sets and must not be pooled into a single accuracy or latency comparison.

The calls use gpt-5.6-luna, low effort, and the fast service-tier flag. The model and output schema stay fixed. Timings include CLI startup, network and model time, and writing the output. These are measured results from this machine and account on 2026-09-07.

## Main comparison

Twelve replies, two passes, two prompts: 48 calls. Eight replies are synthetic and four are unedited StrataMD messages. There are eighteen distinct target requests, yielding thirty-six opportunities per prompt over two passes. Expected answers were written before the calls. Prompts alternate order within matched cases; calls run sequentially.

| Measure | Current plan prompt | First revision |
|---|---:|---:|
| Intended requests identified | 36 / 36 | 35 / 36 |
| Extra rows | 14 | 0 |
| Selection precision | 72.0% | 100% |
| Selection recall | 100% | 97.2% |
| Replies with exactly the expected request set | 15 / 24 | 23 / 24 |
| Median elapsed time | 7.02 s | 6.32 s |
| Mean elapsed time | 7.31 s | 6.85 s |
| Slowest call | 11.59 s | 14.08 s |
| Failed calls | 0 | 0 |

Selection accuracy means identifying the intended request, not proving that its shortened wording and highlight are perfect. Every returned quote existed verbatim in its source reply. One revised output identified the right decision but highlighted a nearby descriptive sentence; the selection count includes it, and the anchor defect is recorded separately.

The revised prompt averaged 0.46 seconds less per matched call. It was faster in fourteen of twenty-four pairs. Variation and the slowest revised call argue against claiming a reliable speed improvement. The result supports "no obvious extra latency in this test," not a speed guarantee. The prompt grew from 199 to 259 words; reported average output tokens, including reasoning, fell from 205 to 163. Fewer returned rows are a plausible contributor, but this experiment does not isolate that cause.

## What improved and what broke

The current prompt's fourteen extra rows were nine conditional or declarative offers, two repeated requests, two requests already registered in a strata block, and one rhetorical "Sounds good?". The first revision returned none of them.

Both prompts found requests that did not block other work, the two real decision questions formatted as numbered headings, and a real unresolved decision stated without a question mark. Both ignored answered questions, quoted examples, and instructions inside the synthetic code block.

The first revision missed the real question "Want me to write that up as a plan file before touching code?" once in two runs. Its broad exclusion of optional offers is a plausible cause. The same prompt caught it on the other run, so the failure is intermittent.

The request-only policy is an experimental product choice. A direct request for input counts even when the work is optional. A declarative offer or an invitation to object to an existing default does not. This deliberately changes the older long reply's labels: the shipping-order invitation and optional spans are excluded. These percentages are conditional on that policy. They are not universal measures of usefulness.

## Questions read on their own

Allowing a longer restatement helped the worktree choice. The current prompt twice returned "Which worktree fence option should I implement?" The revision named the available choices in both runs. Mean time on that case was 7.75 seconds for the current prompt and 7.93 seconds for the revision.

It did not reliably preserve every condition. For the billing reminder case, the current prompt dropped the undisputed-account reminder schedule once and the paid-account restriction once. The first revision preserved the schedule both times but dropped the paid-account restriction once. Both revised export questions named all three formats but omitted that images belong beside the Markdown files for the first two options. Mean time on this two-question case was 6.25 versus 7.00 seconds.

Both prompts also produced "the recommended fix" for the real plan question, without naming transcript scrolling. A short question remains a summary. The answer flow should display the original request and surrounding alternatives, rather than depend on that summary carrying every condition. That UI change was not implemented or timed here.

## The explicit-item gate has a different cost

The model comparison sends the mixed explicit/prose reply to both prompts. The current plan's application gate would instead skip it entirely, losing the additional prose request. The revised prompt correctly returned only the additional request in both runs.

Removing that gate adds a call where the plan currently makes none. On this case the revised call averaged 5.67 seconds. That is an extra background call for those replies; it is not covered by saying that the revised prompt itself has similar latency. Application integration and duplicate handling were not tested.

## Targeted follow-up

The narrowed prompt explicitly includes direct questions about optional work, such as "Want me to ...?" It excludes declarative offers such as "I can ..." when no question or request is made. It also asks for the quote to contain the request itself, rather than a sentence describing an alternative.

Six cases ran twice per prompt: four previously tested cases and two new synthetic cases. The new cases contrast a direct question about making a recording with declarative offers. This is a development check after observing the main results, not a fresh full validation set.

| Measure | First revision, rerun | Narrower wording |
|---|---:|---:|
| Intended requests identified | 20 / 22 | 22 / 22 |
| Extra rows | 1 | 1 |
| Replies with exactly the expected request set | 9 / 12 | 11 / 12 |
| Median elapsed time | 7.12 s | 6.48 s |
| Mean elapsed time | 7.33 s | 7.57 s |
| Slowest call | 10.38 s | 12.23 s |
| Failed calls | 0 | 0 |

The first revision missed the new recording question in both runs. The narrower wording caught it in both. Both prompts caught the original plan question in both follow-up runs, and both correctly returned nothing for the new declarative-offer reply. Each prompt included the conditional shipping-order invitation once, contrary to the frozen request-only policy. This is the remaining observed selection error.

The narrower wording added 0.24 seconds on average in paired calls, with a median paired difference of 0.14 seconds. It was faster in five of twelve pairs. Its lower overall median does not mean every matched case was faster. There is no evidence here of a multi-second systematic overhead from the wording change, and too little data to claim the small difference will hold in production.

The revised anchoring instruction returned the actual placement request in both follow-up runs. The previous prompt also anchored that request correctly in both reruns, so the follow-up does not establish that the new instruction alone fixed the earlier defect.

The longer prompt still dropped the paid-account condition once and the images-beside-Markdown detail in both complex export answers. Keep the original passage available when answering. Increasing the word limit is useful but insufficient protection against lost meaning.

The [narrower prompt](follow-up/revised.txt), [follow-up method](follow-up/METHOD.md), [all scored rows](follow-up/scored.json), and [raw timings](follow-up/out/runs.jsonl) are saved. It has not been rerun over all twelve original cases; its favorable selection result applies to these six cases.

## Evidence and limits

This is a small targeted set, selected to expose specific problems. It does not estimate production error rates. The same reviewer wrote the synthetic labels and evaluated the output. No model graded its own answers.

- [Method and frozen scoring policy](METHOD.md)
- [Input replies and expected requests](cases.json)
- [Current prompt](baseline.txt) and [first revision](revised.txt)
- [All scored rows](scored.json), [manual semantic and anchor notes](manual-review.json), and [timings](out/runs.jsonl)
- [Reproducible runner](run.py), [scorer](score.py), and [environment](environment.json)

The calls used no tools. Configured MCP startup occasionally emitted an unrelated authorization warning; the processes completed successfully and the same setup applied to both prompts. Fast was requested through the CLI setting; the server's actual tier was not independently verified.

All 72 saved outputs passed the two-field schema checks and exact source-quote checks. Every recorded prompt hash matched its saved prompt and input. The model and low/fast arguments were checked in every record. All model outputs were inspected for request selection and wording; specific defects are retained in the manual review files. No implementation tests were run because this task changed only experiment artifacts.

No application code, running application, installed skill, account setting, or implementation plan was changed. This experiment does not validate question retention, Send cancellation, reconnect handling, or rendering.
