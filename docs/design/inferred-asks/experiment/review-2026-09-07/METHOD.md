# Question inference prompt comparison

Started 2026-09-07. The owner requested measured accuracy and latency for proposed inference improvements using Luna low-fast.

## Fixed before the calls

- Baseline is an unchanged copy of the plan's current `prompt.txt`.
- Revised prompt changes the selection policy, excludes already registered explicit asks while retaining additional prose asks, deduplicates repeated requests, and softens the 20-word limit to preserve meaning.
- Both use the existing two-field JSON schema, gpt-5.6-luna, low effort, and the fast service-tier flag. Neither requests generated answer options or an additional context field.
- Twelve replies contain eighteen distinct target requests. Eight replies are synthetic, including the original two; four are unedited messages read from the local StrataMD project history. Real replies were selected to cover direct questions, an explicit offer phrased as a question, a completion report, and a decision stated without a question mark. This is a targeted diagnostic set, not a random production sample.
- `cases.json` freezes expected request anchors and meaning before any calls. No cases or expected answers are supplied to the model beyond the reply being scanned.
- A target is a clear request for owner input, including a clearly identified unresolved owner decision. It need not block all other work. An optional offer, a suggestion, or an invitation to object to a default is not a target. A direct question asking whether to do optional work is a target.
- This changes the original long reply's scoring: its conditional shipping-order objection and three optional spans no longer count as asks. Improvements under this policy do not prove the policy matches every user's preference.

## Run order and timing

`run.py` runs one process at a time, with no concurrent benchmark calls. Case order uses seed 907. Within each case, baseline/revised order alternates; the second pass reverses that case's order. Each prompt runs twice on every reply, giving 48 planned calls and 36 target instances per prompt.

Elapsed time starts immediately before process launch and ends after process exit, including CLI startup, account/MCP initialization, network latency, model time, and writing the result. The first call is included. The calls use the currently active sandflatgmail Codex home, as the earlier experiment did, and the earlier experiment directory as cwd. No account, application, or model settings are edited. The per-call limit is 60 seconds. Failures remain in the record and stop the runner for diagnosis.

The runner saves arguments, prompt hashes, timestamps, raw JSON, event logs, stderr, usage when available, and elapsed time. It checks whether the extractor used tools. Fast is a requested configuration, not independent verification of the server's actual service tier.

## Scoring

Evaluate each returned row against the frozen targets. Count a target at most once and a row as at most one target, so merged questions cannot earn two hits. Extra rows include duplicate requests, already registered asks, examples, and statements converted into questions. Check that every anchor is verbatim and present in the reply. Inspect question meaning separately: right subject, actual alternatives, conditions, and negation. A correct quote does not prove its restated question is correct or independently answerable.

Report selection precision, recall, number of extra and missed rows, replies with the exact expected set, and usability defects. Separate the current application's explicit-item skip rule from baseline prompt accuracy: the benchmark sends all twelve replies to both prompts, whereas the proposed application's gate would skip the mixed-explicit case entirely.

Report median and mean wall time, the slowest call, and paired revised-minus-baseline differences. Two repeats per reply can expose obvious instability; they cannot establish a production failure rate or a reliable tail-latency estimate.

This experiment does not test unresolved-question retention, Send cancellation, snapshot catch-up, annotation rendering, or supplying original surrounding context in the reply UI. Those are application behaviors.

CLI schema output, JSON events, and ephemeral execution were checked against the installed CLI help and [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
