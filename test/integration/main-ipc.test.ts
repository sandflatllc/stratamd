import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppView, StrataApi } from '../../src/shared/contracts'
import { IPC } from '../../src/preload/channels'
import { isAllowedExternalUrl, registerStrataIpc, spellingContext } from '../../src/main/ipc'

const view: AppView = {
  preview: { tabs: [], registered: false, serving: [], reveal: null },
  tabs: [],
  activeDocument: null,
  explorer: [],
  engine: { state: 'unpaired', server: null, problem: null, credential: null, projects: [], activeThreadId: null, accounts: [], terminalDefaults: {}, terminalShimDirectory: null },
  settings: {
    animatedBackground: false,
    panelSizes: {
      explorerWidth: 260,
      rightRailWidth: 320,
      upperReviewHeight: 494,
      documentMeasure: 780,
      themePanel: { x: -1, y: -1, width: 360, height: 560 },
      annotationComposer: { width: 330, height: -1 },
      sendComposer: { width: 680, height: -1 }
    },
    zoom: { explorer: 1, editor: 1, rightRail: 1, composer: 1, themePanel: 1 },
    theme: {
      active: { id: 'strata-vivid', name: 'Strata Vivid', builtIn: true, missing: false, path: null, sparse: { name: 'Strata Vivid' }, values: {}, problems: [] },
      available: [],
      externalRevision: 0
    }
  }
}

