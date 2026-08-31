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
