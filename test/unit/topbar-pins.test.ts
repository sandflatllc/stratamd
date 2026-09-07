import { describe, expect, it } from 'vitest'
import { orderPinned, isPinned, PINS_KEY, readPins, togglePin, writePins } from '../../src/renderer/topbarPins'

describe('top bar pins', () => {
  it('lists pinned open items first, without duplicating active items or reopening closed items', () => {
    const items = [{ id: 'a' }, { id: 'b', active: true }, { id: 'c' }, { id: 'd' }]
    const pins = { documents: ['d', 'b', 'gone'], conversations: ['c'], previews: ['b'] }
    expect(orderPinned(items, pins, 'document').map(item => item.id)).toEqual(['d', 'b', 'a', 'c'])
    expect(orderPinned(items, pins, 'conversation').map(item => item.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(orderPinned(items, pins, 'preview').map(item => item.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('toggles pins and round-trips them through storage, ignoring junk', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    let pins = readPins(storage)
    expect(pins).toEqual({ documents: [], conversations: [], previews: [] })
    pins = togglePin(pins, 'document', '/a.md')
    pins = togglePin(pins, 'conversation', 't1')
    pins = togglePin(pins, 'preview', 'p1')
    writePins(pins, storage)
    expect(readPins(storage)).toEqual({ documents: ['/a.md'], conversations: ['t1'], previews: ['p1'] })
    expect(isPinned(pins, 'document', '/a.md')).toBe(true)
    expect(isPinned(pins, 'preview', 'p1')).toBe(true)
    expect(isPinned(pins, 'conversation', 'p1')).toBe(false)
    expect(togglePin(pins, 'document', '/a.md').documents).toEqual([])
    store.set(PINS_KEY, '{"documents": [1, "/ok.md"], "conversations": "nope"}')
    expect(readPins(storage)).toEqual({ documents: ['/ok.md'], conversations: [], previews: [] })
    store.set(PINS_KEY, 'not json')
    expect(readPins(storage)).toEqual({ documents: [], conversations: [], previews: [] })
  })
})
