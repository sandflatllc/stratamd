import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import {
  adjustedRange,
  createAnnotationPlugin,
  getActiveAnnotation,
  setActiveAnnotation,
  createReviewPlugin,
  createSourceSpanPlugin,
  getAnnotationRanges,
  getReviewRanges,
  getTrackedSourceBlocks,
  isReviewControlActivationKey,
  localizeReviewChange,
  locateAnnotationAnchor,
  locateSourceAnnotationQuote,
  locateSourceReviewInsertion,
  parseMarkdownForEditor,
  reviewBadgeLabel,
  setAnnotationRanges,
  setReviewRanges,
  suggestionPresentation,
} from '../../src/editor/index.js'

describe('editor review and annotation positions', () => {
  it('localizes line-oriented direct hunks to only the deleted and inserted text', () => {
    const oldLine = 'We ship the importer first, then the sync layer, keeping the CLI stable.'
    const newLine = 'We ship the importer first, then the export path, keeping the CLI stable.'
    const localized = localizeReviewChange(oldLine, newLine)

    expect(localized.deletedText).toBe('sync layer')
    expect(localized.insertedText).toBe('export path')
    expect(newLine.slice(0, localized.prefixLength)).toBe('We ship the importer first, then the ')
    expect(newLine.slice(newLine.length - localized.suffixLength)).toBe(', keeping the CLI stable.')
    expect(reviewBadgeLabel({ author: 'Claude', kind: 'direct', status: 'pending' })).toBe('Claude')
    expect(reviewBadgeLabel({ author: 'Haru', kind: 'direct', status: 'mixed' })).toBe('Haru · mixed')

    const parsed = parseMarkdownForEditor(`${newLine}\n`)
    const plugin = createReviewPlugin([{
      id: 'localized',
      from: 1,
      to: newLine.length + 1,
      kind: 'direct',
      status: 'pending',
      author: 'Claude',
      deletedText: oldLine,
      replacementText: newLine,
    }])
    const state = EditorState.create({ doc: parsed.doc, plugins: [plugin] })
    const inline = plugin.getState(state)?.decorations.find().find((decoration) => decoration.from < decoration.to)
    expect(inline).toBeDefined()
    expect(state.doc.textBetween(inline!.from, inline!.to)).toBe('export path')
  })

  it('describes the complete inline suggestion treatment', () => {
    expect(suggestionPresentation({
      quote: 'every construct',
      text: 'each construct',
      author: 'Claude',
    })).toEqual({
      deletedText: 'every construct',
      replacementText: 'each construct',
      badgeLabel: 'Claude · suggestion',
      actions: ['Accept', 'Reject'],
    })
  })

  it('activates focused review controls with Enter and Space', () => {
    expect(isReviewControlActivationKey('Enter')).toBe(true)
    expect(isReviewControlActivationKey(' ')).toBe(true)
    expect(isReviewControlActivationKey('Spacebar')).toBe(true)
    expect(isReviewControlActivationKey('Tab')).toBe(false)
  })

  it('uses hunk and annotation offsets to highlight repeated source text', () => {
    const source = 'same target\n\nmiddle\n\nsame target\n'
    expect(locateSourceReviewInsertion(source, 'same target', 5)).toEqual({
      from: source.lastIndexOf('same target'),
      to: source.lastIndexOf('same target') + 'same target'.length,
    })
    expect(locateSourceAnnotationQuote(
      source,
      'same target',
      source.lastIndexOf('same target'),
      source.lastIndexOf('same target') + 'same target'.length,
    )).toEqual({
      from: source.lastIndexOf('same target'),
      to: source.lastIndexOf('same target') + 'same target'.length,
    })
    expect(locateSourceAnnotationQuote(source, 'same target')).toBeNull()
  })

  it('maps localized multi-line review text with CRLF source offsets', () => {
    const source = 'before\r\nfirst new\r\nsecond changed\r\nafter\r\n'
    const deleted = 'first new\nsecond old'
    const inserted = 'first new\nsecond changed'
    const localized = localizeReviewChange(deleted, inserted)
    const located = locateSourceReviewInsertion(
      source,
      inserted,
      2,
      localized.prefixLength,
      localized.insertedText,
    )
    expect(source.slice(located!.from, located!.to)).toBe('change')
  })

  it('maps pending hunk positions and marks an intersected hunk mixed', () => {
    const parsed = parseMarkdownForEditor('Alpha beta gamma\n')
    let state = EditorState.create({ doc: parsed.doc, plugins: [createReviewPlugin()] })
    state = state.apply(setReviewRanges(state.tr, [{
      id: 'h1',
      from: 7,
      to: 11,
      kind: 'direct',
      status: 'pending',
      author: 'Agent',
    }]))
    state = state.apply(state.tr.insertText('new ', 7))
    expect(getReviewRanges(state)).toEqual([expect.objectContaining({ id: 'h1', status: 'mixed', from: 7, to: 15 })])
  })

  it('maps overlapping annotation ranges through editor transactions', () => {
    const parsed = parseMarkdownForEditor('Alpha beta gamma\n')
    let state = EditorState.create({ doc: parsed.doc, plugins: [createAnnotationPlugin()] })
    state = state.apply(setAnnotationRanges(state.tr, [
      { id: 'a1', kind: 'comment', status: 'open', quote: 'beta', from: 7, to: 11, author: 'user' },
      { id: 'a2', kind: 'question', status: 'open', quote: 'beta gamma', from: 7, to: 17, author: 'Agent' },
    ]))
    state = state.apply(state.tr.insertText('start ', 1))
    expect(getAnnotationRanges(state).map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 13, to: 17 },
      { from: 13, to: 23 },
    ])
  })

  it('relocates only a unique exact quote or a context-disambiguated quote', () => {
    const parsed = parseMarkdownForEditor('First same phrase.\n\nSecond same phrase.\n')
    expect(locateAnnotationAnchor(parsed.doc, { quote: 'same phrase' })).toBeNull()
    expect(locateAnnotationAnchor(parsed.doc, { quote: 'same phrase', prefix: 'Second ' })).toEqual(expect.objectContaining({
      from: expect.any(Number),
      to: expect.any(Number),
    }))
    expect(locateAnnotationAnchor(parsed.doc, { quote: 'missing' })).toBeNull()
  })

  it('rejects a cross-top-level suggestion anchor but permits a comment', () => {
    const parsed = parseMarkdownForEditor('Alpha\n\nBeta\n')
    const anchor = { quote: 'Alpha\nBeta' }
    expect(locateAnnotationAnchor(parsed.doc, anchor, 'suggestion')).toBeNull()
    expect(locateAnnotationAnchor(parsed.doc, anchor, 'comment')).not.toBeNull()
  })

  it('tracks source spans and dirtiness independently from serialization', () => {
    const parsed = parseMarkdownForEditor('# Heading\n\nParagraph\n')
    let state = EditorState.create({ doc: parsed.doc, plugins: [createSourceSpanPlugin()] })
    expect(getTrackedSourceBlocks(state)).toHaveLength(2)
    state = state.apply(state.tr.insertText(' changed', 3))
    expect(getTrackedSourceBlocks(state)[0]).toEqual(expect.objectContaining({ id: 'block-0', dirty: true }))
    expect(getTrackedSourceBlocks(state)[1]).toEqual(expect.objectContaining({ id: 'block-1', dirty: false }))
  })
})

