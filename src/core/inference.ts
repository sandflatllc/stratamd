import { createHash } from 'node:crypto'
import type { EngineMessageView, ItemView } from '../shared/contracts'
import { parseStrataBlock } from './blocks'

export interface InferredQuestion { id: string; text: string; from: number; to: number }

function idFor(messageId: string, from: number, text: string): string {
  return `inferred_${createHash('sha256').update(`${messageId}\0${from}\0${text}`).digest('hex').slice(0, 12)}`
}

/** V1 inference: question-mark sentences and question-mark list entries, nothing else. */
export function inferQuestions(messageId: string, markdown: string): InferredQuestion[] {
  const prose = parseStrataBlock(markdown)?.prose ?? markdown
  const found: InferredQuestion[] = []
  const occupied = new Set<string>()
  const add = (text: string, from: number) => {
    const clean = text.trim().replace(/^[-*+]\s+|^\d+[.)]\s+/u, '')
    if (!clean.endsWith('?') || occupied.has(`${from}:${clean}`)) return
    occupied.add(`${from}:${clean}`)
    found.push({ id: idFor(messageId, from, clean), text: clean, from, to: from + text.length })
  }
  let offset = 0
  for (const line of prose.split(/(?<=\n)/u)) {
    const body = line.replace(/\n$/u, '')
    if (/^\s*(?:[-*+]|\d+[.)])\s+.*\?\s*$/u.test(body)) add(body, offset)
    else {
      const matcher = /[^.!?\n]*\?(?=\s|$)/gu
      for (const match of body.matchAll(matcher)) add(match[0], offset + (match.index ?? 0))
    }
    offset += line.length
  }
  return found
}

export function inferredMessageItems(message: EngineMessageView, threadId: string, explicit: readonly ItemView[] = []): ItemView[] {
  if (message.role !== 'assistant' || message.streaming) return []
  const explicitQuotes = new Set(explicit.filter((item) => item.messageId === message.id).map((item) => item.quote))
  return inferQuestions(message.id, message.text).filter((question) => !explicitQuotes.has(question.text)).map((question) => ({
    id: question.id, kind: 'question', status: 'open', review: 'unreviewed', text: question.text, quote: question.text,
    order: question.from, threadId, turnId: message.turnId, messageId: message.id, annotationId: null, hunkId: null, inferred: true,
  }))
}
