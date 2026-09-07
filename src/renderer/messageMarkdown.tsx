import type { ItemView } from '../shared/contracts'
import { memo, type ReactNode } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

// Conversation messages render as Markdown blocks (PRD §6.9): headings, lists,
// code blocks, quotes, and tables keep their shape and take the document's
// typography tokens through `.conversation-prose`. The parser is the same one
// the editor and rail snippets use, so a message and a document agree on what a
// construct means. Nothing here fetches: images become their alt text and links
// are anchors handled by the shell's shared web link picker.
//
// With `sourceMap`, each text run carries the source offsets its parser
// position recorded, so a reading anchor can name the exact source character
// at the reading edge (§6.15) before the rich editor replaces this rendering.

export interface MessageNode {
  type: string
  value?: string
  alt?: string | null
  url?: string
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  lang?: string | null
  children?: MessageNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** The message's top-level blocks; a parse failure yields one paragraph holding the raw text. */
export function parseMessageMarkdown(text: string): MessageNode[] {
  try {
    const root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MessageNode
    return root.children ?? []
  } catch {
    return [{ type: 'paragraph', children: [{ type: 'text', value: text }], position: { start: { offset: 0 }, end: { offset: text.length } } }]
  }
}

/** A flat summary of block kinds, for tests and for deciding whether a message is prose only. */
export function messageBlockKinds(text: string): string[] {
  return parseMessageMarkdown(text).map((node) => node.type)
}

interface RenderContext {
  /** The message source, present only when text runs carry source offsets. */
  source: string | null
  asks?: readonly ItemView[]
  tagNodes?: Map<string, MessageNode>
  onOpenAsk?: ((id: string) => void) | undefined
}

function span(node: MessageNode): { from: number; to: number } | null {
  const from = node.position?.start.offset
  const to = node.position?.end.offset
  return typeof from === 'number' && typeof to === 'number' && to >= from ? { from, to } : null
}

/** Source attributes for a rendered text run; `verbatim` marks runs whose characters equal their source slice. */
function sourceAttributes(range: { from: number; to: number } | null, verbatim = false): Record<string, string | undefined> {
  if (!range) return {}
  return { 'data-source-from': String(range.from), 'data-source-to': String(range.to), 'data-source-verbatim': verbatim ? 'true' : undefined }
}

/** The fenced or indented code block's content range: the fence line is not shown, so it is excluded. */
function codeContentRange(node: MessageNode, source: string): { from: number; to: number; verbatim: boolean } | null {
  const range = span(node)
  if (!range) return null
  const raw = source.slice(range.from, range.to)
  const fence = /^(\s*)(`{3,}|~{3,})/u.exec(raw)
  if (!fence) return { from: range.from, to: range.to, verbatim: false }
  const firstBreak = raw.indexOf('\n')
  if (firstBreak < 0) return null
  const contentFrom = range.from + firstBreak + 1
  const value = node.value ?? ''
  const verbatim = source.slice(contentFrom, contentFrom + value.length) === value
  return { from: contentFrom, to: verbatim ? contentFrom + value.length : range.to, verbatim }
}

function inlineCodeRange(node: MessageNode, source: string): { from: number; to: number } | null {
  const range = span(node)
  if (!range) return null
  const raw = source.slice(range.from, range.to)
  const fence = /^`+/.exec(raw)?.[0]
  if (!fence) return null
  const from = range.from + fence.length
  return source.slice(from, range.to - fence.length) === node.value ? { from, to: range.to - fence.length } : null
}

function askedText(node: MessageNode, key: string, context: RenderContext): ReactNode {
  const range = span(node), value = node.value ?? ''
  const exact = !!range && context.source?.slice(range.from, range.to) === value
  if (!range || !context.asks?.length) return <span key={key} {...sourceAttributes(range, exact)}>{value}</span>
  const relevant = context.asks.filter(ask => ask.askRange && ask.askRange.from < range.to && ask.askRange.to > range.from)
  const cuts = new Set([0, value.length])
  if (exact) for (const ask of relevant) {
    cuts.add(Math.max(0, ask.askRange!.from - range.from))
    cuts.add(Math.min(value.length, ask.askRange!.to - range.from))
  }
  const points = [...cuts].sort((a, b) => a - b)
  return <span key={key}>{points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]!
    const ask = relevant.find(a => !exact || a.askRange!.from < range.from + end && a.askRange!.to > range.from + start)
    const mappedRange = exact ? { from: range.from + start, to: range.from + end } : range
    // Map only source text. Tag labels must never become reading-anchor text.
    return <span key={start}>
      <span {...sourceAttributes(mappedRange, exact)} className={ask ? 'strata-annotation strata-annotation-question' : undefined} data-annotation-id={ask?.id} onClick={ask ? () => context.onOpenAsk?.(ask.id) : undefined}>{value.slice(start, end)}</span>
      {relevant.filter(a => context.tagNodes?.get(a.id) === node && (exact ? Math.min(a.askRange!.to - range.from, value.length) === end : end === value.length)).map(a => <button key={a.id} type="button" className="conversation-ask-tag" data-atomic="ask-tag" data-ask-id={a.id} data-status={a.status} aria-label={`Answer question: ${a.quote}`} onClick={() => context.onOpenAsk?.(a.id)}>{a.status === 'drafted' ? '✓ Drafted' : a.status === 'done' ? '✓ Answered' : '⊙ Question'}</button>)}
    </span>
  })}</span>
}

