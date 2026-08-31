import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppView, StrataApi } from '../../src/shared/contracts'
import { IPC } from '../../src/preload/channels'
import { isAllowedExternalUrl, registerStrataIpc, spellingContext } from '../../src/main/ipc'

const view: AppView = {
  tabs: [],
  activeDocument: null,
  explorer: [],
  settings: {
    animatedBackground: false,
    attachmentIdleHours: 24,
    panelSizes: {
      explorerWidth: 260,
      rightRailWidth: 320,
      changesHeight: 240,
      annotationsHeight: 240,
      documentMeasure: 780,
      themePanel: { x: -1, y: -1, width: 360, height: 560 },
      threadPanel: { width: 660, height: -1 },
      annotationComposer: { width: 330, height: -1 },
      sendComposer: { width: 680, height: -1 }
    },
    zoom: { explorer: 1, editor: 1, rightRail: 1, composer: 1 },
    theme: {
      active: { id: 'strata', name: 'Strata', builtIn: true, missing: false, path: null, sparse: { name: 'Strata' }, values: {}, problems: [] },
      available: [],
      externalRevision: 0
    }
  }
}

function fakeApi(): StrataApi {
  return {
    getState: vi.fn(async () => view),
    subscribe: vi.fn(() => () => undefined),
    openDocument: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => 'closed' as const),
    updateBuffer: vi.fn(async () => undefined),
    undo: vi.fn(async () => 'empty' as const),
    redo: vi.fn(async () => 'empty' as const),
    save: vi.fn(async () => undefined),
    setSourceMode: vi.fn(async () => undefined),
    keepHunk: vi.fn(async () => undefined),
    revertHunk: vi.fn(async () => undefined),
    markReviewed: vi.fn(async () => undefined),
    saveRound: vi.fn(async () => ({ hunks: [] })),
    addAnnotation: vi.fn(async () => undefined),
    requoteAnnotation: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    resolveAnnotation: vi.fn(async () => undefined),
    acceptSuggestion: vi.fn(async () => undefined),
    rejectSuggestion: vi.fn(async () => undefined),
    acceptAllSuggestions: vi.fn(async () => ({ accepted: [], skipped: [] })),
    rejectAllSuggestions: vi.fn(async () => []),
    clearResolvedAnnotations: vi.fn(async () => undefined),
    resolveRecovery: vi.fn(async () => undefined),
    resolveConflict: vi.fn(async () => undefined),
    previewSend: vi.fn(async () => []),
    send: vi.fn(async () => []),
    copyForAgent: vi.fn(async () => undefined),
    copyText: vi.fn(async () => undefined),
    selectTheme: vi.fn(async () => undefined),
    createTheme: vi.fn(async () => 'copy'),
    setThemeValue: vi.fn(async () => undefined),
    renameTheme: vi.fn(async () => undefined),
    revertTheme: vi.fn(async () => undefined),
    deleteTheme: vi.fn(async () => undefined),
    listFonts: vi.fn(async () => []),
    openThemeSample: vi.fn(async () => undefined),
    nudge: vi.fn(async () => undefined),
    setLead: vi.fn(async () => undefined),
    disconnectAgent: vi.fn(async () => undefined),
    addFolder: vi.fn(async () => undefined),
    scanFolder: vi.fn(async () => undefined),
    refreshExplorer: vi.fn(async () => undefined),
    forgetDocument: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    resolveLocalImage: vi.fn(async () => null)
  }
}

