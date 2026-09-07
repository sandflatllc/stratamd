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
}

/** The message's top-level blocks; a parse failure yields one paragraph holding the raw text. */
export function parseMessageMarkdown(text: string): MessageNode[] {
  try {
    const root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MessageNode
    return root.children ?? []
  } catch {
    return [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
  }
}

/** A flat summary of block kinds, for tests and for deciding whether a message is prose only. */
export function messageBlockKinds(text: string): string[] {
  return parseMessageMarkdown(text).map((node) => node.type)
}

function inline(nodes: readonly MessageNode[] | undefined, prefix: string): ReactNode[] {
  return (nodes ?? []).map((node, index) => {
    const key = `${prefix}.${index}`
    const kids = () => inline(node.children, key)
    switch (node.type) {
      case 'text': return node.value ?? ''
      case 'inlineCode': return <code key={key}>{node.value ?? ''}</code>
      case 'strong': return <strong key={key}>{kids()}</strong>
      case 'emphasis': return <em key={key}>{kids()}</em>
      case 'delete': return <s key={key}>{kids()}</s>
      case 'link': return <a key={key} href={node.url ?? '#'} title={node.url}>{kids()}</a>
      case 'linkReference': return <u key={key}>{kids()}</u>
      case 'image': case 'imageReference': return <span key={key} className="conversation-prose-image">{node.alt ?? ''}</span>
      case 'break': return <br key={key} />
      case 'html': return node.value ?? ''
      default:
        if (node.children) return <span key={key}>{kids()}</span>
        return node.value ?? ''
    }
  })
}

function block(node: MessageNode, key: string): ReactNode {
  const kids = () => (node.children ?? []).map((child, index) => block(child, `${key}.${index}`))
  switch (node.type) {
    case 'paragraph': return <p key={key}>{inline(node.children, key)}</p>
    case 'heading': {
      const depth = Math.min(6, Math.max(1, node.depth ?? 1))
      const Tag = `h${depth}` as 'h1'
      return <Tag key={key}>{inline(node.children, key)}</Tag>
    }
    case 'code': return <pre key={key} data-lang={node.lang ?? undefined}><code>{node.value ?? ''}</code></pre>
    case 'blockquote': return <blockquote key={key}>{kids()}</blockquote>
    case 'list': {
      const items = (node.children ?? []).map((item, index) => {
        const itemKey = `${key}.${index}`
        const content = (item.children ?? []).map((child, childIndex) => {
          // A list item's single paragraph reads inline so bullets stay tight.
          if (child.type === 'paragraph' && (item.children?.length ?? 0) === 1) return inline(child.children, `${itemKey}.${childIndex}`)
          return block(child, `${itemKey}.${childIndex}`)
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
      const cells = (row: MessageNode | undefined, rowKey: string, Tag: 'th' | 'td') => (row?.children ?? []).map((cell, index) => <Tag key={`${rowKey}.${index}`}>{inline(cell.children, `${rowKey}.${index}`)}</Tag>)
      return <table key={key}>
        {head && <thead><tr>{cells(head, `${key}.h`, 'th')}</tr></thead>}
        <tbody>{body.map((row, index) => <tr key={`${key}.${index}`}>{cells(row, `${key}.${index}`, 'td')}</tr>)}</tbody>
      </table>
    }
    case 'html': return <p key={key}>{node.value ?? ''}</p>
    default:
      if (node.children) return <div key={key}>{kids()}</div>
      return node.value ? <p key={key}>{node.value}</p> : null
  }
}

export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return <div className="conversation-prose">{parseMessageMarkdown(text).map((node, index) => block(node, String(index)))}</div>
})