describe('annotation grab handles', () => {
  it('adds one handle widget at each end of the active open annotation only', () => {
    const parsed = parseMarkdownForEditor('Move the handles around this sentence.\n')
    const plugin = createAnnotationPlugin([
      { id: 'a', kind: 'comment', status: 'open', from: 10, to: 17, author: 'user', quote: 'handles' },
      { id: 'b', kind: 'question', status: 'open', from: 25, to: 29, author: 'user', quote: 'this' },
    ])
    const initial = EditorState.create({ doc: parsed.doc, plugins: [plugin] })
    const widgets = (state: EditorState) => plugin.getState(state)!.decorations.find().filter((decoration) => decoration.from === decoration.to)
    expect(widgets(initial)).toHaveLength(0)
    expect(getActiveAnnotation(initial)).toBeNull()

    const active = initial.apply(setActiveAnnotation(initial.tr, 'a'))
    expect(getActiveAnnotation(active)).toBe('a')
    expect(widgets(active).map((decoration) => decoration.from)).toEqual([10, 17])

    const cleared = active.apply(setActiveAnnotation(active.tr, null))
    expect(widgets(cleared)).toHaveLength(0)
  })

  it('keeps handles on the annotation when text is typed before it', () => {
    const parsed = parseMarkdownForEditor('Move the handles around this sentence.\n')
    const plugin = createAnnotationPlugin([{ id: 'a', kind: 'comment', status: 'open', from: 10, to: 17, author: 'user', quote: 'handles' }])
    let state = EditorState.create({ doc: parsed.doc, plugins: [plugin] })
    state = state.apply(setActiveAnnotation(state.tr, 'a'))
    state = state.apply(state.tr.insertText('XX', 1))
    const widgets = plugin.getState(state)!.decorations.find().filter((decoration) => decoration.from === decoration.to)
    expect(widgets.map((decoration) => decoration.from)).toEqual([12, 19])
    expect(state.doc.textBetween(12, 19)).toBe('handles')
  })

  it('never lets a dragged end cross the other one or empty the range', () => {
    const range = { from: 10, to: 17 }
    expect(adjustedRange(range, 'start', 4)).toEqual({ from: 4, to: 17 })
    expect(adjustedRange(range, 'start', 17)).toEqual({ from: 16, to: 17 })
    expect(adjustedRange(range, 'start', 30)).toEqual({ from: 16, to: 17 })
    expect(adjustedRange(range, 'end', 25)).toEqual({ from: 10, to: 25 })
    expect(adjustedRange(range, 'end', 10)).toEqual({ from: 10, to: 11 })
    expect(adjustedRange(range, 'end', 2)).toEqual({ from: 10, to: 11 })
  })
})
