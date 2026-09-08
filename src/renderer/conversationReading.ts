import { engineStorage } from './engineStorage'
import { findInDocument } from '../editor/find'
import { sourceSelectionForEditor } from '../editor/selection'
import { readingSourceRange } from '../editor/reading-source-map'
import { parseMarkdownForEditor } from '../editor/markdown'
import type { ParsedEditorMarkdown } from '../editor/types'

/**
 * Completed-message parses, most recently used last. A parse is reproducible
 * from its source, so the cache holds a bounded amount of source and rebuilds
 * an evicted parse on demand; a mounted rich editor keeps its own parse and
 * is unaffected by eviction. Measured retention was roughly 70 times the
 * source size, so the source budget bounds the heap the cache can hold.
 */
const parsed = new Map<string, ParsedEditorMarkdown>()
let retainedSource = 0
export const CONVERSATION_PARSE_SOURCE_BUDGET = 768 * 1024
export const CONVERSATION_PARSE_ENTRY_LIMIT = 400
export let completedMessageParses = 0

function trimParses(): void {
  for (const [id, entry] of parsed) {
    if (parsed.size <= CONVERSATION_PARSE_ENTRY_LIMIT && retainedSource <= CONVERSATION_PARSE_SOURCE_BUDGET) break
    if (parsed.size === 1) break
    parsed.delete(id)
    retainedSource -= entry.source.length
  }
}

export function conversationParse(id: string, source: string): ParsedEditorMarkdown {
  const prior = parsed.get(id)
  if (prior?.source === source) {
    parsed.delete(id)
    parsed.set(id, prior)
    return prior
  }
  if (prior) retainedSource -= prior.source.length
  const next = parseMarkdownForEditor(source)
  parsed.delete(id)
  parsed.set(id, next)
  retainedSource += source.length
  completedMessageParses++
  trimParses()
  return next
}

/** Cache occupancy, for tests and diagnostics. */
export function conversationParseCacheSize(): { entries: number; sourceBytes: number } {
  return { entries: parsed.size, sourceBytes: retainedSource }
}

export function readConversationReading(thread: string): Record<string, string> {
  try { return JSON.parse(engineStorage.getItem(`conversation-reading:${thread}`) ?? '{}') } catch { return {} }
}
export function writeConversationReading(thread: string, state: Record<string, string>) { engineStorage.setItem(`conversation-reading:${thread}`, JSON.stringify(state)); window.dispatchEvent(new Event('conversation-reading')) }

/** Search the same displayed text as document Find, then reuse visual/source mapping. */
export function conversationMatches(id: string, source: string, query: string) {
  const parsed = conversationParse(id, source)
  return findInDocument(parsed.doc, query).flatMap(match => {
    const range = readingSourceRange(parsed, parsed.doc, match.from, match.to) ?? sourceSelectionForEditor(parsed, parsed.doc, match.from, match.to)
    return range ? [{ from: range.from, to: range.to }] : []
  })
}
