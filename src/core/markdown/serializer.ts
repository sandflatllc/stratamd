import { frontmatterToMarkdown } from 'mdast-util-frontmatter'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'
import { parseMarkdown } from './parser.js'
import type {
  MarkdownBlock,
  MarkdownConventions,
  MarkdownEdit,
  MarkdownNode,
  ParsedMarkdown,
  SerializedMarkdown,
  SourcePoint,
  SourceSpan
} from './types.js'

function alternateBullet(primary: '*' | '+' | '-'): '*' | '+' | '-' {
  return primary === '*' ? '-' : '*'
}

function withoutTerminalLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n') || value.endsWith('\r')) return value.slice(0, -1)
  return value
}

function useLineEnding(value: string, lineEnding: MarkdownConventions['lineEnding']): string {
  return value.replace(/\r\n|\r|\n/g, lineEnding)
}

/** Serialize one edited top-level node using the source document's conventions. */
export function serializeMarkdownBlock(node: MarkdownNode, conventions: MarkdownConventions): string {
  const root = { type: 'root', children: [node] } as Parameters<typeof toMarkdown>[0]
  const markdown = toMarkdown(root, {
    bullet: conventions.bullet,
    bulletOther: alternateBullet(conventions.bullet),
    bulletOrdered: conventions.bulletOrdered,
    emphasis: conventions.emphasis,
    strong: conventions.strong,
    listItemIndent: conventions.listItemIndent,
    fence: conventions.fence,
    setext: conventions.heading === 'setext',
    closeAtx: conventions.closeAtx,
    rule: conventions.rule,
    ruleSpaces: conventions.ruleSpaces,
    quote: conventions.quote,
    extensions: [gfmToMarkdown(), frontmatterToMarkdown(['yaml'])]
  })
  return useLineEnding(withoutTerminalLineEnding(markdown), conventions.lineEnding)
}

function resolveBlock(parsed: ParsedMarkdown, reference: number | string): MarkdownBlock {
  const block = typeof reference === 'number'
    ? parsed.blocks[reference]
    : parsed.blocks.find((candidate) => candidate.id === reference)
  if (!block) throw new RangeError(`Unknown markdown block: ${String(reference)}`)
  return block
}

function boundaryStaysSeparate(left: string, gap: string, right: string): boolean {
  const boundaryStart = left.length
  const boundaryEnd = boundaryStart + gap.length
  const blocks = parseMarkdown(left + gap + right).blocks
  return blocks.some((block) => block.span.end.offset <= boundaryStart)
    && blocks.some((block) => block.span.start.offset >= boundaryEnd)
}

interface Replacement {
  block: MarkdownBlock
  value: string
  structural: boolean
}

function keepStructuralBoundaries(
  parsed: ParsedMarkdown,
  replacements: Map<number, Replacement>,
  insertedBefore: ReadonlySet<number>
): void {
  const sourceFor = (index: number): string => replacements.get(index)?.value ?? parsed.blocks[index]?.source ?? ''

  for (let index = 0; index < parsed.blocks.length - 1; index += 1) {
    if (insertedBefore.has(index + 1)) continue
    const leftEdit = replacements.get(index)
    const rightEdit = replacements.get(index + 1)
    if (!leftEdit?.structural && !rightEdit?.structural) continue

    const left = sourceFor(index)
    const right = sourceFor(index + 1)
    if (!left || !right) continue
    const gap = parsed.gaps[index + 1] ?? ''
    if (boundaryStaysSeparate(left, gap, right)) continue

    if (leftEdit?.structural) leftEdit.value += parsed.conventions.lineEnding
    else if (rightEdit?.structural) rightEdit.value = parsed.conventions.lineEnding + rightEdit.value
  }
}

function pointAtEnd(source: string): SourcePoint {
  const endings = [...source.matchAll(/\r\n|\r|\n/g)]
  const last = endings.at(-1)
  const afterLastEnding = last ? last.index + last[0].length : 0
  return {
    offset: source.length,
    byteOffset: new TextEncoder().encode(source).byteLength,
    line: endings.length + 1,
    column: source.length - afterLastEnding + 1
  }
}

function zeroSpan(point: SourcePoint): SourceSpan {
  return { start: { ...point }, end: { ...point } }
}

function separatedPrefix(left: string, gap: string, right: string, lineEnding: string): string {
  let prefix = ''
  while (left && right && !boundaryStaysSeparate(left, gap + prefix, right)) {
    prefix += lineEnding
    if (prefix.length > lineEnding.length * 2) throw new Error('Could not preserve inserted markdown boundary')
  }
  return prefix
}

