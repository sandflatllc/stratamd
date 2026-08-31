import { Fragment, type Mark, type Node as ProseMirrorNode, type NodeType } from 'prosemirror-model'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { detectMarkdownConventions, parseMarkdown, serializeMarkdown, shiftOffsets } from '../core/markdown/index.js'
import type {
  MarkdownAst,
  MarkdownBlock,
  MarkdownBlockEdit,
  MarkdownConventions,
  MarkdownNode,
  ParsedMarkdown,
  SourcePoint,
} from '../core/markdown/types.js'
import { spliceContent } from '../shared/view-sync.js'
import { strataSchema } from './schema'
import type {
  EditorMarkdownBlock,
  EditorMarkdownUpdate,
  ParsedEditorMarkdown,
  ParsedMarkdownBlock,
} from './types'

interface MdastPosition {
  start: { offset?: number }
  end: { offset?: number }
}

interface MdastNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number | null
  spread?: boolean
  checked?: boolean | null
  url?: string
  title?: string | null
  alt?: string | null
  identifier?: string
  label?: string | null
  lang?: string | null
  meta?: string | null
  align?: Array<'left' | 'right' | 'center' | null>
  position?: MdastPosition
  children?: MdastNode[]
}

interface LinkDefinition {
  url: string
  title: string | null
}

const unsupportedNodeTypes = new Set([
  'yaml',
  'html',
  'definition',
  'footnoteDefinition',
  'footnoteReference',
  'math',
  'inlineMath',
])

function nodePosition(node: MdastNode, source: string): { from: number; to: number } {
  return {
    from: node.position?.start.offset ?? 0,
    to: node.position?.end.offset ?? source.length,
  }
}

function descendants(node: MdastNode): MdastNode[] {
  const result: MdastNode[] = [node]
  for (const child of node.children ?? []) result.push(...descendants(child))
  return result
}

function rawKind(node: MdastNode, raw: string): string | null {
  const unsupported = descendants(node).find((candidate) => unsupportedNodeTypes.has(candidate.type))
  if (unsupported) {
    if (unsupported.type === 'definition') return 'link-definition'
    if (unsupported.type.includes('footnote')) return 'footnote'
    if (unsupported.type.includes('Math') || unsupported.type === 'math') return 'math'
    return unsupported.type
  }
  if (/\[\[[\s\S]*?\]\]/u.test(raw)) return 'wiki-link'
  if (/(?:^|[^\\])\[\^[^\]]+\](?::)?/u.test(raw)) return 'footnote'
  if (/^\s*(?:\$\$|\\\[)/u.test(raw) || /(?:^|[^\\])\$[^\n$]+\$/u.test(raw)) return 'math'
  return null
}

function splitText(value: string, marks: readonly Mark[], sourceRaw?: string): ProseMirrorNode[] {
  const parts = value.split(/(\r?\n)/u)
  const result: ProseMirrorNode[] = []
  let sourceCursor = 0
  for (const part of parts) {
    if (part === '\n' || part === '\r\n') {
      const rawBreak = sourceRaw?.slice(sourceCursor).match(/^(?:\r\n|\r|\n)/u)?.[0] ?? null
      result.push(strataSchema.nodes.soft_break.create({ sourceRaw: rawBreak }))
      sourceCursor += rawBreak?.length ?? part.length
    }
    else if (part) {
      result.push(strataSchema.text(part, marks))
      sourceCursor += part.length
    }
  }
  return result
}

