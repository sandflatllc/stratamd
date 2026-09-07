# Inferred asks experiment

Question: can a small model call replace the question-mark scanner for finding what an agent reply needs from the owner, and is it fast enough to run automatically?

Method: two synthetic agent replies with labeled ground truth in `expected.json`. The short one (198 words) has 3 real asks and 3 traps. The long one (963 words) has 5 real asks, 6 traps, and 3 borderline offers scored as optional. Each config ran twice per reply through `codex exec` with the same flags T3 uses for thread titles, `service_tier="fast"`, structured output against `schema.json`, prompt in `prompt.txt`. Runs used the Codex home T3 uses for the sandflatgmail instance. `run.sh` reproduces a config; `node score.mjs -v` rescores `out/`.

## Accuracy

| Config | Real asks found | Traps hit | Notes |
|---|---|---|---|
| luna low fast | 16 of 16 | 0 | one duplicate anchor on the long reply |
| luna medium fast | 16 of 16 | 0 | also picked up the implicit "I think that's correct" bullet |
| sol low fast | 15 of 16 | 0 | missed "Tell me which you'd rather see" once |
| sol medium fast | 16 of 16 | 0 | one duplicate anchor |

Every quote came back verbatim in all 16 runs, so anchoring to the message works. No run flagged the rhetorical question, the self-answered questions, the heading, the owner's quoted words, or the code comment. All configs consistently picked up the two conditional offers marked optional, which reads as correct behaviour. The four "extra" spans across all runs were duplicate anchors for asks already found, plus the bullet before the implicit confirmation. None was a wrong ask.

Model output labels nearly every ask as a decision with invented binary options. The prompt should reserve decision for alternatives the agent listed.

## Speed, average wall clock per call

| Config | Short reply | Long reply |
|---|---|---|
| luna low fast | 8.2s | 12.4s |
| luna medium fast | 9.9s | 19.7s |
| sol low fast | 8.2s | 19.0s |
| sol medium fast | 12.3s | 17.2s |

A clean Codex home with only auth ran at the same speed, so the configured MCP servers do not add latency here.

## Tokens

Each call reports roughly 18k to 23k tokens regardless of reply length. A clean home with no MCP servers still reports 18k, so this is the Codex CLI's own base context, not the reply. Runs that hit the prompt cache reported under 3k.

## Recommendation

luna low fast. It matched the best accuracy and was the fastest at both lengths. Short replies were just as accurate as long ones, so there is no reason to gate on reply size. Run it automatically after any completed agent reply that carries no explicit question or decision items, in the background, with the question-mark scanner as the fallback when the call fails or no Codex or Claude account is available.

## Round 2: revised prompt, luna only

The prompt dropped the kind and options fields, added "Do not suggest answers", told the model to quote the sentence that introduces a numbered list rather than the list, and to keep the agent's wording when it is already a question. `prompt-v1.txt`, `schema-v1.json`, and `out-v1/` hold round 1. Three runs per config per reply.

| Config | Real asks found | Traps hit | Extras | Notes |
|---|---|---|---|---|
| luna low fast | 24 of 24 | 0 | 0 | one short run merged the two adjacent questions into one ask |
| luna medium fast | 24 of 24 | 1 | 0 | flagged "Sounds good?" once in six runs |

No options were invented in any run. The numbered-list rule held every time: the quote was the introducing sentence. Restated questions read as neutral restatements, for example "Should finished activity stay under the message or move into the Trace drawer?" for "Tell me which you'd rather see and I'll do that one."

Speed was unchanged: luna low averaged 8.7s on the short reply and 11.8s on the long one.

Remaining prompt fix: state that each ask is one question, and adjacent questions are separate asks, so the "at most two sentences" span rule cannot merge neighbours.

## Round 3: one question per ask

`prompt.txt` now says each ask is one question and neighbouring questions are separate asks. `prompt-v2.txt` is the round 2 wording. Three luna low fast runs on the short reply, in `out-v3/`: all three returned the two adjacent questions as separate asks, three asks each, no trap, 7.2s to 8.4s.

## Service tier check

Every timed run passed `--config service_tier="fast"`, the same flag T3 uses. Codex validates the value: a bogus tier prints a warning that it is unsupported for the model and will be omitted. None of the fast runs printed that warning, so fast was accepted and sent. Three runs without the flag on the short reply took 9.3s to 10.7s against 7.2s to 8.4s with it.
