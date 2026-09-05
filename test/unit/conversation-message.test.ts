import { describe, expect, it } from 'vitest'
import { mapMarkdownBlocks, parseStrataBlock } from '../../src/core/blocks'
import { messageAnchor, resolveMessageAnchor, conversationDelivery, renderConversationDelivery, type MessageComment } from '../../src/core/conversation-delivery'
import type { EngineMessageView } from '../../src/shared/contracts'

function message(text: string): EngineMessageView {
  const prose = parseStrataBlock(text)?.prose ?? text
  return { id: 'm1', role: 'assistant', text, prose, blocks: mapMarkdownBlocks('message:m1', prose).blocks, streaming: false, attachmentCount: 0, turnId: 'turn1', createdAt: '' }
}
describe('message passage identity and delivery', () => {
  it.each(['Repeat.\n\nRepeat.', '- Loose first\n\n- Loose second', '~~~js\none\n\ntwo\n~~~', '```js\none\n\ntwo\n```', '<Callout>\n\nHello **world** 🌲\n\nGoodbye.\n</Callout>'])('maps first and last selected source characters without changing the block algorithm: %s', source => {
    const target = message(source)
    const from = source.indexOf('\n\n') + 2
    const to = source.length
    const comment: MessageComment = { id: 'c1', kind: 'comment', anchor: messageAnchor(target, from, to), source, selection: source.slice(from, to), text: 'First line\n```json\nSecond line', revision: 1, state: 'held', replies: [] }
    expect(resolveMessageAnchor(comment, target)).toEqual({ from, to })
    expect(resolveMessageAnchor(comment, message(source + '!'))).toBeNull()
    expect(resolveMessageAnchor(comment, undefined)).toBeNull()
    const delivery = conversationDelivery('t1', 'd1', [comment], {}, [target], [])
    const rendered = renderConversationDelivery(delivery)
    const rows = JSON.parse(rendered.match(/```json\n([\s\S]*?)\n```/)![1]!)
    expect(rows[0]).toMatchObject({ selection: source.slice(from, to), text: comment.text })
    expect(delivery.blocks.every(block => source.slice(block.from, block.to) === block.text)).toBe(true)
  })
  it('anchors repeated text to its selected occurrence and excludes the final action block', () => {
    const target = message('Repeat.\n\nRepeat.\n\n```strata\n[]\n```')
    const anchor = messageAnchor(target, 9, 16)
    expect(anchor.start.block).toBe(target.blocks![1]!.id)
    expect(() => messageAnchor(target, 20, 21)).toThrow()
    expect(() => messageAnchor(target, 9.5, 16)).toThrow()
  })
})
