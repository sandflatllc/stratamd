import { describe, expect, it } from 'vitest'

import {
  canAcceptSuggestion,
  createTextAnchor,
  createStoredTextAnchor,
  isRangeWithinSingleBlock,
  mapAnchorThroughEdit,
  relocateAnchor,
  relocateStoredTextAnchor,
} from '../../src/core/anchors.js'

describe('text anchors', () => {
  it('captures an exact quote and at most 32 characters of context', () => {
    const text = `${'p'.repeat(40)}target${'s'.repeat(40)}`
    const anchor = createTextAnchor(text, { from: 40, to: 46 })

    expect(anchor.quote).toBe('target')
    expect(anchor.prefix).toBe('p'.repeat(32))
    expect(anchor.suffix).toBe('s'.repeat(32))
  })

  it('maps its live range through editor transactions', () => {
    const anchor = createTextAnchor('before target after', { from: 7, to: 13 })
    const mapped = mapAnchorThroughEdit(anchor, { from: 0, to: 0, insert: 'new ' })

    expect(mapped).toMatchObject({ from: 11, to: 17, quote: 'target', status: 'attached' })
  })

  it('does not absorb text inserted immediately beside the quote', () => {
    const anchor = createTextAnchor('target', { from: 0, to: 6 })
    const insertedBefore = mapAnchorThroughEdit(anchor, { from: 0, to: 0, insert: 'new ' })
    const insertedAfter = mapAnchorThroughEdit(anchor, { from: 6, to: 6, insert: ' end' })

    expect(insertedBefore).toMatchObject({ from: 4, to: 10 })
    expect(insertedAfter).toMatchObject({ from: 0, to: 6 })
  })

  it('uses context only to disambiguate exact duplicate quotes', () => {
    const original = 'first target end\nsecond target finish'
    const anchor = createTextAnchor(original, { from: 24, to: 30 })
    const relocated = relocateAnchor(anchor, `added target\n${original}`)

    expect(relocated.candidates).toBe(3)
    expect(relocated.anchor).toMatchObject({
      from: 37,
      to: 43,
      quote: 'target',
      status: 'attached',
    })
  })

  it('orphans changed or ambiguous quotes and emits each state edge once', () => {
    const anchor = createTextAnchor('prefix target suffix', { from: 7, to: 13 })
    const orphaned = relocateAnchor(anchor, 'prefix changed suffix')
    const stillOrphaned = relocateAnchor(orphaned.anchor, 'nothing here')
    const reattached = relocateAnchor(stillOrphaned.anchor, 'prefix target suffix')

    expect(orphaned.event).toBe('orphaned')
    expect(canAcceptSuggestion(orphaned.anchor)).toBe(false)
    expect(stillOrphaned.event).toBe('none')
    expect(reattached.event).toBe('reattached')
    expect(canAcceptSuggestion(reattached.anchor)).toBe(true)

    const ambiguous = createTextAnchor('target', { from: 0, to: 6 }, { contextLength: 0 })
    expect(relocateAnchor(ambiguous, 'target and target').anchor.status).toBe('orphaned')
  })

  it('checks the single-top-level-block constraint for suggestions', () => {
    const blocks = [
      { from: 0, to: 10 },
      { from: 12, to: 20 },
    ]
    expect(isRangeWithinSingleBlock({ from: 2, to: 8 }, blocks)).toBe(true)
    expect(isRangeWithinSingleBlock({ from: 8, to: 14 }, blocks)).toBe(false)
  })

  it('relocates a zero-width stored range by its surrounding context', () => {
    const stored = createStoredTextAnchor('beforeafter', { from: 6, to: 6 })
    const relocated = relocateStoredTextAnchor(stored, 'new beforeafter')

    expect(stored.quote).toBe('')
    expect(relocated).toEqual({ range: { from: 10, to: 10 }, candidates: 1 })
  })
})
