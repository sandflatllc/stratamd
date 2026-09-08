import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { askPrompt, askSource, scanAsks, anchorAsks, parseStrataBlock } from '../../../../../out/ask-eval/bundle/entry.js'

const root = resolve('docs/design/inferred-asks/experiment/answer-required-2026-09-07')
const evidence = resolve(process.env.ASK_EVAL_OUTPUT ?? root)
await mkdir(evidence, { recursive: true })
const model = process.env.ASK_EVAL_MODEL ?? 'gpt-5.6-luna'
const cases = [
  ...JSON.parse(await readFile(join(root, 'cases.json'), 'utf8')),
  ...JSON.parse(await readFile(join(root, '../quote-only-2026-09-07/cases.json'), 'utf8')),
]
const prompt = askPrompt('', [])
const promptHash = createHash('sha256').update(prompt).digest('hex')
const output = join(evidence, 'runs.jsonl')
const completed = await readFile(output, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).catch(error => {
  if (error.code !== 'ENOENT') throw error
  return []
})
if (completed.some(row => row.promptHash !== promptHash || row.model !== model)) throw new Error('Archive previous evidence before running another prompt or model.')
await writeFile(join(evidence, 'prompt.txt'), prompt + '\n')

for (let repeat = 0; repeat < 2; repeat++) for (const item of cases) {
  if (completed.some(row => row.case === item.id && row.repeat === repeat)) continue
  const source = askSource({ text: item.text })
  const parsed = parseStrataBlock(item.text)
  const registered = (parsed?.results ?? []).flatMap(result => result.entry && ['question', 'decision'].includes(result.entry.verb) ? [result.entry.text] : [])
  const started = performance.now()
  let asks, error
  try {
    asks = await scanAsks({ binary: 'codex', model, env: { ...process.env, ...(process.env.ASK_EVAL_HOME ? { CODEX_HOME: process.env.ASK_EVAL_HOME } : {}) } }, source, registered, new AbortController().signal)
  } catch (failure) { error = String(failure) }
  const anchors = asks ? anchorAsks(item.id, source, asks, registered) : []
  const expected = anchorAsks(item.id, source, item.expected.map(value => ({ quote: value.anchor })))
  const overlaps = (left, right) => left.from < right.to && right.from < left.to
  const missed = expected.filter(value => !anchors.some(found => overlaps(value, found)))
  const extra = anchors.filter(value => !expected.some(wanted => overlaps(value, wanted)))
  // Overlap flags candidates for human inspection; it is not a semantic score.
  const record = { case: item.id, repeat, model, promptHash, source, registered, seconds: (performance.now() - started) / 1000, asks, anchors, expected, missed, extra, error }
  await appendFile(output, JSON.stringify(record) + '\n')
  console.log(item.id, repeat, record.seconds.toFixed(2), error ?? `${anchors.length} accepted, ${missed.length} missed, ${extra.length} extra`)
  if (error || missed.length || extra.length) process.exit(1)
}
