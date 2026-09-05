import type { EngineThreadView } from '../shared/contracts'
import { resolveMessageAnchor, isOwnerComment } from '../core/conversation-delivery'

export interface ConversationMarker {
  id: string
  message: string
  kind: 'message' | 'comment'
  text: string
  quote?: string
  comment?: string
  from: number
  to: number
  unavailable: boolean
  held?: boolean
}

export function conversationMarkers(thread: EngineThreadView): ConversationMarker[] {
  const comments = (thread.comments ?? []).filter(isOwnerComment)
  const markers: ConversationMarker[] = []
  for (const message of thread.messages) {
    if (message.role === 'user') markers.push({ id: message.id, message: message.id, kind: 'message', text: message.text.trim() || 'Attached context', from: 0, to: 0, unavailable: false })
    const anchored = comments.filter(comment => comment.anchor.message === message.id).map(comment => ({ comment, range: resolveMessageAnchor(comment, message) }))
    anchored.sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity))
    for (const { comment, range } of anchored) markers.push({ id: comment.id, message: message.id, kind: 'comment', text: comment.text, quote: comment.selection, comment: comment.id, from: range?.from ?? 0, to: range?.to ?? 0, unavailable: !range, held: comment.state === 'held' })
  }
  for (const comment of comments.filter(comment => !thread.messages.some(message => message.id === comment.anchor.message))) {
    markers.push({ id: comment.id, message: comment.anchor.message, kind: 'comment', text: comment.text, quote: comment.selection, comment: comment.id, from: 0, to: 0, unavailable: true, held: comment.state === 'held' })
  }
  return markers
}
