import { performance } from 'node:perf_hooks'
import { EditorState } from 'prosemirror-state'
import { computeHunks } from '../../src/core/diff'
import { applyUserEdit, createDocumentState } from '../../src/core/state'
import { parseMarkdownForEditor, serializeEditorDocument } from '../../src/editor/markdown'
import { generateCorpus } from './corpus'
import type { CorpusShape } from './types'

const sizes = (process.env.STRATAMD_PERF_SIZES ?? '10000,100000').split(',').map(Number).filter((value) => Number.isInteger(value) && value > 0)
const shapes = (process.env.STRATAMD_PERF_SHAPES ?? 'rich,plain').split(',').filter(Boolean) as CorpusShape[]

function timed<Result>(job: () => Result): { value: Result; durationMs: number } {
  const started = performance.now()
  const value = job()
  return { value, durationMs: performance.now() - started }
}

for (const shape of shapes) {
  for (const requestedBytes of sizes) {
    global.gc?.()
    const beforeMemory = process.memoryUsage()
    const corpus = generateCorpus(shape, requestedBytes)
    const parsed = timed(() => parseMarkdownForEditor(corpus.markdown))
    const state = EditorState.create({ doc: parsed.value.doc })
    const changed = state.apply(state.tr.insertText('X', 2)).doc
    const serialized = timed(() => serializeEditorDocument(parsed.value, changed))
    const diffed = timed(() => computeHunks(corpus.markdown, serialized.value))
    const application = createDocumentState(corpus.markdown, corpus.markdown)
    const stateUpdate = timed(() => applyUserEdit(application, { from: 2, to: 2, insert: 'X' }))
    global.gc?.()
    const afterMemory = process.memoryUsage()
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      corpus: corpus.manifest,
      parseMs: parsed.durationMs,
      serializeMs: serialized.durationMs,
      diffMs: diffed.durationMs,
      stateUpdateMs: stateUpdate.durationMs,
      hunks: diffed.value.length,
      snapshotsAfterEdit: Object.keys(stateUpdate.value.snapshots).length,
      heapDeltaMB: (afterMemory.heapUsed - beforeMemory.heapUsed) / 1024 / 1024,
      rssDeltaMB: (afterMemory.rss - beforeMemory.rss) / 1024 / 1024,
    })}\n`)
  }
}