describe('renderer IPC boundary', () => {
  it('checks both the WebContents identity and app protocol URL', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
      on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeListener: vi.fn()
    }
    const renderer = { id: 1, isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/' }
    registerStrataIpc({ ipcMain: ipcMain as never, api: fakeApi(), renderer: renderer as never })
    const getState = handlers.get(IPC.state)

    await expect(getState?.({ sender: renderer, senderFrame: { url: 'app://stratamd/' } })).resolves.toEqual({ seq: 1, view })
    await expect(getState?.({ sender: { ...renderer, id: 2 }, senderFrame: { url: 'app://stratamd/' } })).rejects.toThrow('unknown renderer')
    await expect(getState?.({ sender: renderer, senderFrame: { url: 'https://evil.invalid/' } })).rejects.toThrow('untrusted URL')
  })

  it('rejects malformed arguments before calling the application service', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
      on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeListener: vi.fn()
    }
    const renderer = { isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/' }
    const api = fakeApi()
    registerStrataIpc({ ipcMain: ipcMain as never, api, renderer: renderer as never })
    const save = handlers.get(IPC.save)
    const event = { sender: renderer, senderFrame: { url: 'app://stratamd/' } }

    await expect(save?.(event, '')).rejects.toThrow()
    expect(api.save).not.toHaveBeenCalled()

    const updateBuffer = handlers.get(IPC.updateBuffer)
    await expect(updateBuffer?.(event, '/tmp/plan.md', 'text', 'later')).rejects.toThrow()
    expect(api.updateBuffer).not.toHaveBeenCalled()
    await updateBuffer?.(event, '/tmp/plan.md', 'text', 'history')
    expect(api.updateBuffer).toHaveBeenCalledWith('/tmp/plan.md', 'text', 'history')

    const redo = handlers.get(IPC.redo)
    await expect(redo?.(event, '')).rejects.toThrow()
    await expect(redo?.(event, '/tmp/plan.md')).resolves.toBe('empty')
    expect(api.redo).toHaveBeenCalledWith('/tmp/plan.md')
  })

  it('publishes state only to the registered renderer and unregisters every handler', () => {
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const renderer = { isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/' }
    const registration = registerStrataIpc({ ipcMain: ipcMain as never, api: fakeApi(), renderer: renderer as never })
    registration.publish(view)
    expect(renderer.send).toHaveBeenCalledWith(IPC.stateChanged, { seq: 1, full: view })
    registration.publish(view)
    expect(renderer.send).toHaveBeenLastCalledWith(IPC.stateChanged, { seq: 2, base: 1, sections: {} })
    registration.dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(ipcMain.handle.mock.calls.length)
    expect(ipcMain.removeListener).toHaveBeenCalledTimes(ipcMain.on.mock.calls.length)
  })

  it('logs a trusted failure report and drops malformed or untrusted ones without throwing', () => {
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'stratamd-ipc-log-'))
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn(),
      removeHandler: vi.fn(),
      on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeListener: vi.fn()
    }
    const renderer = { isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/' }
    registerStrataIpc({ ipcMain: ipcMain as never, api: fakeApi(), renderer: renderer as never })
    const report = handlers.get(IPC.reportError)!
    const event = { sender: renderer, senderFrame: { url: 'app://stratamd/' } }

    expect(() => report(event, { scope: 'boundary:editor', message: 'boom', stack: 'Error: boom\n    at Pane (app://stratamd/x.js:1:1)' })).not.toThrow()
    expect(() => report(event, { scope: '', message: '' })).not.toThrow()
    expect(() => report(event, 'garbage')).not.toThrow()
    expect(() => report(event, { scope: 's', message: 'm', extra: true })).not.toThrow()
    expect(() => report({ sender: renderer, senderFrame: { url: 'https://evil.invalid/' } }, { scope: 's', message: 'm' })).not.toThrow()

    const lines = readFileSync(join(process.env.XDG_DATA_HOME, 'stratamd/logs/stratamd.log'), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      scope: 'boundary:editor',
      message: 'boom',
      frame: 'at Pane (app://stratamd/x.js:1:1)'
    })
  })
})

describe('external URL policy', () => {
  it('allows only the PRD external schemes', () => {
    expect(isAllowedExternalUrl('https://example.test')).toBe(true)
    expect(isAllowedExternalUrl('http://example.test')).toBe(true)
    expect(isAllowedExternalUrl('mailto:owner@example.test')).toBe(true)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('spelling', () => {
  const misspelled = {
    isEditable: true,
    misspelledWord: 'occured',
    dictionarySuggestions: ['occurred', 'occulted']
  }

  it('forwards only editable misspellings, in suggestion order', () => {
    expect(spellingContext(misspelled)).toEqual({ word: 'occured', suggestions: ['occurred', 'occulted'] })
    expect(spellingContext({ ...misspelled, misspelledWord: '', dictionarySuggestions: [] })).toBeNull()
    expect(spellingContext({ ...misspelled, isEditable: false })).toBeNull()
  })

  it('keeps a suggestionless misspelling so the dictionary action still shows', () => {
    expect(spellingContext({ ...misspelled, misspelledWord: 'blorptastic', dictionarySuggestions: [] }))
      .toEqual({ word: 'blorptastic', suggestions: [] })
  })

  it('teaches the renderer session one validated word per request', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const addWordToSpellCheckerDictionary = vi.fn()
    const renderer = { isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/', session: { addWordToSpellCheckerDictionary } }
    registerStrataIpc({ ipcMain: ipcMain as never, api: fakeApi(), renderer: renderer as never })
    const addWord = handlers.get(IPC.addDictionaryWord)!
    const event = { sender: renderer, senderFrame: { url: 'app://stratamd/' } }

    await addWord(event, 'blorptastic')
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledExactlyOnceWith('blorptastic')

    await expect(addWord(event, '')).rejects.toThrow()
    await expect(addWord(event, 42)).rejects.toThrow()
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledTimes(1)
  })
})
