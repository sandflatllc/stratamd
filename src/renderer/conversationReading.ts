import { findInDocument } from '../editor/find'
import { sourceSelectionForEditor } from '../editor/selection'
import { parseMarkdownForEditor } from '../editor/markdown'
import type { ParsedEditorMarkdown } from '../editor/types'
const parsed = new Map<string, ParsedEditorMarkdown>()
export let completedMessageParses = 0
export function conversationParse(id: string, source: string): ParsedEditorMarkdown {
  const prior = parsed.get(id)
  if (prior?.source === source) return prior
  const next = parseMarkdownForEditor(source)
  parsed.set(id, next)
  completedMessageParses++
  return next
}
export function conversationHeadings(id: string, source: string) {
  const headings: Array<{ text: string; level: number; from: number; to: number }> = []
  conversationParse(id, source).doc.descendants(node => {
    if (node.type.name === 'heading' && typeof node.attrs.sourceFrom === 'number') headings.push({ text: node.textContent, level: Number(node.attrs.level), from: node.attrs.sourceFrom, to: node.attrs.sourceTo })
  })
  return headings
}
export function readConversationReading(thread: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(`conversation-reading:${thread}`) ?? '{}') } catch { return {} }
}
export function writeConversationReading(thread: string, state: Record<string, string>) { localStorage.setItem(`conversation-reading:${thread}`, JSON.stringify(state)); window.dispatchEvent(new Event('conversation-reading')) }

/** Search the same displayed text as document Find, then reuse visual/source mapping. */
export function conversationMatches(id: string, source: string, query: string) {
  const parsed = conversationParse(id, source)
  return findInDocument(parsed.doc, query).flatMap(match => {
    const range = sourceSelectionForEditor(parsed, parsed.doc, match.from, match.to)
    return range ? [{ from: range.from, to: range.to }] : []
  })
}
