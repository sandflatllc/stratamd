import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppView, SpellingContext, StrataApi, WindowApi, WindowState } from '../shared/contracts'
import { applyViewUpdate, isViewUpdate, sameJson, type SyncedView } from '../shared/view-sync'
import { IPC } from './channels'

const invoke = <Result>(channel: string, ...arguments_: unknown[]): Promise<Result> => ipcRenderer.invoke(channel, ...arguments_)

let synced: SyncedView | null = null
let resyncing: Promise<AppView> | null = null
let resyncs = 0
let verifyMismatches = 0

const fetchState = async (): Promise<AppView> => {
  const envelope = await invoke<SyncedView>(IPC.state)
  if (synced === null || envelope.seq >= synced.seq) synced = envelope
  return synced.view
}

const isSpellingContext = (value: unknown): value is SpellingContext => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.word === 'string'
    && Array.isArray(candidate.suggestions)
    && candidate.suggestions.every((entry) => typeof entry === 'string')
}

const resyncState = (): Promise<AppView> => {
  if (resyncing === null) {
    resyncing = fetchState().finally(() => { resyncing = null })
  }
  return resyncing
}

const windowApi: WindowApi = {
  getState: () => invoke<WindowState>(IPC.windowState),
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: WindowState) => listener(state)
    ipcRenderer.on(IPC.windowStateChanged, receive)
    return () => { ipcRenderer.removeListener(IPC.windowStateChanged, receive) }
  },
  minimize: () => invoke<void>(IPC.minimizeWindow),
  toggleMaximize: () => invoke<void>(IPC.toggleMaximizeWindow),
  close: () => invoke<void>(IPC.closeWindow)
}
contextBridge.exposeInMainWorld('strataWindow', windowApi)

