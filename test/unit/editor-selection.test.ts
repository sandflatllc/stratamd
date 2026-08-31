import { describe, expect, it } from 'vitest'
import {
  editorRangeForSource,
  parseMarkdownForEditor,
  sourceRangeIsSingleBlock,
  sourceSelectionForEditor,
  wordRangeAt,
} from '../../src/editor/index.js'

function textPosition(
  parsed: ReturnType<typeof parseMarkdownForEditor>,
  text: string,
  occurrence = 0,
): number {
  let seen = 0
  let result = -1
  parsed.doc.descendants((node, pos) => {
    if (!node.isText || result >= 0) return
    let cursor = 0
    while (cursor <= (node.text?.length ?? 0) - text.length) {
      const found = node.text?.indexOf(text, cursor) ?? -1
      if (found < 0) break
      if (seen === occurrence) {
        result = pos + found
        return
      }
      seen += 1
      cursor = found + 1
    }
  })
  if (result < 0) throw new Error(`Missing text: ${text}`)
  return result
}

describe('visual selection markdown spans', () => {
  it('preserves exact blank-line separators across top-level blocks', () => {
    const source = 'First paragraph.\r\n\r\nSecond paragraph.\r\n'
    const parsed = parseMarkdownForEditor(source)
    const from = textPosition(parsed, 'paragraph.')
    const second = textPosition(parsed, 'Second')
    const selection = sourceSelectionForEditor(parsed, parsed.doc, from, second + 'Second'.length)

    expect(selection).toEqual({
      quote: 'paragraph.\r\n\r\nSecond',
      from: source.indexOf('paragraph.'),
      to: source.indexOf('Second') + 'Second'.length,
      singleBlock: false,
    })
    expect(source.slice(selection!.from, selection!.to)).toBe(selection!.quote)

    const rendered = editorRangeForSource(parsed, parsed.doc, selection!.from, selection!.to)
    expect(rendered).toEqual(expect.objectContaining({ singleBlock: false }))
    expect(parsed.doc.textBetween(rendered!.from, rendered!.to, '\n', '\n')).toBe('paragraph.\nSecond')
  })

  it('maps a marked visual selection to the exact text inside its markdown delimiters', () => {
    const source = 'Before **bold target** after.\n'
    const parsed = parseMarkdownForEditor(source)
    const from = textPosition(parsed, 'bold target')
    const selection = sourceSelectionForEditor(parsed, parsed.doc, from, from + 'bold target'.length)

    expect(selection).toEqual({
      quote: 'bold target',
      from: source.indexOf('bold target'),
      to: source.indexOf('bold target') + 'bold target'.length,
      singleBlock: true,
    })
  })

  it('maps a selection inside a table cell to its exact source slice', () => {
    // The header row matters: consuming a source newline for the virtual
    // separator between its cells used to strand every later cell of the row.
    const source = '| Part | Behavior |\n|---|---|\n| Attach | Multiple agents can attach without sharing. |\n'
    const parsed = parseMarkdownForEditor(source)
    const target = 'Multiple agents can attach'
    const from = textPosition(parsed, target)
    const selection = sourceSelectionForEditor(parsed, parsed.doc, from, from + target.length)

    expect(selection).toEqual({
      quote: target,
      from: source.indexOf(target),
      to: source.indexOf(target) + target.length,
      singleBlock: true,
    })

    const rendered = editorRangeForSource(parsed, parsed.doc, selection!.from, selection!.to)
    expect(rendered).not.toBeNull()
    expect(parsed.doc.textBetween(rendered!.from, rendered!.to, '\n', '\n')).toBe(target)
  })

  it('maps a header-row cell selection after the first cell', () => {
    const source = '| Part | Behavior |\n|---|---|\n| Attach | Works. |\n'
    const parsed = parseMarkdownForEditor(source)
    const from = textPosition(parsed, 'Behavior')
    const selection = sourceSelectionForEditor(parsed, parsed.doc, from, from + 'Behavior'.length)

    expect(selection).toEqual({
      quote: 'Behavior',
      from: source.indexOf('Behavior'),
      to: source.indexOf('Behavior') + 'Behavior'.length,
      singleBlock: true,
    })
  })

  it('identifies source selections that suggestions may safely replace', () => {
    const parsed = parseMarkdownForEditor('Alpha\n\nBeta\n')
    expect(sourceRangeIsSingleBlock(parsed, 0, 5)).toBe(true)
    expect(sourceRangeIsSingleBlock(parsed, 0, 11)).toBe(false)
  })
})

describe('word range at a caret', () => {
  it('expands from the middle of a word', () => {
    expect(wordRangeAt('one two three', 5)).toEqual({ from: 4, to: 7 })
  })

  it('expands from the first character of a word', () => {
    expect(wordRangeAt('one two', 4)).toEqual({ from: 4, to: 7 })
  })

  it('takes the word behind a caret sitting just past it', () => {
    expect(wordRangeAt('one two', 3)).toEqual({ from: 0, to: 3 })
    expect(wordRangeAt('one two', 7)).toEqual({ from: 4, to: 7 })
  })

  it('returns null between words and on punctuation', () => {
    expect(wordRangeAt('one, two', 4)).toBeNull()
    expect(wordRangeAt('… — …', 2)).toBeNull()
    expect(wordRangeAt('', 0)).toBeNull()
  })

  it('treats digits, underscores, and accented letters as word characters', () => {
    expect(wordRangeAt('see item_42 now', 8)).toEqual({ from: 4, to: 11 })
    expect(wordRangeAt('la métaphore vive', 6)).toEqual({ from: 3, to: 12 })
  })

  it('stops at the text boundaries', () => {
    expect(wordRangeAt('word', 0)).toEqual({ from: 0, to: 4 })
    expect(wordRangeAt('word', 4)).toEqual({ from: 0, to: 4 })
  })
})
