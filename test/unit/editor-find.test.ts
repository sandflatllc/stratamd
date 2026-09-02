import { EditorState } from 'prosemirror-state'
import type { DecorationSet } from 'prosemirror-view'
import { describe, expect, it } from 'vitest'
import {
  createFindPlugin,
  findCountLabel,
  findInDocument,
  findInText,
  findResultOf,
  firstMatchFrom,
  getFindState,
  parseMarkdownForEditor,
  setFind,
  stepMatch,
} from '../../src/editor/index.js'

// Find (PRD §6.1): the same engine serves the visual document and the raw source.

describe('find engine', () => {
  it('finds every occurrence ignoring case and never overlaps matches', () => {
    expect(findInText('Aaa aaa AAA', 'aa')).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
      { from: 8, to: 10 },
    ])
    expect(findInText('x', '')).toEqual([])
    expect(findInText('paragraph', 'graph', 100)).toEqual([{ from: 104, to: 109 }])
  })

  it('finds inside each text block of the document at positions that select the text', () => {
    const parsed = parseMarkdownForEditor('# Title here\n\nOne *title* two, and a title.\n\n- title in a list\n')
    const matches = findInDocument(parsed.doc, 'TITLE')
    expect(matches).toHaveLength(4)
    for (const match of matches) {
      expect(parsed.doc.textBetween(match.from, match.to).toLowerCase()).toBe('title')
    }
    expect(matches.map((match) => match.from)).toEqual([...matches.map((match) => match.from)].sort((left, right) => left - right))
  })

  it('starts at the match after the caret, wraps, and steps in both directions', () => {
    const matches = findInText('a b a b a', 'a')
    expect(firstMatchFrom(matches, 0)).toBe(0)
    expect(firstMatchFrom(matches, 1)).toBe(1)
    expect(firstMatchFrom(matches, 9)).toBe(0)
    expect(firstMatchFrom([], 0)).toBe(-1)
    expect(stepMatch(3, 2, 1)).toBe(0)
    expect(stepMatch(3, 0, -1)).toBe(2)
    expect(stepMatch(3, -1, 1)).toBe(0)
    expect(stepMatch(3, -1, -1)).toBe(2)
    expect(stepMatch(0, -1, 1)).toBe(-1)
  })

  it('labels the count in plain words', () => {
    expect(findCountLabel('', { count: 0, current: 0 })).toBe('')
    expect(findCountLabel('x', { count: 0, current: 0 })).toBe('No matches')
    expect(findCountLabel('x', findResultOf([{ from: 0, to: 1 }, { from: 2, to: 3 }], 1))).toBe('2 of 2')
    expect(findResultOf([], -1)).toEqual({ count: 0, current: 0 })
  })

  it('decorates matches in the visual document and follows edits under an open search', () => {
    const parsed = parseMarkdownForEditor('Find me. Find me again.\n')
    let state = EditorState.create({ doc: parsed.doc, plugins: [createFindPlugin()] })
    state = state.apply(setFind(state.tr, 'find', 1))
    const found = getFindState(state)
    expect(found.matches).toHaveLength(2)
    expect(found.current).toBe(1)
    const decorations = state.plugins[0]!.props.decorations!.call(state.plugins[0]!, state) as DecorationSet
    const classes = decorations.find().map((decoration) => (decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class)
    expect(classes).toEqual(['strata-find-match', 'strata-find-match strata-find-current'])

    // Typing a third occurrence re-runs the search; the current match stays where it was.
    state = state.apply(state.tr.insertText(' Find me too.', state.doc.content.size - 1))
    const after = getFindState(state)
    expect(after.matches).toHaveLength(3)
    expect(after.current).toBe(1)

    state = state.apply(setFind(state.tr, '', -1))
    expect(getFindState(state).matches).toHaveLength(0)
  })
})
