import { describe, expect, it } from 'vitest'

import {
  applyHunks,
  computeHunks,
  mapOldRangeToNew,
  mapRange,
  reverseHunks,
} from '../../src/core/diff.js'

describe('computeHunks', () => {
  it('returns zero-context Myers hunks with source and destination offsets', () => {
    const before = 'alpha\nbeta\ngamma\n'
    const after = 'alpha\nBETA\ngamma\ndelta\n'

    expect(computeHunks(before, after)).toEqual([
      {
        oldStartLine: 2,
        newStartLine: 2,
        removedLines: 1,
        addedLines: 1,
        before: { from: 6, to: 11 },
        after: { from: 6, to: 11 },
        removed: 'beta\n',
        added: 'BETA\n',
      },
      {
        oldStartLine: 4,
        newStartLine: 4,
        removedLines: 0,
        addedLines: 1,
        before: { from: 17, to: 17 },
        after: { from: 17, to: 23 },
        removed: '',
        added: 'delta\n',
      },
    ])
  })

  it('preserves CRLF and a missing final newline in hunk text', () => {
    const before = 'one\r\ntwo'
    const after = 'one\r\nTWO'
    const [hunk] = computeHunks(before, after)

    expect(hunk?.removed).toBe('two')
    expect(hunk?.added).toBe('TWO')
    expect(applyHunks(before, [hunk!])).toBe(after)
    expect(reverseHunks(after, [hunk!])).toBe(before)
  })

  it('applies separated hunks without offset drift', () => {
    const before = 'a\nb\nc\nd\n'
    const after = 'A\nb\nc\nD\n'
    const hunks = computeHunks(before, after)

    expect(hunks).toHaveLength(2)
    expect(applyHunks(before, hunks)).toBe(after)
    expect(reverseHunks(after, hunks)).toBe(before)
  })
})

describe('range mapping', () => {
  it('maps ranges through insertions and replacements', () => {
    expect(mapRange({ from: 4, to: 7 }, { from: 2, to: 2, insert: '++' })).toEqual({
      from: 6,
      to: 9,
    })
    expect(mapRange({ from: 4, to: 7 }, { from: 5, to: 6, insert: 'long' })).toEqual({
      from: 4,
      to: 10,
    })
  })

  it('maps old coordinates to the new side of a multi-hunk diff', () => {
    const before = 'a\nb\nc\n'
    const after = 'zero\na\nB\nc\n'
    const hunks = computeHunks(before, after)

    expect(mapOldRangeToNew({ from: 4, to: 6 }, hunks)).toEqual({ from: 9, to: 11 })
  })
})

describe('context hunks for deliveries', () => {
  it('carries one unchanged line each side and the line in the after text', async () => {
    const { contextHunks } = await import('../../src/core/diff')
    const before = 'one\ntwo\nthree\nfour\n'
    const after = 'one\n2\nthree\nfour\nfive\n'
    const hunks = contextHunks(before, after)
    expect(hunks).toEqual([
      {
        oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
        removed: ['two'], added: ['2'],
        contextBefore: ['one'], contextAfter: ['three'], line: 2,
      },
      {
        oldStart: 5, oldLines: 0, newStart: 5, newLines: 1,
        removed: [], added: ['five'],
        contextBefore: ['four'], contextAfter: [], line: 5,
      },
    ])
  })

  it('has no context at the document edges and reports a top insertion at line 1', async () => {
    const { contextHunks } = await import('../../src/core/diff')
    const [top] = contextHunks('body\n', 'title\nbody\n')
    expect(top).toMatchObject({ oldStart: 1, oldLines: 0, newStart: 1, contextBefore: [], contextAfter: ['body'], line: 1 })
    const [deletion] = contextHunks('a\nb\n', 'a\n')
    expect(deletion).toMatchObject({ oldStart: 2, oldLines: 1, newLines: 0, contextBefore: ['a'], contextAfter: [] })
    expect(deletion!.line).toBe(deletion!.newStart)
  })
})