const api: StrataApi & { openDroppedFiles(files: File[]): Promise<void>; viewSyncDiagnostics(): { seq: number; resyncs: number; verifyMismatches: number } } = {
  getState: () => fetchState(),
  reportError: (report) => {
    // Fire-and-forget into the local failure log; a failing report must never
    // become a second failure inside an error path.
    try {
      ipcRenderer.send(IPC.reportError, report)
    } catch {
      // Dropped.
    }
  },
  viewSyncDiagnostics: () => ({ seq: synced?.seq ?? 0, resyncs, verifyMismatches }),
  subscribe(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, update: unknown): void => {
      if (!isViewUpdate(update)) return
      const result = applyViewUpdate(synced, update)
      if (result.status === 'applied') {
        if (update.verify !== undefined && !sameJson(result.synced.view, update.verify)) {
          verifyMismatches += 1
          console.error(`StrataMD view sync: merged view diverged from the published view at seq ${update.seq}`)
          synced = { seq: update.seq, view: update.verify }
        } else {
          synced = result.synced
        }
        listener(synced.view)
        return
      }
      resyncs += 1
      void resyncState().then((view) => listener(view))
    }
    ipcRenderer.on(IPC.stateChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.stateChanged, wrapped)
  },
  pairEngine: (request) => invoke<void>(IPC.pairEngine, request),
  reconnectEngine: () => invoke<void>(IPC.reconnectEngine),
  openConversation: (threadId) => invoke<void>(IPC.openConversation, threadId),
  createEngineThread: (input) => invoke<string>(IPC.createEngineThread, input),
  createEngineProject: (input) => invoke<string>(IPC.createEngineProject, input),
  startThreadFromDocument: (path, input) => invoke<string>(IPC.startThreadFromDocument, path, input),
  actOnEngineThread: (threadId, action) => invoke<void>(IPC.actOnEngineThread, threadId, action),
  parkAccount: (instanceId, parked) => invoke<void>(IPC.parkAccount, instanceId, parked),
  updateEngineThread: (threadId, change) => invoke<void>(IPC.updateEngineThread, threadId, change),
  setTerminalDefault: (driver, selection) => invoke<void>(IPC.setTerminalDefault, driver, selection),
  refreshAccounts: () => invoke<void>(IPC.refreshAccounts),
  holdMessageComment: (threadId, input) => invoke<string>(IPC.holdMessageComment, threadId, input),
  actMessageComment: (threadId, itemId, action) => invoke<void>(IPC.actMessageComment, threadId, itemId, action),
  queueItemReply: (threadId, itemId, text) => invoke<void>(IPC.queueItemReply, threadId, itemId, text),
  discardItemReply: (threadId, itemId) => invoke<void>(IPC.discardItemReply, threadId, itemId),
  dismissItem: (threadId, itemId) => invoke<void>(IPC.dismissItem, threadId, itemId),
  startConversationTurn: (threadId, input) => invoke<void>(IPC.startConversationTurn, threadId, input),
  stopConversationTurn: (threadId) => invoke<void>(IPC.stopConversationTurn, threadId),
  answerEngineApproval: (threadId, requestId, decision) => invoke<void>(IPC.answerEngineApproval, threadId, requestId, decision),
  answerEngineUserInput: (threadId, requestId, answers) => invoke<void>(IPC.answerEngineUserInput, threadId, requestId, answers),
  onSpelling(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, spelling: unknown): void => {
      if (!isSpellingContext(spelling)) return
      listener({ word: spelling.word, suggestions: [...spelling.suggestions] })
    }
    ipcRenderer.on(IPC.spelling, wrapped)
    return () => ipcRenderer.removeListener(IPC.spelling, wrapped)
  },
  addDictionaryWord: (word) => invoke<void>(IPC.addDictionaryWord, word),
  flashWindow: () => { void invoke<void>(IPC.flashWindow).catch(() => undefined) },
  createFile: (directory, name) => invoke<string>(IPC.createFile, directory, name),
  renameFile: (path, name) => invoke<string>(IPC.renameFile, path, name),
  trashFile: (path) => invoke<void>(IPC.trashFile, path),
  revealFile: (path) => invoke<void>(IPC.revealFile, path),
  openFileDialog: () => invoke<void>(IPC.openFileDialog),
  pasteFromClipboard: () => invoke<void>(IPC.pasteFromClipboard),
  openDocument: (path) => invoke<void>(IPC.openDocument, path),
  async openDroppedFiles(files) {
    for (const file of files) await invoke<void>(IPC.openDocument, webUtils.getPathForFile(file))
  },
  closeDocument: (path, decision) => invoke<'closed' | 'needs-decision' | 'cancelled'>(IPC.closeDocument, path, decision),
  updateBuffer: (path, content, origin) => invoke<void>(IPC.updateBuffer, path, content, origin),
  undo: (path) => invoke<'undone' | 'empty'>(IPC.undo, path),
  redo: (path) => invoke<'redone' | 'empty'>(IPC.redo, path),
  save: (path) => invoke<void>(IPC.save, path),
  setSourceMode: (path, source) => invoke<void>(IPC.setSourceMode, path, source),
  updateReadingState: (path, state) => invoke<void>(IPC.updateReadingState, path, state),
  updateWalkthrough: (path, action) => invoke<void>(IPC.updateWalkthrough, path, action),
  updateTableView: (path, state) => invoke<void>(IPC.updateTableView, path, state),
  updateFold: (path, heading, folded) => invoke<void>(IPC.updateFold, path, heading, folded),
  keepHunk: (path, hunkId) => invoke<void>(IPC.keepHunk, path, hunkId),
  revertHunk: (path, hunkId, confirmMixed) => invoke<void>(IPC.revertHunk, path, hunkId, confirmMixed),
  markReviewed: (path) => invoke<void>(IPC.markReviewed, path),
  saveRound: (path, index) => invoke(IPC.saveRound, path, index),
  addAnnotation: (path, annotation) => invoke<string>(IPC.addAnnotation, path, annotation),
  holdDraft: (path, draft) => invoke<string>(IPC.holdDraft, path, draft),
  discardDraft: (path, draftId) => invoke<void>(IPC.discardDraft, path, draftId),
  quickSend: (path, draft) => invoke<string[]>(IPC.quickSend, path, draft),
  requoteAnnotation: (path, annotationId, range) => invoke<void>(IPC.requoteAnnotation, path, annotationId, range),
  reply: (path, annotationId, text) => invoke<void>(IPC.reply, path, annotationId, text),
  resolveAnnotation: (path, annotationId) => invoke<void>(IPC.resolveAnnotation, path, annotationId),
  answerDecision: (path, annotationId, answer) => invoke<void>(IPC.answerDecision, path, annotationId, answer),
  reopenDecision: (path, annotationId) => invoke<void>(IPC.reopenDecision, path, annotationId),
  acceptSuggestion: (path, annotationId) => invoke<void>(IPC.acceptSuggestion, path, annotationId),
  rejectSuggestion: (path, annotationId) => invoke<void>(IPC.rejectSuggestion, path, annotationId),
  acceptAllSuggestions: (path, agentId) => invoke(IPC.acceptAllSuggestions, path, agentId),
  rejectAllSuggestions: (path, agentId) => invoke(IPC.rejectAllSuggestions, path, agentId),
  clearResolvedAnnotations: (path) => invoke<void>(IPC.clearResolvedAnnotations, path),
  resolveRecovery: (path, decision) => invoke<void>(IPC.resolveRecovery, path, decision),
  resolveConflict: (path, conflictId, decision) => invoke<void>(IPC.resolveConflict, path, conflictId, decision),
  previewSend: (path, request) => invoke(IPC.previewSend, path, request),
  send: (path, request) => invoke(IPC.send, path, request),
  copyText: (text) => invoke<void>(IPC.copyText, text),
  setLead: (path, agentId) => invoke<void>(IPC.setLead, path, agentId),
  detachThread: (path, threadId) => invoke<void>(IPC.detachThread, path, threadId),
  addFolder: () => invoke<void>(IPC.addFolder),
  removeFolder: (path) => invoke<void>(IPC.removeFolder, path),
  scanFolder: (path) => invoke<void>(IPC.scanFolder, path),
  refreshExplorer: () => invoke<void>(IPC.refreshExplorer),
  forgetDocument: (path) => invoke<void>(IPC.forgetDocument, path),
  updateSettings: (settings) => invoke<void>(IPC.updateSettings, settings),
  selectTheme: (id) => invoke<void>(IPC.selectTheme, id),
  createTheme: (name, fromId) => invoke<string>(IPC.createTheme, name, fromId),
  setThemeValue: (key, value) => invoke<void>(IPC.setThemeValue, key, value),
  renameTheme: (name) => invoke<void>(IPC.renameTheme, name),
  revertTheme: (sparse) => invoke<void>(IPC.revertTheme, sparse),
  deleteTheme: (id) => invoke<void>(IPC.deleteTheme, id),
  listFonts: () => invoke<string[]>(IPC.listFonts),
  openThemeSample: () => invoke<void>(IPC.openThemeSample),
  resolveLocalImage: (documentPath, source) => invoke(IPC.resolveLocalImage, documentPath, source),
  resolveLocalMarkdown: (documentPath, source) => invoke(IPC.resolveLocalMarkdown, documentPath, source)
}

