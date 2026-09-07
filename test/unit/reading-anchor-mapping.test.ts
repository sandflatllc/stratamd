import { describe, expect, it } from 'vitest'
import { parseMarkdownForEditor } from '../../src/editor/markdown'
import { editorPositionForSource, sourceOffsetForEditorPosition, sourceOffsetWithin } from '../../src/editor/selection'

// Reading anchors map a rendered text point to the exact source character it
// shows and back, through the same matching the editor uses for selections.
describe('reading anchor source mapping', () => {
  const source = '# Title\n\nA \\*literal\\* star and an &amp; entity, **bold** text.\n\n| Col | Val |\n| --- | --- |\n| a | 1 |\n\n```ts\nconst a = 1\n```\n\nRepeated passage.\n\nRepeated passage.\n'
  const parsed = parseMarkdownForEditor(source)

  it('round-trips positions through escapes, entities, and inline formatting', () => {
    const doc = parsed.doc
    const paragraph = doc.child(1)
    const rendered = paragraph.textBetween(0, paragraph.content.size, '\n', '\n')
    for (const needle of ['literal', 'star and', 'entity', 'bold', 'text']) {
      const textOffset = rendered.indexOf(needle)
      expect(textOffset).toBeGreaterThanOrEqual(0)
      const position = doc.child(0).nodeSize + 1 + textOffset
      const sourceOffset = sourceOffsetForEditorPosition(parsed, doc, position)
      expect(sourceOffset).not.toBeNull()
      expect(source.slice(sourceOffset!, sourceOffset! + needle.length)).toBe(needle)
      expect(editorPositionForSource(parsed, doc, sourceOffset!)).toBe(position)
    }
  })

  it('maps an entity to its source start and keeps the two repeated passages apart', () => {
    const doc = parsed.doc
    const paragraph = doc.child(1)
    const rendered = paragraph.textBetween(0, paragraph.content.size, '\n', '\n')
    const ampersand = rendered.indexOf('&')
    const position = doc.child(0).nodeSize + 1 + ampersand
    expect(source.slice(sourceOffsetForEditorPosition(parsed, doc, position)!)).toMatch(/^&amp;/)
    const firstIndex = source.indexOf('Repeated passage.')
    const secondIndex = source.lastIndexOf('Repeated passage.')
    const first = editorPositionForSource(parsed, doc, firstIndex)
    const second = editorPositionForSource(parsed, doc, secondIndex)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).toBeGreaterThan(first!)
    expect(sourceOffsetForEditorPosition(parsed, doc, second!)).toBe(secondIndex)
  })

  it('maps table cells and code block text to their own characters', () => {
    const doc = parsed.doc
    const cellOffset = source.indexOf('| a |') + 2
    const cellPosition = editorPositionForSource(parsed, doc, cellOffset)
    expect(cellPosition).not.toBeNull()
    expect(sourceOffsetForEditorPosition(parsed, doc, cellPosition!)).toBe(cellOffset)
    const codeOffset = source.indexOf('const a')
    const codePosition = editorPositionForSource(parsed, doc, codeOffset)
    expect(codePosition).not.toBeNull()
    expect(source.slice(sourceOffsetForEditorPosition(parsed, doc, codePosition!)!, codeOffset + 7)).toBe('const a')
  })

  it('uses parser leaves for entities, misleading link URLs, and repeated formatted text', () => {
    const text = '[same](https://same.test) **same** &copy; &#x1F43B; `code` and \\*literal\\*.\n'
    const parsed = parseMarkdownForEditor(text)
    for (const offset of [text.indexOf('same'), text.indexOf('**same') + 2, text.indexOf('&copy;'), text.indexOf('&#x'), text.indexOf('code'), text.indexOf('literal')]) {
      const position = editorPositionForSource(parsed, parsed.doc, offset)
      expect(position).not.toBeNull()
      expect(sourceOffsetForEditorPosition(parsed, parsed.doc, position!)).toBe(offset)
    }
    expect(editorPositionForSource(parsed, parsed.doc, text.indexOf('https'))).toBeNull()
  })

  it('answers null for text runs that cannot be matched instead of guessing', () => {
    expect(sourceOffsetWithin('plain', 'plain', 2)).toBe(2)
    expect(sourceOffsetWithin('a \\* b', 'a * b', 2)).toBe(2)
    expect(sourceOffsetWithin('&copy; sign', '© sign', 1)).toBe(6)
    expect(sourceOffsetWithin('plain', 'different', 1)).toBeNull()
    expect(sourceOffsetWithin('', '', 0)).toBe(0)
  })
})
