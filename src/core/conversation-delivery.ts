import type { DraftKind, EngineMessageView } from '../shared/contracts'

export interface MessageAnchor {
  message: string
  start: { block: string; offset: number }
  end: { block: string; offset: number }
}
export interface MessageComment {
  id: string
  kind: DraftKind | 'decision'
  anchor: MessageAnchor
  source: string
  selection: string
  text: string
  revision: number
  state: 'held' | 'pending' | 'open' | 'resolved'
  options?: string[]
  replies: Array<{ author: 'user' | 'agent'; text: string }>
}
/** Owner passage feedback is history, not an item waiting for a reply. */
export function isOwnerComment(comment: Pick<MessageComment, 'id'>): boolean {
  return comment.id.startsWith('c_')
}

export interface ConversationOutcome {
  message: string
  index: number
  status: 'applied' | 'failed'
  itemId?: string
  reason?: string
}
export interface ConversationDelivery {
  deliveryId: string
  threadId: string
  annotations: MessageComment[]
  replies: Array<{ itemId: string; text: string }>
  blocks: Array<{ message: string; block: string; from: number; to: number; text: string }>
  outcomes: ConversationOutcome[]
}
export function messageAnchor(message: EngineMessageView, from: number, to: number): MessageAnchor {
  const source = message.prose ?? message.text
  if (message.streaming || message.role !== 'assistant' || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > source.length) throw new Error(`Invalid passage in message ${message.id}`)
  const start = message.blocks?.find(block => block.from <= from && from < block.to)
  const end = message.blocks?.find(block => block.from <= to - 1 && to - 1 < block.to)
  if (!start || !end) throw new Error(`Passage endpoints have no blocks in message ${message.id}`)
  return { message: message.id, start: { block: start.id, offset: from - start.from }, end: { block: end.id, offset: to - end.from } }
}
export function resolveMessageAnchor(comment: Pick<MessageComment, 'anchor' | 'source'>, message: EngineMessageView | undefined): { from: number; to: number } | null {
  if (!message || message.streaming || message.id !== comment.anchor.message || (message.prose ?? message.text) !== comment.source) return null
  const start = message.blocks?.find(block => block.id === comment.anchor.start.block)
  const end = message.blocks?.find(block => block.id === comment.anchor.end.block)
  if (!start || !end) return null
  const from = start.from + comment.anchor.start.offset
  const to = end.from + comment.anchor.end.offset
  try { messageAnchor(message, from, to) } catch { return null }
  if (from >= start.to || to > end.to || to <= end.from || comment.anchor.start.offset < 0) return null
  return { from, to }
}
export function renderConversationDelivery(input: ConversationDelivery): string {
  const sections: Array<[string, unknown[]]> = [
    ['New annotations', input.annotations.map(({ id, kind, anchor, selection, text }) => ({ id, kind, anchor, selection, text }))],
    ['Replies', input.replies], ['Message blocks', input.blocks], ['Strata block outcomes', input.outcomes],
  ]
  return `# Conversation context\n\nDelivery: ${input.deliveryId}\nThread: ${input.threadId}\n` + sections.filter(([, rows]) => rows.length).map(([title, rows]) => `\n## ${title}\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`).join('')
}
export function conversationDelivery(threadId: string, deliveryId: string, annotations: MessageComment[], replies: Record<string, { text: string }>, messages: EngineMessageView[], outcomes: ConversationOutcome[]): ConversationDelivery {
  const blocks = new Map<string, ConversationDelivery['blocks'][number]>()
  for (const comment of annotations) {
    const message = messages.find(message => message.id === comment.anchor.message)
    const range = resolveMessageAnchor(comment, message)
    if (!range || !message) throw new Error(`Target unavailable for comment ${comment.id}`)
    for (const block of message.blocks ?? []) if (block.to > range.from && block.from < range.to) blocks.set(`${message.id}:${block.id}`, { message: message.id, block: block.id, from: block.from, to: block.to, text: block.text })
  }
  return { deliveryId, threadId, annotations, replies: Object.entries(replies).map(([itemId, reply]) => ({ itemId, text: reply.text })), blocks: [...blocks.values()], outcomes }
}