const preservableSourceToken = /(?:&(?:#[xX][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);|\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu

function decodedMarkdownToken(raw: string): string | null {
  const root = fromMarkdown(raw) as unknown as { children?: Array<{ children?: Array<{ type?: string; value?: string }> }> }
  const children = root.children?.[0]?.children
  if (children?.length !== 1 || children[0]?.type !== 'text') return null
  return children[0].value ?? null
}

/** Split only source spellings that Markdown decodes, leaving normal text editable. */
function sourcePreservingText(value: string, raw: string, marks: readonly Mark[]): ProseMirrorNode[] {
  const matches = [...raw.matchAll(preservableSourceToken)]
  if (matches.length === 0) return splitText(value, marks, raw)

  const output: ProseMirrorNode[] = []
  let rawCursor = 0
  let valueCursor = 0
  for (const match of matches) {
    const rawToken = match[0]
    const rawIndex = match.index
    const literal = raw.slice(rawCursor, rawIndex)
    if (value.slice(valueCursor, valueCursor + literal.length) !== literal) {
      return splitText(value, marks, raw)
    }
    if (literal) output.push(...splitText(literal, marks, literal))
    valueCursor += literal.length

    const decoded = decodedMarkdownToken(rawToken)
    if (decoded === null || value.slice(valueCursor, valueCursor + decoded.length) !== decoded) {
      return splitText(value, marks, raw)
    }
    output.push(strataSchema.text(decoded, [
      ...marks,
      strataSchema.marks.source_token.create({ raw: rawToken, decoded }),
    ]))
    valueCursor += decoded.length
    rawCursor = rawIndex + rawToken.length
  }

  const remainder = raw.slice(rawCursor)
  if (value.slice(valueCursor) !== remainder) return splitText(value, marks, raw)
  if (remainder) output.push(...splitText(remainder, marks, remainder))
  return output
}

function sourceSlice(node: MdastNode, source: string): string {
  const { from, to } = nodePosition(node, source)
  return source.slice(from, to)
}

function inlineNodes(
  nodes: readonly MdastNode[],
  source: string,
  definitions: ReadonlyMap<string, LinkDefinition>,
  marks: readonly Mark[] = [],
): ProseMirrorNode[] {
  const output: ProseMirrorNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        output.push(...sourcePreservingText(node.value ?? '', sourceSlice(node, source), marks))
        break
      case 'emphasis':
        output.push(...inlineNodes(node.children ?? [], source, definitions, [
          ...marks,
          strataSchema.marks.em.create({ delimiter: sourceSlice(node, source).startsWith('_') ? '_' : '*' }),
        ]))
        break
      case 'strong':
        output.push(...inlineNodes(node.children ?? [], source, definitions, [
          ...marks,
          strataSchema.marks.strong.create({ delimiter: sourceSlice(node, source).startsWith('__') ? '__' : '**' }),
        ]))
        break
      case 'delete':
        output.push(...inlineNodes(node.children ?? [], source, definitions, [
          ...marks,
          strataSchema.marks.strike.create({ delimiter: '~~' }),
        ]))
        break
      case 'inlineCode': {
        const delimiter = sourceSlice(node, source).match(/^`+/u)?.[0] ?? '`'
        output.push(...splitText(node.value ?? '', [...marks, strataSchema.marks.code.create({ delimiter })]))
        break
      }
      case 'link': {
        const raw = sourceSlice(node, source)
        const autolink = raw.startsWith('<') || raw === node.url || /^https?:\/\//iu.test(raw) && raw === node.url
        const link = strataSchema.marks.link.create({
          href: node.url ?? '',
          title: node.title ?? null,
          autolink,
          reference: null,
        })
        output.push(...inlineNodes(node.children ?? [], source, definitions, [...marks, link]))
        break
      }
      case 'linkReference': {
        const identifier = (node.identifier ?? '').toLowerCase()
        const definition = definitions.get(identifier)
        const link = strataSchema.marks.link.create({
          href: definition?.url ?? '',
          title: definition?.title ?? null,
          autolink: false,
          reference: node.label ?? node.identifier ?? '',
        })
        output.push(...inlineNodes(node.children ?? [], source, definitions, [...marks, link]))
        break
      }
      case 'image':
        output.push(strataSchema.nodes.image.create({
          src: node.url ?? '',
          alt: node.alt ?? '',
          title: node.title ?? null,
          reference: null,
        }))
        break
      case 'imageReference': {
        const definition = definitions.get((node.identifier ?? '').toLowerCase())
        output.push(strataSchema.nodes.image.create({
          src: definition?.url ?? '',
          alt: node.alt ?? '',
          title: definition?.title ?? null,
          reference: node.label ?? node.identifier ?? '',
        }))
        break
      }
      case 'break':
        output.push(strataSchema.nodes.hard_break.create({ sourceRaw: sourceSlice(node, source) }))
        break
      default:
        output.push(...splitText(sourceSlice(node, source) || node.value || '', marks))
    }
  }
  return output
}

function sourceAttrs(id: string | null, node: MdastNode, source: string): Record<string, unknown> {
  const span = nodePosition(node, source)
  return { sourceId: id, sourceFrom: span.from, sourceTo: span.to }
}

function blockNode(
  node: MdastNode,
  source: string,
  definitions: ReadonlyMap<string, LinkDefinition>,
  sourceId: string | null,
): ProseMirrorNode {
  const attrs = sourceAttrs(sourceId, node, source)
  const raw = sourceSlice(node, source)
  const unsupported = rawKind(node, raw)
  if (unsupported) return strataSchema.nodes.raw_block.create({ ...attrs, raw, kind: unsupported })

  switch (node.type) {
    case 'paragraph':
      return strataSchema.nodes.paragraph.create(attrs, inlineNodes(node.children ?? [], source, definitions))
    case 'heading': {
      const style = /^\s*#{1,6}(?:\s|$)/u.test(raw) ? 'atx' : 'setext'
      return strataSchema.nodes.heading.create(
        { ...attrs, level: node.depth ?? 1, style },
        inlineNodes(node.children ?? [], source, definitions),
      )
    }
    case 'thematicBreak':
      return strataSchema.nodes.horizontal_rule.create({ ...attrs, markup: raw.trim() })
    case 'blockquote':
      return strataSchema.nodes.blockquote.create(
        attrs,
        (node.children ?? []).map((child) => blockNode(child, source, definitions, null)),
      )
    case 'code': {
      const fenced = /^\s*(?:`{3,}|~{3,})/u.test(raw)
      const fence = fenced ? raw.trimStart()[0] : null
      return strataSchema.nodes.code_block.create(
        {
          ...attrs,
          fenced,
          fence,
          info: node.lang ?? null,
          meta: node.meta ?? null,
        },
        node.value ? strataSchema.text(node.value) : undefined,
      )
    }
    case 'list': {
      const ordered = node.ordered === true
      const markerMatch = raw.match(/^\s*(?:([-+*])|(\d+)([.)]))\s/u)
      const listAttrs = {
        ...attrs,
        order: ordered ? node.start ?? 1 : 1,
        marker: ordered ? markerMatch?.[3] ?? '.' : markerMatch?.[1] ?? '-',
        tight: node.spread !== true,
      }
      const children = (node.children ?? []).map((child) => blockNode(child, source, definitions, null))
      return (ordered ? strataSchema.nodes.ordered_list : strataSchema.nodes.bullet_list).create(listAttrs, children)
    }
    case 'listItem':
      return strataSchema.nodes.list_item.create(
        { ...attrs, checked: node.checked ?? null, spread: node.spread === true },
        (node.children ?? []).map((child) => blockNode(child, source, definitions, null)),
      )
    case 'table': {
      const rows = (node.children ?? []).map((row, rowIndex) => {
        const cells = (row.children ?? []).map((cell, cellIndex) => {
          const cellType = rowIndex === 0 ? strataSchema.nodes.table_header : strataSchema.nodes.table_cell
          const paragraph = strataSchema.nodes.paragraph.create(null, inlineNodes(cell.children ?? [], source, definitions))
          return cellType.create({ align: node.align?.[cellIndex] ?? null }, paragraph)
        })
        return strataSchema.nodes.table_row.create(null, cells)
      })
      return strataSchema.nodes.table.create({ ...attrs, align: node.align ?? [] }, rows)
    }
    case 'yaml':
    case 'html':
    case 'definition':
      return strataSchema.nodes.raw_block.create({ ...attrs, raw, kind: rawKind(node, raw) ?? node.type })
    default:
      return strataSchema.nodes.raw_block.create({ ...attrs, raw, kind: node.type })
  }
}

/** One conversion path from a core block to its editor block, shared by full parse and stitch. */
function editorBlockFromCore(
  coreBlock: MarkdownBlock,
  source: string,
  definitions: ReadonlyMap<string, LinkDefinition>,
): ParsedMarkdownBlock {
  const node = coreBlock.node as MdastNode
  const id = coreBlock.id
  const span = { from: coreBlock.span.start.offset, to: coreBlock.span.end.offset }
  const raw = source.slice(span.from, span.to)
  const converted = coreBlock.presentation === 'raw'
    ? strataSchema.nodes.raw_block.create({
        ...sourceAttrs(id, node, source),
        raw,
        kind: coreBlock.rawKind === 'frontmatter' ? 'yaml' : coreBlock.rawKind ?? 'unsupported',
      })
    : blockNode(node, source, definitions, id)
  return { id, span, raw, node: converted }
}

export function parseMarkdownForEditor(markdown: string): ParsedEditorMarkdown {
  const core = parseMarkdown(markdown)
  const tree = core.ast as MdastNode
  const definitions = new Map<string, LinkDefinition>()
  for (const node of tree.children ?? []) {
    if (node.type === 'definition' && node.identifier) {
      definitions.set(node.identifier.toLowerCase(), { url: node.url ?? '', title: node.title ?? null })
    }
  }

  const blocks = core.blocks.map((coreBlock) => editorBlockFromCore(coreBlock, markdown, definitions))
  const editorNodes: ProseMirrorNode[] = blocks.map((block) => block.node)
  if (editorNodes.length === 0) editorNodes.push(strataSchema.nodes.paragraph.create())
  const doc = strataSchema.nodes.doc.create(null, editorNodes)
  return {
    source: markdown,
    doc,
    blocks,
    lineEnding: markdown.includes('\r\n') ? '\r\n' : '\n',
    hasBom: markdown.charCodeAt(0) === 0xfeff,
    hasFinalNewline: /(?:\r?\n)$/u.test(markdown),
    core,
  }
}

// Block-scoped reparse: parse the splice, not the document (docs/plans/completed/reparse-plan.md).

export type ReparseFallbackReason =
  | 'no-blocks'
  | 'link-definition'
  | 'offset-zero'
  | 'frontmatter'
  | 'changed-construct'
  | 'raw-block'
  | 'region-too-large'
  | 'region-bom'
  | 'region-parse-raw'
  | 'sentinel-mismatch'
  | 'stitch-mismatch'
  | 'verify-divergence'

export interface ReparseStats {
  /** Successful stitched reparses. */
  stitched: number
  /** Full parses taken instead of a stitch, by reason (docs/plans/completed/reparse-plan.md §7). */
  fallbacks: Partial<Record<ReparseFallbackReason, number>>
}

export const reparseStats: ReparseStats = { stitched: 0, fallbacks: {} }
// Readable from e2e runs without reaching into the bundle.
;(globalThis as Record<string, unknown>).strataReparseStats = reparseStats

export function resetReparseStats(): void {
  reparseStats.stitched = 0
  reparseStats.fallbacks = {}
}

function countFallback(reason: ReparseFallbackReason): void {
  reparseStats.fallbacks[reason] = (reparseStats.fallbacks[reason] ?? 0) + 1
}

function parseVerifyEnabled(): boolean {
  if ((globalThis as { strataParseVerify?: unknown }).strataParseVerify === '1') return true
  return typeof process !== 'undefined' && process.env?.STRATAMD_PARSE_VERIFY === '1'
}

/**
 * Constructs whose reach a region parse cannot see (docs/plans/completed/reparse-plan.md §5):
 * fence markers, math fences, footnote syntax, and lines that can open an HTML
 * block or a link reference definition.
 */
const reachyText = /```|~~~|\$\$|\[\^/u
const reachyLineStart = /(?:^|[\r\n]) {0,3}[<[]/u

function extendToLines(text: string, start: number, end: number): string {
  let from = start
  while (from > 0 && text[from - 1] !== '\n' && text[from - 1] !== '\r') from -= 1
  let to = end
  while (to < text.length && text[to] !== '\n' && text[to] !== '\r') to += 1
  return text.slice(from, to)
}

function hasReachyConstruct(slice: string): boolean {
  return reachyText.test(slice) || reachyLineStart.test(slice)
}

interface MdastShiftPoint {
  line: number
  column: number
  offset?: number | undefined
}

interface ShiftableNode {
  position?: { start: MdastShiftPoint; end: MdastShiftPoint } | undefined
  children?: readonly ShiftableNode[] | undefined
}

/**
 * shiftOffsets, but cloning: the previous parse stays alive as the
 * serializer's byte-preservation baseline, so its mdast is never mutated.
 * Inner line/column values are left as-is, exactly like shiftOffsets.
 */
function cloneWithShiftedOffsets(node: ShiftableNode, amount: number): ShiftableNode {
  const clone: ShiftableNode = { ...node }
  if (node.position) {
    clone.position = {
      start: {
        ...node.position.start,
        ...(node.position.start.offset === undefined ? {} : { offset: node.position.start.offset + amount }),
      },
      end: {
        ...node.position.end,
        ...(node.position.end.offset === undefined ? {} : { offset: node.position.end.offset + amount }),
      },
    }
  }
  if (node.children) clone.children = node.children.map((child) => cloneWithShiftedOffsets(child, amount))
  return clone
}

/** Block containers whose children also carry sourceFrom/sourceTo attributes. */
const sourceAttrContainers: ReadonlySet<NodeType> = new Set([
  strataSchema.nodes.blockquote,
  strataSchema.nodes.bullet_list,
  strataSchema.nodes.ordered_list,
  strataSchema.nodes.list_item,
])

/**
 * Rewrite sourceId/sourceFrom/sourceTo on a reused ProseMirror block,
 * recursing only where nested blocks carry source attributes. Inline content
 * is reused as-is; the node comes back unchanged when nothing shifts.
 */
function shiftEditorNode(node: ProseMirrorNode, amount: number, id?: string): ProseMirrorNode {
  let content = node.content
  if (sourceAttrContainers.has(node.type)) {
    const children: ProseMirrorNode[] = []
    let changed = false
    node.forEach((child) => {
      const shifted = shiftEditorNode(child, amount)
      if (shifted !== child) changed = true
      children.push(shifted)
    })
    if (changed) content = Fragment.fromArray(children)
  }
  const shiftsSpan = amount !== 0 && typeof node.attrs.sourceFrom === 'number'
  const renames = id !== undefined && node.attrs.sourceId !== id
  if (!shiftsSpan && !renames && content === node.content) return node
  const attrs: Record<string, unknown> = { ...node.attrs }
  if (typeof node.attrs.sourceFrom === 'number') attrs.sourceFrom = node.attrs.sourceFrom + amount
  if (typeof node.attrs.sourceTo === 'number') attrs.sourceTo = node.attrs.sourceTo + amount
  if (id !== undefined) attrs.sourceId = id
  return node.type.create(attrs, content, node.marks)
}

function shiftPoint(point: SourcePoint, offset: number, bytes: number, lines: number): SourcePoint {
  return { offset: point.offset + offset, byteOffset: point.byteOffset + bytes, line: point.line + lines, column: point.column }
}

/** Region-relative point to document coordinates; `base` is the point the region text starts at. */
function rebasePoint(point: SourcePoint, base: SourcePoint): SourcePoint {
  return {
    offset: point.offset + base.offset,
    byteOffset: point.byteOffset + base.byteOffset,
    line: point.line + base.line - 1,
    column: point.line === 1 ? point.column + base.column - 1 : point.column,
  }
}

function countLineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/gu)?.length ?? 0
}

const utf8 = new TextEncoder()

type StitchAttempt = { ok: true; parsed: ParsedEditorMarkdown } | { ok: false; reason: ReparseFallbackReason }

function tryStitchParse(previous: ParsedEditorMarkdown, nextSource: string): StitchAttempt {
  const fail = (reason: ReparseFallbackReason): StitchAttempt => ({ ok: false, reason })
  const previousSource = previous.source
  const coreBlocks = previous.core.blocks
  const blockCount = coreBlocks.length
  if (blockCount === 0) return fail('no-blocks')
  // A link reference definition's reach is unbounded (docs/plans/completed/reparse-plan.md §5).
  if (coreBlocks.some((block) => block.rawKind === 'link-definition')) return fail('link-definition')

  const splice = spliceContent(previousSource, nextSource)
  let prefix = splice.prefix
  let suffix = splice.suffix
  // Never split a surrogate pair or a CRLF pair at a boundary: byte and line
  // deltas are computed from the changed slices alone.
  while (prefix > 0) {
    const boundary = previousSource.charCodeAt(prefix - 1)
    const splitsPair = boundary >= 0xd800 && boundary <= 0xdbff
    const splitsCrlf = previousSource[prefix - 1] === '\r'
      && (previousSource[prefix] === '\n' || nextSource[prefix] === '\n')
    if (!splitsPair && !splitsCrlf) break
    prefix -= 1
  }
  while (suffix > 0) {
    const boundary = previousSource.charCodeAt(previousSource.length - suffix)
    const splitsPair = boundary >= 0xdc00 && boundary <= 0xdfff
    const splitsCrlf = previousSource[previousSource.length - suffix] === '\n'
      && (previousSource[previousSource.length - suffix - 1] === '\r'
        || nextSource[nextSource.length - suffix - 1] === '\r')
    if (!splitsPair && !splitsCrlf) break
    suffix -= 1
  }

  const changeStart = prefix
  const changeEnd = previousSource.length - suffix
  const delta = nextSource.length - previousSource.length

  if (hasReachyConstruct(extendToLines(previousSource, changeStart, changeEnd))
    || hasReachyConstruct(extendToLines(nextSource, prefix, nextSource.length - suffix))) {
    return fail('changed-construct')
  }

  // Touched blocks: spans overlapping the changed range, boundaries inclusive.
  let firstTouched = -1
  let lastTouched = -1
  for (let index = 0; index < blockCount; index += 1) {
    const span = coreBlocks[index]!.span
    if (span.end.offset >= changeStart && span.start.offset <= changeEnd) {
      if (firstTouched < 0) firstTouched = index
      lastTouched = index
    }
  }
  if (firstTouched < 0) {
    // The change sits strictly inside a gap: both neighbouring blocks count as touched.
    let following = 0
    while (following < blockCount && coreBlocks[following]!.span.start.offset <= changeEnd) following += 1
    firstTouched = Math.max(0, following - 1)
    lastTouched = Math.min(blockCount - 1, following)
  }

  // Expand by one block on each side; the expansion blocks are the sentinels.
  const regionFirst = firstTouched - 1
  if (regionFirst < 1) return fail('offset-zero')
  const hasEndSentinel = lastTouched + 1 <= blockCount - 1
  const regionLast = hasEndSentinel ? lastTouched + 1 : blockCount - 1
  if (regionLast - regionFirst + 1 > 32) return fail('region-too-large')
  for (let index = regionFirst - 1; index <= Math.min(blockCount - 1, regionLast + 1); index += 1) {
    const block = coreBlocks[index]!
    if (block.rawKind === 'frontmatter') return fail('frontmatter')
    if (block.rawKind !== undefined) return fail('raw-block')
  }

  // The region includes the gap on both sides, so blank-line context is real.
  const regionBase = coreBlocks[regionFirst - 1]!.span.end
  const regionOldEnd = regionLast + 1 < blockCount
    ? coreBlocks[regionLast + 1]!.span.start.offset
    : previousSource.length
  if (regionBase.offset > changeStart || regionOldEnd < changeEnd) return fail('stitch-mismatch')
  const regionText = nextSource.slice(regionBase.offset, regionOldEnd + delta)
  if (regionText.charCodeAt(0) === 0xfeff) return fail('region-bom')

  const regionParsed = parseMarkdown(regionText)
  const regionBlocks = regionParsed.blocks
  if (regionBlocks.length < (hasEndSentinel ? 2 : 1)) return fail('sentinel-mismatch')
  // Definitions and frontmatter formed inside the region reach beyond it.
  if (regionBlocks.some((block) => block.rawKind === 'link-definition' || block.rawKind === 'frontmatter')) {
    return fail('region-parse-raw')
  }

  // Verify, then trust: the untouched expansion blocks must come back
  // byte-for-byte at the same spans with the same shape, or the edit's
  // effects escaped the region (docs/plans/completed/reparse-plan.md §4.5).
  const startSentinel = regionBlocks[0]!
  const beforeSentinel = coreBlocks[regionFirst]!
  if (startSentinel.source !== beforeSentinel.source
    || startSentinel.span.start.offset + regionBase.offset !== beforeSentinel.span.start.offset
    || startSentinel.span.end.offset + regionBase.offset !== beforeSentinel.span.end.offset
    || startSentinel.node.type !== beforeSentinel.node.type
    || startSentinel.rawKind !== beforeSentinel.rawKind) {
    return fail('sentinel-mismatch')
  }
  if (hasEndSentinel) {
    const endSentinel = regionBlocks[regionBlocks.length - 1]!
    const afterSentinel = coreBlocks[regionLast]!
    if (endSentinel.source !== afterSentinel.source
      || endSentinel.span.start.offset + regionBase.offset !== afterSentinel.span.start.offset + delta
      || endSentinel.span.end.offset + regionBase.offset !== afterSentinel.span.end.offset + delta
      || endSentinel.node.type !== afterSentinel.node.type
      || endSentinel.rawKind !== afterSentinel.rawKind) {
      return fail('sentinel-mismatch')
    }
  }

  const removed = previousSource.slice(changeStart, changeEnd)
  const inserted = nextSource.slice(prefix, nextSource.length - suffix)
  const byteDelta = utf8.encode(inserted).byteLength - utf8.encode(removed).byteLength
  const lineDelta = countLineBreaks(inserted) - countLineBreaks(removed)

  // The sentinels themselves are stitched from the previous parse (the exact
  // blocks a full parse of nextSource reproduces); the region parse's copies
  // of them exist only for the verification above.
  const interior = regionBlocks.slice(1, hasEndSentinel ? regionBlocks.length - 1 : regionBlocks.length)

  const stitchedCore: MarkdownBlock[] = []
  const editorBlocks: ParsedMarkdownBlock[] = []
  const definitions = new Map<string, LinkDefinition>()

  // Before the region: byte-identical prefix, everything reused.
  for (let index = 0; index <= regionFirst; index += 1) {
    stitchedCore.push({ ...coreBlocks[index]! })
    editorBlocks.push({ ...previous.blocks[index]! })
  }
  // Interior: freshly parsed, rebased to document coordinates.
  for (const block of interior) {
    const index = stitchedCore.length
    const id = `block-${index}`
    shiftOffsets(block.node as Parameters<typeof shiftOffsets>[0], regionBase.offset)
    const span = { start: rebasePoint(block.span.start, regionBase), end: rebasePoint(block.span.end, regionBase) }
    const stitched: MarkdownBlock = {
      id,
      index,
      node: block.node,
      span,
      source: block.source,
      presentation: block.presentation,
    }
    if (block.rawKind !== undefined) stitched.rawKind = block.rawKind
    stitchedCore.push(stitched)
    editorBlocks.push(editorBlockFromCore(stitched, nextSource, definitions))
  }
  // From the end sentinel on: byte-identical suffix shifted by the splice deltas.
  if (hasEndSentinel) {
    const unchangedTail = delta === 0 && byteDelta === 0 && lineDelta === 0
    for (let index = regionLast; index < blockCount; index += 1) {
      const block = coreBlocks[index]!
      const stitchedIndex = stitchedCore.length
      const id = `block-${stitchedIndex}`
      const node = delta === 0
        ? block.node
        : cloneWithShiftedOffsets(block.node as ShiftableNode, delta) as MarkdownNode
      const span = unchangedTail
        ? block.span
        : {
            start: shiftPoint(block.span.start, delta, byteDelta, lineDelta),
            end: shiftPoint(block.span.end, delta, byteDelta, lineDelta),
          }
      const stitched: MarkdownBlock = {
        id,
        index: stitchedIndex,
        node,
        span,
        source: block.source,
        presentation: block.presentation,
      }
      if (block.rawKind !== undefined) stitched.rawKind = block.rawKind
      stitchedCore.push(stitched)
      const previousEditor = previous.blocks[index]!
      editorBlocks.push({
        id,
        span: { from: previousEditor.span.from + delta, to: previousEditor.span.to + delta },
        raw: previousEditor.raw,
        node: shiftEditorNode(previousEditor.node, delta, id),
      })
    }
  }

  // Assert, don't assume: every stitched span must carve nextSource exactly,
  // in order, so the blocks plus the recomputed gaps reassemble the document.
  let cursor = 0
  for (const block of stitchedCore) {
    const { start, end } = block.span
    if (start.offset < cursor || end.offset < start.offset || end.offset > nextSource.length) return fail('stitch-mismatch')
    if (nextSource.slice(start.offset, end.offset) !== block.source) return fail('stitch-mismatch')
    cursor = end.offset
  }

  const gaps: string[] = []
  let gapCursor = 0
  for (const block of stitchedCore) {
    gaps.push(nextSource.slice(gapCursor, block.span.start.offset))
    gapCursor = block.span.end.offset
  }
  gaps.push(nextSource.slice(gapCursor))

  const previousRoot = previous.core.ast as unknown as {
    position?: { start: MdastShiftPoint; end: MdastShiftPoint } | undefined
  }
  const regionRoot = regionParsed.ast as unknown as {
    position?: { start: MdastShiftPoint; end: MdastShiftPoint } | undefined
  }
  let position: { start: MdastShiftPoint; end: MdastShiftPoint } | undefined
  if (previousRoot.position) {
    const end = regionOldEnd === previousSource.length && regionRoot.position
      ? {
          line: regionRoot.position.end.line + regionBase.line - 1,
          column: regionRoot.position.end.line === 1
            ? regionRoot.position.end.column + regionBase.column - 1
            : regionRoot.position.end.column,
          offset: (regionRoot.position.end.offset ?? regionText.length) + regionBase.offset,
        }
      : {
          line: previousRoot.position.end.line + lineDelta,
          column: previousRoot.position.end.column,
          offset: nextSource.length,
        }
    position = { start: { ...previousRoot.position.start }, end }
  }
  const ast = {
    type: 'root',
    children: stitchedCore.map((block) => block.node),
    ...(position ? { position } : {}),
  } as unknown as MarkdownAst

  const core: ParsedMarkdown = {
    source: nextSource,
    ast,
    blocks: stitchedCore,
    gaps,
    conventions: detectMarkdownConventions(nextSource, ast),
  }

  const editorNodes = editorBlocks.map((block) => block.node)
  if (editorNodes.length === 0) editorNodes.push(strataSchema.nodes.paragraph.create())
  return {
    ok: true,
    parsed: {
      source: nextSource,
      doc: strataSchema.nodes.doc.create(null, editorNodes),
      blocks: editorBlocks,
      lineEnding: nextSource.includes('\r\n') ? '\r\n' : '\n',
      hasBom: nextSource.charCodeAt(0) === 0xfeff,
      hasFinalNewline: /(?:\r?\n)$/u.test(nextSource),
      core,
    },
  }
}

function pointsDiffer(left: SourcePoint, right: SourcePoint): boolean {
  return left.offset !== right.offset || left.byteOffset !== right.byteOffset
    || left.line !== right.line || left.column !== right.column
}

/** Deep comparison across every consumed field; returns the first divergence, or null. */
export function describeParseDivergence(stitched: ParsedEditorMarkdown, full: ParsedEditorMarkdown): string | null {
  if (stitched.source !== full.source) return 'source differs'
  if (stitched.lineEnding !== full.lineEnding) return 'lineEnding differs'
  if (stitched.hasBom !== full.hasBom) return 'hasBom differs'
  if (stitched.hasFinalNewline !== full.hasFinalNewline) return 'hasFinalNewline differs'
  if (stitched.blocks.length !== full.blocks.length) return 'editor block count differs'
  for (let index = 0; index < full.blocks.length; index += 1) {
    const left = stitched.blocks[index]!
    const right = full.blocks[index]!
    if (left.id !== right.id) return `editor block ${index} id`
    if (left.span.from !== right.span.from || left.span.to !== right.span.to) return `editor block ${index} span`
    if (left.raw !== right.raw) return `editor block ${index} raw`
    if (!left.node.eq(right.node)) return `editor block ${index} node`
  }
  if (!stitched.doc.eq(full.doc)) return 'doc differs'
  if (stitched.core.blocks.length !== full.core.blocks.length) return 'core block count differs'
  for (let index = 0; index < full.core.blocks.length; index += 1) {
    const left = stitched.core.blocks[index]!
    const right = full.core.blocks[index]!
    if (left.id !== right.id || left.index !== right.index) return `core block ${index} id`
    if (left.source !== right.source) return `core block ${index} source`
    if (left.presentation !== right.presentation) return `core block ${index} presentation`
    if (left.rawKind !== right.rawKind) return `core block ${index} rawKind`
    if (pointsDiffer(left.span.start, right.span.start) || pointsDiffer(left.span.end, right.span.end)) {
      return `core block ${index} span`
    }
  }
  if (stitched.core.gaps.length !== full.core.gaps.length) return 'gap count differs'
  for (let index = 0; index < full.core.gaps.length; index += 1) {
    if (stitched.core.gaps[index] !== full.core.gaps[index]) return `gap ${index} differs`
  }
  if (JSON.stringify(stitched.core.conventions) !== JSON.stringify(full.core.conventions)) return 'conventions differ'
  return null
}

/**
 * Parse nextSource by reparsing only the blocks the splice against
 * previous.source touches, stitching the rest, or fall back to a full parse
 * whenever equivalence cannot be guaranteed. The result is indistinguishable
 * from parseMarkdownForEditor(nextSource) in every consumed field
 * (docs/plans/completed/reparse-plan.md §2).
 */
export function updateParsedMarkdown(previous: ParsedEditorMarkdown, nextSource: string): ParsedEditorMarkdown {
  if (previous.source === nextSource) return previous
  const attempt = tryStitchParse(previous, nextSource)
  if (!attempt.ok) {
    countFallback(attempt.reason)
    return parseMarkdownForEditor(nextSource)
  }
  if (parseVerifyEnabled()) {
    const full = parseMarkdownForEditor(nextSource)
    const divergence = describeParseDivergence(attempt.parsed, full)
    if (divergence !== null) {
      console.error(`StrataMD reparse: stitched parse diverged from the full parse (${divergence}); using the full parse`)
      countFallback('verify-divergence')
      return full
    }
  }
  reparseStats.stitched += 1
  return attempt.parsed
}

export function createEditorMarkdownUpdate(
  original: ParsedEditorMarkdown,
  doc: ProseMirrorNode,
): EditorMarkdownUpdate {
  const originalsById = new Map(original.blocks.map((block) => [block.id, block]))
  const seen = new Set<string>()
  const blocks: EditorMarkdownBlock[] = []
  doc.forEach((node) => {
    const sourceId = typeof node.attrs.sourceId === 'string' ? node.attrs.sourceId : null
    const old = sourceId && !seen.has(sourceId) ? originalsById.get(sourceId) ?? null : null
    if (sourceId) seen.add(sourceId)
    blocks.push({ id: old ? sourceId : null, node, original: old, unchanged: old?.node.eq(node) ?? false })
  })
  return {
    source: original.source,
    original,
    blocks,
    deleted: original.blocks.filter((block) => !seen.has(block.id)),
  }
}

function escapeInline(value: string): string {
  // Escape characters that can open inline constructs anywhere. Characters
  // such as '.', '-', '+', '#', and '!' are only special in line-specific
  // contexts and escaping them here creates unrelated byte churn.
  return value.replace(/([\\`*_\[\]<>])/gu, '\\$1')
}

function serializeInline(
  node: ProseMirrorNode,
  conventions?: MarkdownConventions,
  lineEnding = '\n',
): string {
  if (node.type === strataSchema.nodes.hard_break) {
    return typeof node.attrs.sourceRaw === 'string' ? node.attrs.sourceRaw : `  ${lineEnding}`
  }
  if (node.type === strataSchema.nodes.soft_break) {
    return typeof node.attrs.sourceRaw === 'string' ? node.attrs.sourceRaw : lineEnding
  }
  if (node.type === strataSchema.nodes.image) {
    if (node.attrs.reference) return `![${String(node.attrs.alt ?? '')}][${String(node.attrs.reference)}]`
    const title = node.attrs.title ? ` \"${String(node.attrs.title).replaceAll('"', '\\"')}\"` : ''
    return `![${String(node.attrs.alt ?? '')}](${String(node.attrs.src)}${title})`
  }
  if (!node.isText) return node.textContent
  return wrapInlineText(serializeTextSource(node), semanticMarks(node), conventions)
}

function semanticMarks(node: ProseMirrorNode): readonly Mark[] {
  return node.marks.filter((mark) => mark.type !== strataSchema.marks.source_token)
}

function sameMarks(left: readonly Mark[], right: readonly Mark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark.eq(right[index]!))
}

function serializeTextSource(node: ProseMirrorNode): string {
  const sourceToken = node.marks.find((mark) => mark.type === strataSchema.marks.source_token)
  const tokenIsIntact = sourceToken !== undefined && node.text === sourceToken.attrs.decoded
  if (tokenIsIntact) return String(sourceToken.attrs.raw)
  if (node.marks.some((mark) => mark.type === strataSchema.marks.code)) return node.text ?? ''
  return escapeInline(node.text ?? '')
}

function wrapInlineText(
  source: string,
  marks: readonly Mark[],
  conventions?: MarkdownConventions,
): string {
  const codeMark = marks.find((mark) => mark.type === strataSchema.marks.code)
  const codeDelimiter = String(codeMark?.attrs.delimiter ?? '`')
  let value = codeMark ? `${codeDelimiter}${source}${codeDelimiter}` : source
  for (const mark of marks) {
    if (mark.type === strataSchema.marks.code) continue
    if (mark.type === strataSchema.marks.strong) {
      const delimiter = String(mark.attrs.delimiter ?? (conventions?.strong === '_' ? '__' : '**'))
      value = `${delimiter}${value}${delimiter}`
    } else if (mark.type === strataSchema.marks.em) {
      const delimiter = String(mark.attrs.delimiter ?? conventions?.emphasis ?? '*')
      value = `${delimiter}${value}${delimiter}`
    } else if (mark.type === strataSchema.marks.strike) {
      const delimiter = String(mark.attrs.delimiter ?? '~~')
      value = `${delimiter}${value}${delimiter}`
    }
    else if (mark.type === strataSchema.marks.link) {
      if (mark.attrs.autolink) value = `<${String(mark.attrs.href)}>`
      else if (mark.attrs.reference) value = `[${value}][${String(mark.attrs.reference)}]`
      else {
        const title = mark.attrs.title ? ` \"${String(mark.attrs.title).replaceAll('"', '\\"')}\"` : ''
        value = `[${value}](${String(mark.attrs.href)}${title})`
      }
    }
  }
  return value
}

interface InlineRunItem {
  source: string
  marks: readonly Mark[]
}

/** One mark layer around already-serialized inner content; code is only ever innermost. */
function wrapWithMark(value: string, mark: Mark, conventions?: MarkdownConventions): string {
  if (mark.type === strataSchema.marks.code) {
    const delimiter = String(mark.attrs.delimiter ?? '`')
    return `${delimiter}${value}${delimiter}`
  }
  if (mark.type === strataSchema.marks.strong) {
    const delimiter = String(mark.attrs.delimiter ?? (conventions?.strong === '_' ? '__' : '**'))
    return `${delimiter}${value}${delimiter}`
  }
  if (mark.type === strataSchema.marks.em) {
    const delimiter = String(mark.attrs.delimiter ?? conventions?.emphasis ?? '*')
    return `${delimiter}${value}${delimiter}`
  }
  if (mark.type === strataSchema.marks.strike) {
    const delimiter = String(mark.attrs.delimiter ?? '~~')
    return `${delimiter}${value}${delimiter}`
  }
  if (mark.type === strataSchema.marks.link) {
    if (mark.attrs.autolink) return `<${String(mark.attrs.href)}>`
    if (mark.attrs.reference) return `[${value}][${String(mark.attrs.reference)}]`
    const title = mark.attrs.title ? ` \"${String(mark.attrs.title).replaceAll('"', '\\"')}\"` : ''
    return `[${value}](${String(mark.attrs.href)}${title})`
  }
  return value
}

/**
 * Serializes inline items by nesting marks instead of reopening them at every
 * mark-set change: the mark covering the longest run from the current item
 * wraps once, and the run serializes recursively with that mark removed. A
 * grouping approach would split `**text `code`**` into `**text **` plus a
 * separately wrapped code span, which does not survive a reparse.
 */
function serializeInlineRun(items: readonly InlineRunItem[], conventions?: MarkdownConventions): string {
  let result = ''
  let index = 0
  while (index < items.length) {
    const item = items[index]!
    if (item.marks.length === 0) {
      result += item.source
      index += 1
      continue
    }
    let best = item.marks[0]!
    let bestLength = 0
    for (const mark of item.marks) {
      let length = 1
      while (index + length < items.length && mark.isInSet(items[index + length]!.marks)) length += 1
      // Prefer the longest run; on ties keep code innermost and otherwise let
      // the later mark wrap outside, matching the established nesting order.
      const better = length > bestLength
        || (length === bestLength
          && (best.type === strataSchema.marks.code || mark.type !== strataSchema.marks.code))
      if (better) {
        best = mark
        bestLength = length
      }
    }
    const run = items.slice(index, index + bestLength).map((entry) => ({
      source: entry.source,
      marks: entry.marks.filter((mark) => !mark.eq(best)),
    }))
    result += wrapWithMark(serializeInlineRun(run, conventions), best, conventions)
    index += bestLength
  }
  return result
}

function inlineContent(
  node: ProseMirrorNode,
  conventions?: MarkdownConventions,
  lineEnding = '\n',
): string {
  const items: InlineRunItem[] = node.content.content.map((child) => child.isText
    ? { source: serializeTextSource(child), marks: semanticMarks(child) }
    : { source: serializeInline(child, conventions, lineEnding), marks: semanticMarks(child) })
  return serializeInlineRun(items, conventions)
}

export function serializeEditorBlock(
  node: ProseMirrorNode,
  lineEnding = '\n',
  conventions?: MarkdownConventions,
): string {
  if (node.type === strataSchema.nodes.raw_block) return String(node.attrs.raw ?? '')
  if (node.type === strataSchema.nodes.paragraph) return inlineContent(node, conventions, lineEnding)
  if (node.type === strataSchema.nodes.heading) {
    const text = inlineContent(node, conventions, lineEnding)
    if (node.attrs.style === 'setext' && Number(node.attrs.level) <= 2) {
      return `${text}${lineEnding}${Number(node.attrs.level) === 1 ? '=' : '-'.repeat(Math.max(3, text.length))}`
    }
    return `${'#'.repeat(Number(node.attrs.level) || 1)} ${text}`
  }
  if (node.type === strataSchema.nodes.horizontal_rule) return String(node.attrs.markup || '---')
  if (node.type === strataSchema.nodes.code_block) {
    if (!node.attrs.fenced) return node.textContent.split('\n').map((line) => `    ${line}`).join(lineEnding)
    const fenceCharacter = node.attrs.fence === '~' ? '~' : '`'
    const needed = Math.max(3, ...Array.from(node.textContent.matchAll(new RegExp(`${fenceCharacter}+`, 'gu')), (match) => match[0].length + 1))
    const fence = fenceCharacter.repeat(needed)
    const info = node.attrs.info ? String(node.attrs.info) : ''
    const meta = node.attrs.meta ? String(node.attrs.meta) : ''
    const opening = `${fence}${info}${meta ? `${info ? ' ' : ''}${meta}` : ''}`
    return `${opening}${lineEnding}${node.textContent}${lineEnding}${fence}`
  }
  if (node.type === strataSchema.nodes.blockquote) {
    return serializeChildren(node, lineEnding, conventions).split(lineEnding).map((line) => `> ${line}`).join(lineEnding)
  }
  if (node.type === strataSchema.nodes.bullet_list || node.type === strataSchema.nodes.ordered_list) {
    const ordered = node.type === strataSchema.nodes.ordered_list
    const start = Number(node.attrs.order) || 1
    const marker = String(node.attrs.marker || (ordered ? '.' : '-'))
    const rows: string[] = []
    node.forEach((item, _offset, index) => {
      const prefix = ordered ? `${start + index}${marker} ` : `${marker} `
      const checked = item.attrs.checked === null ? '' : item.attrs.checked ? '[x] ' : '[ ] '
      const body = serializeChildren(item, lineEnding, conventions)
      const lines = body.split(lineEnding)
      rows.push(`${prefix}${checked}${lines[0] ?? ''}${lines.slice(1).map((line) => `${lineEnding}${' '.repeat(prefix.length)}${line}`).join('')}`)
    })
    return rows.join(node.attrs.tight ? lineEnding : lineEnding + lineEnding)
  }
  if (node.type === strataSchema.nodes.table) {
    const rows: string[][] = []
    node.forEach((row) => {
      const cells: string[] = []
      row.forEach((cell) => cells.push(inlineContent(cell.firstChild ?? cell, conventions, lineEnding).replaceAll('|', '\\|')))
      rows.push(cells)
    })
    const width = Math.max(1, ...rows.map((row) => row.length))
    const header = rows[0] ?? Array.from({ length: width }, () => '')
    const align = Array.isArray(node.attrs.align) ? node.attrs.align as Array<string | null> : []
    const divider = Array.from({ length: width }, (_, index) => {
      if (align[index] === 'center') return ':---:'
      if (align[index] === 'right') return '---:'
      if (align[index] === 'left') return ':---'
      return '---'
    })
    return [header, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join(lineEnding)
  }
  if (node.type === strataSchema.nodes.list_item) return serializeChildren(node, lineEnding, conventions)
  return node.textContent
}

function serializeChildren(node: ProseMirrorNode, lineEnding: string, conventions?: MarkdownConventions): string {
  const blocks: string[] = []
  node.forEach((child) => blocks.push(serializeEditorBlock(child, lineEnding, conventions)))
  return blocks.join(lineEnding + lineEnding)
}

/**
 * Editor-local fallback used for live buffer mirrors and source mode. The core
 * serializer should consume createEditorMarkdownUpdate when saving to disk.
 */
export function serializeEditorDocument(original: ParsedEditorMarkdown, doc: ProseMirrorNode): string {
  if (doc.eq(original.doc)) return original.source
  const update = createEditorMarkdownUpdate(original, doc)
  const originals = new Map(original.blocks.map((block, index) => [block.id, { block, index }]))
  const existingIndexes = update.blocks
    .map((block) => block.id ? originals.get(block.id)?.index : undefined)
    .filter((index): index is number => index !== undefined)
  const stableOrder = existingIndexes.every((value, index) => index === 0 || existingIndexes[index - 1]! < value)

  const coreEdits = stableOrder ? tryCreateCoreMarkdownEdits(original, update) : null
  if (coreEdits) {
    const edits = coreEdits
    return serializeMarkdown(original.core, edits)
  }

  if (!stableOrder) {
    return update.blocks.map((block) => block.unchanged ? block.original!.raw : serializeEditorBlock(block.node, original.lineEnding, original.core.conventions))
      .join(original.lineEnding + original.lineEnding)
  }

  const rendered: string[] = []
  for (const block of update.blocks) {
    rendered.push(block.unchanged ? block.original!.raw : serializeEditorBlock(block.node, original.lineEnding, original.core.conventions))
  }
  const separator = original.lineEnding + original.lineEnding
  let result = rendered.join(separator)
  if (original.hasBom && !result.startsWith('\ufeff')) result = `\ufeff${result}`
  if (original.hasFinalNewline && !result.endsWith(original.lineEnding)) result += original.lineEnding
  return result
}

/** Build exact-span replacements for src/core/markdown/serializer.ts. */
export function createCoreMarkdownEdits(
  original: ParsedEditorMarkdown,
  doc: ProseMirrorNode,
): readonly MarkdownBlockEdit[] {
  const update = createEditorMarkdownUpdate(original, doc)
  const edits = tryCreateCoreMarkdownEdits(original, update)
  if (!edits) throw new RangeError('The editor block order cannot be represented as source-span replacements')
  return edits
}

function tryCreateCoreMarkdownEdits(
  original: ParsedEditorMarkdown,
  update: EditorMarkdownUpdate,
): MarkdownBlockEdit[] | null {
  if (original.blocks.length === 0) return update.blocks.length === 0 ? [] : null
  const originalIndex = new Map(original.blocks.map((block, index) => [block.id, index]))
  const anchors: Array<{ current: number; original: ParsedMarkdownBlock; originalIndex: number }> = []
  update.blocks.forEach((block, current) => {
    if (!block.original) return
    anchors.push({ current, original: block.original, originalIndex: originalIndex.get(block.original.id)! })
  })
  if (anchors.some((anchor, index) => index > 0 && anchors[index - 1]!.originalIndex >= anchor.originalIndex)) return null
  if (anchors.length === 0 && update.blocks.length > 0) return null

  const ownerByCurrentIndex = new Map<number, string>()
  for (let current = 0; current < update.blocks.length; current += 1) {
    const own = anchors.find((anchor) => anchor.current === current)
    if (own) {
      ownerByCurrentIndex.set(current, own.original.id)
      continue
    }
    const previous = anchors.filter((anchor) => anchor.current < current).at(-1)
    const next = anchors.find((anchor) => anchor.current > current)
    const owner = previous ?? next
    if (!owner) return null
    ownerByCurrentIndex.set(current, owner.original.id)
  }

  const grouped = new Map<string, EditorMarkdownBlock[]>()
  update.blocks.forEach((block, current) => {
    const owner = ownerByCurrentIndex.get(current)
    if (!owner) return
    const group = grouped.get(owner) ?? []
    group.push(block)
    grouped.set(owner, group)
  })

  const edits: MarkdownBlockEdit[] = []
  for (const sourceBlock of original.blocks) {
    const group = grouped.get(sourceBlock.id)
    if (!group) {
      edits.push({ block: sourceBlock.id, replacement: null })
      continue
    }
    if (group.length === 1 && group[0]!.unchanged && group[0]!.original?.id === sourceBlock.id) continue
    const replacement = group.map((block) => block.unchanged && block.original
      ? block.original.raw
      : serializeEditorBlock(block.node, original.lineEnding, original.core.conventions))
      .join(original.lineEnding + original.lineEnding)
    edits.push({ block: sourceBlock.id, replacement })
  }
  return edits
}
