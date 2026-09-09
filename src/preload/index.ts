import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppView, SpellingContext, StrataApi, WindowApi, WindowState } from '../shared/contracts'
import { applyViewUpdate, isViewUpdate, sameJson, type SyncedView } from '../shared/view-sync'
import { IPC } from './channels'

const invoke = async <Result>(channel: string, ...arguments_: unknown[]): Promise<Result> => {
  try { return await ipcRenderer.invoke(channel, ...arguments_) }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const message = detail.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error: /, '')
    const plain = new Error(message); plain.name = ''; throw plain
  }
}

let saveRequest = 0
let lastSave: { request: number; path: string; error: string | null } | null = null

let synced: SyncedView | null = null
let resyncing: Promise<void> | null = null
let resyncs = 0
let verifyMismatches = 0
const viewListeners = new Set<(view: AppView) => void>()
let notifiedSeq = -1
let receivedSeq = -1

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

const notifyState = (): void => {
  if (!synced || synced.seq <= notifiedSeq) return
  notifiedSeq = synced.seq
  for (const listener of viewListeners) {
    try { listener(synced.view) }
    catch (error) { console.error('StrataMD state listener failed', error) }
  }
}

const resyncState = (): void => {
  if (resyncing !== null) return
  resyncs += 1
  resyncing = fetchState().then(() => {
    resyncing = null
    notifyState()
    // A newer patch may have arrived while this snapshot was in flight. If
    // it could not be applied, fetch again even when no more updates follow.
    if (synced && synced.seq < receivedSeq) resyncState()
  }).catch(error => {
    resyncing = null
    console.error('StrataMD state resynchronization failed', error)
  })
}

// The preload owns one sequence cursor. Apply each IPC update once, then fan
// out to EngineScope, App, and any other subscribers sharing that cursor.
ipcRenderer.on(IPC.stateChanged, (_event, update: unknown): void => {
  if (!isViewUpdate(update)) return
  receivedSeq = Math.max(receivedSeq, update.seq)
  if (synced && update.seq <= synced.seq) { notifyState(); return }
  const result = applyViewUpdate(synced, update)
  if (result.status === 'applied') {
    if (update.verify !== undefined && !sameJson(result.synced.view, update.verify)) {
      verifyMismatches += 1
      console.error(`StrataMD view sync: merged view diverged from the published view at seq ${update.seq}`)
      synced = { seq: update.seq, view: update.verify }
    } else synced = result.synced
    notifyState()
  } else resyncState()
})

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

