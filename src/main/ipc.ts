import { spawn } from 'node:child_process'
import type { ContextMenuParams, IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { z } from 'zod'
import type { AppView, SpellingContext, StrataApi, BufferOrigin } from '../shared/contracts'
import { encodeViewUpdate, type SyncedView } from '../shared/view-sync'
import { IPC, type InvokeChannel } from '../preload/channels'
import { logRendererReport } from './log'

type StrataIpcApi = Omit<StrataApi, 'subscribe'>

const pathSchema = z.string().min(1).max(16_384)
const idSchema = z.string().min(1).max(512)
const textSchema = z.string().max(64 * 1_024)
const sendRequestSchema = z.object({
  recipients: z.array(idSchema).max(128),
  note: textSchema,
  includeExternal: z.boolean(),
  excludedHunks: z.array(z.string().max(256)).max(4_096).optional(),
  excludedEvents: z.array(z.number().int().nonnegative()).max(4_096).optional(),
  token: z.object({
    snapshotId: z.string().max(128),
    segmentIndex: z.number().int().min(-1),
    cursor: z.number().int().nonnegative()
  }).strict().optional()
}).strict()
const themeIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)
const settingsSchema = z.object({
  animatedBackground: z.boolean().optional(),
  attachmentIdleHours: z.number().positive().finite().optional(),
  panelSizes: z.object({
    explorerWidth: z.number().positive().finite(),
    rightRailWidth: z.number().positive().finite(),
    changesHeight: z.number().positive().finite(),
    annotationsHeight: z.number().positive().finite(),
    documentMeasure: z.number().positive().finite(),
    themePanel: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().positive().finite(),
      height: z.number().positive().finite()
    }).strict(),
    threadPanel: z.object({
      width: z.number().positive().finite(),
      height: z.number().finite().min(-1)
    }).strict(),
    annotationComposer: z.object({
      width: z.number().positive().finite(),
      height: z.number().finite().min(-1)
    }).strict(),
    sendComposer: z.object({
      width: z.number().positive().finite(),
      height: z.number().finite().min(-1)
    }).strict()
  }).strict().optional(),
  zoom: z.object({
    explorer: z.number().positive().finite(),
    editor: z.number().positive().finite(),
    rightRail: z.number().positive().finite(),
    composer: z.number().positive().finite()
  }).strict().optional()
}).strict()

const argumentSchemas: Record<InvokeChannel, z.ZodType> = {
  [IPC.state]: z.tuple([]),
  [IPC.openDocument]: z.tuple([pathSchema.optional()]),
  [IPC.closeDocument]: z.tuple([pathSchema, z.enum(['save', 'discard', 'cancel']).optional()]),
  [IPC.updateBuffer]: z.tuple([pathSchema, z.string(), z.enum(['edit', 'history'])]),
  [IPC.undo]: z.tuple([pathSchema]),
  [IPC.redo]: z.tuple([pathSchema]),
  [IPC.save]: z.tuple([pathSchema]),
  [IPC.setSourceMode]: z.tuple([pathSchema, z.boolean()]),
  [IPC.keepHunk]: z.tuple([pathSchema, idSchema]),
  [IPC.revertHunk]: z.tuple([pathSchema, idSchema, z.boolean().optional()]),
  [IPC.markReviewed]: z.tuple([pathSchema]),
  [IPC.saveRound]: z.tuple([pathSchema, z.number().int().nonnegative()]),
  [IPC.addAnnotation]: z.tuple([pathSchema, z.object({
    kind: z.enum(['comment', 'question', 'suggestion']),
    quote: z.string().min(1),
    text: textSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative()
  }).strict()]),
  [IPC.requoteAnnotation]: z.tuple([pathSchema, idSchema, z.object({
    quote: z.string().min(1),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative()
  }).strict()]),
  [IPC.reply]: z.tuple([pathSchema, idSchema, textSchema]),
  [IPC.resolveAnnotation]: z.tuple([pathSchema, idSchema]),
  [IPC.acceptSuggestion]: z.tuple([pathSchema, idSchema]),
  [IPC.rejectSuggestion]: z.tuple([pathSchema, idSchema]),
  [IPC.acceptAllSuggestions]: z.tuple([pathSchema, idSchema]),
  [IPC.rejectAllSuggestions]: z.tuple([pathSchema, idSchema]),
  [IPC.clearResolvedAnnotations]: z.tuple([pathSchema]),
  [IPC.resolveRecovery]: z.tuple([pathSchema, z.enum(['recover', 'discard'])]),
  [IPC.resolveConflict]: z.tuple([pathSchema, idSchema, z.enum(['mine', 'incoming'])]),
  [IPC.previewSend]: z.tuple([pathSchema, sendRequestSchema]),
  [IPC.send]: z.tuple([pathSchema, sendRequestSchema]),
  [IPC.copyForAgent]: z.tuple([pathSchema, textSchema, z.boolean()]),
  [IPC.copyText]: z.tuple([textSchema]),
  [IPC.nudge]: z.tuple([pathSchema, idSchema]),
  [IPC.setLead]: z.tuple([pathSchema, idSchema.nullable()]),
  [IPC.disconnectAgent]: z.tuple([pathSchema, idSchema]),
  [IPC.addFolder]: z.tuple([]),
  [IPC.scanFolder]: z.tuple([pathSchema]),
  [IPC.refreshExplorer]: z.tuple([]),
  [IPC.forgetDocument]: z.tuple([pathSchema]),
  [IPC.updateSettings]: z.tuple([settingsSchema]),
  [IPC.selectTheme]: z.tuple([themeIdSchema]),
  [IPC.createTheme]: z.tuple([z.string().trim().min(1).max(120), themeIdSchema]),
  [IPC.setThemeValue]: z.tuple([z.string().regex(/^[a-z]+\.[a-z0-9-]+$/), z.union([z.string().max(256), z.number().finite(), z.null()])]),
  [IPC.renameTheme]: z.tuple([z.string().trim().min(1).max(120)]),
  [IPC.revertTheme]: z.tuple([z.record(z.string(), z.unknown())]),
  [IPC.deleteTheme]: z.tuple([themeIdSchema]),
  [IPC.listFonts]: z.tuple([]),
  [IPC.openThemeSample]: z.tuple([]),
  [IPC.resolveLocalImage]: z.tuple([pathSchema, z.string().min(1).max(16_384)]),
  [IPC.openExternal]: z.tuple([z.string().url().max(16_384)]),
  [IPC.addDictionaryWord]: z.tuple([z.string().min(1).max(512)])
}