function fakeApi(): StrataApi {
  return {
    editEngineSettings: vi.fn(async () => ({ providerInstances: {} })),
    editEngineProvider: vi.fn(async () => undefined),
    readEngineSupport: vi.fn(async () => ({ sourceControl: [], problems: [] })),
    readEngineProjectDefaults: vi.fn(async () => ({ identity: null, projectId: 'p1', checkedIn: null, computerModel: null, computerEnvironment: 'local' as const })),
    editEngineProjectDefaults: vi.fn(async () => ({ identity: null, projectId: 'p1', checkedIn: null, computerModel: null, computerEnvironment: 'local' as const })),
    readEngineSettings: vi.fn(async () => ({ providerInstances: {} })),
    browseEngineFolder: vi.fn(async () => ({ parentPath: '/projects', entries: [] })),
    lookupEngineRepository: vi.fn(async () => ({ provider: 'github', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo', sshUrl: 'git@github.com:owner/repo.git' })),
    cloneEngineRepository: vi.fn(async () => ({ cwd: '/projects/repo' })),
    setModelPreference: vi.fn(async () => undefined),
    listEngineRefs: vi.fn(async () => ({ refs: [], isRepo: false, hasPrimaryRemote: false })),
    attachEngineTerminal: vi.fn(async () => undefined),
    detachEngineTerminal: vi.fn(async () => undefined),
    writeEngineTerminal: vi.fn(async () => undefined),
    resizeEngineTerminal: vi.fn(async () => undefined),
    closeEngineTerminal: vi.fn(async () => undefined),
    readEngineUsage: vi.fn(),
    getState: vi.fn(async () => view),
    stageConversationAttachment: vi.fn(async () => ({ id: 'a_00000000-0000-4000-8000-000000000000', sizeBytes: 1 })),
    discardConversationAttachment: vi.fn(async () => undefined),
    retainConversationAttachments: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    pairEngine: vi.fn(async () => undefined),
    reconnectEngine: vi.fn(async () => undefined),
    createEngineThread: vi.fn(async () => 'thread-new'),
    scanEngineHistory: vi.fn(async () => ({ candidates: [], scannedAt: '2026-09-03T12:00:00Z' })),
    importEngineHistory: vi.fn(async () => ({ importedCount: 0, skippedCount: 0 })),
    createEngineProject: vi.fn(async () => 'project-new'),
    parkAccount: vi.fn(async () => undefined),
    updateEngineThread: vi.fn(async () => undefined),
    holdMessageComment: vi.fn(async () => "c_test"),
    actMessageComment: vi.fn(async () => undefined),
    runAskScan: vi.fn(async () => undefined),
    cancelAskScan: vi.fn(async () => undefined),
    saveAskDraft: vi.fn(async () => undefined),
    queueItemReply: vi.fn(async () => undefined),
    discardItemReply: vi.fn(async () => undefined),
    dismissItem: vi.fn(async () => undefined),
    holdVisualComment: vi.fn(async () => 'v_test'),
    actVisualComment: vi.fn(async () => undefined),
    openPreviewTab: vi.fn(async () => 'tab_00000000-0000-4000-8000-000000000000'),
    closePreviewTab: vi.fn(async () => undefined),
    navigatePreview: vi.fn(async () => undefined),
    resizePreview: vi.fn(async () => undefined),
    previewEvidenceAction: vi.fn(async () => null),
    resumePreviewTab: vi.fn(async () => undefined),
    readDocument: vi.fn(async () => { throw new Error('no document') }),
    reportDocumentBounds: vi.fn(async () => undefined),
    closeDocumentPreview: vi.fn(async () => undefined),
    openDocumentExternally: vi.fn(async () => undefined),
    reportPreviewBounds: vi.fn(async () => undefined),
    reportOverlay: vi.fn(async () => undefined),
    capturePreviewFrame: vi.fn(async () => { throw new Error('no preview') }),
    describePreview: vi.fn(async () => null),
    scrollPreview: vi.fn(async () => ({ x: 0, y: 0 })),
    showVisualComment: vi.fn(async () => ({ shown: false as const, reason: 'no preview', url: null })),
    adjustPreview: vi.fn(async () => { throw new Error('no preview') }),
    clearPreviewOverrides: vi.fn(async () => undefined),
    setTerminalDefault: vi.fn(async () => undefined),
    consumeResetCredit: vi.fn(async () => ({ outcome: 'noCredit' as const })),
    refreshAccounts: vi.fn(async () => undefined),
    startThreadFromDocument: vi.fn(async () => 'thread-new'),
    actOnEngineThread: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    startConversationTurn: vi.fn(async () => undefined),
    compactContext: vi.fn(async () => undefined),
    stopConversationTurn: vi.fn(async () => undefined),
    answerEngineApproval: vi.fn(async () => undefined),
    dismissEngineUserInput: vi.fn(async () => undefined),
    answerEngineUserInput: vi.fn(async () => undefined),
    openDocument: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => 'closed' as const),
    updateBuffer: vi.fn(async () => undefined),
    undo: vi.fn(async () => 'empty' as const),
    redo: vi.fn(async () => 'empty' as const),
    save: vi.fn(async () => undefined),
    setSourceMode: vi.fn(async () => undefined),
    updateReadingState: vi.fn(async () => undefined),
    updateWalkthrough: vi.fn(async () => undefined),
    updateTableView: vi.fn(async () => undefined),
    updateFold: vi.fn(async () => undefined),
    keepHunk: vi.fn(async () => undefined),
    revertHunk: vi.fn(async () => undefined),
    markReviewed: vi.fn(async () => undefined),
    saveRound: vi.fn(async () => ({ hunks: [] })),
    addAnnotation: vi.fn(async () => 'a_test'),
    holdDraft: vi.fn(async () => 'd_test'),
    discardDraft: vi.fn(async () => undefined),
    quickSend: vi.fn(async () => []),
    requoteAnnotation: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    resolveAnnotation: vi.fn(async () => undefined),
    answerDecision: vi.fn(async () => undefined),
    reopenDecision: vi.fn(async () => undefined),
    acceptSuggestion: vi.fn(async () => undefined),
    rejectSuggestion: vi.fn(async () => undefined),
    acceptAllSuggestions: vi.fn(async () => ({ accepted: [], skipped: [] })),
    rejectAllSuggestions: vi.fn(async () => []),
    clearResolvedAnnotations: vi.fn(async () => undefined),
    resolveRecovery: vi.fn(async () => undefined),
    resolveConflict: vi.fn(async () => undefined),
    previewSend: vi.fn(async () => []),
    send: vi.fn(async () => []),
    copyText: vi.fn(async () => undefined),
    selectTheme: vi.fn(async () => undefined),
    createTheme: vi.fn(async () => 'copy'),
    setThemeValue: vi.fn(async () => undefined),
    renameTheme: vi.fn(async () => undefined),
    revertTheme: vi.fn(async () => undefined),
    deleteTheme: vi.fn(async () => undefined),
    listFonts: vi.fn(async () => []),
    openThemeSample: vi.fn(async () => undefined),
    setLead: vi.fn(async () => undefined),
    detachThread: vi.fn(async () => undefined),
    addFolder: vi.fn(async () => undefined),
    removeFolder: vi.fn(async () => undefined),
    scanFolder: vi.fn(async () => undefined),
    refreshExplorer: vi.fn(async () => undefined),
    forgetDocument: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    resolveLocalImage: vi.fn(async () => null),
    resolveLocalMarkdown: vi.fn(async () => null),
    resolveLocalLink: vi.fn(async () => ({ kind: 'html' as const, path: '/tmp/a.html', url: 'file:///tmp/a.html' }))
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
    const registration = registerStrataIpc({ ipcMain: ipcMain as never, api: fakeApi(), renderer: renderer as never })
    const getState = handlers.get(IPC.state)
    const event = { sender: renderer, senderFrame: { url: 'app://stratamd/' } }

    await expect(getState?.(event)).resolves.toEqual({ seq: 1, view })
    await expect(getState?.(event)).resolves.toEqual({ seq: 1, view })
    registration.publish({ ...view, tabs: [{ path: '/tmp/next.md', name: 'next.md', pendingCount: 0, active: true, dirty: false }] })
    expect(renderer.send).toHaveBeenLastCalledWith(IPC.stateChanged, expect.objectContaining({ seq: 2, base: 1 }))
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
    expect(api.updateBuffer).toHaveBeenCalledWith('/tmp/plan.md', 'text', 'history', undefined)
    await updateBuffer?.(event, '/tmp/plan.md', 'text', 'edit', [{ from: 0, to: 4 }])
    expect(api.updateBuffer).toHaveBeenLastCalledWith('/tmp/plan.md', 'text', 'edit', [{ from: 0, to: 4 }])
    for (const ranges of [
      [{ from: -1, to: 3 }], [{ from: 0, to: 5 }], [{ from: 2, to: 2 }],
      [{ from: 2, to: 1 }], [{ from: 0.5, to: 3 }],
      [{ from: 2, to: 4 }, { from: 0, to: 2 }],
      [{ from: 0, to: 3 }, { from: 2, to: 4 }],
    ]) await expect(updateBuffer?.(event, '/tmp/plan.md', 'text', 'edit', ranges)).rejects.toThrow()


    const redo = handlers.get(IPC.redo)
    await expect(redo?.(event, '')).rejects.toThrow()
    await expect(redo?.(event, '/tmp/plan.md')).resolves.toBe('empty')
    expect(api.redo).toHaveBeenCalledWith('/tmp/plan.md')

    const tableState = {
      table: { headingLevel: 2, headingText: 'Islands', headers: ['Name', 'Verdict'], occurrence: 0 },
      presentation: 'focus-row', sort: null, filter: null, hiddenColumns: [], selectedRows: [],
      focusedRow: 0, focusedColumn: 1, density: 'comfortable', columnWidths: [180, 220],
    }
    const updateTable = handlers.get(IPC.updateTableView)
    await updateTable?.(event, '/tmp/plan.md', tableState)
    expect(api.updateTableView).toHaveBeenCalledWith('/tmp/plan.md', tableState)
    await expect(updateTable?.(event, '/tmp/plan.md', { ...tableState, presentation: 'editable-sort' })).rejects.toThrow()

    const context = { kind: 'table-cell', heading: 'Islands', columns: ['Name', 'Verdict'], column: { index: 1, label: 'Verdict' } }
    const addAnnotation = handlers.get(IPC.addAnnotation)
    await expect(addAnnotation?.(event, '/tmp/plan.md', { kind: 'question', quote: '| A | No |', text: 'Why?', from: 10, to: 20, context })).resolves.toBe('a_test')
    expect(api.addAnnotation).toHaveBeenCalledWith('/tmp/plan.md', { kind: 'question', quote: '| A | No |', text: 'Why?', from: 10, to: 20, context })
    await expect(addAnnotation?.(event, '/tmp/plan.md', { kind: 'question', quote: '| A | No |', text: 'Why?', from: 10, to: 20, context: { ...context, column: { index: -1, label: 'Verdict' } } })).rejects.toThrow()

    const screenshotContext = { kind: 'screenshot-pin', component: 'AnnotatedScreenshot', componentLine: 40, image: './review.png', pin: 3 }
    await expect(addAnnotation?.(event, '/tmp/plan.md', { kind: 'question', quote: '| 3 | 75 | 20 | version | Note |', text: 'Aligned?', from: 30, to: 65, context: screenshotContext })).resolves.toBe('a_test')
    expect(api.addAnnotation).toHaveBeenLastCalledWith('/tmp/plan.md', { kind: 'question', quote: '| 3 | 75 | 20 | version | Note |', text: 'Aligned?', from: 30, to: 65, context: screenshotContext })
    await expect(addAnnotation?.(event, '/tmp/plan.md', { kind: 'question', quote: 'row', text: 'Why?', from: 1, to: 4, context: { ...screenshotContext, pin: 0 } })).rejects.toThrow()
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

describe('window IPC boundary', () => {
  it('guards commands, rejects arguments, publishes state, and disposes the owning controller', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
      removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn()
    }
    const renderer = { isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/' }
    const state = { revision: 1, chrome: 'custom' as const, maximized: false, fullscreen: false, focused: true }
    let publish: (next: typeof state) => void = () => undefined
    const unsubscribe = vi.fn()
    const controls = {
      getState: () => state,
      subscribe: (listener: typeof publish) => { publish = listener; return unsubscribe },
      minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn()
    }
    const registration = registerStrataIpc({ ipcMain: ipcMain as never, api: fakeApi(), renderer: renderer as never, windowControls: controls })
    const event = { sender: renderer, senderFrame: { url: 'app://stratamd/' } }
    for (const channel of [IPC.windowState, IPC.minimizeWindow, IPC.toggleMaximizeWindow, IPC.closeWindow]) {
      const call = handlers.get(channel)!
      await expect(call({ ...event, sender: {} })).rejects.toThrow('unknown renderer')
      await expect(call({ ...event, senderFrame: { url: 'https://example.com/' } })).rejects.toThrow('untrusted URL')
      await expect(call(event, 'some-other-window')).rejects.toThrow()
    }
    expect(controls.close).not.toHaveBeenCalled()
    expect(await handlers.get(IPC.windowState)!(event)).toEqual(state)
    await handlers.get(IPC.minimizeWindow)!(event)
    await handlers.get(IPC.toggleMaximizeWindow)!(event)
    await handlers.get(IPC.closeWindow)!(event)
    for (const action of [controls.minimize, controls.toggleMaximize, controls.close]) expect(action).toHaveBeenCalledOnce()
    publish({ ...state, revision: 2, maximized: true })
    expect(renderer.send).toHaveBeenCalledWith(IPC.windowStateChanged, expect.objectContaining({ revision: 2, maximized: true }))
    registration.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC.closeWindow)
  })
})

describe('engine setup IPC boundary', () => {
  it('validates new setup, usage and terminal commands before calling the engine', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const renderer = { isDestroyed: () => false, send: vi.fn(), getURL: () => 'app://stratamd/' }
    const api = fakeApi()
    const registration = registerStrataIpc({ ipcMain: ipcMain as never, api, renderer: renderer as never })
    const event = { sender: renderer, senderFrame: { url: 'app://stratamd/' } }
    try {
      const invalid: Array<[string, unknown[]]> = [
        [IPC.readEngineSettings, ['extra']], [IPC.browseEngineFolder, ['']], [IPC.listEngineRefs, ['/project', 'x'.repeat(257)]],
        [IPC.cloneEngineRepository, [{ repoUrl: 'x' }]],
        [IPC.setModelPreference, ['codex', 'model', { hidden: 'yes' }]], [IPC.readEngineUsage, ['365d']],
        [IPC.attachEngineTerminal, [{ attachmentId: 'one', threadId: 'thread', terminalId: 'term-1', cwd: '/project', cols: 0, rows: 24 }]],
        [IPC.resizeEngineTerminal, [{ threadId: 'thread', terminalId: 'term-1', cols: 80, rows: 501 }]],
        [IPC.writeEngineTerminal, [{ threadId: 'thread', terminalId: 'term-1', data: 'x'.repeat(65_537) }]],
      ]
      for (const [channel, args] of invalid) await expect(handlers.get(channel)!(event, ...args), channel).rejects.toThrow()
      expect(api.readEngineUsage).not.toHaveBeenCalled()
      expect(api.attachEngineTerminal).not.toHaveBeenCalled()
      await handlers.get(IPC.consumeResetCredit)!(event, { instanceId: 'codex' })
      expect(api.consumeResetCredit).toHaveBeenCalledWith({ instanceId: 'codex' })
      await handlers.get(IPC.readEngineUsage)!(event, '24h')
      expect(api.readEngineUsage).toHaveBeenCalledWith('24h')
      await handlers.get(IPC.resizeEngineTerminal)!(event, { threadId: 'thread', terminalId: 'term-1', cols: 80, rows: 24 })
      expect(api.resizeEngineTerminal).toHaveBeenCalledWith({ threadId: 'thread', terminalId: 'term-1', cols: 80, rows: 24 })
    } finally { registration.dispose() }
  })
})
