import { afterEach, expect, it, vi } from 'vitest'
import { consumeDocumentLaunch, readWorkspace, WORKSPACE_KEY, writeWorkspace } from '../../src/renderer/workspaceState'

function setup(value: string | null = null, query = '') {
  const storage = new Map(value === null ? [] : [[WORKSPACE_KEY, value]])
  const location = { href: `app://stratamd/${query}` }
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, next: string) => storage.set(key, next) })
  vi.stubGlobal('window', { location, history: { replaceState: (_state: unknown, _title: string, url: URL) => { location.href = url.href } } })
}
afterEach(() => vi.unstubAllGlobals())

it('defaults to centered conversations with no state or invalid state', () => {
  for (const value of [null, '{', '{}', '{"conversationCentered":false,"conversationTabs":[1]}']) {
    setup(value)
    expect(readWorkspace()).toEqual({ conversationCentered: true, conversationTabs: [], previews: [], previewCentered: null })
  }
})

it('remembers either placement and the open tabs, including an empty center', () => {
  setup()
  for (const conversationCentered of [false, true]) {
    const state = { conversationCentered, conversationTabs: ['t2', 't1'], previews: ['p1'], previewCentered: 'p1' }
    writeWorkspace(state)
    expect(readWorkspace()).toEqual(state)
  }
  writeWorkspace({ conversationCentered: true, conversationTabs: [], previews: [], previewCentered: null })
  expect(readWorkspace()).toEqual({ conversationCentered: true, conversationTabs: [], previews: [], previewCentered: null })
})

it('consumes an explicit file launch without overriding later layout changes on reload', () => {
  setup(null, '?openDocument=1')
  expect(readWorkspace().conversationCentered).toBe(false)
  expect(readWorkspace().conversationCentered).toBe(false)
  consumeDocumentLaunch()
  writeWorkspace({ conversationCentered: true, conversationTabs: ['t1'], previews: [], previewCentered: null })
  expect(readWorkspace()).toEqual({ conversationCentered: true, conversationTabs: ['t1'], previews: [], previewCentered: null })
})
