import { fromMarkdown } from 'mdast-util-from-markdown'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { gfm } from 'micromark-extension-gfm'
import { detectMarkdownConventions } from './conventions.js'
import type { MarkdownBlock, MarkdownNode, ParsedMarkdown, RawConstructKind, SourcePoint } from './types.js'

const BOM = '\uFEFF'

interface NodeWithChildren {
  type: string
  position?: {
    start: { offset?: number | undefined }
    end: { offset?: number | undefined }
  } | undefined
  children?: readonly NodeWithChildren[] | undefined
}

/** Shift every mdast position offset in the subtree; lines and columns are untouched. */
export function shiftOffsets(node: NodeWithChildren, amount: number): void {
  if (node.position) {
    if (node.position.start.offset !== undefined) node.position.start.offset += amount
    if (node.position.end.offset !== undefined) node.position.end.offset += amount
  }
  if (node.children) for (const child of node.children) shiftOffsets(child, amount)
}

function containsNodeType(node: NodeWithChildren, types: ReadonlySet<string>): boolean {
  if (types.has(node.type)) return true
  return node.children?.some((child) => containsNodeType(child, types)) ?? false
}

function hasMathSyntax(source: string): boolean {
  let dollars = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '$') continue
    let slashes = 0
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1
    if (slashes % 2 === 0) dollars += 1
  }
  return dollars >= 2 || /(^|[^\\])\\(?:\([\s\S]*?\\\)|\[[\s\S]*?\\\])/.test(source)
}

function classifyRaw(node: MarkdownNode, source: string): RawConstructKind | undefined {
  if (node.type === 'yaml') return 'frontmatter'
  if (containsNodeType(node as NodeWithChildren, new Set(['html']))) return 'html'
  if (node.type === 'definition') return 'link-definition'
  if (containsNodeType(node as NodeWithChildren, new Set(['footnoteDefinition', 'footnoteReference']))) return 'footnote'
  if (/(^|[^\\])\[\[[\s\S]*?\]\]/.test(source)) return 'wiki-link'
  if (hasMathSyntax(source)) return 'math'
  return undefined
}

function byteOffsets(source: string, offsets: readonly number[]): Map<number, number> {
  const sorted = [...new Set(offsets)].sort((left, right) => left - right)
  const result = new Map<number, number>()
  let previousOffset = 0
  let bytes = 0
  for (const offset of sorted) {
    bytes += new TextEncoder().encode(source.slice(previousOffset, offset)).byteLength
    result.set(offset, bytes)
    previousOffset = offset
  }
  return result
}

function point(
  mdastPoint: { line: number; column: number; offset?: number | undefined },
  sourceOffset: number,
  bytes: ReadonlyMap<number, number>
): SourcePoint {
  const offset = (mdastPoint.offset ?? 0) + sourceOffset
  const byteOffset = bytes.get(offset)
  if (byteOffset === undefined) throw new Error(`Missing UTF-8 offset for source position ${offset}`)
  return {
    offset,
    byteOffset,
    line: mdastPoint.line,
    column: mdastPoint.column
  }
}

/** Parse CommonMark, GFM, and YAML frontmatter while retaining exact top-level source spans. */
export function parseMarkdown(source: string): ParsedMarkdown {
  const bomLength = source.startsWith(BOM) ? BOM.length : 0
  const parseSource = source.slice(bomLength)
  const ast = fromMarkdown(parseSource, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])]
  })
  if (bomLength) shiftOffsets(ast as NodeWithChildren, bomLength)

  const offsets = [0, source.length]
  for (const node of ast.children) {
    if (!node.position) continue
    offsets.push(node.position.start.offset ?? 0)
    offsets.push(node.position.end.offset ?? 0)
  }
  const bytes = byteOffsets(source, offsets)

  const blocks: MarkdownBlock[] = []
  for (const node of ast.children) {
    if (!node.position) continue
    const start = point(node.position.start, 0, bytes)
    const end = point(node.position.end, 0, bytes)
    const original = source.slice(start.offset, end.offset)
    const rawKind = classifyRaw(node, original)
    const block: MarkdownBlock = {
      id: `block-${blocks.length}`,
      index: blocks.length,
      node,
      span: { start, end },
      source: original,
      presentation: rawKind ? 'raw' : 'visual'
    }
    if (rawKind) block.rawKind = rawKind
    blocks.push(block)
  }

  const gaps: string[] = []
  let cursor = 0
  for (const block of blocks) {
    gaps.push(source.slice(cursor, block.span.start.offset))
    cursor = block.span.end.offset
  }
  gaps.push(source.slice(cursor))

  return {
    source,
    ast,
    blocks,
    gaps,
    conventions: detectMarkdownConventions(source, ast)
  }
}
