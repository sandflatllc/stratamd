import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { queryObjects } from 'node:v8'
import { createRequire } from 'node:module'

// Exercise the actual staged functions with the artifact's bundled Effect helpers.
// Fake SQL pages isolate retention from database caches and provider processes.
const bundle = resolve(process.argv[2])
const bin = join(bundle, 'node_modules/t3/dist/bin.mjs')
let source = await readFile(bin, 'utf8')
const baseline = process.argv.includes('--baseline')
if (baseline) {
  const patch = JSON.parse(await readFile(new URL('../packaging/engine/patches/10777-bundle.json', import.meta.url), 'utf8'))
  for (const replacement of patch.replacements) source = source.replace(replacement.after, replacement.before)
}
async function helper(name) {
  for (const match of source.matchAll(/import \{ ([^\n]+) \} from "([^"\n]+)";/g)) {
    for (const spec of match[1].split(', ')) {
      const [exported, local = exported] = spec.split(' as ')
      if (local !== name) continue
      const url = match[2].startsWith('.') ? new URL(match[2], pathToFileURL(bin)) : pathToFileURL(createRequire(bin).resolve(match[2]))
      return (await import(url.href))[exported]
    }
  }
  throw new Error(`Missing staged helper ${name}`)
}
const names = ['strataReplayPaginate', 'empty$15', 'mapError', 'flatMap$1', 'forEach', 'map$5', 'none$1', 'some', 'succeed$1', 'runForEach', 'runCollect', 'fromEffect', 'flatMap$3', 'concat$1', 'fromIterable$2']
const values = await Promise.all(names.map(helper))
const helpers = Object.fromEntries(names.map((name, index) => [name, values[index]]))
const fixtures = {
  ...helpers, DEFAULT_READ_FROM_SEQUENCE_LIMIT: 10000, READ_PAGE_SIZE: 500,
  toPersistenceSqlOrDecodeError$4: () => error => error,
  toPersistenceDecodeError: () => error => error,
  decodeEvent: event => helpers.succeed$1(event),
  readEventRowsFromSequence: ({ sequenceExclusive, limit }) => rows(sequenceExclusive, limit, 1501),
  readAggregateEventRows: ({ fromSequenceExclusive, limit, toSequenceInclusive }) => rows(fromSequenceExclusive, limit, toSequenceInclusive),
}
function rows(cursor, limit, maximum) {
  return helpers.succeed$1(Array.from({ length: Math.max(0, Math.min(limit, maximum - cursor)) }, (_, index) => ({ sequence: cursor + index + 1 })))
}
helpers.runPromise = (await import(pathToFileURL(createRequire(bin).resolve('effect/Effect')).href)).runPromise
const checks = []
for (const [name, end] of [['readFromSequence', 'findEventAfter'], ['readAggregateRange', 'getAggregateReplayStats']]) {
  const start = source.indexOf(`\tconst ${name} =`)
  assert.ok(start > 0)
  const fn = Function(...Object.keys(fixtures), source.slice(start, source.indexOf(`\tconst ${end} =`, start)) + `\nreturn ${name};`)(...Object.values(fixtures))
  const replay = name === 'readFromSequence' ? fn(0, 1501) : fn({ fromSequenceExclusive: 0, toSequenceInclusive: 1501, limit: 1501 })
  let count = 0
  let maximumRetainedPageMarkers = 0
  const started = performance.now()
  class ReplayPage {}
  await helpers.runPromise(helpers.runForEach(replay, event => {
    assert.equal(event.sequence, ++count)
    if ((count - 1) % 500 === 0) {
      event.replayPage = new ReplayPage()
      maximumRetainedPageMarkers = Math.max(maximumRetainedPageMarkers, queryObjects(ReplayPage, { format: 'count' }))
      if (!baseline) assert.ok(maximumRetainedPageMarkers <= 1, 'Consumed replay pages remain reachable')
    }
    return helpers.succeed$1(undefined)
  }))
  const replayMsIncludingForcedGC = Math.round(performance.now() - started)
  assert.equal(count, 1501)
  assert.equal((await helpers.runPromise(helpers.runCollect(replay))).length, 1501, 'Replay state must reset for each consumer')
  const empty = name === 'readFromSequence' ? fn(0, -1) : fn({ fromSequenceExclusive: 0, toSequenceInclusive: 1501, limit: -1 })
  assert.equal((await helpers.runPromise(helpers.runCollect(empty))).length, 0)
  for (const limit of [1, 499, 500, 501, 1001]) {
    const limited = name === 'readFromSequence' ? fn(0, limit) : fn({ fromSequenceExclusive: 0, toSequenceInclusive: 1501, limit })
    assert.equal((await helpers.runPromise(helpers.runCollect(limited))).length, limit, `Positive limit ${limit}`)
  }
  checks.push({ reader: name, events: count, pageSize: 500, maximumRetainedPageMarkers, repeated: true, replayMsIncludingForcedGC })
}
console.log(JSON.stringify({ checks }))