contextBridge.exposeInMainWorld('strata', Object.freeze(api))

// Warm-editor cache override for tests and A/B measurement runs (docs/plans/completed/cold-tab-plan.md §5).
const editorCacheOverride = process.env.STRATAMD_EDITOR_CACHE
if (editorCacheOverride !== undefined) {
  contextBridge.exposeInMainWorld('strataEditorCache', editorCacheOverride)
}

// Reparse verify mode: every stitched parse is checked against a full parse
// (docs/plans/completed/reparse-plan.md §7). The renderer cannot read process.env.
const parseVerify = process.env.STRATAMD_PARSE_VERIFY
if (parseVerify !== undefined) {
  contextBridge.exposeInMainWorld('strataParseVerify', parseVerify)
}

// Crash probe for the e2e containment tests (docs/plans/completed/crash-hardening-plan.md §4).
if (process.env.STRATAMD_CRASH_PROBE === '1') {
  contextBridge.exposeInMainWorld('strataCrashProbe', '1')
}

// The Phase 6 dependency proof renders the real review diagrams in the same
// sandboxed renderer as the editor before any Mermaid NodeView is installed.
if (process.env.STRATAMD_MERMAID_PROOF === '1') {
  contextBridge.exposeInMainWorld('strataMermaidProofEnabled', '1')
}
if (process.env.STRATAMD_PHASE6_DISABLED === '1') {
  contextBridge.exposeInMainWorld('strataPhase6Disabled', '1')
}
if (process.env.STRATAMD_PHASE7_DISABLED === '1') {
  contextBridge.exposeInMainWorld('strataPhase7Disabled', '1')
}