const api: StrataApi & {
  openDroppedFiles(files: File[]): Promise<void>
  saveDiagnostics(): { issued: number; completed: typeof lastSave }
  viewSyncDiagnostics(): { seq: number; resyncs: number; verifyMismatches: number }
} = {
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
  saveDiagnostics: () => ({ issued: saveRequest, completed: lastSave }),
  viewSyncDiagnostics: () => ({ seq: synced?.seq ?? 0, resyncs, verifyMismatches }),
  subscribe(listener) {
    const receive = (view: AppView) => listener(view)
    viewListeners.add(receive)
    return () => { viewListeners.delete(receive) }
  },
  pairEngine: (request) => invoke<void>(IPC.pairEngine, request),
  manageEngine: (action) => invoke<void>(IPC.manageEngine, action),
  reconnectEngine: () => invoke<void>(IPC.reconnectEngine),
  openConversation: (threadId) => invoke<void>(IPC.openConversation, threadId),
  createEngineThread: (input) => invoke<string>(IPC.createEngineThread, input),
  scanEngineHistory: () => invoke(IPC.scanEngineHistory),
  importEngineHistory: (input) => invoke(IPC.importEngineHistory, input),
  createEngineProject: (input) => invoke<string>(IPC.createEngineProject, input),
  startThreadFromDocument: (path, input) => invoke<string>(IPC.startThreadFromDocument, path, input),
  actOnEngineThread: (threadId, action) => invoke<void>(IPC.actOnEngineThread, threadId, action),
  parkAccount: (instanceId, parked) => invoke<void>(IPC.parkAccount, instanceId, parked),
  updateEngineThread: (threadId, change) => invoke<void>(IPC.updateEngineThread, threadId, change),
  setTerminalDefault: (driver, selection) => invoke<void>(IPC.setTerminalDefault, driver, selection),
  openExternal: (url) => invoke<void>(IPC.openExternal, url),
  resolveLocalLink: input => invoke(IPC.resolveLocalLink, input),
  readEngineUsage: window => invoke(IPC.readEngineUsage, window),
  engineRecovery: request => invoke(IPC.engineRecovery, request),
  computer: request => invoke(IPC.computer, request),
  providerSetup: request => invoke(IPC.providerSetup, request),
  readEngineSupport: () => invoke(IPC.readEngineSupport),
  readEngineProjectDefaults: projectId => invoke(IPC.readEngineProjectDefaults, projectId),
  editEngineProjectDefaults: edit => invoke(IPC.editEngineProjectDefaults, edit),
  readEngineSettings: () => invoke(IPC.readEngineSettings),
  editEngineSettings: edit => invoke(IPC.editEngineSettings, edit),
  editEngineProvider: edit => invoke(IPC.editEngineProvider, edit),
  browseEngineFolder: (path) => invoke(IPC.browseEngineFolder, path),
  lookupEngineRepository: (repository) => invoke(IPC.lookupEngineRepository, repository),
  cloneEngineRepository: (input) => invoke(IPC.cloneEngineRepository, input),
  setModelPreference: (instanceId, slug, preference) => invoke(IPC.setModelPreference, instanceId, slug, preference),
  listEngineRefs: (cwd, query) => invoke(IPC.listEngineRefs, cwd, query),
  attachEngineTerminal: (input) => invoke(IPC.attachEngineTerminal, input),
  detachEngineTerminal: (attachmentId) => invoke(IPC.detachEngineTerminal, attachmentId),
  writeEngineTerminal: (input) => invoke(IPC.writeEngineTerminal, input),
  resizeEngineTerminal: (input) => invoke(IPC.resizeEngineTerminal, input),
  closeEngineTerminal: (input) => invoke(IPC.closeEngineTerminal, input),
  consumeResetCredit: input => invoke<import('../shared/usage-limits').ConsumeResetCreditResult>(IPC.consumeResetCredit, input),
  refreshAccounts: () => invoke<void>(IPC.refreshAccounts),
  holdMessageComment: (threadId, input) => invoke<string>(IPC.holdMessageComment, threadId, input),
  actMessageComment: (threadId, itemId, action) => invoke<void>(IPC.actMessageComment, threadId, itemId, action),
  runAskScan: (identity, threadId, messageId) => invoke<void>(IPC.runAskScan, identity, threadId, messageId),
  cancelAskScan: (identity, threadId) => invoke<void>(IPC.cancelAskScan, identity, threadId),
  saveAskDraft: (identity, threadId, itemId, text) => invoke<void>(IPC.saveAskDraft, identity, threadId, itemId, text),
  queueItemReply: (threadId, itemId, text) => invoke<void>(IPC.queueItemReply, threadId, itemId, text),
  discardItemReply: (threadId, itemId) => invoke<void>(IPC.discardItemReply, threadId, itemId),
  dismissItem: (threadId, itemId) => invoke<void>(IPC.dismissItem, threadId, itemId),
  retainVisualEvidence: (owner, ids) => invoke<void>(IPC.retainVisualEvidence, owner, ids),
  onWindowCapture: (listener) => { const wrapped = () => listener(); ipcRenderer.on(IPC.captureRequested, wrapped); return () => ipcRenderer.removeListener(IPC.captureRequested, wrapped) },
  windowCapture: (input) => invoke(IPC.windowCapture, input),
  holdVisualComment: (input) => invoke<string>(IPC.holdVisualComment, input),
  actVisualComment: (id, action) => invoke<void>(IPC.actVisualComment, id, action),
  openPreviewTab: (input) => invoke<string>(IPC.openPreviewTab, input),
  closePreviewTab: (tabId) => invoke<void>(IPC.closePreviewTab, tabId),
  navigatePreview: (tabId, navigation) => invoke<void>(IPC.navigatePreview, tabId, navigation),
  resizePreview: (tabId, viewport) => invoke<void>(IPC.resizePreview, tabId, viewport),
  previewEvidenceAction: (id, action) => invoke<string | null>(IPC.previewEvidenceAction, id, action),
  resumePreviewTab: (tabId) => invoke<void>(IPC.resumePreviewTab, tabId),
  reportPreviewBounds: (report) => invoke<void>(IPC.reportPreviewBounds, report),
  reportOverlay: (open) => invoke<void>(IPC.reportOverlay, open),
  capturePreviewFrame: (tabId) => invoke(IPC.capturePreviewFrame, tabId),
  describePreview: (tabId, target) => invoke(IPC.describePreview, tabId, target),
  scrollPreview: (tabId, move) => invoke(IPC.scrollPreview, tabId, move),
  showVisualComment: (id) => invoke(IPC.showVisualComment, id),
  adjustPreview: (tabId, targets) => invoke(IPC.adjustPreview, tabId, targets),
  clearPreviewOverrides: (tabId) => invoke(IPC.clearPreviewOverrides, tabId),
  startConversationTurn: (threadId, input) => invoke<void>(IPC.startConversationTurn, threadId, input),
  readDocument: (source, identity) => invoke(IPC.readDocument, source, identity),
  reportDocumentBounds: report => invoke<void>(IPC.reportDocumentBounds, report),
  closeDocumentPreview: id => invoke<void>(IPC.closeDocumentPreview, id),
  openDocumentExternally: id => invoke<void>(IPC.openDocumentExternally, id),
  stageConversationAttachment: (input) => invoke<{ id: string; sizeBytes: number }>(IPC.stageConversationAttachment, input),
  discardConversationAttachment: (id) => invoke<void>(IPC.discardConversationAttachment, id),
  retainConversationAttachments: (ids) => invoke<void>(IPC.retainConversationAttachments, ids),
  continueInterruptedThread: threadId => invoke<void>(IPC.continueInterruptedThread, threadId),
  compactContext: (threadId, input) => invoke<void>(IPC.compactContext, threadId, input),
  stopConversationTurn: (threadId) => invoke<void>(IPC.stopConversationTurn, threadId),
  answerEngineApproval: (threadId, requestId, decision) => invoke<void>(IPC.answerEngineApproval, threadId, requestId, decision),
  dismissEngineUserInput: (threadId, requestId) => invoke<void>(IPC.dismissEngineUserInput, threadId, requestId),
  answerEngineUserInput: (threadId, requestId, answers, attachmentsByQuestionId) => invoke<void>(IPC.answerEngineUserInput, threadId, requestId, answers, attachmentsByQuestionId),
  onTerminalEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, push: import('../shared/contracts').TerminalPush) => listener(push)
    ipcRenderer.on(IPC.terminalEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.terminalEvent, wrapped)
  },
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
  updateBuffer: (path, content, origin, blockRanges) => invoke<void>(IPC.updateBuffer, path, content, origin, blockRanges),
  undo: (path) => invoke<'undone' | 'empty'>(IPC.undo, path),
  redo: (path) => invoke<'redone' | 'empty'>(IPC.redo, path),
  save: async (path) => {
    const request = ++saveRequest
    try {
      await invoke<void>(IPC.save, path)
      lastSave = { request, path, error: null }
    } catch (error) {
      lastSave = { request, path, error: error instanceof Error ? error.message : String(error) }
      throw error
    }
  },
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

