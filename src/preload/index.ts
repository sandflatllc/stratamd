import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppView, SpellingContext, StrataApi } from '../shared/contracts'
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
  onSpelling(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, spelling: unknown): void => {
      if (!isSpellingContext(spelling)) return
      listener({ word: spelling.word, suggestions: [...spelling.suggestions] })
    }
    ipcRenderer.on(IPC.spelling, wrapped)
    return () => ipcRenderer.removeListener(IPC.spelling, wrapped)
  },
  addDictionaryWord: (word) => invoke<void>(IPC.addDictionaryWord, word),
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
  keepHunk: (path, hunkId) => invoke<void>(IPC.keepHunk, path, hunkId),
  revertHunk: (path, hunkId, confirmMixed) => invoke<void>(IPC.revertHunk, path, hunkId, confirmMixed),
  markReviewed: (path) => invoke<void>(IPC.markReviewed, path),
  saveRound: (path, index) => invoke(IPC.saveRound, path, index),
  addAnnotation: (path, annotation) => invoke<void>(IPC.addAnnotation, path, annotation),
  requoteAnnotation: (path, annotationId, range) => invoke<void>(IPC.requoteAnnotation, path, annotationId, range),
  reply: (path, annotationId, text) => invoke<void>(IPC.reply, path, annotationId, text),
  resolveAnnotation: (path, annotationId) => invoke<void>(IPC.resolveAnnotation, path, annotationId),
  acceptSuggestion: (path, annotationId) => invoke<void>(IPC.acceptSuggestion, path, annotationId),
  rejectSuggestion: (path, annotationId) => invoke<void>(IPC.rejectSuggestion, path, annotationId),
  acceptAllSuggestions: (path, agentId) => invoke(IPC.acceptAllSuggestions, path, agentId),
  rejectAllSuggestions: (path, agentId) => invoke(IPC.rejectAllSuggestions, path, agentId),
  clearResolvedAnnotations: (path) => invoke<void>(IPC.clearResolvedAnnotations, path),
  resolveRecovery: (path, decision) => invoke<void>(IPC.resolveRecovery, path, decision),
  resolveConflict: (path, conflictId, decision) => invoke<void>(IPC.resolveConflict, path, conflictId, decision),
  previewSend: (path, request) => invoke(IPC.previewSend, path, request),
  send: (path, request) => invoke(IPC.send, path, request),
  copyForAgent: (path, note, includeExternal) => invoke<void>(IPC.copyForAgent, path, note, includeExternal),
  copyText: (text) => invoke<void>(IPC.copyText, text),
  nudge: (path, agentId) => invoke<void>(IPC.nudge, path, agentId),
  setLead: (path, agentId) => invoke<void>(IPC.setLead, path, agentId),
  disconnectAgent: (path, agentId) => invoke<void>(IPC.disconnectAgent, path, agentId),
  addFolder: () => invoke<void>(IPC.addFolder),
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
  resolveLocalImage: (documentPath, source) => invoke<string | null>(IPC.resolveLocalImage, documentPath, source)
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
