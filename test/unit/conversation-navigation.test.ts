import { expect, it } from 'vitest'
import { conversationMarkers } from '../../src/renderer/conversationNavigation'
import { messageAnchor, type MessageComment } from '../../src/core/conversation-delivery'
import { mapMarkdownBlocks } from '../../src/core/blocks'
import type { EngineMessageView, EngineThreadView } from '../../src/shared/contracts'

it('keeps each owner comment at its passage, including sent and resolved history', () => {
  const source = 'First paragraph.\n\nSecond paragraph.\n'
  const message: EngineMessageView = { id: 'answer', role: 'assistant', text: source, blocks: mapMarkdownBlocks('message:answer', source).blocks, streaming: false, attachmentCount: 0, turnId: 'turn', createdAt: '' }
  const comment = (id: string, from: number, state: MessageComment['state']): MessageComment => ({ id, kind: 'comment', anchor: messageAnchor(message, from, from + 5), source, selection: source.slice(from, from + 5), text: id, revision: 1, state, replies: [] })
  const thread = { messages: [{ ...message, id: 'request', role: 'user', text: 'Compare these.' }, message], comments: [comment('c_second', 18, 'resolved'), comment('m_agent', 0, 'open'), comment('c_first', 0, 'open'), comment('c_same', 0, 'held')] } as EngineThreadView
  const markers = conversationMarkers(thread)
  expect(markers.map(marker => marker.id)).toEqual(['request', 'c_first', 'c_same', 'c_second'])
  expect(markers[1]).toMatchObject({ message: 'answer', from: 0, to: 5, unavailable: false, held: false })
  expect(markers[2]).toMatchObject({ held: true })
  expect(conversationMarkers({ ...thread, messages: [] })).toHaveLength(3)
  expect(conversationMarkers({ ...thread, messages: [{ ...message, text: 'Changed source.' }] }).every(marker => marker.unavailable)).toBe(true)
})

it('navigates inferred asks to their original source range', () => {
  const thread = { messages: [{ id: 'm', role: 'assistant', text: 'Choose a date.' }], items: [{ id: 'a', messageId: 'm', inferred: true, quote: 'Choose a date.', askRange: { from: 0, to: 14 } }] } as EngineThreadView
  expect(conversationMarkers(thread)).toEqual([{ id: 'a', message: 'm', kind: 'ask', text: 'Choose a date.', comment: 'a', from: 0, to: 14, unavailable: false }])
})
