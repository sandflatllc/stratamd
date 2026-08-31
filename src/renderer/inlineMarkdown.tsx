import type { ReactNode } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

// Rail snippets render formatted, never raw markdown syntax (PRD §6.9): bold
// bold, italics italic, code in a code face, link text without URL syntax.

export interface InlineSegment {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  strike: boolean
  link: boolean
}

interface InlineNode {
  type: string
  value?: string
  alt?: string | null
  children?: InlineNode[]
}

interface Marks {
  bold: boolean
  italic: boolean
  code: boolean
  strike: boolean
  link: boolean
}

const PLAIN: Marks = { bold: false, italic: false, code: false, strike: false, link: false }

function collect(nodes: readonly InlineNode[], marks: Marks, out: InlineSegment[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ ...marks, text: node.value ?? '' })
        break
      case 'inlineCode':
        out.push({ ...marks, code: true, text: node.value ?? '' })
        break
      case 'strong':
        collect(node.children ?? [], { ...marks, bold: true }, out)
        break
      case 'emphasis':
        collect(node.children ?? [], { ...marks, italic: true }, out)
        break
      case 'delete':
        collect(node.children ?? [], { ...marks, strike: true }, out)
        break
      case 'link':
      case 'linkReference':
        collect(node.children ?? [], { ...marks, link: true }, out)
        break
      case 'image':
        out.push({ ...marks, text: node.alt ?? '' })
        break
      case 'break':
        out.push({ ...marks, text: ' ' })
        break
      default:
        if (node.children) collect(node.children, marks, out)
        else if (typeof node.value === 'string') out.push({ ...marks, text: node.value })
    }
  }
}

/** Parses one snippet through the markdown parser and flattens it to styled runs. */
export function inlineSegments(markdown: string): InlineSegment[] {
  let root: InlineNode
  try {
    root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as InlineNode
  } catch {
    return [{ ...PLAIN, text: markdown }]
  }
  const out: InlineSegment[] = []
  const blocks = root.children ?? []
  blocks.forEach((block, index) => {
    if (index > 0) out.push({ ...PLAIN, text: ' ' })
    if (block.type === 'code') out.push({ ...PLAIN, code: true, text: block.value ?? '' })
    else collect(block.children ?? [block], PLAIN, out)
  })
  return out.filter((segment) => segment.text.length > 0)
}

export function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {inlineSegments(text).map((segment, index) => {
        let node: ReactNode = segment.text
        if (segment.code) node = <code>{node}</code>
        if (segment.bold) node = <strong>{node}</strong>
        if (segment.italic) node = <em>{node}</em>
        if (segment.strike) node = <s>{node}</s>
        if (segment.link) node = <u>{node}</u>
        return <span key={index}>{node}</span>
      })}
    </>
  )
}
