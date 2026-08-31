import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'
import type { SourceSpan } from './types'

export interface TrackedSourceBlock {
  id: string
  span: SourceSpan
  from: number
  to: number
  dirty: boolean
}

interface SourceSpanState {
  blocks: readonly TrackedSourceBlock[]
}

const sourceSpanKey = new PluginKey<SourceSpanState>('stratamd-source-spans')

function changedRanges(transaction: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  transaction.mapping.maps.forEach((map) => {
    map.forEach((oldFrom, oldTo) => ranges.push({ from: oldFrom, to: oldTo }))
  })
  return ranges
}

function readBlocks(state: EditorState, previous: readonly TrackedSourceBlock[] = [], transaction?: Transaction): TrackedSourceBlock[] {
  const byId = new Map(previous.map((block) => [block.id, block]))
  const changed = transaction ? changedRanges(transaction) : []
  const seen = new Set<string>()
  const blocks: TrackedSourceBlock[] = []
  state.doc.forEach((node, offset) => {
    if (typeof node.attrs.sourceId !== 'string' || seen.has(node.attrs.sourceId)) return
    const id = node.attrs.sourceId
    seen.add(id)
    const old = byId.get(id)
    const from = offset
    const to = offset + node.nodeSize
    const touched = changed.some((range) => range.from <= (old?.to ?? to) && range.to >= (old?.from ?? from))
    blocks.push({
      id,
      span: {
        from: Number(node.attrs.sourceFrom) || 0,
        to: Number(node.attrs.sourceTo) || 0,
      },
      from,
      to,
      dirty: old?.dirty === true || touched,
    })
  })
  return blocks
}

export function createSourceSpanPlugin(): Plugin<SourceSpanState> {
  return new Plugin<SourceSpanState>({
    key: sourceSpanKey,
    state: {
      init: (_config, state) => ({ blocks: readBlocks(state) }),
      apply(transaction, value, _oldState, newState) {
        return { blocks: readBlocks(newState, value.blocks, transaction) }
      },
    },
  })
}

export function getTrackedSourceBlocks(state: EditorState): readonly TrackedSourceBlock[] {
  return sourceSpanKey.getState(state)?.blocks ?? []
}
