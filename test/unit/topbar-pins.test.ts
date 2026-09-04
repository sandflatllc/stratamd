import { describe, expect, it } from 'vitest'
import type { DocumentTabView } from '../../src/shared/contracts'
import { arrangeStrip, isPinned, PINS_KEY, readPins, togglePin, writePins } from '../../src/renderer/topbarPins'

// PRD §6.9: pinned items and the active item are pills; everything else open
// sits in the Docs or Conversations dropdown. Pins are a window preference,
// never a record of what is open.
const tab = (path: string, active = false): DocumentTabView => ({ path, name: path.split('/').pop()!, pendingCount: 0, active, dirty: false })

describe('top bar pins', () => {
  it('shows pinned items in pin order, then the active item when unpinned', () => {
    const tabs = [tab('/a.md'), tab('/b.md', true), tab('/c.md'), tab('/d.md')]
    const pins = { documents: ['/d.md', '/a.md', '/gone.md'], conversations: [] }
    const strip = arrangeStrip(tabs, [], pins, false)
    expect(strip.documents.pills.map((item) => item.path)).toEqual(['/d.md', '/a.md', '/b.md'])
    expect(strip.documents.menu.map((item) => item.path)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md'])
    expect(strip.documents.activeShown).toBe(true)
    // A pinned active document appears once.
    expect(arrangeStrip(tabs, [], { documents: ['/b.md'], conversations: [] }, false).documents.pills.map((item) => item.path)).toEqual(['/b.md'])
  })

  it('treats a centered conversation as the active item and demotes the active document to the dropdown', () => {
    const tabs = [tab('/a.md', true), tab('/b.md')]
    const conversations = [{ id: 't1', name: 'Thread one', attention: 0, active: true }, { id: 't2', name: 'Thread two', attention: 2, active: false }]
    const strip = arrangeStrip(tabs, conversations, { documents: [], conversations: ['t2'] }, true)
    expect(strip.documents.pills).toEqual([])
    expect(strip.documents.activeShown).toBe(false)
    expect(strip.conversations.pills.map((item) => item.id)).toEqual(['t2', 't1'])
  })

  it('toggles pins and round-trips them through storage, ignoring junk', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    let pins = readPins(storage)
    expect(pins).toEqual({ documents: [], conversations: [] })
    pins = togglePin(pins, 'document', '/a.md')
    pins = togglePin(pins, 'conversation', 't1')
    writePins(pins, storage)
    expect(readPins(storage)).toEqual({ documents: ['/a.md'], conversations: ['t1'] })
    expect(isPinned(pins, 'document', '/a.md')).toBe(true)
    expect(togglePin(pins, 'document', '/a.md').documents).toEqual([])
    store.set(PINS_KEY, '{"documents": [1, "/ok.md"], "conversations": "nope"}')
    expect(readPins(storage)).toEqual({ documents: ['/ok.md'], conversations: [] })
    store.set(PINS_KEY, 'not json')
    expect(readPins(storage)).toEqual({ documents: [], conversations: [] })
  })
})