// Preview probe for the e2e browser tests (docs/plans/open/visual-review, phase 2): a real input into a preview tab.
if (process.env.STRATAMD_PREVIEW_PROBE === '1') {
  contextBridge.exposeInMainWorld('strataPreviewProbe', Object.freeze({ humanInput: (tabId: string, point: { x: number; y: number }) => invoke<void>(IPC.previewProbe, tabId, point) }))
}

// Crash probe for the e2e containment tests (docs/plans/completed/crash-hardening-plan.md §4).
if (process.env.STRATAMD_CRASH_PROBE === '1') {
  contextBridge.exposeInMainWorld('strataCrashProbe', '1')
}

// Transcript probe for the scroll-stability tests: lets a test hold image
// metadata, image decode, and Mermaid completion until it releases them.
if (process.env.STRATAMD_TRANSCRIPT_PROBE === '1') {
  contextBridge.exposeInMainWorld('strataTranscriptProbe', '1')
}
// Switches for the optional transcript optimizations; '0' disables one.
for (const [name, variable] of [['strataTranscriptCache', 'STRATAMD_TRANSCRIPT_CACHE'], ['strataTranscriptSweep', 'STRATAMD_TRANSCRIPT_SWEEP']] as const) {
  if (process.env[variable] === '0') contextBridge.exposeInMainWorld(name, '0')
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
