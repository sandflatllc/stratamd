import { expect, it } from 'vitest'
import { mapMarkdownBlocks } from '../../src/core/blocks'
import { conversationDelivery, messageAnchor, renderConversationDelivery, type MessageComment } from '../../src/core/conversation-delivery'
import { legacyCommentNote, sentCommentsFromDelivery } from '../../src/core/sent-comments'
import type { EngineMessageView } from '../../src/shared/contracts'

it('retains exact multi-block selections, separate responses, and context for repeated passages', () => {
  const source = 'Repeated phrase.\n\nRepeated phrase.\n\nAnother **passage**.'
  const message: EngineMessageView = { id: 'a1', role: 'assistant', text: source, blocks: mapMarkdownBlocks('message:a1', source).blocks, turnId: null, streaming: false, createdAt: '', attachmentCount: 0 }
  const comments: MessageComment[] = [
    { id: 'c_1', anchor: messageAnchor(message, 18, source.length), selection: source.slice(18), text: 'Line one\n\n```json\n{"text":"<script>"}\n```', kind: 'comment', state: 'held', revision: 1, replies: [], source },
    { id: 'c_2', anchor: messageAnchor(message, 0, 8), selection: source.slice(0, 8), text: 'The first one.', kind: 'comment', state: 'held', revision: 1, replies: [], source },
  ]
  const delivery = renderConversationDelivery(conversationDelivery('t1', 'u1', comments, {}, [message], []))
  const sent = sentCommentsFromDelivery(delivery, 't1', 'u1', 'My note')!
  expect(sent.note).toBe('My note')
  expect(sent.comments.map(comment => [comment.selection, comment.text])).toEqual(comments.map(comment => [comment.selection, comment.text]))
  expect(sent.comments[0]!.passage).toBe(source.slice(18))
  expect(sent.comments[1]!.passage).toBe('Repeated phrase.')
  for (const comment of sent.comments) expect(comment.passage.slice(comment.range!.from, comment.range!.to)).toBe(comment.selection)
  expect(sentCommentsFromDelivery(delivery, 'wrong-thread', 'u1', '')).toBeNull()
  expect(sentCommentsFromDelivery(delivery, 't1', 'wrong-message', '')).toBeNull()
  expect(sentCommentsFromDelivery(delivery.replace('"anchor":', '"badAnchor":'), 't1', 'u1', '')).toBeNull()
})

it('recognizes old singular and plural generated summaries without hiding ordinary notes', () => {
  expect(legacyCommentNote('Comments on 1 passages.', 1)).toBe('')
  expect(legacyCommentNote('Comments on 1 passage.', 1)).toBe('')
  expect(legacyCommentNote('Comments on 2 passages.', 2)).toBe('')
  expect(legacyCommentNote('My comments on 2 passages.', 2)).toBe('My comments on 2 passages.')
  expect(legacyCommentNote('Replies to 2 items.', 2)).toBe('Replies to 2 items.')
})
