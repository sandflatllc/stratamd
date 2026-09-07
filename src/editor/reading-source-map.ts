import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { ParsedEditorMarkdown } from './types'

interface SourceNode {
  type: string
  value?: string
  children?: SourceNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** Decode a single parser text run while retaining each character's source position. */
export function textRunPositions(raw: string, rendered: string, literal = false): number[] | null {
  const positions: number[] = []
  let text = ''
  for (let cursor = 0; cursor < raw.length;) {
    const start = cursor
    let value = raw[cursor]!
    if (!literal && value === '\\' && /^[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]$/.test(raw[cursor + 1] ?? '')) {
      cursor += 1
      value = raw[cursor]!
    } else if (!literal && value === '&') {
      const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/.exec(raw.slice(cursor))?.[0]
      if (entity) {
        const node = fromMarkdown(entity).children[0] as SourceNode | undefined
        const decoded = node?.children?.[0]?.value
        if (decoded && decoded !== entity) { value = decoded; cursor += entity.length - 1 }
      }
    } else if (value === '\r') {
      if (raw[cursor + 1] === '\n') cursor += 1
      value = '\n'
    }
    for (let index = 0; index < value.length; index += 1) positions.push(start)
    text += value
    cursor += 1
  }
  return text === rendered ? positions : null
}

function leafPositions(node: SourceNode, source: string): { positions: number[]; end: number } | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined || node.value === undefined) return null
  let raw = source.slice(start, end)
  let from = start
  if (node.type === 'inlineCode') {
    const fence = /^`+/.exec(raw)?.[0]
    if (!fence) return null
    raw = raw.slice(fence.length, -fence.length).replace(/\r\n?|\n/g, ' ')
    from += fence.length
    if (raw.startsWith(' ') && raw.endsWith(' ') && /[^ ]/.test(raw)) { raw = raw.slice(1, -1); from += 1 }
  } else if (node.type === 'code') {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      const line = raw.indexOf('\n')
      if (line < 0) return null
      from += line + 1
      raw = source.slice(from, from + node.value.length)
    } else return null // Indented blocks need per-line offsets; defer instead of guessing.
  }
  const positions = textRunPositions(raw, node.value, node.type !== 'text')
  return positions ? { positions: positions.map(position => from + position), end: from + raw.length } : null
}

interface Point { source: number; end: number; editor: number }
const maps = new WeakMap<ProseMirrorNode, { source: string; points: Point[] }>()

/** Pair parser leaves with editor text in source order. No quote search or punctuation matching. */
function readingPoints(parsed: ParsedEditorMarkdown, doc: ProseMirrorNode): Point[] {
  const cached = maps.get(doc)
  if (cached?.source === parsed.source) return cached.points
  const points: Point[] = []
  let blockOffset = 0
  doc.forEach((block, _offset, index) => {
    const ast = parsed.core.blocks[index]?.node as SourceNode | undefined
    const positions: number[] = []
    const ends: number[] = []
    let expected = ''
    let valid = true
    const visit = (node: SourceNode) => {
      if (['text', 'inlineCode', 'code'].includes(node.type)) {
        const mapped = leafPositions(node, parsed.source)
        if (!mapped) { valid = false; return }
        positions.push(...mapped.positions)
        mapped.positions.forEach((position, index) => {
          let next = index + 1
          while (mapped.positions[next] === position) next += 1
          ends.push(mapped.positions[next] ?? mapped.end)
        })
        expected += node.value ?? ''
      } else for (const child of node.children ?? []) visit(child)
    }
    if (ast) visit(ast)
    const editorPositions: number[] = []
    let actual = ''
    block.descendants((node, pos) => {
      if (!node.isText) return
      actual += node.text!
      for (let index = 0; index < node.text!.length; index += 1) editorPositions.push(blockOffset + 1 + pos + index)
    })
    if (valid && actual === expected && positions.length === editorPositions.length) {
      positions.forEach((source, index) => points.push({ source, end: ends[index]!, editor: editorPositions[index]! }))
    }
    blockOffset += block.nodeSize
  })
  maps.set(doc, { source: parsed.source, points })
  return points
}

export function readingEditorPosition(parsed: ParsedEditorMarkdown, doc: ProseMirrorNode, source: number): number | null {
  return readingPoints(parsed, doc).find(point => point.source === source)?.editor ?? null
}

export function readingSourcePosition(parsed: ParsedEditorMarkdown, doc: ProseMirrorNode, editor: number): number | null {
  return readingPoints(parsed, doc).find(point => point.editor === editor)?.source ?? null
}

/** Exact source range for completed-answer Find; entity/escape ends include their full spelling. */
export function readingSourceRange(parsed: ParsedEditorMarkdown, doc: ProseMirrorNode, from: number, to: number): { from: number; to: number } | null {
  const points = readingPoints(parsed, doc)
  const start = points.find(point => point.editor === from)
  const end = points.find(point => point.editor === to - 1)
  return start && end ? { from: start.source, to: end.end } : null
}