function separatedSuffix(left: string, right: string, lineEnding: string): string {
  let suffix = ''
  while (left && right && !boundaryStaysSeparate(left, suffix, right)) {
    suffix += lineEnding
    if (suffix.length > lineEnding.length * 2) throw new Error('Could not preserve inserted markdown boundary')
  }
  return suffix
}

interface RewriteOperation {
  start: number
  end: number
  blockId: string
  original: SourceSpan
  value: string
  order: number
}

/**
 * Replace only edited top-level source spans. An empty edit set is an exact no-op,
 * including BOM, mixed line endings, trailing spaces, and a missing final newline.
 */
export function serializeMarkdownWithMetadata(
  parsed: ParsedMarkdown,
  edits: readonly MarkdownEdit[] = []
): SerializedMarkdown {
  if (edits.length === 0) return { value: parsed.source, rewrittenSpans: [] }

  const replacements = new Map<number, Replacement>()
  const insertions = new Map<number, { value: string; original: SourceSpan; id: string }>()
  let insertionNumber = 0
  for (const edit of edits) {
    if ('insertBefore' in edit) {
      const target = edit.insertBefore === 'end' ? undefined : resolveBlock(parsed, edit.insertBefore)
      const targetIndex = target?.index ?? parsed.blocks.length
      if (insertions.has(targetIndex)) throw new Error(`More than one insertion at markdown boundary ${targetIndex}`)
      const insertionPoint = target?.span.start ?? pointAtEnd(parsed.source)
      const insertionValue = typeof edit.replacement === 'string'
        ? edit.replacement
        : serializeMarkdownBlock(edit.replacement, parsed.conventions)
      insertions.set(targetIndex, {
        value: insertionValue,
        original: zeroSpan(insertionPoint),
        id: `insertion-${insertionNumber}`
      })
      insertionNumber += 1
      continue
    }
    const block = resolveBlock(parsed, edit.block)
    if (replacements.has(block.index)) throw new Error(`Markdown block edited more than once: ${block.id}`)
    const value = edit.replacement === null
      ? ''
      : typeof edit.replacement === 'string'
        ? edit.replacement
        : serializeMarkdownBlock(edit.replacement, parsed.conventions)
    replacements.set(block.index, {
      block,
      value,
      structural: edit.replacement !== null
    })
  }
  for (const targetIndex of insertions.keys()) {
    if (targetIndex < parsed.blocks.length && replacements.get(targetIndex)?.value === '') {
      throw new Error('Cannot insert before a block deleted in the same serialization')
    }
  }
  keepStructuralBoundaries(parsed, replacements, new Set(insertions.keys()))

  const sourceFor = (index: number): string => replacements.get(index)?.value ?? parsed.blocks[index]?.source ?? ''
  const operations: RewriteOperation[] = [...replacements.values()].map(({ block, value }) => ({
    start: block.span.start.offset,
    end: block.span.end.offset,
    blockId: block.id,
    original: block.span,
    value,
    order: 1
  }))

  for (const [targetIndex, insertion] of insertions) {
    const target = parsed.blocks[targetIndex]
    const left = targetIndex > 0 ? sourceFor(targetIndex - 1) : ''
    const right = target ? sourceFor(targetIndex) : ''
    const leftGap = target
      ? parsed.gaps[targetIndex] ?? ''
      : parsed.gaps[parsed.blocks.length] ?? ''
    const prefix = separatedPrefix(left, leftGap, insertion.value, parsed.conventions.lineEnding)
    let suffix = separatedSuffix(insertion.value, right, parsed.conventions.lineEnding)
    if (!target && parsed.conventions.hasFinalNewline) suffix += parsed.conventions.lineEnding
    const offset = target?.span.start.offset ?? parsed.source.length
    operations.push({
      start: offset,
      end: offset,
      blockId: insertion.id,
      original: insertion.original,
      value: prefix + insertion.value + suffix,
      order: 0
    })
  }

  let value = ''
  let sourceCursor = 0
  const rewrittenSpans: SerializedMarkdown['rewrittenSpans'][number][] = []
  for (const operation of operations.sort((left, right) => left.start - right.start || left.order - right.order)) {
    value += parsed.source.slice(sourceCursor, operation.start)
    const outputStart = value.length
    value += operation.value
    rewrittenSpans.push({
      blockId: operation.blockId,
      original: operation.original,
      outputStart,
      outputEnd: value.length
    })
    sourceCursor = Math.max(sourceCursor, operation.end)
  }
  value += parsed.source.slice(sourceCursor)

  return { value, rewrittenSpans }
}

export function serializeMarkdown(parsed: ParsedMarkdown, edits: readonly MarkdownEdit[] = []): string {
  return serializeMarkdownWithMetadata(parsed, edits).value
}
