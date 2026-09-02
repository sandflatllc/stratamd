import { EditorState, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import {
  looksLikeMarkdown,
  markdownClipboardTextParser,
  markdownPasteSlice,
  parseMarkdownForEditor,
  serializeEditorDocument,
  stripSourceIdentity,
  strataSchema,
} from '../../src/editor/index.js'

// Plain-text paste (usability round 2 §5.9): markdown becomes structure,
// prose stays prose, and pasted blocks never borrow the document's identities.

describe('markdown paste', () => {
  it('tells markdown from plain prose', () => {
    expect(looksLikeMarkdown('# Title\n\nBody')).toBe(true)
    expect(looksLikeMarkdown('- one\n- two')).toBe(true)
    expect(looksLikeMarkdown('1. first\n2. second')).toBe(true)
    expect(looksLikeMarkdown('Some **bold** words')).toBe(true)
    expect(looksLikeMarkdown('A [link](https://example.com) here')).toBe(true)
    expect(looksLikeMarkdown('```js\ncode\n```')).toBe(true)
    expect(looksLikeMarkdown('> quoted')).toBe(true)
    expect(looksLikeMarkdown('Use `git status` first')).toBe(true)

    expect(looksLikeMarkdown('Just a plain sentence, nothing more.')).toBe(false)
    expect(looksLikeMarkdown('Prices are 2 * 3 * 4 dollars')).toBe(false)
    expect(looksLikeMarkdown('snake_case_name and file_name.txt')).toBe(false)
    expect(looksLikeMarkdown('See https://example.com for more')).toBe(false)
    expect(looksLikeMarkdown('Item 1. was done')).toBe(false)
  })

  it('parses a markdown paste into nodes with no source identities', () => {
    const slice = markdownPasteSlice('# Heading\n\nA **bold** line.\n\n- item')
    const types = [] as string[]
    slice.content.forEach((node) => types.push(node.type.name))
    expect(types).toEqual(['heading', 'paragraph', 'bullet_list'])
    slice.content.descendants((node) => {
      if ('sourceId' in node.attrs) expect(node.attrs.sourceId).toBeNull()
    })
    expect(slice.openStart).toBe(1)
    expect(slice.openEnd).toBe(1)
  })

  it('strips identities recursively while keeping content and marks', () => {
    const parsed = parseMarkdownForEditor('- a *b* c\n')
    const stripped = stripSourceIdentity(parsed.doc)
    expect(stripped.textContent).toBe(parsed.doc.textContent)
    expect(parsed.doc.firstChild?.attrs.sourceId).toBe('block-0')
    expect(stripped.firstChild?.attrs.sourceId).toBeNull()
    let emphasis = 0
    stripped.descendants((node) => { if (node.marks.some((mark) => mark.type === strataSchema.marks.em)) emphasis += 1 })
    expect(emphasis).toBe(1)
  })

  it('leaves plain prose, code blocks, and Shift+paste to the default handling', () => {
    const parsed = parseMarkdownForEditor('Prose\n\n```\ncode\n```\n')
    const $paragraph = parsed.doc.resolve(1)
    const $code = parsed.doc.resolve(parsed.doc.child(0).nodeSize + 1)
    expect(markdownClipboardTextParser('plain words', $paragraph, false)).toBeNull()
    expect(markdownClipboardTextParser('# heading', $code, false)).toBeNull()
    expect(markdownClipboardTextParser('# heading', $paragraph, true)).toBeNull()
    expect(markdownClipboardTextParser('# heading', $paragraph, false)).not.toBeNull()
  })

  it('pasting markdown into a paragraph serializes as markdown, and the original block keeps its bytes', () => {
    const source = 'First   paragraph.\n\nSecond.\n'
    const parsed = parseMarkdownForEditor(source)
    const end = 1 + parsed.doc.child(0).content.size
    let state = EditorState.create({ schema: strataSchema, doc: parsed.doc, selection: TextSelection.create(parsed.doc, end) })
    state = state.apply(state.tr.replaceSelection(markdownPasteSlice('tail **bold**\n\n- item one\n- item two')))
    const markdown = serializeEditorDocument(parsed, state.doc)
    // Markdown drops a paragraph's leading space; the pasted words join the caret's paragraph.
    expect(markdown).toContain('First   paragraph.tail **bold**')
    expect(markdown).toContain('- item one\n- item two')
    expect(markdown.trimEnd().endsWith('Second.')).toBe(true)
  })
})