function inline(nodes: readonly MessageNode[] | undefined, prefix: string, context: RenderContext): ReactNode[] {
  return (nodes ?? []).map((node, index) => {
    const key = `${prefix}.${index}`
    const kids = () => inline(node.children, key, context)
    const mapped = context.source !== null
    switch (node.type) {
      case 'text': return mapped ? askedText(node, key, context) : node.value ?? ''
      case 'inlineCode': return <code key={key} {...(mapped ? sourceAttributes(inlineCodeRange(node, context.source!), true) : {})}>{node.value ?? ''}</code>
      case 'strong': return <strong key={key}>{kids()}</strong>
      case 'emphasis': return <em key={key}>{kids()}</em>
      case 'delete': return <s key={key}>{kids()}</s>
      case 'link': return <a key={key} href={node.url ?? '#'} title={node.url}>{kids()}</a>
      case 'linkReference': return <u key={key}>{kids()}</u>
      case 'image': case 'imageReference': return <span key={key} className="conversation-prose-image" data-atomic="image">{node.alt ?? ''}</span>
      case 'break': return <br key={key} />
      case 'html': return mapped ? <span key={key} {...sourceAttributes(span(node), true)}>{node.value ?? ''}</span> : node.value ?? ''
      default:
        if (node.children) return <span key={key}>{kids()}</span>
        return node.value ?? ''
    }
  })
}

function block(node: MessageNode, key: string, context: RenderContext): ReactNode {
  const kids = () => (node.children ?? []).map((child, index) => block(child, `${key}.${index}`, context))
  switch (node.type) {
    case 'paragraph': return <p key={key}>{inline(node.children, key, context)}</p>
    case 'heading': {
      const depth = Math.min(6, Math.max(1, node.depth ?? 1))
      const Tag = `h${depth}` as 'h1'
      return <Tag key={key}>{inline(node.children, key, context)}</Tag>
    }
    case 'code': {
      const range = context.source === null || node.lang === 'mermaid' || node.lang === 'tree' ? null : codeContentRange(node, context.source)
      return <pre key={key} data-atomic={node.lang === 'mermaid' || node.lang === 'tree' ? 'diagram' : undefined} data-lang={node.lang ?? undefined}><code {...(range ? sourceAttributes(range, range.verbatim) : {})}>{node.value ?? ''}</code></pre>
    }
    case 'blockquote': return <blockquote key={key}>{kids()}</blockquote>
    case 'list': {
      const items = (node.children ?? []).map((item, index) => {
        const itemKey = `${key}.${index}`
        const content = (item.children ?? []).map((child, childIndex) => {
          // A list item's single paragraph reads inline so bullets stay tight.
          if (child.type === 'paragraph' && (item.children?.length ?? 0) === 1) return inline(child.children, `${itemKey}.${childIndex}`, context)
          return block(child, `${itemKey}.${childIndex}`, context)
        })
        return <li key={itemKey} data-checked={item.checked === null || item.checked === undefined ? undefined : item.checked}>
          {item.checked !== null && item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly disabled aria-label={item.checked ? 'Done' : 'Not done'} />}
          {content}
        </li>
      })
      return node.ordered ? <ol key={key} start={node.start ?? undefined}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'thematicBreak': return <hr key={key} />
    case 'table': {
      const [head, ...body] = node.children ?? []
      const cells = (row: MessageNode | undefined, rowKey: string, Tag: 'th' | 'td') => (row?.children ?? []).map((cell, index) => <Tag key={`${rowKey}.${index}`}>{inline(cell.children, `${rowKey}.${index}`, context)}</Tag>)
      return <table key={key}>
        {head && <thead><tr>{cells(head, `${key}.h`, 'th')}</tr></thead>}
        <tbody>{body.map((row, index) => <tr key={`${key}.${index}`}>{cells(row, `${key}.${index}`, 'td')}</tr>)}</tbody>
      </table>
    }
    case 'html': return <p key={key}>{context.source !== null ? <span {...sourceAttributes(span(node), true)}>{node.value ?? ''}</span> : node.value ?? ''}</p>
    default:
      if (node.children) return <div key={key}>{kids()}</div>
      return node.value ? <p key={key}>{node.value}</p> : null
  }
}

export const MessageMarkdown = memo(function MessageMarkdown({ text, sourceMap = false, asks = [], onOpenAsk }: { text: string; sourceMap?: boolean; asks?: readonly ItemView[]; onOpenAsk?: (id: string) => void }) {
  const nodes = parseMessageMarkdown(text), tagNodes = new Map<string, MessageNode>()
  const visit = (node: MessageNode) => { const range = span(node); if (node.type === 'text' && range) for (const ask of asks) if (ask.askRange && ask.askRange.from < range.to && ask.askRange.to > range.from) tagNodes.set(ask.id,node); node.children?.forEach(visit) }
  nodes.forEach(visit)
  const context: RenderContext = { source: sourceMap ? text : null, asks, tagNodes, onOpenAsk }
  return <div className="conversation-prose" data-source-mapped={sourceMap || undefined}>{nodes.map((node, index) => block(node, String(index), context))}</div>
})
