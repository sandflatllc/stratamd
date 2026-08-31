import { describe, expect, it } from 'vitest'
import { lineAt, stableValue } from '../../src/main/view-stability'

function referenceLineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

describe('lineAt', () => {
  it('matches the reference implementation at every offset', () => {
    const texts = [
      '',
      'one line',
      '\n',
      'a\nb',
      'a\nb\n',
      '\n\n\n',
      'first line\n\nthird line\nfourth\n',
      'trailing newline then text\n\ntail',
    ]
    for (const text of texts) {
      for (let offset = 0; offset <= text.length; offset += 1) {
        expect(lineAt(text, offset), `text ${JSON.stringify(text)} offset ${offset}`).toBe(referenceLineAt(text, offset))
      }
    }
  })

  it('stays correct across cache eviction', () => {
    const texts = Array.from({ length: 20 }, (_, index) => `document ${index}\nsecond ${index}\nthird ${index}`)
    for (let round = 0; round < 2; round += 1) {
      for (const text of texts) {
        expect(lineAt(text, text.length)).toBe(referenceLineAt(text, text.length))
        expect(lineAt(text, 0)).toBe(1)
      }
    }
  })
})

describe('stableValue', () => {
  it('returns the previous value when deep-equal', () => {
    const previous = { tabs: [{ path: '/a', active: true }], count: 2, nothing: null }
    const next = { tabs: [{ path: '/a', active: true }], count: 2, nothing: null }
    expect(stableValue(previous, next)).toBe(previous)
  })

  it('keeps unchanged children identical when a sibling changes', () => {
    const previous = { document: { content: 'same', hunks: [{ id: 'h1' }] }, settings: { zoom: 1 } }
    const next = { document: { content: 'same', hunks: [{ id: 'h1' }] }, settings: { zoom: 2 } }
    const merged = stableValue(previous, next)
    expect(merged).not.toBe(previous)
    expect(merged.document).toBe(previous.document)
    expect(merged.settings).toEqual({ zoom: 2 })
  })

  it('reuses unchanged array elements when the array grows or shrinks', () => {
    const previous = { items: [{ id: 1 }, { id: 2 }] }
    const grown = stableValue(previous, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    expect(grown.items[0]).toBe(previous.items[0])
    expect(grown.items[1]).toBe(previous.items[1])
    expect(grown.items).toHaveLength(3)
    const shrunk = stableValue(previous, { items: [{ id: 1 }] })
    expect(shrunk.items[0]).toBe(previous.items[0])
    expect(shrunk.items).toHaveLength(1)
  })

  it('never returns stale data for changed keys, additions, or removals', () => {
    expect(stableValue({ a: 1 } as Record<string, number>, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
    expect(stableValue({ a: 1, b: 2 } as Record<string, number>, { a: 1 })).toEqual({ a: 1 })
    expect(stableValue({ a: { b: 1 } }, { a: { b: 2 } })).toEqual({ a: { b: 2 } })
    expect(stableValue<unknown>({ a: 1 }, [1])).toEqual([1])
    expect(stableValue<unknown>(null, { a: 1 })).toEqual({ a: 1 })
    expect(stableValue<unknown>({ a: 1 }, null)).toBeNull()
  })
})