/**
 * The context-menu params that qualify for the annotate menu's spelling column,
 * or null (docs/plans/completed/spellcheck-plan.md). Suggestions keep Electron's order.
 * A non-empty misspelledWord is itself the proof the spellchecker ran; the
 * params' spellcheckEnabled flag reads false even then, so it gates nothing.
 */
export function spellingContext(
  params: Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions'>
): SpellingContext | null {
  if (!params.isEditable || !params.misspelledWord) return null
  return { word: params.misspelledWord, suggestions: [...params.dictionarySuggestions] }
}

// Field caps mirror the log contract (docs/plans/completed/crash-hardening-plan.md §5).
const errorReportSchema = z.object({
  scope: z.string().min(1).max(100),
  message: z.string().min(1).max(2_000),
  stack: z.string().max(4_000).optional(),
  componentStack: z.string().max(4_000).optional()
}).strict()

export interface RegisterIpcOptions {
  ipcMain: IpcMain
  api: StrataIpcApi
  renderer: WebContents
  allowedRendererUrls?: readonly string[]
  openExternal?: (url: string) => Promise<void>
}

export interface RegisteredIpc {
  publish(state: AppView): void
  dispose(): void
}

export function registerStrataIpc(options: RegisterIpcOptions): RegisteredIpc {
  const allowedRendererUrls = options.allowedRendererUrls ?? ['app://stratamd/']
  const openExternal = options.openExternal ?? openWithXdg
  const verify = process.env.STRATAMD_VIEW_VERIFY === '1'
  let lastSent: SyncedView | null = null
  let nextSeq = 0
  const record = (view: AppView): SyncedView => {
    nextSeq += 1
    lastSent = { seq: nextSeq, view }
    return lastSent
  }
  const handlers: Record<InvokeChannel, (...args: never[]) => unknown> = {
    [IPC.state]: async () => {
      // A publish during the await is at least as fresh as this view (every
      // engine mutation publishes synchronously), so never rewind lastSent.
      const before = nextSeq
      const view = await options.api.getState()
      return before === nextSeq ? record(view) : lastSent!
    },
    [IPC.openDocument]: (path?: string) => options.api.openDocument(path),
    [IPC.closeDocument]: (path: string, decision?: 'save' | 'discard' | 'cancel') => options.api.closeDocument(path, decision),
    [IPC.updateBuffer]: (path: string, content: string, origin: BufferOrigin) => options.api.updateBuffer(path, content, origin),
    [IPC.undo]: (path: string) => options.api.undo(path),
    [IPC.redo]: (path: string) => options.api.redo(path),
    [IPC.save]: (path: string) => options.api.save(path),
    [IPC.setSourceMode]: (path: string, source: boolean) => options.api.setSourceMode(path, source),
    [IPC.keepHunk]: (path: string, hunkId: string) => options.api.keepHunk(path, hunkId),
    [IPC.revertHunk]: (path: string, hunkId: string, confirmMixed?: boolean) => options.api.revertHunk(path, hunkId, confirmMixed),
    [IPC.markReviewed]: (path: string) => options.api.markReviewed(path),
    [IPC.saveRound]: (path: string, index: number) => options.api.saveRound(path, index),
    [IPC.addAnnotation]: (path: string, annotation: Parameters<StrataApi['addAnnotation']>[1]) => options.api.addAnnotation(path, annotation),
    [IPC.requoteAnnotation]: (path: string, annotationId: string, range: Parameters<StrataApi['requoteAnnotation']>[2]) => options.api.requoteAnnotation(path, annotationId, range),
    [IPC.reply]: (path: string, annotationId: string, text: string) => options.api.reply(path, annotationId, text),
    [IPC.resolveAnnotation]: (path: string, annotationId: string) => options.api.resolveAnnotation(path, annotationId),
    [IPC.acceptSuggestion]: (path: string, annotationId: string) => options.api.acceptSuggestion(path, annotationId),
    [IPC.rejectSuggestion]: (path: string, annotationId: string) => options.api.rejectSuggestion(path, annotationId),
    [IPC.acceptAllSuggestions]: (path: string, agentId: string) => options.api.acceptAllSuggestions(path, agentId),
    [IPC.rejectAllSuggestions]: (path: string, agentId: string) => options.api.rejectAllSuggestions(path, agentId),
    [IPC.clearResolvedAnnotations]: (path: string) => options.api.clearResolvedAnnotations(path),
    [IPC.resolveRecovery]: (path: string, decision: 'recover' | 'discard') => options.api.resolveRecovery(path, decision),
    [IPC.resolveConflict]: (path: string, conflictId: string, decision: 'mine' | 'incoming') => options.api.resolveConflict(path, conflictId, decision),
    [IPC.previewSend]: (path: string, request: Parameters<StrataApi['previewSend']>[1]) => options.api.previewSend(path, request),
    [IPC.send]: (path: string, request: Parameters<StrataApi['send']>[1]) => options.api.send(path, request),
    [IPC.copyForAgent]: (path: string, note: string, includeExternal: boolean) => options.api.copyForAgent(path, note, includeExternal),
    [IPC.copyText]: (text: string) => options.api.copyText(text),
    [IPC.nudge]: (path: string, agentId: string) => options.api.nudge(path, agentId),
    [IPC.setLead]: (path: string, agentId: string | null) => options.api.setLead(path, agentId),
    [IPC.disconnectAgent]: (path: string, agentId: string) => options.api.disconnectAgent(path, agentId),
    [IPC.addFolder]: () => options.api.addFolder(),
    [IPC.scanFolder]: (path: string) => options.api.scanFolder(path),
    [IPC.refreshExplorer]: () => options.api.refreshExplorer(),
    [IPC.forgetDocument]: (path: string) => options.api.forgetDocument(path),
    [IPC.updateSettings]: (settings: Parameters<StrataApi['updateSettings']>[0]) => options.api.updateSettings(settings),
    [IPC.selectTheme]: (id: string) => options.api.selectTheme(id),
    [IPC.createTheme]: (name: string, fromId: string) => options.api.createTheme(name, fromId),
    [IPC.setThemeValue]: (key: string, value: string | number | null) => options.api.setThemeValue(key, value),
    [IPC.renameTheme]: (name: string) => options.api.renameTheme(name),
    [IPC.revertTheme]: (sparse: Record<string, unknown>) => options.api.revertTheme(sparse),
    [IPC.deleteTheme]: (id: string) => options.api.deleteTheme(id),
    [IPC.listFonts]: () => options.api.listFonts(),
    [IPC.openThemeSample]: () => options.api.openThemeSample(),
    [IPC.resolveLocalImage]: (documentPath: string, source: string) => options.api.resolveLocalImage(documentPath, source),
    [IPC.openExternal]: (url: string) => openExternal(url),
    [IPC.addDictionaryWord]: (word: string) => { options.renderer.session.addWordToSpellCheckerDictionary(word) }
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    options.ipcMain.handle(channel, async (event, ...untrustedArguments: unknown[]) => {
      assertTrustedSender(event, options.renderer, allowedRendererUrls)
      const parsed = argumentSchemas[channel].parse(untrustedArguments) as never[]
      return handlers[channel](...parsed)
    })
  }

  // Fire-and-forget failure reports (docs/plans/completed/crash-hardening-plan.md §7). A
  // malformed or untrusted report is dropped: reporting must not throw.
  const onReportError = (event: IpcMainEvent, report: unknown): void => {
    try {
      assertTrustedSender(event, options.renderer, allowedRendererUrls)
      logRendererReport(errorReportSchema.parse(report))
    } catch {
      // Dropped.
    }
  }
  options.ipcMain.on(IPC.reportError, onReportError)

  return {
    publish(state) {
      if (options.renderer.isDestroyed()) return
      const update = encodeViewUpdate(lastSent, nextSeq + 1, state, verify)
      record(state)
      options.renderer.send(IPC.stateChanged, update)
    },
    dispose() {
      for (const channel of Object.keys(handlers) as InvokeChannel[]) options.ipcMain.removeHandler(channel)
      options.ipcMain.removeListener(IPC.reportError, onReportError)
    }
  }
}

export function assertTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  renderer: WebContents,
  allowedRendererUrls: readonly string[]
): void {
  if (event.sender !== renderer) throw new Error('Rejected IPC from an unknown renderer')
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
  if (!allowedRendererUrls.some((prefix) => senderUrl.startsWith(prefix))) {
    throw new Error(`Rejected IPC from untrusted URL: ${senderUrl}`)
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

export async function openWithXdg(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) throw new Error('Only http, https, and mailto links can be opened externally')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
