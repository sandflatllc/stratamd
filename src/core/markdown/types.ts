import type { fromMarkdown } from 'mdast-util-from-markdown'

export type MarkdownAst = ReturnType<typeof fromMarkdown>
export type MarkdownNode = MarkdownAst['children'][number]

export type LineEnding = '\n' | '\r\n' | '\r'

export interface SourcePoint {
  /** UTF-16 code-unit offset, suitable for String.slice. */
  offset: number
  /** UTF-8 byte offset in the original document. */
  byteOffset: number
  line: number
  column: number
}

export interface SourceSpan {
  start: SourcePoint
  end: SourcePoint
}

export type RawConstructKind =
  | 'frontmatter'
  | 'footnote'
  | 'wiki-link'
  | 'html'
  | 'math'
  | 'link-definition'

export interface MarkdownBlock {
  /** Stable within this parse. It is deliberately based on source order. */
  id: string
  index: number
  node: MarkdownNode
  span: SourceSpan
  /** Exact source covered by the mdast node's source span. */
  source: string
  presentation: 'visual' | 'raw'
  rawKind?: RawConstructKind
}

export interface MarkdownConventions {
  lineEnding: LineEnding
  hasFinalNewline: boolean
  bom: boolean
  bullet: '*' | '+' | '-'
  bulletOrdered: '.' | ')'
  emphasis: '*' | '_'
  strong: '*' | '_'
  listItemIndent: 'mixed' | 'one' | 'tab'
  fence: '`' | '~'
  heading: 'atx' | 'setext'
  closeAtx: boolean
  rule: '*' | '-' | '_'
  ruleSpaces: boolean
  quote: '"' | "'"
}

export interface ParsedMarkdown {
  source: string
  ast: MarkdownAst
  blocks: readonly MarkdownBlock[]
  /** Text before the first block, between blocks, and after the final block. */
  gaps: readonly string[]
  conventions: MarkdownConventions
}

export type MarkdownBlockReplacement = MarkdownNode | string | null

export interface MarkdownBlockEdit {
  /** Block index or id from ParsedMarkdown.blocks. */
  block: number | string
  /** String content is retained as supplied. The serializer may add a boundary newline. null deletes the block span. */
  replacement: MarkdownBlockReplacement
}

export interface MarkdownBlockInsertion {
  /** Insert immediately before this block, or at the end of the document. */
  insertBefore: number | string | 'end'
  replacement: Exclude<MarkdownBlockReplacement, null>
}

export type MarkdownEdit = MarkdownBlockEdit | MarkdownBlockInsertion

export interface RewrittenSpan {
  blockId: string
  original: SourceSpan
  outputStart: number
  outputEnd: number
}

export interface SerializedMarkdown {
  value: string
  rewrittenSpans: readonly RewrittenSpan[]
}
