import { describe, expect, it } from 'vitest'
import { messageBlockKinds, parseMessageMarkdown } from '../../src/renderer/messageMarkdown'

// Conversation messages keep their block structure (PRD §6.9): a heading is a
// heading and a code fence is a code block, in the conversation as in the document.
describe('message markdown', () => {
  it('keeps headings, lists, code, quotes, tables, and rules as blocks', () => {
    const text = [
      '## Plan',
      '',
      'Two steps, then a check.',
      '',
      '1. Read `src/main/application.ts`',
      '2. Patch **quickSend**',
      '',
      '- [x] done item',
      '- [ ] open item',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '> A quote.',
      '',
      '| Col | Val |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '---',
    ].join('\n')
    expect(messageBlockKinds(text)).toEqual(['heading', 'paragraph', 'list', 'list', 'code', 'blockquote', 'table', 'thematicBreak'])
    const blocks = parseMessageMarkdown(text)
    expect(blocks[0]).toMatchObject({ type: 'heading', depth: 2 })
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true, start: 1 })
    expect(blocks[3]?.children?.map((item) => item.checked)).toEqual([true, false])
    expect(blocks[4]).toMatchObject({ type: 'code', lang: 'ts', value: 'const a = 1' })
  })

  it('reads plain prose as one paragraph and never throws on odd input', () => {
    expect(messageBlockKinds('Just a sentence.')).toEqual(['paragraph'])
    expect(messageBlockKinds('')).toEqual([])
    expect(messageBlockKinds('<div>unclosed <b>html')).toEqual(['html'])
    expect(messageBlockKinds('* [link](http://example.com) and ![img](x.png)')).toEqual(['list'])
  })
})
