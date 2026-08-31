import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { ParsedEditorMarkdown } from './types.js'

export interface SourceSelection {
  quote: string
  from: number
  to: number
  singleBlock: boolean
}

interface BlockPosition {
  index: number
  textOffset: number
  renderedText: string
}

function topLevelOffset(doc: ProseMirrorNode, index: number): number {
  let offset = 0
  for (let child = 0; child < index; child += 1) offset += doc.child(child).nodeSize
  return offset
}

function blockPosition(doc: ProseMirrorNode, position: number): BlockPosition | null {
  if (doc.childCount === 0) return null
  const resolved = doc.resolve(Math.max(0, Math.min(position, doc.content.size)))
  const index = Math.min(resolved.index(0), doc.childCount - 1)
  const node = doc.child(index)
  const offset = topLevelOffset(doc, index)
  const relative = Math.max(0, Math.min(position - offset - 1, node.content.size))
  return {
    index,
    textOffset: node.textBetween(0, relative, '\n', '\n').length,
    renderedText: node.textBetween(0, node.content.size, '\n', '\n'),
  }
}

function renderedCharacterPositions(source: string, rendered: string): number[] | null {
  const positions: number[] = []
  let sourceCursor = 0
  for (let renderedCursor = 0; renderedCursor < rendered.length; renderedCursor += 1) {
    const character = rendered[renderedCursor]!
    // ProseMirror inserts virtual separators between nested blocks. They have
    // no source character of their own: between table cells of one row the
    // nearest source newline sits past every later cell, so consuming it
    // would strand the rest of the row.
    if (character === '\n') {
      positions.push(sourceCursor)
      continue
    }
    const match = source.indexOf(character, sourceCursor)
    if (match < 0) return null
    positions.push(match)
    sourceCursor = match + 1
  }
  return positions
}

function sourceOffsetForTextOffset(
  source: string,
  rendered: string,
  textOffset: number,
  bias: 'start' | 'end',
): number | null {
  if (!rendered) return textOffset === 0 ? 0 : null
  const positions = renderedCharacterPositions(source, rendered)
  if (!positions) return null
  const bounded = Math.max(0, Math.min(textOffset, rendered.length))
  if (bounded === 0) return positions[0] ?? 0
  if (bounded === rendered.length) return (positions.at(-1) ?? source.length - 1) + 1
  return bias === 'start'
    ? positions[bounded] ?? null
    : (positions[bounded - 1] ?? -1) + 1
}

/** Map a visual ProseMirror selection to an exact UTF-16 markdown slice. */
export function sourceSelectionForEditor(
  parsed: ParsedEditorMarkdown,
  doc: ProseMirrorNode,
  from: number,
  to: number,
): SourceSelection | null {
  const start = blockPosition(doc, from)
  const end = blockPosition(doc, to)
  if (!start || !end) return null
  const startBlock = parsed.blocks[start.index]
  const endBlock = parsed.blocks[end.index]
  if (!startBlock || !endBlock) return null

  const startWithinBlock = sourceOffsetForTextOffset(
    startBlock.raw,
    start.renderedText,
    start.textOffset,
    'start',
  )
  const endWithinBlock = sourceOffsetForTextOffset(
    endBlock.raw,
    end.renderedText,
    end.textOffset,
    'end',
  )
  if (startWithinBlock === null || endWithinBlock === null) return null

  const sourceFrom = startBlock.span.from + startWithinBlock
  const sourceTo = endBlock.span.from + endWithinBlock
  if (sourceTo <= sourceFrom) return null
  return {
    quote: parsed.source.slice(sourceFrom, sourceTo),
    from: sourceFrom,
    to: sourceTo,
    singleBlock: start.index === end.index,
  }
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u

/**
 * The word around a caret offset, or null when neither adjacent character is a
 * word character. Offsets are UTF-16; an astral character never counts as a
 * word character, matching the anchor code's word class.
 */
export function wordRangeAt(text: string, offset: number): { from: number; to: number } | null {
  const isWord = (character: string | undefined): boolean =>
    character !== undefined && WORD_CHARACTER.test(character)
  let anchor = offset
  if (!isWord(text[anchor])) {
    if (!isWord(text[anchor - 1])) return null
    anchor -= 1
  }
  let from = anchor
  let to = anchor + 1
  while (isWord(text[from - 1])) from -= 1
  while (isWord(text[to])) to += 1
  return { from, to }
}

export function sourceRangeIsSingleBlock(
  parsed: ParsedEditorMarkdown,
  from: number,
  to: number,
): boolean {
  return parsed.blocks.some((block) => from >= block.span.from && to <= block.span.to)
}

function editorPositionAtTextOffset(node: ProseMirrorNode, textOffset: number): number {
  let low = 0
  let high = node.content.size
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const length = node.textBetween(0, middle, '\n', '\n').length
    if (length < textOffset) low = middle + 1
    else high = middle
  }
  return low
}

function editorPositionForSourceOffset(
  parsed: ParsedEditorMarkdown,
  doc: ProseMirrorNode,
  sourceOffset: number,
  bias: 'start' | 'end',
): { index: number; position: number } | null {
  const index = parsed.blocks.findIndex((block) =>
    sourceOffset >= block.span.from && sourceOffset <= block.span.to,
  )
  if (index < 0 || index >= doc.childCount) return null
  const block = parsed.blocks[index]!
  const node = doc.child(index)
  const rendered = node.textBetween(0, node.content.size, '\n', '\n')
  const positions = renderedCharacterPositions(block.raw, rendered)
  if (!positions) return null
  const withinBlock = sourceOffset - block.span.from
  const textOffset = bias === 'start'
    ? positions.findIndex((position) => position >= withinBlock)
    : positions.filter((position) => position < withinBlock).length
  const normalizedTextOffset = textOffset < 0 ? rendered.length : textOffset
  return {
    index,
    position: topLevelOffset(doc, index) + 1 + editorPositionAtTextOffset(node, normalizedTextOffset),
  }
}

/** Map exact markdown offsets back into the rendered editor document. */
export function editorRangeForSource(
  parsed: ParsedEditorMarkdown,
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { from: number; to: number; singleBlock: boolean } | null {
  const start = editorPositionForSourceOffset(parsed, doc, from, 'start')
  const end = editorPositionForSourceOffset(parsed, doc, to, 'end')
  if (!start || !end || end.position <= start.position) return null
  return {
    from: start.position,
    to: end.position,
    singleBlock: start.index === end.index,
  }
}
