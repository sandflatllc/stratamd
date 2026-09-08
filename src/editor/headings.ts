import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'

export interface EditorHeading {
  id: string
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
  /** Position before the heading node in the live ProseMirror document. */
  position: number
  /** Markdown offset retained by the byte-preserving parser, when available. */
  sourceFrom: number | null
  /** Whether the live heading uses # syntax and can carry a heading decision. */
  atx: boolean
}

interface HeadingPluginState {
  headings: EditorHeading[]
  nextId: number
  lastUpdateMs: number
}

export const headingPluginKey = new PluginKey<HeadingPluginState>('stratamd-headings')

export function headingText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, ' ', (leaf) => {
    if (leaf.type.name === 'image' && typeof leaf.attrs.alt === 'string') return leaf.attrs.alt
    return ''
  }).trim()
}

function candidates(doc: ProseMirrorNode): Array<Omit<EditorHeading, 'id'>> {
  const headings: Array<Omit<EditorHeading, 'id'>> = []
  doc.descendants((node, position) => {
    if (node.type.name !== 'heading') return true
    headings.push({
      level: Math.min(6, Math.max(1, Number(node.attrs.level))) as EditorHeading['level'],
      text: headingText(node) || 'Untitled heading',
      position,
      sourceFrom: typeof node.attrs.sourceFrom === 'number' ? node.attrs.sourceFrom : null,
      atx: node.attrs.style === 'atx',
    })
    return false
  })
  return headings
}

function candidateAt(node: ProseMirrorNode, position: number): Omit<EditorHeading, 'id'> {
  return {
    level: Math.min(6, Math.max(1, Number(node.attrs.level))) as EditorHeading['level'],
    text: headingText(node) || 'Untitled heading',
    position,
    sourceFrom: typeof node.attrs.sourceFrom === 'number' ? node.attrs.sourceFrom : null,
    atx: node.attrs.style === 'atx',
  }
}

/** Above this many steps, mapping each step through the ones after it costs more than one full pass. */
const WHOLE_DOCUMENT_STEPS = 64

function changedRanges(transaction: Transaction): Array<{ from: number; to: number }> {
  const size = transaction.doc.content.size
  if (transaction.steps.length > WHOLE_DOCUMENT_STEPS) return [{ from: 0, to: size }]
  const ranges: Array<{ from: number; to: number }> = []
  transaction.mapping.maps.forEach((stepMap, index) => {
    const following = transaction.mapping.slice(index + 1)
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      const from = Math.max(0, following.map(newFrom, -1) - 1)
      const to = Math.min(size, following.map(newTo, 1) + 1)
      ranges.push({ from: Math.min(from, to), to: Math.max(from, to) })
    })
  })
  ranges.sort((left, right) => left.from - right.from)
  const merged: Array<{ from: number; to: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

function initialState(doc: ProseMirrorNode): HeadingPluginState {
  const started = performance.now()
  const used = new Set<string>()
  let nextId = 1
  const headings = candidates(doc).map((heading) => {
    const node = doc.nodeAt(heading.position)
    const sourceId = node && typeof node.attrs.sourceId === 'string' && node.attrs.sourceId.length > 0
      ? `heading:${node.attrs.sourceId}`
      : null
    let id = sourceId ?? `heading:runtime:${nextId++}`
    while (used.has(id)) id = `${sourceId ?? 'heading:runtime'}:${nextId++}`
    used.add(id)
    return { id, ...heading }
  })
  return { headings, nextId, lastUpdateMs: performance.now() - started }
}

function applyTransaction(transaction: Transaction, previous: HeadingPluginState): HeadingPluginState {
  if (!transaction.docChanged) return previous
  const started = performance.now()
  const nextByPosition = new Map<number, EditorHeading>()
  const used = new Set<string>()
  for (const heading of previous.headings) {
    const mapped = transaction.mapping.mapResult(heading.position, 1)
    if (mapped.deleted) continue
    const node = transaction.doc.nodeAt(mapped.pos)
    if (node?.type.name !== 'heading' || nextByPosition.has(mapped.pos)) continue
    nextByPosition.set(mapped.pos, { id: heading.id, ...candidateAt(node, mapped.pos) })
    used.add(heading.id)
  }
  const additions = new Map<number, Omit<EditorHeading, 'id'>>()
  for (const range of changedRanges(transaction)) {
    transaction.doc.nodesBetween(range.from, range.to, (node, position) => {
      if (node.type.name !== 'heading' || nextByPosition.has(position)) return true
      additions.set(position, candidateAt(node, position))
      return false
    })
  }
  let nextId = previous.nextId
  for (const heading of additions.values()) {
    const node = transaction.doc.nodeAt(heading.position)
    const sourceId = node && typeof node.attrs.sourceId === 'string' && node.attrs.sourceId.length > 0
      ? `heading:${node.attrs.sourceId}`
      : null
    let id = sourceId && !used.has(sourceId) ? sourceId : `heading:runtime:${nextId++}`
    while (used.has(id)) id = `heading:runtime:${nextId++}`
    used.add(id)
    nextByPosition.set(heading.position, { id, ...heading })
  }
  const headings = [...nextByPosition.values()].sort((left, right) => left.position - right.position)
  return { headings, nextId, lastUpdateMs: performance.now() - started }
}

export function createHeadingPlugin(): Plugin<HeadingPluginState> {
  return new Plugin({
    key: headingPluginKey,
    state: {
      init: (_config, state) => initialState(state.doc),
      apply: applyTransaction,
    },
  })
}

export function headingsForState(state: EditorState): readonly EditorHeading[] {
  return headingPluginKey.getState(state)?.headings ?? projectHeadings(state.doc)
}

export function headingUpdateDurationForState(state: EditorState): number {
  return headingPluginKey.getState(state)?.lastUpdateMs ?? 0
}

/** Pure projection used by focused tests and non-editor callers. */
export function projectHeadings(doc: ProseMirrorNode): EditorHeading[] {
  return initialState(doc).headings
}
