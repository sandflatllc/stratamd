import { randomUUID } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { pathForDescriptor } from '../platform/descriptor-path'
import type {
  AgentIdentity,
  AnnotationView,
  AppSettingsView,
  ThemeView,
  AppView,
  AttachmentView,
  DocumentView,
  ExplorerFolderView,
  HunkView,
  RoundHunkView,
  SendChangeItem,
  SendDocumentToken,
  SendEventItem,
  SendItems,
  SendPreview,
  SendPreviewRequest,
  StrataApi,
  BufferOrigin
} from '../shared/contracts'
import {
  acceptAllSuggestions as acceptAllAnnotationSuggestions,
  acceptSuggestion as acceptAnnotationSuggestion,
  AnnotationAnchorError,
  annotationDeliverySlice,
  annotationStepChanges,
  redoAnnotationStep,
  undoAnnotationStep,
  type AnnotationStepChanges,
  clearResolvedAnnotations as clearResolvedAnnotationLog,
  closestAnnotationMatches,
  createAnnotation,
  createAnnotationLog,
  mapAnnotationsThroughEdit,
  nearestQuoteStart,
  pruneResolvedAnnotations,
  relocateAnnotation,
  rejectAllSuggestions as rejectAllAnnotationSuggestions,
  rejectSuggestion as rejectAnnotationSuggestion,
  replyToAnnotation,
  requoteAnnotation,
  resolveAnnotation as resolveAnnotationThread,
  isHunkVerdict,
  recordHunkVerdict,
  verdictQuote,
  type LogEvent,
  type AnnotationLog
} from '../core/annotations'
import {
  acknowledgeDelivery,
  acknowledgeClipboardWrite,
  attachmentDisplayState,
  collectOldest,
  createAttachment,
  createClipboardRecipient,
  createInitialPayload,
  deliveryStart,
  enqueueDelivery,
  expireIdleAttachments,
  finishAttachCall,
  freezeDelivery,
  freezeMessage,
  isMessageDelivery,
  noteAttachCall,
  prepareClipboardDelivery,
  type Attachment,
  type ClipboardRecipient,
  type DeliverySource,
  type IndexedSegment
} from '../core/delivery'
import { createPayload, type PayloadSegment } from '../core/payload'
import { computeHunks, contentHash, mapOldRangeToNew, rangesTouch, type TextRange } from '../core/diff'
import {
  acceptAgentReplacement,
  acceptUserReplacement,
  applyExternalChange,
  applyUserEdit,
  createDocumentState,
  discardOnClose,
  keepHunk as keepPendingHunk,
  markReviewed as reviewAll,
  markSendBoundary,
  persistPendingHunkAnchors,
  prepareSave,
  recordMirrorWrite,
  resolveExternalConflict,
  revertHunk as revertPendingHunk,
  restoreReviewFrame,
  reviewFrame,
  setExternalTag,
  type ExternalAttribution,
  type PendingHunkAnchor,
  type DocumentState,
  type ReviewFrame
} from '../core/state'
import { parseMarkdown } from '../core/markdown'
import { findMarkdownByIdentity, scanAndSeedExplorer, scanExplorer, type ExplorerScanResult } from './explorer'
import { readDiskState, readDocument, resolveAllowedLocalPath, resolveDocumentPath, saveDocumentWithHashCheck, seedGhostFromGit } from './files'
import { localImageUrl } from './protocols'
import { lineAt, stableValue } from './view-stability'
import { SessionRegistry } from './session'
import { DEFAULT_SETTINGS, SettingsStore, type Settings } from './settings'
import { BUILT_IN_THEME, listInstalledFonts, ThemeBrokenError, ThemeStore, type LoadedTheme, type ThemeSummary } from './themes'
import { readSparseValue, THEME_KEY_BY_NAME, THEME_SCHEMA_VERSION, writeSparseValue, normalizeThemeValue, type SparseTheme } from '../shared/theme-keys'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { THEME_SAMPLE_FILE_NAME, THEME_SAMPLE_MARKDOWN } from '../shared/theme-sample'
import { atomicWriteFile } from './storage'
import watcher, { type AsyncSubscription } from '@parcel/watcher'
import { CURRENT_META_VERSION, GhostStore, type AttachmentMeta, type DocumentLock, type DocumentMeta, type SaveAuthorMeta, type SaveMeta, type SegmentMeta } from './storage'
import { DebouncedMirror, HashReconciler, WatchCoordinator } from './watcher'
import { AttachWaitRegistry } from './socket'
import { CommandFailure, type CommandRequest, type SocketCommandHandler } from '../cli/protocol'
import { toDeliveredAnnotation } from '../core/annotations'

interface PersistedApplicationState {
  state: DocumentState
  annotations: AnnotationLog
  attachments: Record<string, Attachment>
  clipboardRecipient: ClipboardRecipient
  sourceMode: boolean
  lastSavedAt: number | null
  lastSentSegmentIndex: number
  lastSentAnnotationSeq: number
}

interface OpenDocumentSession {
  path: string
  diskHash: string | null
  state: DocumentState
  /** Absolute index represented by state.segments[0]. */
  segmentOffset: number
  annotations: AnnotationLog
  attachments: Record<string, Attachment>
  /** The at-most-one attachment holding the Lead (PRD §6.6); dies with it. */
  leadAgentId: string | null
  clipboardRecipient: ClipboardRecipient
  sourceMode: boolean
  sourceOnly: boolean
  readOnly: boolean
  invalidUtf8: boolean
  deleted: boolean
  lastSavedAt: number | null
  lastSentSegmentIndex: number
  lastSentAnnotationSeq: number
  /** Save history (PRD §6.7): one entry per Save that changed the document. */
  saves: SaveMeta[]
  /**
   * A Save awaiting its history entry. The entry is appended inside the next
   * #persist pass with the same clock read that stamps that pass's segments,
   * so strict greater-than against `threshold` splits adjacent rounds cleanly.
   */
  pendingSaveRecord: { beforeBlob: string; afterBlob: string; threshold: number } | null
  recovery?: { diskUpdatedAt: number; bufferUpdatedAt: number }
  reconciler?: HashReconciler
  watcher?: WatchCoordinator
  mirror?: DebouncedMirror
  lock?: DocumentLock
  documentHandle?: FileHandle
  identity?: { dev: bigint; ino: bigint }
  applicationUndo: ApplicationHistoryEntry[]
  applicationRedo: ApplicationHistoryEntry[]
  /** Object ids proven written this session; entries are added only after a successful write. */
  persistedBlobs: Set<string>
  /** Blob ids for this session's role contents (ghost, disk, shadow, mirror), keyed by content. */
  persistedContentBlobs: Map<string, string>
  /** Increases once per application step; published so the editor can order it against typing. */
  historyStep: number
  attachWaitVersions: Record<string, number>
}

/** The typed inverse of one application step: only what the step owns. */
interface ApplicationHistoryEntry {
  before: ReviewFrame
  after: ReviewFrame
  annotations: AnnotationStepChanges
}

export interface ApplicationOptions {
  store?: GhostStore
  settingsStore?: SettingsStore
  themeStore?: ThemeStore
  listFonts?: () => Promise<string[]>
  clipboardWrite?: (text: string) => Promise<void>
  selectFolder?: () => Promise<string | null>
  now?: () => number
  watch?: boolean
}

export class StrataApplication implements StrataApi {
  readonly #store: GhostStore
  readonly #settingsStore: SettingsStore
  readonly #themeStore: ThemeStore
  readonly #listFonts: () => Promise<string[]>
  #theme: LoadedTheme = BUILT_IN_THEME
  #themeMissing = false
  #themesAvailable: ThemeSummary[] = [{ id: BUILT_IN_THEME.id, name: BUILT_IN_THEME.name, builtIn: true, broken: false, problems: [] }]
  #themeExternalRevision = 0
  #themeWriteTimer: ReturnType<typeof setTimeout> | null = null
  #themeWriteQueue: Promise<void> = Promise.resolve()
  #themeLastWritten = ''
  #themeSubscription: AsyncSubscription | null = null
  #themeRelistTimer: ReturnType<typeof setTimeout> | null = null
  #fontsCache: string[] | null = null
  readonly #clipboardWrite: (text: string) => Promise<void>
  readonly #selectFolder: () => Promise<string | null>
  readonly #now: () => number
  readonly #watch: boolean
  readonly #sessions = new Map<string, OpenDocumentSession>()
  readonly #listeners = new Set<(state: AppView) => void>()
  readonly #tabs: SessionRegistry
  readonly #attachWaits = new AttachWaitRegistry<ReturnType<typeof createPayload>>()
  #settings: Settings = structuredClone(DEFAULT_SETTINGS)
  #explorer: ExplorerScanResult = { roots: [], files: [] }
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  #shutdown: Promise<void> | null = null
  #lastView: AppView | null = null

  constructor(options: ApplicationOptions = {}) {
    this.#store = options.store ?? new GhostStore()
    this.#settingsStore = options.settingsStore ?? new SettingsStore()
    this.#themeStore = options.themeStore ?? new ThemeStore({ configDirectory: this.#settingsStore.configDirectory })
    this.#listFonts = options.listFonts ?? listInstalledFonts
    this.#clipboardWrite = options.clipboardWrite ?? (async () => {
      throw new Error('Clipboard access is unavailable')
    })
    this.#selectFolder = options.selectFolder ?? (async () => null)
    this.#now = options.now ?? Date.now
    this.#watch = options.watch ?? true
    this.#tabs = new SessionRegistry({
      canonicalize: resolveDocumentPath,
      now: this.#now,
      onChange: () => this.#publish()
    })
  }

  async initialize(): Promise<this> {
    await this.#store.initialize()
    this.#settings = await this.#settingsStore.load()
    await this.#themeStore.ensureDirectory()
    await this.#loadActiveTheme(this.#settings.theme)
    await this.#relistThemes()
    if (this.#watch) await this.#watchThemes()
    await this.refreshExplorer()
    return this
  }

  // ---- Themes (PRD §6.13)

  get activeTheme(): LoadedTheme {
    return this.#theme
  }

  async #loadActiveTheme(id: string): Promise<void> {
    try {
      this.#theme = await this.#themeStore.load(id)
      this.#themeMissing = false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A missing theme at startup means the file went away between runs; fall back to built-in.
        this.#theme = BUILT_IN_THEME
        this.#themeMissing = id !== BUILT_IN_THEME.id
      } else if (error instanceof ThemeBrokenError) {
        this.#theme = { ...BUILT_IN_THEME, id, name: `${id}.json`, builtIn: false, path: this.#themeStore.pathFor(id), problems: [{ key: 'file', reason: error.detail }] }
        this.#themeMissing = false
      } else throw error
    }
  }

  async #relistThemes(): Promise<void> {
    this.#themesAvailable = await this.#themeStore.list()
  }

  async #watchThemes(): Promise<void> {
    this.#themeSubscription = await watcher.subscribe(this.#themeStore.directory, (error, events) => {
      if (error) return
      const activePath = this.#theme.path
      const activeTouched = activePath !== null && events.some((event) => event.path === activePath)
      if (this.#themeRelistTimer) clearTimeout(this.#themeRelistTimer)
      this.#themeRelistTimer = setTimeout(() => {
        this.#themeRelistTimer = null
        void this.#themesChangedOnDisk(activeTouched)
      }, 150)
    })
  }

  async #themesChangedOnDisk(activeTouched: boolean): Promise<void> {
    if (activeTouched && this.#theme.path) {
      let text: string | null = null
      try {
        text = await readFile(this.#theme.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (text === null) {
        this.#themeMissing = true
      } else if (text !== this.#themeLastWritten) {
        // Someone else wrote the active theme (an agent, an editor). Adopt it.
        try {
          this.#theme = await this.#themeStore.load(this.#theme.id)
          this.#themeMissing = false
          this.#themeLastWritten = text
          this.#themeExternalRevision += 1
        } catch (error) {
          if (!(error instanceof ThemeBrokenError)) throw error
          this.#theme = { ...this.#theme, problems: [{ key: 'file', reason: error.detail }] }
        }
      } else {
        this.#themeMissing = false
      }
    }
    await this.#relistThemes()
    this.#publish()
  }

  async selectTheme(id: string): Promise<void> {
    this.#flushThemeWrite()
    await this.#loadActiveTheme(id)
    if (this.#theme.path) {
      try {
        this.#themeLastWritten = await readFile(this.#theme.path, 'utf8')
      } catch {
        this.#themeLastWritten = ''
      }
    }
    this.#settings = await this.#settingsStore.update({ theme: this.#theme.id })
    await this.#relistThemes()
    this.#publish()
  }

  async createTheme(name: string, fromId: string): Promise<string> {
    this.#flushThemeWrite()
    const created = await this.#themeStore.create(name, fromId)
    await this.selectTheme(created.id)
    return created.id
  }

  async setThemeValue(key: string, value: string | number | null): Promise<void> {
    const entry = THEME_KEY_BY_NAME.get(key)
    if (!entry) throw new Error(`Unknown theme key ${key}`)
    if (this.#theme.builtIn) throw new Error('Themes that ship with StrataMD cannot be edited; use New from this to make a copy')
    if (value !== null && normalizeThemeValue(entry, value).problem) throw new Error(`Invalid value for ${key}`)
    this.#applySparse(writeSparseValue(this.#theme.sparse, key, value))
  }

  async renameTheme(name: string): Promise<void> {
    if (this.#theme.builtIn) throw new Error('The built-in theme cannot be renamed')
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A theme needs a name')
    this.#applySparse({ ...this.#theme.sparse, name: trimmed })
  }

  async revertTheme(sparse: Record<string, unknown>): Promise<void> {
    if (this.#theme.builtIn) throw new Error('The built-in theme cannot be edited')
    this.#applySparse(sparse)
  }

  /** Fast path: publish from memory now, write the file shortly after. */
  #applySparse(edited: SparseTheme): void {
    // Stamped here too, so the in-memory sparse matches what write() puts on disk
    // and the file watcher recognizes our own write.
    const sparse: SparseTheme = { 'schema-version': THEME_SCHEMA_VERSION, ...edited }
    const normalized = this.#themeStore.normalize(this.#theme.id, sparse)
    this.#theme = { ...normalized, path: this.#themeStore.pathFor(this.#theme.id) }
    this.#themeMissing = false
    this.#publish()
    if (this.#themeWriteTimer) clearTimeout(this.#themeWriteTimer)
    this.#themeWriteTimer = setTimeout(() => this.#flushThemeWrite(), 150)
  }

  #flushThemeWrite(): void {
    if (!this.#themeWriteTimer) return
    clearTimeout(this.#themeWriteTimer)
    this.#themeWriteTimer = null
    const { id, sparse } = this.#theme
    const text = `${JSON.stringify(sparse, null, 2)}\n`
    this.#themeLastWritten = text
    this.#themeWriteQueue = this.#themeWriteQueue
      .then(() => this.#themeStore.write(id, sparse))
      .then(() => this.#relistThemes())
      .then(() => this.#publish(), () => undefined)
  }

  /** Test hook: resolves once pending theme writes have reached disk. */
  async flushThemeWrites(): Promise<void> {
    this.#flushThemeWrite()
    await this.#themeWriteQueue
  }

  /** Deleting the active theme first falls back to the built-in, so the file is never in use when it goes. */
  async deleteTheme(id: string): Promise<void> {
    if (id === this.#theme.id) await this.selectTheme(BUILT_IN_THEME.id)
    await this.#themeStore.delete(id, this.#theme.id)
    await this.#relistThemes()
    this.#publish()
  }

  /** The sample lives beside settings.json; rewritten only when its text differs, so an unchanged file never shows as an edit. */
  get themeSamplePath(): string {
    return join(this.#settingsStore.configDirectory, THEME_SAMPLE_FILE_NAME)
  }

  async openThemeSample(): Promise<void> {
    const path = this.themeSamplePath
    let current: string | null = null
    try {
      current = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (current !== THEME_SAMPLE_MARKDOWN) await atomicWriteFile(path, THEME_SAMPLE_MARKDOWN)
    await this.openDocument(path)
  }

  async listFonts(): Promise<string[]> {
    this.#fontsCache ??= await this.#listFonts()
    return this.#fontsCache
  }

  #themeView(): ThemeView {
    return {
      active: {
        id: this.#theme.id,
        name: this.#theme.name,
        builtIn: this.#theme.builtIn,
        missing: this.#themeMissing,
        path: this.#theme.path,
        sparse: structuredClone(this.#theme.sparse) as Record<string, unknown>,
        values: { ...this.#theme.values },
        problems: [...this.#theme.problems]
      },
      available: this.#themesAvailable.map((summary) => ({ ...summary, problems: [...summary.problems], missing: summary.id === this.#theme.id && this.#themeMissing })),
      externalRevision: this.#themeExternalRevision
    }
  }

  async getState(): Promise<AppView> {
    return this.#view()
  }

  subscribe(listener: (state: AppView) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= this.#shutdownOnce()
    return this.#shutdown
  }

  async #shutdownOnce(): Promise<void> {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
    if (this.#themeRelistTimer) clearTimeout(this.#themeRelistTimer)
    this.#themeRelistTimer = null
    this.#flushThemeWrite()
    await this.#themeWriteQueue
    await this.#themeSubscription?.unsubscribe()
    this.#themeSubscription = null
    this.#attachWaits.rejectAll(new Error('StrataMD is shutting down'))
    const sessions = [...this.#sessions.values()]
    this.#listeners.clear()
    const results = await Promise.allSettled(sessions.map(async (session) => {
      session.mirror?.cancel()
      await releaseSessionResources(session)
      this.#sessions.delete(session.path)
      this.#tabs.close(session.path)
    }))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  async openDocument(path?: string): Promise<void> {
    if (!path) {
      if (this.#tabs.focusedPath) this.#tabs.focus(this.#tabs.focusedPath)
      return
    }
    const canonical = await resolveDocumentPath(path)
    if (this.#sessions.has(canonical)) {
      this.#tabs.focus(canonical)
      await this.#sessions.get(canonical)?.reconciler?.wake('focus')
      return
    }

    const disk = await readDocument(canonical)
    const bufferPath = this.#store.pathsForDocument(canonical).buffer
    if (!disk.validUtf8) {
      const tracked = await openTrackedDocument(canonical)
      const state = createDocumentState(disk.bytes.toString('utf8'), disk.bytes.toString('utf8'))
      this.#sessions.set(canonical, {
        path: canonical,
        diskHash: disk.hash,
        state,
        segmentOffset: 0,
        annotations: createAnnotationLog(),
        attachments: {},
        leadAgentId: null,
        clipboardRecipient: createClipboardRecipient(),
        sourceMode: true,
        sourceOnly: true,
        readOnly: true,
        invalidUtf8: true,
        deleted: false,
        lastSavedAt: null,
        lastSentSegmentIndex: -1,
        lastSentAnnotationSeq: 0,
        saves: [],
        pendingSaveRecord: null,
        applicationUndo: [],
        applicationRedo: [],
        persistedBlobs: new Set(),
        persistedContentBlobs: new Map(),
        historyStep: 0,
        attachWaitVersions: {},
        documentHandle: tracked.handle,
        identity: tracked.identity,
      })
      await this.#tabs.open(canonical)
      return
    }

    let meta: DocumentMeta
    if (await this.#store.hasDocument(canonical)) {
      meta = await this.#store.consumeReseedMarker(await this.#store.loadMeta(canonical), disk.bytes)
    } else {
      meta = await this.#store.createDocument(canonical, disk.bytes)
    }
    const saved = persistedApplication(meta)
    const ghost = await this.#store.getObjectText(meta.ghostBlob)
    const buffer = await this.#store.readBuffer(canonical)
    const bufferText = buffer?.toString('utf8')
    const bufferStat = buffer ? await stat(bufferPath) : null
    const diskStat = await stat(canonical, { bigint: true })
    const lastSavedAt = persistedNumber(meta.lastSavedAt) ?? saved?.lastSavedAt ?? null
    const recovery = bufferText !== undefined
      && bufferText !== disk.text
      && bufferStat !== null
      && bufferStat.mtimeMs > Number(diskStat.mtimeMs)
      && (lastSavedAt === null || bufferStat.mtimeMs > lastSavedAt)
      ? { diskUpdatedAt: Number(diskStat.mtimeMs), bufferUpdatedAt: bufferStat.mtimeMs }
      : undefined
    const shadow = recovery ? (bufferText ?? disk.text) : disk.text
    const mirror = recovery ? (bufferText ?? disk.text) : disk.text
    const state = await restoreDocumentState(
      this.#store,
      meta,
      saved?.state,
      disk.text,
      ghost,
      shadow,
      mirror,
    )
    const annotations = restoredAnnotationLog(meta)
    // The expiry filter runs before the Lead is restored, so a holder that aged
    // past the idle timeout while the app was closed comes back with no Lead.
    const attachments = { ...expireIdleAttachments(
      restoreAttachments(meta, saved?.attachments),
      this.#now(),
      this.#settings.attachmentIdleTimeoutMs
    ) }
    const session: OpenDocumentSession = {
      path: canonical,
      diskHash: disk.hash,
      state,
      segmentOffset: meta.segmentOffset,
      annotations: relocateOpenAnnotations(annotations, state.shadow),
      attachments,
      leadAgentId: typeof meta.leadAgentId === 'string' && attachments[meta.leadAgentId] !== undefined
        ? meta.leadAgentId
        : null,
      clipboardRecipient: restoreClipboardRecipient(meta.clipboardRecipient, saved?.clipboardRecipient),
      sourceMode: persistedBoolean(meta.sourceMode) ?? saved?.sourceMode ?? false,
      sourceOnly: false,
      readOnly: false,
      invalidUtf8: false,
      deleted: false,
      lastSavedAt,
      lastSentSegmentIndex: persistedNumber(meta.lastSentSegmentIndex) ?? saved?.lastSentSegmentIndex ?? -1,
      lastSentAnnotationSeq: persistedNumber(meta.lastSentAnnotationSeq) ?? saved?.lastSentAnnotationSeq ?? 0,
      saves: meta.saves.map((save) => ({ ...save, authors: save.authors.map((author) => ({ ...author })) })),
      pendingSaveRecord: null,
      ...(recovery ? { recovery } : {}),
      applicationUndo: [],
      applicationRedo: [],
      persistedBlobs: new Set(),
      persistedContentBlobs: new Map(),
      historyStep: 0,
      attachWaitVersions: {}
    }
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    const tracked = await openTrackedDocument(canonical)
    session.documentHandle = tracked.handle
    session.identity = tracked.identity
    try {
      session.lock = await this.#store.acquireLock(canonical)
    } catch (error) {
      await tracked.handle.close()
      throw error
    }
    this.#sessions.set(canonical, session)
    await this.#tabs.open(canonical)

    if (!buffer || (!recovery && bufferText !== disk.text)) {
      await this.#store.writeBuffer(canonical, state.shadow)
    }
    this.#installMirrorAndWatcher(session)
    await session.reconciler?.initialize('open')
    await this.#persist(session)
    this.#scheduleIdleExpiry()
    this.#publish()
  }

  async closeDocument(path: string, decision?: 'save' | 'discard' | 'cancel'): Promise<'closed' | 'needs-decision' | 'cancelled'> {
    const session = this.#require(path)
    if (session.state.shadow !== session.state.disk && !decision) return 'needs-decision'
    if (decision === 'cancel') return 'cancelled'
    if (decision === 'save') await this.save(path)
    if (decision === 'discard') {
      await session.mirror?.flush()
      this.#clearApplicationHistory(session)
      session.state = discardOnClose(session.state)
      session.mirror?.cancel()
      await this.#store.writeBuffer(path, session.state.disk)
      await this.#persist(session)
    }
    if (Object.keys(session.attachments).length > 0) {
      await this.#enqueueDeliveries(
        session,
        { recipients: Object.keys(session.attachments), note: '', includeExternal: false },
        Object.keys(session.attachments),
        'closed'
      )
      for (const [agent, attachment] of Object.entries(session.attachments)) {
        const delivery = collectOldest(attachment)
        if (delivery) this.#attachWaits.deliver(attachKey(path, agent), delivery.payload)
      }
      await this.#persist(session)
    }
    session.mirror?.cancel()
    await releaseSessionResources(session)
    this.#sessions.delete(path)
    this.#tabs.close(path)
    this.#scheduleIdleExpiry()
    return 'closed'
  }

  async updateBuffer(path: string, content: string, origin: BufferOrigin = 'edit'): Promise<void> {
    const session = this.#writable(path)
    if (content === session.state.shadow) return
    if (origin === 'edit') session.applicationRedo = []
    for (const hunk of computeHunks(session.state.shadow, content).sort((a, b) => b.before.from - a.before.from)) {
      session.state = applyUserEdit(session.state, { ...hunk.before, insert: hunk.added })
      session.annotations = mapAnnotationsThroughEdit(session.annotations, {
        start: hunk.before.from,
        deleteCount: hunk.before.to - hunk.before.from,
        insertText: hunk.added
      })
    }
    for (const annotation of Object.values(session.annotations.annotations)) {
      if (annotation.status !== 'resolved') session.annotations = relocateAnnotation(session.annotations, annotation.id, session.state.shadow).log
    }
    session.mirror?.schedule(session.state.shadow)
    await this.#persist(session)
    this.#scheduleIdleExpiry()
    this.#publish()
  }

  async undo(path: string): Promise<'undone' | 'empty'> {
    const session = this.#writable(path)
    const entry = session.applicationUndo.pop()
    if (!entry) return 'empty'
    this.#restoreApplicationStep(session, entry.before, undoAnnotationStep(session.annotations, entry.annotations))
    session.applicationRedo.push(entry)
    await this.#changed(session)
    return 'undone'
  }

  async redo(path: string): Promise<'redone' | 'empty'> {
    const session = this.#writable(path)
    const entry = session.applicationRedo.pop()
    if (!entry) return 'empty'
    this.#restoreApplicationStep(session, entry.after, redoAnnotationStep(session.annotations, entry.annotations))
    session.applicationUndo.push(entry)
    await this.#changed(session)
    return 'redone'
  }

  async save(path: string): Promise<void> {
    const session = this.#writable(path)
    await session.reconciler?.wake('before-save')
    if (session.state.conflicts.length > 0) throw new Error('Resolve external changes before saving')
    const cancelOwnedWrite = session.reconciler?.noteOwnedWrite('document', session.state.shadow)
    const result = await saveDocumentWithHashCheck(
      path,
      session.state.shadow,
      session.deleted ? null : session.diskHash,
    ).catch((error: unknown) => {
      cancelOwnedWrite?.()
      throw error
    })
    if (result.status === 'conflict') {
      cancelOwnedWrite?.()
      if (!('missing' in result.disk) && result.disk.validUtf8) {
        session.diskHash = result.disk.hash
        const diskText = result.disk.text
        await this.#applyApplicationStep(session, () => {
          session.state = applyExternalChange(session.state, 'disk', diskText, {
            blockRanges: markdownBlockRanges(session.state.disk),
          }).state
        })
        await this.#persist(session)
        this.#publish()
      }
      throw new Error('The document changed on disk. Resolve the incoming change before saving.')
    }
    const prepared = prepareSave(session.state, session.state.disk)
    if (prepared.status !== 'saved') throw new Error('The document changed on disk')
    // Record the round before the state flips: the content this save replaced,
    // the content it wrote, and the previous save's time as the round threshold
    // (falling back to lastSavedAt on stores whose history predates the format).
    // A save that changed nothing records nothing (PRD §6.7).
    if (session.state.disk !== prepared.content) {
      const beforeBlob = await this.#persistContent(session, session.state.disk)
      session.pendingSaveRecord = {
        beforeBlob,
        afterBlob: contentHash(prepared.content),
        threshold: session.saves.at(-1)?.time ?? session.lastSavedAt ?? Number.NEGATIVE_INFINITY,
      }
    }
    session.state = prepared.state
    this.#clearApplicationHistory(session)
    session.diskHash = result.disk.hash
    session.deleted = false
    await this.#replaceDocumentHandle(session, path)
    session.lastSavedAt = (await stat(path)).mtimeMs
    session.mirror?.schedule(session.state.shadow)
    await session.mirror?.flush()
    await this.#persist(session)
    this.#publish()
  }

  /** The hunks of one past save round, read-only, from the entry's own snapshots (PRD §6.7). */
  async saveRound(path: string, index: number): Promise<{ hunks: RoundHunkView[] }> {
    const session = this.#require(path)
    const save = session.saves[index]
    if (save === undefined) throw new Error('No such save')
    const before = await this.#store.getObjectText(save.beforeBlob)
    const after = await this.#store.getObjectText(save.afterBlob)
    return {
      hunks: computeHunks(before, after).map((hunk) => ({
        oldStart: hunk.oldStartLine,
        oldLines: hunk.removedLines,
        newStart: hunk.newStartLine,
        newLines: hunk.addedLines,
        removed: splitLines(hunk.removed),
        added: splitLines(hunk.added),
      })),
    }
  }

  async setSourceMode(path: string, source: boolean): Promise<void> {
    const session = this.#require(path)
    session.sourceMode = session.sourceOnly || source
    await this.#persist(session)
    this.#publish()
  }

  async keepHunk(path: string, hunkId: string): Promise<void> {
    const session = this.#writable(path)
    await this.#applyApplicationStep(session, () => {
      this.#recordVerdict(session, hunkId, 'hunk-kept')
      session.state = keepPendingHunk(session.state, hunkId)
    })
    await this.#changed(session)
  }

  async revertHunk(path: string, hunkId: string, confirmMixed = false): Promise<void> {
    const session = this.#writable(path)
    await this.#applyApplicationStep(session, () => {
      const result = revertPendingHunk(session.state, hunkId, confirmMixed)
      if (result.status === 'confirmation-required') throw new Error('Reverting this mixed hunk requires confirmation')
      this.#recordVerdict(session, hunkId, 'hunk-reverted')
      session.state = result.state
    })
    await this.#changed(session)
  }

  async markReviewed(path: string): Promise<void> {
    const session = this.#writable(path)
    await this.#applyApplicationStep(session, () => {
      for (const hunk of session.state.pendingHunks) this.#recordVerdict(session, hunk.id, 'hunk-kept')
      session.state = reviewAll(session.state)
    })
    await this.#changed(session)
  }

  /** The author of a kept or reverted hunk learns the verdict as an event, never as its own text diffed back (PRD §6.3). */
  #recordVerdict(session: OpenDocumentSession, hunkId: string, type: 'hunk-kept' | 'hunk-reverted'): void {
    const hunk = session.state.pendingHunks.find((candidate) => candidate.id === hunkId)
    if (hunk?.author.agentId == null) return
    const added = session.state.shadow.slice(hunk.shadow.from, hunk.shadow.to)
    const removed = session.state.ghost.slice(hunk.ghost.from, hunk.ghost.to)
    session.annotations = recordHunkVerdict(session.annotations, type, hunk.author.agentId, verdictQuote(removed, added))
  }

  async addAnnotation(path: string, annotation: { kind: 'comment' | 'question' | 'suggestion'; quote: string; text: string; from: number; to: number }): Promise<void> {
    const session = this.#writable(path)
    const start = this.#anchorQuote(session, annotation)
    session.annotations = createAnnotation(session.annotations, session.state.shadow, {
      id: `a_${randomUUID().slice(0, 12)}`,
      kind: annotation.kind,
      author: 'user',
      quote: annotation.quote,
      text: annotation.text,
      start
    }).log
    session.applicationRedo = []
    await this.#persist(session)
    this.#publish()
  }

  /**
   * The renderer captures quote offsets when the selection is made; an edit
   * landing before Submit (an agent writing while the composer is open) moves
   * the text out from under them. The quote is the text the user chose, so a
   * stale offset re-anchors to its nearest occurrence instead of failing.
   */
  #anchorQuote(session: OpenDocumentSession, range: { quote: string; from: number; to: number }): number {
    if (session.state.shadow.slice(range.from, range.to) === range.quote) return range.from
    const relocated = nearestQuoteStart(session.state.shadow, range.quote, range.from)
    if (relocated === null) throw new Error('The selected quote no longer matches the buffer')
    return relocated
  }

  async requoteAnnotation(path: string, annotationId: string, range: { quote: string; from: number; to: number }): Promise<void> {
    const session = this.#writable(path)
    const start = this.#anchorQuote(session, range)
    const applied = await this.#applyApplicationStep(session, () => {
      const result = requoteAnnotation(session.annotations, session.state.shadow, annotationId, { quote: range.quote, start })
      if (result.log === session.annotations) return false
      session.annotations = result.log
      return true
    })
    if (!applied) return
    await this.#persist(session)
    this.#publish()
  }

  async reply(path: string, annotationId: string, text: string): Promise<void> {
    const session = this.#writable(path)
    session.annotations = replyToAnnotation(session.annotations, annotationId, {
      id: `r_${randomUUID().slice(0, 12)}`,
      author: 'user',
      text
    }).log
    session.applicationRedo = []
    await this.#persist(session)
    this.#publish()
  }

  async resolveAnnotation(path: string, annotationId: string): Promise<void> {
    const session = this.#writable(path)
    session.annotations = resolveAnnotationThread(session.annotations, annotationId).log
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    session.applicationRedo = []
    await this.#persist(session)
    this.#publish()
  }

  async acceptSuggestion(path: string, annotationId: string): Promise<void> {
    const session = this.#writable(path)
    await this.#applyApplicationStep(session, () => {
      const attribution = suggestionAttribution(session, annotationId)
      const result = acceptAnnotationSuggestion(session.annotations, session.state.shadow, annotationId)
      if (result.userChange) {
        session.state = acceptUserReplacement(session.state, {
          from: result.userChange.start,
          to: result.userChange.end,
          insert: result.userChange.added
        }, attribution)
        session.annotations = relocateOpenAnnotations(
          mapAnnotationsThroughEdit(result.log, {
            start: result.userChange.start,
            deleteCount: result.userChange.end - result.userChange.start,
            insertText: result.userChange.added
          }),
          session.state.shadow,
        )
      } else {
        session.annotations = result.log
      }
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    })
    await this.#changed(session)
  }

  async rejectSuggestion(path: string, annotationId: string): Promise<void> {
    const session = this.#writable(path)
    session.annotations = rejectAnnotationSuggestion(session.annotations, annotationId).log
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    session.applicationRedo = []
    await this.#persist(session)
    this.#publish()
  }

  async acceptAllSuggestions(path: string, agentId: string): Promise<{ accepted: string[]; skipped: string[] }> {
    const session = this.#writable(path)
    let outcome: { accepted: string[]; skipped: string[] } = { accepted: [], skipped: [] }
    await this.#applyApplicationStep(session, () => {
      const attribution: ExternalAttribution = { agentId, name: session.attachments[agentId]?.name ?? agentId }
      const result = acceptAllAnnotationSuggestions(session.annotations, session.state.shadow, agentId)
      for (const change of result.changes) {
        session.state = acceptUserReplacement(session.state, {
          from: change.start,
          to: change.end,
          insert: change.added
        }, attribution)
      }
      session.annotations = relocateOpenAnnotations(result.log, session.state.shadow)
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      outcome = { accepted: [...result.accepted], skipped: [...result.skipped] }
      return result.changes.length > 0
    })
    await this.#changed(session)
    return outcome
  }

  async rejectAllSuggestions(path: string, agentId: string): Promise<string[]> {
    const session = this.#writable(path)
    const result = rejectAllAnnotationSuggestions(session.annotations, agentId)
    session.annotations = result.log
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    session.applicationRedo = []
    await this.#persist(session)
    this.#publish()
    return [...result.rejected]
  }

  async clearResolvedAnnotations(path: string): Promise<void> {
    const session = this.#writable(path)
    session.annotations = clearResolvedAnnotationLog(session.annotations)
    session.applicationRedo = []
    await this.#persist(session)
    this.#publish()
  }

  async resolveRecovery(path: string, decision: 'recover' | 'discard'): Promise<void> {
    const session = this.#require(path)
    if (session.readOnly) throw new Error('This document is read-only')
    if (!session.recovery) return
    this.#clearApplicationHistory(session)
    if (decision === 'recover') {
      const buffer = await this.#store.readBuffer(path)
      if (buffer) {
        const meta = await this.#store.loadMeta(path)
        session.state = await restoreDocumentState(
          this.#store,
          meta,
          persistedApplication(meta)?.state,
          session.state.disk,
          session.state.ghost,
          buffer.toString('utf8'),
          buffer.toString('utf8'),
        )
      }
    } else {
      await this.#store.writeBuffer(path, session.state.disk)
      session.state = discardOnClose(session.state)
      session.reconciler?.noteOwnedWrite('buffer', session.state.disk)
    }
    session.annotations = relocateOpenAnnotations(session.annotations, session.state.shadow)
    delete session.recovery
    await this.#persist(session)
    this.#publish()
  }

  async resolveConflict(path: string, conflictId: string, decision: 'mine' | 'incoming'): Promise<void> {
    const session = this.#writable(path)
    await this.#applyApplicationStep(session, () => {
      session.state = resolveExternalConflict(session.state, conflictId, decision)
    })
    await this.#changed(session)
  }

  async previewSend(path: string, request: SendPreviewRequest): Promise<SendPreview[]> {
    const session = this.#require(path)
    const token = this.#documentToken(session)
    return Promise.all(request.recipients.map(async (id) => {
      const attachment = session.attachments[id]
      if (!attachment) throw new Error(`Attachment ${id} was not found`)
      const delivery = freezeDelivery(attachment, await this.#deliverySource(session, request, id))
      return {
        recipient: agentIdentity(id, attachment.name, Object.keys(session.attachments).indexOf(id)),
        text: delivery.payload.text,
        token,
        items: delivery.payload.event === 'resync' ? { changes: [], events: [] } : this.#sendItems(session, attachment),
        ...(delivery.payload.event === 'resync' ? { resync: true } : {}),
        ...(attachment.deliveries.at(-1) ? { queuedAfter: attachment.deliveries.at(-1)!.id } : {}),
        dependentExternalHunks: dependentExternalHunkCount(
          session.state,
          deliveryStart(attachment).segmentIndex,
          session.segmentOffset,
        )
      }
    }))
  }

  async send(path: string, request: SendPreviewRequest): Promise<string[]> {
    const session = this.#writable(path)
    if (request.recipients.length === 0) throw new Error('Select at least one recipient')
    await session.mirror?.flush()
    // A frozen delivery must equal the preview the user saw: an edit landing
    // between preview and click can add content never shown, and a segment
    // extension renumbers hunk keys under the captured exclusions.
    if (request.token !== undefined) {
      const current = this.#documentToken(session)
      if (current.snapshotId !== request.token.snapshotId
        || current.segmentIndex !== request.token.segmentIndex
        || current.cursor !== request.token.cursor) {
        throw new Error("The document changed. Check what you're sending again.")
      }
    }
    session.state = markSendBoundary(session.state)
    const deliveries = await this.#enqueueDeliveries(session, request, request.recipients)
    session.lastSentSegmentIndex = currentSegmentIndex(session)
    session.lastSentAnnotationSeq = session.annotations.nextSeq - 1
    this.#clearApplicationHistory(session)
    for (const id of request.recipients) {
      const delivery = collectOldest(session.attachments[id]!)
      if (delivery) this.#attachWaits.deliver(attachKey(path, id), delivery.payload)
    }
    await this.#persist(session)
    this.#scheduleIdleExpiry()
    this.#publish()
    return deliveries.map((delivery) => delivery.id)
  }

  async copyText(text: string): Promise<void> {
    await this.#clipboardWrite(text)
  }

  async copyForAgent(path: string, note: string, includeExternal: boolean): Promise<void> {
    const session = this.#require(path)
    await session.mirror?.flush()
    session.state = markSendBoundary(session.state)
    const prepared = prepareClipboardDelivery(
      session.clipboardRecipient,
      await this.#deliverySource(session, { recipients: [], note, includeExternal }, 'clipboard'),
    )
    session.clipboardRecipient = prepared.recipient
    await this.#persist(session)
    try {
      await this.#clipboardWrite(prepared.delivery.payload.text)
      session.clipboardRecipient = acknowledgeClipboardWrite(session.clipboardRecipient, prepared.delivery.id, true)
      session.lastSentSegmentIndex = currentSegmentIndex(session)
      session.lastSentAnnotationSeq = session.annotations.nextSeq - 1
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      this.#clearApplicationHistory(session)
    } catch (error) {
      session.clipboardRecipient = acknowledgeClipboardWrite(session.clipboardRecipient, prepared.delivery.id, false)
      throw error
    } finally {
      await this.#persist(session)
      this.#publish()
    }
  }

  async nudge(path: string, agentId: string): Promise<void> {
    const session = this.#require(path)
    if (!session.attachments[agentId]) throw new Error(`Attachment ${agentId} was not found`)
    await this.#clipboardWrite(`Run \`stratamd attach --as ${agentId}\` and continue.`)
  }

  async addFolder(): Promise<void> {
    const folder = await this.#selectFolder()
    if (!folder) return
    this.#settings = await this.#settingsStore.update({ explorerFolders: [...this.#settings.explorerFolders, folder] })
    await this.scanFolder(folder)
  }

  async scanFolder(path: string): Promise<void> {
    const folders = [...new Set([...this.#settings.explorerFolders, resolve(path)])]
    if (folders.length !== this.#settings.explorerFolders.length) this.#settings = await this.#settingsStore.update({ explorerFolders: folders })
    this.#explorer = await scanAndSeedExplorer(folders, this.#store)
    this.#publish()
  }

  async refreshExplorer(): Promise<void> {
    this.#explorer = await scanExplorer(this.#settings.explorerFolders, { knownDocuments: await this.#store.listDocuments() })
    this.#publish()
  }

  async forgetDocument(path: string): Promise<void> {
    if (this.#sessions.has(path)) throw new Error('Close the document before forgetting it')
    await this.#store.forgetDocument(path)
    // Forgetting runs the object-store garbage collector, so every session
    // re-proves its blobs on the next persist instead of trusting a cache.
    for (const session of this.#sessions.values()) {
      session.persistedBlobs = new Set()
      session.persistedContentBlobs = new Map()
    }
    await this.refreshExplorer()
  }

  async updateSettings(settings: Partial<Omit<AppSettingsView, 'theme'>>): Promise<void> {
    this.#settings = await this.#settingsStore.update({
      ...(settings.animatedBackground === undefined ? {} : { ambientMotion: settings.animatedBackground }),
      ...(settings.attachmentIdleHours === undefined ? {} : { attachmentIdleTimeoutMs: settings.attachmentIdleHours * 60 * 60 * 1_000 }),
      ...(settings.panelSizes === undefined ? {} : { panels: settings.panelSizes }),
      ...(settings.zoom === undefined ? {} : { zoom: settings.zoom })
    })
    this.#scheduleIdleExpiry()
    this.#publish()
  }

  async resolveLocalImage(documentPath: string, source: string): Promise<string | null> {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) return null
    const session = this.#require(documentPath)
    try {
      const safe = await resolveAllowedLocalPath(source, session.path, this.#settings.explorerFolders)
      return safe ? localImageUrl(safe) : null
    } catch {
      return null
    }
  }

  async recheckFocused(): Promise<void> {
    const path = this.#tabs.focusedPath
    if (path) await this.#sessions.get(path)?.reconciler?.wake('focus')
  }

  commandHandler(): SocketCommandHandler {
    return async (request, context) => {
      try {
        return await this.#handleCommand(request, context.signal)
      } catch (error) {
        if (error instanceof CommandFailure) throw error
        if (error instanceof AnnotationAnchorError) {
          throw new CommandFailure(error.message, 3, error.code.toUpperCase(), { matches: error.matches })
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CommandFailure('Document not found', 2, 'NOT_FOUND')
        }
        throw error
      }
    }
  }

  async #handleCommand(request: CommandRequest, signal: AbortSignal): Promise<unknown> {
    const args = request.args as Record<string, unknown>
    const requestedFile = typeof args.file === 'string'
      ? (this.#sessions.has(args.file) ? args.file : await resolveDocumentPath(args.file))
      : this.#tabs.focusedPath
    if ((request.command === 'attach' || request.command === 'state') && !requestedFile) {
      throw new CommandFailure('No document is focused', 2, 'DOCUMENT_NOT_FOUND')
    }
    if (request.command === 'open') {
      await this.openDocument((request.args as { file: string }).file)
      return { opened: await resolveDocumentPath((request.args as { file: string }).file) }
    }
    if (request.command === 'checkpoint') {
      const file = await resolveDocumentPath((request.args as { file: string }).file)
      const fileStat = await stat(file)
      if (fileStat.isDirectory()) {
        const result = await scanAndSeedExplorer([file], this.#store)
        return { checkpointed: result.seeded }
      }
      const disk = await readDocument(file)
      if (!disk.validUtf8) throw new CommandFailure('Invalid UTF-8 cannot be checkpointed', 1, 'INVALID_UTF8')
      const seed = await seedGhostFromGit(file, disk.bytes)
      const open = this.#sessions.get(file)
      if (open) {
        open.state = {
          ...open.state,
          ghost: seed.content.toString('utf8'),
          pendingHunks: [],
          conflicts: [],
        }
        await this.#persist(open)
        this.#publish()
      } else if (await this.#store.hasDocument(file)) {
        const existing = await this.#store.loadMeta(file)
        const ghostBlob = await this.#store.putObject(seed.content)
        await this.#store.saveMeta({ ...existing, ghostBlob, pendingHunks: [] })
      } else {
        await this.#store.createDocument(file, seed.content)
      }
      return { checkpointed: file }
    }
    if (request.command === 'forget') {
      await this.forgetDocument((request.args as { file: string }).file)
      return { forgotten: true }
    }
    const file = requestedFile!
    if (request.command === 'state' && !this.#sessions.has(file)) {
      return this.#closedStatePayload(file)
    }
    if (!this.#sessions.has(file)) await this.openDocument(file)
    const session = this.#require(file)

    switch (request.command) {
      case 'attach': {
        const attach = request.args
        let attachment = session.attachments[attach.agent]
        if (!attachment) {
          const snapshot = deliverySnapshot(session)
          attachment = createAttachment({ id: attach.agent, name: attach.name, now: this.#now(), snapshot })
          session.attachments[attach.agent] = attachment
          await this.#persist(session)
          this.#scheduleIdleExpiry()
          this.#publish()
          return createInitialPayload(
            attachment,
            file,
            this.#store.pathsForDocument(file).buffer,
            snapshot,
            Object.values(session.annotations.annotations).map(toDeliveredAnnotation)
          )
        }
        attachment = noteAttachCall(attachment, this.#now())
        session.attachments[attach.agent] = attachment
        const queued = collectOldest(attachment)
        if (queued) {
          session.attachments[attach.agent] = finishAttachCall(attachment, this.#now())
          await this.#persist(session)
          this.#scheduleIdleExpiry()
          this.#publish()
          return queued.payload
        }
        const waitVersion = (session.attachWaitVersions[attach.agent] ?? 0) + 1
        session.attachWaitVersions[attach.agent] = waitVersion
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        try {
          const result = await this.#attachWaits.wait(attachKey(file, attach.agent), attach.timeout * 1_000, signal)
          if (result.event === 'delivery') return result.value
          return createPayload({
            file,
            buffer: this.#store.pathsForDocument(file).buffer,
            agent: attach.agent,
            event: result.event
          })
        } finally {
          if (session.attachWaitVersions[attach.agent] === waitVersion) {
            const current = session.attachments[attach.agent]
            if (current) session.attachments[attach.agent] = finishAttachCall(current, this.#now())
            await this.#persist(session)
            this.#scheduleIdleExpiry()
            this.#publish()
          }
        }
      }
      case 'ack': {
        const ack = request.args
        const attachment = session.attachments[ack.agent]
        if (!attachment) throw new CommandFailure('Attachment not found', 2, 'ATTACHMENT_NOT_FOUND')
        const result = acknowledgeDelivery(attachment, ack.deliveryId)
        session.attachments[ack.agent] = result.attachment
        session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { acknowledged: result.acknowledged }
      }
      case 'detach': {
        if (!session.attachments[request.args.agent]) {
          throw new CommandFailure('Attachment not found', 2, 'ATTACHMENT_NOT_FOUND')
        }
        this.#removeAttachment(session, request.args.agent)
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { detached: true }
      }
      case 'state': {
        const snapshot = deliverySnapshot(session)
        return {
          ...withoutAgent(createPayload({
            file,
            buffer: this.#store.pathsForDocument(file).buffer,
            agent: 'state',
            event: 'state',
            cursor: snapshot.cursor,
            document: snapshot.document,
            annotations: Object.values(session.annotations.annotations).map(toDeliveredAnnotation),
            attachments: Object.entries(session.attachments).map(([id, attachment]) => ({
              agent: id,
              name: attachment.name,
              state: attachmentDisplayState(attachment),
              lead: id === session.leadAgentId
            }))
          })),
          theme: { id: this.#theme.id, name: this.#theme.name, path: this.#theme.path }
        }
      }
      case 'changes':
        return withoutAgent(createPayload({
          file,
          buffer: this.#store.pathsForDocument(file).buffer,
          agent: 'changes',
          event: 'changes',
          segments: currentUnreviewedSegments(session.state)
        }, { currentDocument: session.state.shadow }))
      case 'changed':
        session.state = setExternalTag(session.state, request.args.agent, request.args.name, this.#now())
        await this.#persist(session)
        return { tagged: true }
      case 'annotate': {
        let next = session.annotations
        const failures: Array<{ index: number; quote: string; code: string; matches: readonly string[] }> = []
        for (const [index, annotation] of request.args.annotations.entries()) {
          try {
            next = createAnnotation(next, session.state.shadow, {
              id: `a_${randomUUID().slice(0, 12)}`,
              kind: annotation.kind,
              author: 'agent',
              agent: request.args.agent,
              quote: annotation.quote,
              text: annotation.text ?? '',
              ...(annotation.label ? { label: annotation.label } : {}),
              ...(annotation.precededBy ? { precededBy: annotation.precededBy } : {}),
              ...(annotation.followedBy ? { followedBy: annotation.followedBy } : {})
            }).log
          } catch (error) {
            if (!(error instanceof AnnotationAnchorError)) throw error
            failures.push({
              index,
              quote: annotation.quote,
              code: error.code,
              matches: closestAnnotationMatches(session.state.shadow, annotation.quote, error.matches),
            })
          }
        }
        if (failures.length > 0) {
          throw new CommandFailure('One or more annotation quotes are invalid', 3, 'QUOTE_INVALID', failures)
        }
        session.annotations = next
        await this.#persist(session)
        this.#publish()
        return { created: request.args.annotations.length }
      }
      case 'reply':
        if (!session.annotations.annotations[request.args.annotation]) {
          throw new CommandFailure('Annotation not found', 2, 'ANNOTATION_NOT_FOUND')
        }
        session.annotations = replyToAnnotation(session.annotations, request.args.annotation, {
          id: `r_${randomUUID().slice(0, 12)}`,
          author: 'agent',
          agent: request.args.agent,
          text: request.args.text
        }).log
        await this.#persist(session)
        this.#publish()
        return { replied: true }
      case 'send': {
        const message = request.args
        const sender = session.attachments[message.agent]
        if (!sender) throw new CommandFailure('Sender is not attached', 2, 'ATTACHMENT_NOT_FOUND')
        const requested = message.to ?? Object.keys(session.attachments).filter((id) => id !== message.agent)
        if (requested.includes(message.agent)) {
          throw new CommandFailure('A message cannot name its sender as a recipient', 2, 'SELF_RECIPIENT')
        }
        if (requested.length === 0) {
          throw new CommandFailure('No other agents are attached', 2, 'NO_RECIPIENTS')
        }
        const recipients = [...new Set(requested)]
        const missing = recipients.filter((id) => session.attachments[id] === undefined)
        if (missing.length > 0) {
          throw new CommandFailure('Recipient is not attached', 2, 'ATTACHMENT_NOT_FOUND', { recipients: missing })
        }
        // All-or-nothing: every sender→recipient slot is checked before anything
        // is enqueued, so a failed send never double-delivers on retry.
        const blocked = recipients.find((id) => session.attachments[id]!.deliveries.some(
          (delivery) => isMessageDelivery(delivery) && delivery.payload.from?.agent === message.agent,
        ))
        if (blocked !== undefined) {
          throw new CommandFailure(
            'An earlier message to this recipient has not been collected yet',
            3,
            'MESSAGE_PENDING',
            { recipient: blocked },
          )
        }
        const senderTag = { agent: message.agent, name: sender.name }
        const sent = recipients.map((id) => {
          const attachment = session.attachments[id]!
          session.attachments[id] = enqueueDelivery(attachment, freezeMessage(attachment, {
            file,
            buffer: this.#store.pathsForDocument(file).buffer,
            sender: senderTag,
            note: message.text,
            now: this.#now()
          }))
          return { agent: id, name: attachment.name }
        })
        for (const { agent } of sent) {
          const delivery = collectOldest(session.attachments[agent]!)
          if (delivery) this.#attachWaits.deliver(attachKey(file, agent), delivery.payload)
        }
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { sent }
      }
      case 'lead': {
        const claim = request.args
        if (!session.attachments[claim.agent]) {
          throw new CommandFailure('Attachment not found', 2, 'ATTACHMENT_NOT_FOUND')
        }
        if (session.leadAgentId !== null && session.leadAgentId !== claim.agent) {
          throw new CommandFailure('Another agent already holds the Lead', 3, 'LEAD_TAKEN', {
            holder: {
              agent: session.leadAgentId,
              name: session.attachments[session.leadAgentId]?.name ?? session.leadAgentId
            }
          })
        }
        session.leadAgentId = claim.agent
        await this.#persist(session)
        this.#publish()
        return { lead: claim.agent }
      }
      case 'accept': {
        const action = request.args
        this.#requireLead(session, action.agent)
        if (!session.annotations.annotations[action.annotation]) {
          throw new CommandFailure('Annotation not found', 2, 'ANNOTATION_NOT_FOUND')
        }
        await this.#acceptSuggestionAsLead(session, action.annotation, action.agent)
        return { accepted: action.annotation }
      }
      case 'reject': {
        const action = request.args
        this.#requireLead(session, action.agent)
        if (!session.annotations.annotations[action.annotation]) {
          throw new CommandFailure('Annotation not found', 2, 'ANNOTATION_NOT_FOUND')
        }
        session.annotations = rejectAnnotationSuggestion(
          session.annotations,
          action.annotation,
          'agent',
          action.agent,
        ).log
        session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
        await this.#persist(session)
        this.#publish()
        return { rejected: action.annotation }
      }
      case 'resolve': {
        const action = request.args
        if (!session.attachments[action.agent]) {
          throw new CommandFailure('Attachment not found', 2, 'ATTACHMENT_NOT_FOUND')
        }
        const record = session.annotations.annotations[action.annotation]
        if (!record) throw new CommandFailure('Annotation not found', 2, 'ANNOTATION_NOT_FOUND')
        if (record.agent !== action.agent && session.leadAgentId !== action.agent) {
          throw new CommandFailure('Only the Lead may resolve annotations it did not author', 3, 'NOT_LEAD')
        }
        session.annotations = resolveAnnotationThread(session.annotations, action.annotation, 'agent', action.agent).log
        session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
        await this.#persist(session)
        this.#publish()
        return { resolved: action.annotation }
      }
      case 'save': {
        this.#requireLead(session, request.args.agent)
        try {
          await this.save(file)
        } catch (error) {
          // A conflict or pending recovery needs the user; the round may end unsaved.
          throw new CommandFailure(
            error instanceof Error ? error.message : 'Save was blocked',
            3,
            'SAVE_BLOCKED',
            { reason: error instanceof Error ? error.message : String(error) },
          )
        }
        return { saved: true }
      }
      default:
        throw new CommandFailure('Unsupported command', 1, 'UNSUPPORTED_COMMAND')
    }
  }

  /** The user's transfer or revoke from the attachments panel; authoritative over agent claims. */
  async setLead(path: string, agentId: string | null): Promise<void> {
    const session = this.#require(path)
    if (agentId !== null && !session.attachments[agentId]) {
      throw new Error(`Attachment ${agentId} was not found`)
    }
    session.leadAgentId = agentId
    await this.#persist(session)
    this.#publish()
  }

  /** The panel's disconnect: the same path as agent `detach`, cancelling a blocked attach call. */
  async disconnectAgent(path: string, agentId: string): Promise<void> {
    const session = this.#require(path)
    if (!session.attachments[agentId]) throw new Error(`Attachment ${agentId} was not found`)
    this.#removeAttachment(session, agentId)
    await this.#persist(session)
    this.#scheduleIdleExpiry()
    this.#publish()
  }

  #removeAttachment(session: OpenDocumentSession, agentId: string): void {
    delete session.attachments[agentId]
    if (session.leadAgentId === agentId) session.leadAgentId = null
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    this.#attachWaits.cancel(attachKey(session.path, agentId), new Error('Attachment detached'))
  }

  #requireLead(session: OpenDocumentSession, agentId: string): void {
    if (!session.attachments[agentId]) {
      throw new CommandFailure('Attachment not found', 2, 'ATTACHMENT_NOT_FOUND')
    }
    if (session.leadAgentId !== agentId) {
      throw new CommandFailure('This action needs the Lead', 3, 'NOT_LEAD')
    }
  }

  /**
   * The Lead's accept reuses the suggestion path with the Lead as actor: the
   * replacement lands as an external, Lead-tagged segment with a pending hunk,
   * the ghost stays put, and the whole step is undoable like an external merge.
   */
  async #acceptSuggestionAsLead(
    session: OpenDocumentSession,
    annotationId: string,
    agentId: string,
  ): Promise<void> {
    const name = session.attachments[agentId]?.name ?? agentId
    await this.#applyApplicationStep(session, () => {
      const result = acceptAnnotationSuggestion(
        session.annotations,
        session.state.shadow,
        annotationId,
        'agent',
        agentId,
      )
      if (result.userChange) {
        session.state = acceptAgentReplacement(
          session.state,
          {
            from: result.userChange.start,
            to: result.userChange.end,
            insert: result.userChange.added
          },
          { agentId, name },
        )
        session.annotations = relocateOpenAnnotations(
          mapAnnotationsThroughEdit(result.log, {
            start: result.userChange.start,
            deleteCount: result.userChange.end - result.userChange.start,
            insertText: result.userChange.added
          }),
          session.state.shadow,
        )
      } else {
        session.annotations = result.log
      }
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    })
    await this.#changed(session)
  }

  #installMirrorAndWatcher(session: OpenDocumentSession): void {
    const paths = this.#store.pathsForDocument(session.path)
    const reconciler = new HashReconciler({
      documentPath: session.path,
      bufferPath: paths.buffer,
      onChange: async (change) => {
        if (change.current.bytes === null) {
          if (change.source === 'document') {
            const renamed = await this.#findRename(session)
            if (renamed) {
              await this.#followRename(session, renamed)
              return
            }
            session.deleted = true
          }
          this.#publish()
          return
        }
        const incoming = new TextDecoder('utf-8', { fatal: true }).decode(change.current.bytes)
        if (change.source === 'buffer' && session.recovery) return
        await this.#applyApplicationStep(session, () => {
          const result = applyExternalChange(
            session.state,
            change.source === 'document' ? 'disk' : 'buffer',
            incoming,
            {
              blockRanges: markdownBlockRanges(
                change.source === 'document' ? session.state.disk : session.state.mirror,
              ),
            },
          )
          if (result.status === 'applied') {
            session.annotations = mapAndRelocateAnnotations(
              session.annotations,
              session.state.shadow,
              result.state.shadow,
            )
          }
          session.state = result.state
          return result.status === 'applied'
        })
        if (change.source === 'document') {
          session.diskHash = change.current.hash
          session.deleted = false
          await this.#replaceDocumentHandle(session, session.path)
          session.mirror?.schedule(session.state.shadow)
        }
        await this.#persist(session)
        this.#publish()
      }
    })
    session.reconciler = reconciler
    session.mirror = new DebouncedMirror({
      writer: { write: async (content) => {
        session.state = recordMirrorWrite(session.state, content)
        const cancelOwnedWrite = reconciler.noteOwnedWrite('buffer', content)
        await this.#store.writeBuffer(session.path, content).catch((error: unknown) => {
          cancelOwnedWrite()
          throw error
        })
      } },
      onWritten: (content) => {
        void this.#persist(session)
      }
    })
    if (this.#watch) {
      session.watcher = new WatchCoordinator({
        documentPath: session.path,
        ghostEntryPath: paths.directory,
        reconcile: (reason) => reconciler.wake(reason)
      })
      void session.watcher.start()
    }
  }

  async #findRename(session: OpenDocumentSession): Promise<string | null> {
    if (!session.identity) return null
    const trackedPath = await pathForTrackedDocument(session)
    if (trackedPath && trackedPath !== session.path) return trackedPath
    return findMarkdownByIdentity(
      [dirname(session.path), ...this.#settings.explorerFolders],
      session.identity,
      [session.path],
    )
  }

  async #followRename(session: OpenDocumentSession, target: string): Promise<void> {
    const previous = session.path
    await session.watcher?.stop()
    session.mirror?.cancel()
    await this.#store.moveDocument(previous, target, session.lock)
    this.#sessions.delete(previous)
    session.path = target
    this.#sessions.set(target, session)
    await this.#tabs.rename(previous, target)
    await this.#replaceDocumentHandle(session, target)
    this.#installMirrorAndWatcher(session)
    await session.reconciler?.initialize('open')
    await this.#persist(session)
    this.#publish()
  }

  async #replaceDocumentHandle(session: OpenDocumentSession, path: string): Promise<void> {
    const tracked = await openTrackedDocument(path)
    const previous = session.documentHandle
    session.documentHandle = tracked.handle
    session.identity = tracked.identity
    await previous?.close()
  }

  async #changed(session: OpenDocumentSession): Promise<void> {
    session.mirror?.schedule(session.state.shadow)
    await this.#persist(session)
    this.#publish()
  }

  async #persist(session: OpenDocumentSession): Promise<void> {
    if (session.invalidUtf8) return
    const existing = await this.#store.loadMeta(session.path)
    const ghostBlob = await this.#persistContent(session, session.state.ghost)
    const diskBlob = await this.#persistContent(session, session.state.disk)
    const shadowBlob = await this.#persistContent(session, session.state.shadow)
    const mirrorBlob = await this.#persistContent(session, session.state.mirror)
    const snapshotBlobs: string[] = []
    for (const [id, content] of Object.entries(session.state.snapshots)) {
      if (!session.persistedBlobs.has(id)) {
        const blob = await this.#store.putObject(content)
        if (blob !== id) throw new Error(`Snapshot ${id} does not match its content hash`)
        session.persistedBlobs.add(id)
      }
      snapshotBlobs.push(id)
    }
    const previousSegmentTimes = new Map(existing.segments.map((segment) => [segment.id, segment.time]))
    // One clock read stamps this pass's new segments and any save entry it
    // lands, so a round threshold of strict greater-than never splits a save
    // from the segments persisted with it.
    const persistNow = this.#now()
    const segments: SegmentMeta[] = session.state.segments.map((segment) => ({
      id: segment.id,
      beforeBlob: segment.beforeSnapshotId,
      afterBlob: segment.afterSnapshotId,
      author: segment.author,
      ...(segment.attribution ? { tag: segment.attribution } : {}),
      time: previousSegmentTimes.get(segment.id) ?? persistNow,
    }))
    const record = session.pendingSaveRecord
    if (record !== null) {
      session.pendingSaveRecord = null
      const authors: SaveAuthorMeta[] = []
      const seen = new Set<string>()
      for (const [index, segment] of session.state.segments.entries()) {
        const stamped = segments[index]
        if (stamped === undefined || stamped.time <= record.threshold) continue
        const author: SaveAuthorMeta = segment.author === 'user'
          ? { name: 'you', user: true }
          : { name: segment.attribution?.name ?? 'external', user: false }
        const key = `${author.user ? 'you' : 'agent'}:${author.name}`
        if (seen.has(key)) continue
        seen.add(key)
        authors.push(author)
      }
      session.saves = [
        ...session.saves,
        { beforeBlob: record.beforeBlob, afterBlob: record.afterBlob, time: persistNow, authors },
      ]
    }
    const attachments = Object.fromEntries(Object.entries(session.attachments).map(([id, attachment]) => [
      id,
      persistAttachment(attachment),
    ]))
    const { application: _legacyApplication, ...canonical } = existing
    const persisted = await this.#store.saveMeta({
      ...canonical,
      formatVersion: CURRENT_META_VERSION,
      realpath: session.path,
      ghostBlob,
      saves: session.saves,
      diskBlob,
      shadowBlob,
      mirrorBlob,
      snapshotBlobs,
      segmentOffset: session.segmentOffset,
      pendingHunks: persistPendingHunkAnchors(session.state),
      segments,
      conflicts: session.state.conflicts,
      nextId: session.state.nextId,
      forceNewUserSegment: session.state.forceNewUserSegment,
      pendingTag: session.state.pendingTag,
      attachments,
      leadAgentId: session.leadAgentId,
      clipboardRecipient: persistClipboardRecipient(session.clipboardRecipient),
      annotationEvents: session.annotations.events,
      annotations: session.annotations.annotations,
      nextAnnotationSeq: session.annotations.nextSeq,
      sourceMode: session.sourceMode,
      lastSavedAt: session.lastSavedAt,
      lastSentSegmentIndex: session.lastSentSegmentIndex,
      lastSentAnnotationSeq: session.lastSentAnnotationSeq,
    })
    const removedCount = persisted.segmentOffset - session.segmentOffset
    if (removedCount > 0) {
      const segments = session.state.segments.slice(removedCount)
      const retainedSnapshots = new Set<string>([
        contentHash(session.state.ghost),
        contentHash(session.state.disk),
        contentHash(session.state.shadow),
        contentHash(session.state.mirror),
      ])
      for (const segment of segments) {
        retainedSnapshots.add(segment.beforeSnapshotId)
        retainedSnapshots.add(segment.afterSnapshotId)
      }
      session.state = {
        ...session.state,
        segments,
        snapshots: Object.fromEntries(
          Object.entries(session.state.snapshots)
            .filter(([id]) => retainedSnapshots.has(id)),
        ),
      }
      session.segmentOffset = persisted.segmentOffset
    }
    // Cached ids stay within what the saved meta references, so garbage
    // collection of unreferenced objects can never invalidate a cache entry.
    const referenced = new Set([
      ghostBlob,
      diskBlob,
      shadowBlob,
      mirrorBlob,
      ...snapshotBlobs,
      ...session.saves.flatMap((save) => [save.beforeBlob, save.afterBlob]),
    ])
    session.persistedBlobs = new Set([...session.persistedBlobs].filter((blob) => referenced.has(blob)))
    session.persistedContentBlobs = new Map(
      [...session.persistedContentBlobs].filter(([, blob]) => referenced.has(blob)),
    )
  }

  /** Content-addressed writes are idempotent, so a blob proven written this session is skipped. */
  async #persistContent(session: OpenDocumentSession, content: string): Promise<string> {
    const cached = session.persistedContentBlobs.get(content)
    if (cached !== undefined) return cached
    const blob = await this.#store.putObject(content)
    session.persistedBlobs.add(blob)
    if (session.persistedContentBlobs.size >= 16) {
      session.persistedContentBlobs = new Map(
        [...session.persistedContentBlobs].slice(-8),
      )
    }
    session.persistedContentBlobs.set(content, blob)
    return blob
  }

  async #enqueueDeliveries(
    session: OpenDocumentSession,
    request: SendPreviewRequest,
    recipients: readonly string[],
    event: 'send' | 'closed' = 'send',
  ) {
    const deliveries = await Promise.all(recipients.map(async (id) => {
      const attachment = session.attachments[id]
      if (!attachment) throw new Error(`Attachment ${id} was not found`)
      const delivery = freezeDelivery(
        attachment,
        await this.#deliverySource(session, request, id, event),
      )
      session.attachments[id] = enqueueDelivery(attachment, delivery)
      return delivery
    }))
    return deliveries
  }

  async #deliverySource(
    session: OpenDocumentSession,
    request: SendPreviewRequest,
    recipient: string | 'clipboard',
    event: 'send' | 'closed' = 'send',
  ): Promise<DeliverySource> {
    const cursor = session.annotations.nextSeq - 1
    const fromCursor = recipient === 'clipboard'
      ? (session.clipboardRecipient.pending?.to.cursor ?? session.clipboardRecipient.cursor)
      : deliveryStart(session.attachments[recipient]!).cursor
    const slice = annotationDeliverySlice(session.annotations, fromCursor, recipient, new Set(request.excludedEvents ?? []))
    const start = recipient === 'clipboard'
      ? deliveryStartForClipboard(session.clipboardRecipient)
      : deliveryStart(session.attachments[recipient]!)
    const baselineWithinHistory = start.segmentIndex >= session.segmentOffset - 1
    const baselineAvailable = recipient === 'clipboard' && session.clipboardRecipient.baseline === null
      ? true
      : baselineWithinHistory && await this.#store.hasObject(start.snapshotId)
    return {
      file: session.path,
      buffer: this.#store.pathsForDocument(session.path).buffer,
      snapshot: {
        snapshotId: contentHash(session.state.shadow),
        segmentIndex: currentSegmentIndex(session),
        cursor,
        document: session.state.shadow
      },
      segments: indexedSegments(session.state, session.segmentOffset),
      annotations: slice.annotations,
      replies: slice.replies,
      resolved: slice.resolved,
      edits: slice.edits,
      note: request.note,
      includeExternal: request.includeExternal,
      excludedHunks: request.excludedHunks ?? [],
      eventsLeftOut: slice.excluded > 0,
      event,
      now: this.#now(),
      baselineAvailable,
    }
  }

  /** Everything one recipient could receive, independent of the current selection, for the composer's checkboxes. */
  #sendItems(session: OpenDocumentSession, attachment: Attachment): SendItems {
    const start = deliveryStart(attachment)
    const through = currentSegmentIndex(session)
    const changes: SendChangeItem[] = []
    for (const segment of indexedSegments(session.state, session.segmentOffset)) {
      if (segment.index <= start.segmentIndex || segment.index > through) continue
      if (segment.tag?.agent === attachment.id) continue
      segment.hunks.forEach((hunk, index) => changes.push({
        key: `${segment.id}:${index}`,
        author: segment.author,
        ...(segment.tag ? { name: segment.tag.name } : {}),
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        removed: [...hunk.removed],
        added: [...hunk.added],
      }))
    }
    const agentName = (agent: string | null | undefined) =>
      agent == null ? {} : { name: session.attachments[agent]?.name ?? agent }
    const slice = annotationDeliverySlice(session.annotations, start.cursor, attachment.id)
    const events: SendEventItem[] = [
      ...slice.annotations.map((annotation) => ({
        seq: annotation.seq,
        kind: 'annotation' as const,
        annotationKind: annotation.kind,
        author: annotation.author,
        ...agentName(annotation.agent),
        text: annotation.text,
        quote: annotation.quote,
      })),
      ...slice.replies.map((reply) => ({
        seq: reply.seq,
        kind: 'reply' as const,
        author: reply.author,
        ...agentName(reply.agent),
        text: reply.text,
      })),
      ...slice.resolved.map((resolution) => ({
        seq: resolution.seq,
        kind: 'resolution' as const,
        annotationKind: resolution.kind,
        text: resolution.resolution,
      })),
      ...slice.edits.map((edit) => ({
        seq: edit.seq,
        kind: 'verdict' as const,
        text: edit.verdict,
        quote: edit.quote,
      })),
    ].sort((left, right) => left.seq - right.seq)
    return { changes, events }
  }

  /** The state a preview was computed against; `send` refuses a request whose token no longer matches. */
  #documentToken(session: OpenDocumentSession): SendDocumentToken {
    return {
      snapshotId: contentHash(session.state.shadow),
      segmentIndex: currentSegmentIndex(session),
      cursor: session.annotations.nextSeq - 1,
    }
  }

  #require(path: string): OpenDocumentSession {
    const session = this.#sessions.get(path)
    if (!session) throw new Error(`Document is not open: ${path}`)
    return session
  }

  async #closedStatePayload(file: string): Promise<unknown> {
    const disk = await readDocument(file)
    if (!disk.validUtf8) throw new CommandFailure('Invalid UTF-8', 1, 'INVALID_UTF8')
    let document = disk.text
    let annotations = createAnnotationLog()
    if (await this.#store.hasDocument(file)) {
      const meta = await this.#store.loadMeta(file)
      annotations = restoredAnnotationLog(meta)
      const buffer = await this.#store.readBuffer(file)
      if (buffer) {
        const [bufferInfo, diskInfo] = await Promise.all([
          stat(this.#store.pathsForDocument(file).buffer),
          stat(file),
        ])
        if (bufferInfo.mtimeMs > diskInfo.mtimeMs) document = buffer.toString('utf8')
      }
    }
    return withoutAgent(createPayload({
      file,
      buffer: this.#store.pathsForDocument(file).buffer,
      agent: 'state',
      event: 'state',
      cursor: annotations.nextSeq - 1,
      document,
      annotations: Object.values(annotations.annotations).map(toDeliveredAnnotation),
    }))
  }

  #writable(path: string): OpenDocumentSession {
    const session = this.#require(path)
    if (session.readOnly) throw new Error('This document is read-only')
    if (session.recovery) throw new Error('Choose Recover or Discard before editing')
    return session
  }

  /**
   * Run one application step and record its typed inverse only if it
   * succeeded and changed something. A thrown step records nothing.
   */
  async #applyApplicationStep(
    session: OpenDocumentSession,
    step: () => boolean | void | Promise<boolean | void>,
  ): Promise<boolean> {
    const before = reviewFrame(session.state)
    const beforeAnnotations = session.annotations
    const applied = await step()
    if (applied === false) return false
    session.applicationUndo.push({
      before,
      after: reviewFrame(session.state),
      annotations: annotationStepChanges(beforeAnnotations, session.annotations),
    })
    session.applicationRedo = []
    session.historyStep += 1
    return true
  }

  #restoreApplicationStep(session: OpenDocumentSession, frame: ReviewFrame, annotations: AnnotationLog): void {
    const shadowBefore = session.state.shadow
    session.state = restoreReviewFrame(session.state, frame)
    // Annotations the step did not touch follow the shadow like any user edit;
    // the ones it did touch come back exactly as recorded.
    const mapped = mapAndRelocateAnnotations(session.annotations, shadowBefore, session.state.shadow)
    session.annotations = relocateOpenAnnotations(
      { ...annotations, annotations: { ...mapped.annotations, ...restoredRecords(session.annotations, annotations) } },
      session.state.shadow,
    )
  }

  /** Save, Send, and Copy for agent end the application-step history. */
  #clearApplicationHistory(session: OpenDocumentSession): void {
    session.applicationUndo = []
    session.applicationRedo = []
  }

  #scheduleIdleExpiry(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
    let deadline = Number.POSITIVE_INFINITY
    for (const session of this.#sessions.values()) {
      for (const attachment of Object.values(session.attachments)) {
        // Same predicate as mayExpireAttachment: a message-only queue still arms the timer.
        if (attachment.waiting || attachment.deliveries.some((delivery) => !isMessageDelivery(delivery))) continue
        deadline = Math.min(deadline, attachment.lastCallAt + this.#settings.attachmentIdleTimeoutMs)
      }
    }
    if (!Number.isFinite(deadline)) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      void this.#expireIdleAttachmentsLive()
    }, Math.max(0, deadline - this.#now()))
    this.#idleTimer.unref?.()
  }

  async #expireIdleAttachmentsLive(): Promise<void> {
    const now = this.#now()
    let changed = false
    for (const session of this.#sessions.values()) {
      const retained = expireIdleAttachments(
        session.attachments,
        now,
        this.#settings.attachmentIdleTimeoutMs,
      )
      if (Object.keys(retained).length === Object.keys(session.attachments).length) continue
      session.attachments = { ...retained }
      if (session.leadAgentId !== null && session.attachments[session.leadAgentId] === undefined) {
        session.leadAgentId = null
      }
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      changed = true
      await this.#persist(session)
    }
    this.#scheduleIdleExpiry()
    if (changed) this.#publish()
  }

  #view(): AppView {
    const raw = this.#rawView()
    const last = this.#lastView
    const next = last === null ? raw : {
      tabs: stableValue(last.tabs, raw.tabs),
      activeDocument: stableValue(last.activeDocument, raw.activeDocument),
      explorer: stableValue(last.explorer, raw.explorer),
      settings: stableValue(last.settings, raw.settings)
    }
    this.#lastView = next
    return next
  }

  #rawView(): AppView {
    const focused = this.#tabs.focusedPath
    return {
      tabs: this.#tabs.list().map((tab) => {
        const session = this.#sessions.get(tab.path)!
        const pendingAuthor = session.state.pendingHunks.find((hunk) => hunk.author.agentId)?.author.agentId
        const attachmentIds = Object.keys(session.attachments)
        const pendingColor = pendingAuthor
          ? agentIdentity(pendingAuthor, session.attachments[pendingAuthor]?.name ?? pendingAuthor, Math.max(0, attachmentIds.indexOf(pendingAuthor))).color
          : undefined
        return {
          path: tab.path,
          name: tab.name,
          pendingCount: session.state.pendingHunks.length,
          ...(pendingColor ? { pendingColor } : {}),
          active: tab.path === focused,
          dirty: session.state.shadow !== session.state.disk
        }
      }),
      activeDocument: focused ? documentView(this.#sessions.get(focused)!, this.#store) : null,
      explorer: explorerView(this.#explorer, this.#sessions),
      settings: { ...settingsView(this.#settings), theme: this.#themeView() }
    }
  }

  #publish(): void {
    const state = this.#view()
    for (const listener of this.#listeners) listener(state)
  }
}

export async function createStrataApplication(options: ApplicationOptions = {}): Promise<StrataApplication> {
  return new StrataApplication(options).initialize()
}

/** The annotation records a step restore changed, keyed by id (deleted ones are omitted). */
function restoredRecords(previous: AnnotationLog, restored: AnnotationLog): AnnotationLog['annotations'] {
  const records: Record<string, AnnotationLog['annotations'][string]> = {}
  for (const [id, record] of Object.entries(restored.annotations)) {
    if (previous.annotations[id] !== record) records[id] = record
  }
  return records
}

function relocateOpenAnnotations(log: AnnotationLog, document: string): AnnotationLog {
  let next = log
  for (const annotation of Object.values(log.annotations)) {
    if (annotation.status !== 'resolved') {
      next = relocateAnnotation(next, annotation.id, document).log
    }
  }
  return next
}

function mapAndRelocateAnnotations(
  log: AnnotationLog,
  before: string,
  after: string,
): AnnotationLog {
  let next = log
  for (const hunk of computeHunks(before, after).sort((left, right) => right.before.from - left.before.from)) {
    next = mapAnnotationsThroughEdit(next, {
      start: hunk.before.from,
      deleteCount: hunk.before.to - hunk.before.from,
      insertText: hunk.added,
    })
  }
  return relocateOpenAnnotations(next, after)
}

function retainConfiguredResolvedAnnotations(
  session: OpenDocumentSession,
  keepResolvedAnnotations: boolean,
): AnnotationLog {
  if (keepResolvedAnnotations) return session.annotations
  const cursors = [
    ...Object.values(session.attachments).map((attachment) => attachment.cursor),
    session.clipboardRecipient.cursor,
  ]
  const removable = new Set(
    Object.values(session.annotations.annotations)
      .filter((annotation) =>
        annotation.status === 'resolved'
        && cursors.every((cursor) => cursor >= annotation.seq),
      )
      .map((annotation) => annotation.id),
  )
  return pruneResolvedAnnotations(session.annotations, removable)
}

/** An agent's own annotation events are never delivered back to it, so they alone do not enable Send. */
function sendableToSomeone(event: LogEvent, attachmentIds: readonly string[]): boolean {
  if (isHunkVerdict(event)) return attachmentIds.includes(event.targetAgentId)
  if (event.author !== 'agent') return true
  return attachmentIds.some((id) => id !== event.agent)
}

/** A user segment enables Send only when someone other than its author could receive it (PRD §6.7). */
function sendableSegment(segment: DocumentState['segments'][number], attachmentIds: readonly string[]): boolean {
  const author = segment.attribution?.agentId
  if (author == null) return true
  return attachmentIds.length === 0 || attachmentIds.some((id) => id !== author)
}

/** The attribution an accepted suggestion's user segment carries: its authoring agent, or null for the user's own. */
function suggestionAttribution(session: OpenDocumentSession, annotationId: string): ExternalAttribution | null {
  const annotation = session.annotations.annotations[annotationId]
  if (annotation === undefined || annotation.author !== 'agent' || annotation.agent === null) return null
  return { agentId: annotation.agent, name: session.attachments[annotation.agent]?.name ?? annotation.agent }
}

function currentUnreviewedSegments(state: DocumentState): PayloadSegment[] {
  return [...state.pendingHunks]
    .sort((left, right) => left.shadow.from - right.shadow.from)
    .map((pending) => {
      const removed = state.ghost.slice(pending.ghost.from, pending.ghost.to)
      const added = state.shadow.slice(pending.shadow.from, pending.shadow.to)
      return {
        author: 'external' as const,
        ...(pending.author.agentId
          ? { tag: { agent: pending.author.agentId, name: pending.author.name } }
          : {}),
        hunks: [{
          oldStart: lineAt(state.ghost, pending.ghost.from),
          oldLines: splitLines(removed).length,
          newStart: lineAt(state.shadow, pending.shadow.from),
          newLines: splitLines(added).length,
          removed: splitLines(removed),
          added: splitLines(added)
        }]
      }
    })
}

function mapRangesThroughHunks(ranges: readonly TextRange[], hunks: ReturnType<typeof computeHunks>): TextRange[] {
  return ranges.map((range) => mapOldRangeToNew(range, hunks))
}

function dependentExternalHunkCount(
  state: DocumentState,
  afterSegmentIndex: number,
  segmentOffset = 0,
): number {
  let unseenExternalRanges: TextRange[] = []
  let dependent = 0
  const firstLocalIndex = Math.max(0, afterSegmentIndex - segmentOffset + 1)
  for (let index = firstLocalIndex; index < state.segments.length; index += 1) {
    const segment = state.segments[index]!
    const before = state.snapshots[segment.beforeSnapshotId]
    const after = state.snapshots[segment.afterSnapshotId]
    if (before === undefined || after === undefined) continue
    const hunks = computeHunks(before, after)
    if (segment.author === 'user') {
      dependent += hunks.filter((hunk) =>
        unseenExternalRanges.some((range) => rangesTouch(range, hunk.before)),
      ).length
      unseenExternalRanges = mapRangesThroughHunks(unseenExternalRanges, hunks)
    } else {
      unseenExternalRanges = [
        ...mapRangesThroughHunks(unseenExternalRanges, hunks),
        ...hunks.map((hunk) => ({ ...hunk.after })),
      ]
    }
  }
  return dependent
}

function persistedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function persistedBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function markdownBlockRanges(source: string): TextRange[] {
  try {
    return parseMarkdown(source).blocks.map((block) => ({
      from: block.span.start.offset,
      to: block.span.end.offset,
    }))
  } catch {
    return []
  }
}

function isPendingAnchor(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { shadow?: unknown; ghost?: unknown }
  const stored = (anchor: unknown): boolean => Boolean(
    anchor
    && typeof anchor === 'object'
    && typeof (anchor as { quote?: unknown }).quote === 'string',
  )
  return stored(candidate.shadow) && stored(candidate.ghost)
}

async function restoreDocumentState(
  store: GhostStore,
  meta: DocumentMeta,
  legacy: DocumentState | undefined,
  disk: string,
  ghost: string,
  shadow: string,
  mirror: string,
): Promise<DocumentState> {
  const canonical = typeof meta.nextId === 'number'
    && meta.segments.every((segment) => segment.beforeBlob && segment.afterBlob)
  const pendingAnchors = meta.pendingHunks
    .filter(isPendingAnchor)
    .map((value) => value as unknown as PendingHunkAnchor)
  const base = createDocumentState(disk, ghost, {
    shadow,
    mirror,
    ...(pendingAnchors.length === meta.pendingHunks.length
      ? { persistedPendingAnchors: pendingAnchors }
      : { persistedPending: legacy?.pendingHunks ?? [] }),
  })
  if (!canonical && legacy) {
    return {
      ...base,
      segments: structuredClone(legacy.segments),
      snapshots: { ...legacy.snapshots, [contentHash(shadow)]: shadow },
      pendingTag: legacy.pendingTag ? { ...legacy.pendingTag } : null,
      nextId: legacy.nextId,
      forceNewUserSegment: legacy.forceNewUserSegment,
      conflicts: structuredClone(legacy.conflicts ?? []),
    }
  }

  const snapshotIds = new Set(meta.snapshotBlobs ?? [])
  if (meta.diskBlob) snapshotIds.add(meta.diskBlob)
  if (meta.shadowBlob) snapshotIds.add(meta.shadowBlob)
  if (meta.mirrorBlob) snapshotIds.add(meta.mirrorBlob)
  for (const segment of meta.segments) {
    if (segment.beforeBlob) snapshotIds.add(segment.beforeBlob)
    if (segment.afterBlob) snapshotIds.add(segment.afterBlob)
  }
  for (const attachment of Object.values(meta.attachments)) {
    snapshotIds.add(attachment.baselineBlob)
    for (const delivery of attachment.deliveries) snapshotIds.add(delivery.snapshotBlob)
  }
  if (meta.clipboardRecipient && typeof meta.clipboardRecipient === 'object') {
    const clipboard = meta.clipboardRecipient as {
      baselineBlob?: unknown
      pending?: { snapshotBlob?: unknown }
    }
    if (typeof clipboard.baselineBlob === 'string') snapshotIds.add(clipboard.baselineBlob)
    if (typeof clipboard.pending?.snapshotBlob === 'string') snapshotIds.add(clipboard.pending.snapshotBlob)
  }
  const snapshots: Record<string, string> = {}
  for (const id of snapshotIds) {
    try {
      snapshots[id] = await store.getObjectText(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A missing baseline is intentionally left absent so delivery freezes a resync.
    }
  }
  snapshots[contentHash(shadow)] = shadow
  return {
    ...base,
    segments: meta.segments.flatMap((segment) => {
      if (!segment.id || !segment.beforeBlob || !segment.afterBlob) return []
      const tag = segment.tag && typeof segment.tag === 'object'
        ? segment.tag as DocumentState['segments'][number]['attribution']
        : null
      return [{
        id: segment.id,
        author: segment.author,
        beforeSnapshotId: segment.beforeBlob,
        afterSnapshotId: segment.afterBlob,
        attribution: tag,
      }]
    }),
    snapshots,
    pendingTag: meta.pendingTag && typeof meta.pendingTag === 'object'
      ? meta.pendingTag as DocumentState['pendingTag']
      : null,
    nextId: meta.nextId ?? base.nextId,
    forceNewUserSegment: meta.forceNewUserSegment ?? false,
    conflicts: Array.isArray(meta.conflicts)
      ? structuredClone(meta.conflicts) as DocumentState['conflicts']
      : [],
  }
}

function restoreAttachments(
  meta: DocumentMeta,
  legacy: Record<string, Attachment> | undefined,
): Record<string, Attachment> {
  if (Object.keys(meta.attachments).length === 0) return structuredClone(legacy ?? {})
  return Object.fromEntries(Object.entries(meta.attachments).map(([id, stored]) => [id, {
    id: stored.id ?? id,
    name: stored.name ?? id,
    attachedAt: stored.attachedAt ?? 0,
    lastCallAt: stored.lastCallAt ?? stored.attachedAt ?? 0,
    waiting: false,
    baseline: { snapshotId: stored.baselineBlob, segmentIndex: stored.segmentIndex },
    cursor: stored.cursor,
    deliveries: stored.deliveries.map(({ snapshotBlob: _snapshotBlob, ...delivery }) => delivery),
  } as unknown as Attachment]))
}

function persistAttachment(attachment: Attachment): AttachmentMeta {
  return {
    id: attachment.id,
    name: attachment.name,
    attachedAt: attachment.attachedAt,
    lastCallAt: attachment.lastCallAt,
    waiting: attachment.waiting ?? false,
    baselineBlob: attachment.baseline.snapshotId,
    segmentIndex: attachment.baseline.segmentIndex,
    cursor: attachment.cursor,
    deliveries: attachment.deliveries.map((delivery) => ({
      ...delivery,
      snapshotBlob: delivery.to.snapshotId,
    })),
  }
}

function restoreClipboardRecipient(
  stored: unknown,
  legacy: ClipboardRecipient | undefined,
): ClipboardRecipient {
  if (!stored || typeof stored !== 'object') return structuredClone(legacy ?? createClipboardRecipient())
  const value = stored as {
    baselineBlob?: unknown
    segmentIndex?: unknown
    cursor?: unknown
    pending?: unknown
  }
  const baseline = typeof value.baselineBlob === 'string' && typeof value.segmentIndex === 'number'
    ? { snapshotId: value.baselineBlob, segmentIndex: value.segmentIndex }
    : null
  const pendingValue = value.pending && typeof value.pending === 'object'
    ? value.pending as Record<string, unknown>
    : null
  let pending: ClipboardRecipient['pending'] = null
  if (pendingValue) {
    const { snapshotBlob: _snapshotBlob, ...delivery } = pendingValue
    pending = delivery as unknown as ClipboardRecipient['pending']
  }
  return {
    baseline,
    cursor: typeof value.cursor === 'number' ? value.cursor : 0,
    pending,
  }
}

function persistClipboardRecipient(recipient: ClipboardRecipient): unknown {
  return {
    baselineBlob: recipient.baseline?.snapshotId ?? null,
    segmentIndex: recipient.baseline?.segmentIndex ?? -1,
    cursor: recipient.cursor,
    pending: recipient.pending
      ? { ...recipient.pending, snapshotBlob: recipient.pending.to.snapshotId }
      : null,
  }
}

function deliveryStartForClipboard(recipient: ClipboardRecipient) {
  return recipient.pending?.to ?? recipient.baseline ?? { snapshotId: '', segmentIndex: -1 }
}

function persistedApplication(meta: DocumentMeta): PersistedApplicationState | undefined {
  const value = meta.application
  if (!value || typeof value !== 'object') return undefined
  return value as PersistedApplicationState
}

function persistedAnnotationLog(meta: DocumentMeta): AnnotationLog {
  const annotations = meta.annotations
  const nextSeq = meta.nextAnnotationSeq
  if (annotations && typeof annotations === 'object' && typeof nextSeq === 'number') {
    return {
      annotations: annotations as AnnotationLog['annotations'],
      nextSeq,
      events: meta.annotationEvents as AnnotationLog['events']
    }
  }
  return createAnnotationLog()
}

function restoredAnnotationLog(meta: DocumentMeta): AnnotationLog {
  const canonical = persistedAnnotationLog(meta)
  const legacy = persistedApplication(meta)?.annotations
  if (!legacy) return canonical
  return canonical.nextSeq >= legacy.nextSeq ? canonical : legacy
}

function agentIdentity(id: string, name: string, index: number): AgentIdentity {
  const colors: AgentIdentity['color'][] = ['grape', 'sky', 'mint', 'tangerine']
  return { id, name, color: colors[index % colors.length]! }
}

function annotationView(log: AnnotationLog, attachments: Record<string, Attachment>): AnnotationView[] {
  const ids = Object.keys(attachments)
  return Object.values(log.annotations).map((annotation) => ({
    id: annotation.id,
    seq: annotation.seq,
    kind: annotation.kind,
    status: annotation.status,
    author: annotation.author === 'user'
      ? 'user'
      : agentIdentity(annotation.agent ?? 'agent', attachments[annotation.agent ?? '']?.name ?? annotation.agent ?? 'agent', Math.max(0, ids.indexOf(annotation.agent ?? ''))),
    quote: annotation.quote,
    text: annotation.text,
    ...(annotation.label ? { label: annotation.label } : {}),
    line: annotation.status === 'orphaned' ? null : annotation.line,
    from: annotation.status === 'orphaned' ? null : annotation.anchor.start,
    to: annotation.status === 'orphaned' ? null : annotation.anchor.end,
    ...(annotation.kind === 'suggestion' ? { replacement: annotation.text } : {}),
    replies: annotation.replies.map((reply) => ({
      id: reply.id,
      author: reply.author === 'user'
        ? 'user'
        : agentIdentity(reply.agent ?? 'agent', attachments[reply.agent ?? '']?.name ?? reply.agent ?? 'agent', Math.max(0, ids.indexOf(reply.agent ?? ''))),
      text: reply.text,
      createdAt: 0
    }))
  }))
}

function hunkViews(state: DocumentState, attachments: Record<string, Attachment>): HunkView[] {
  const ids = Object.keys(attachments)
  // Save-state classification (PRD §6.9): a hunk is saved when its shadow
  // region already matches the file, read off the shadow-vs-disk diff. With
  // nothing pending there is nothing to classify, so plain typing never diffs.
  const unsavedRanges = state.pendingHunks.length === 0 || state.disk === state.shadow
    ? []
    : computeHunks(state.disk, state.shadow).map((hunk) => hunk.after)
  return state.pendingHunks.map((pending) => {
    const removed = state.ghost.slice(pending.ghost.from, pending.ghost.to)
    const added = state.shadow.slice(pending.shadow.from, pending.shadow.to)
    return {
      id: pending.id,
      oldStart: lineAt(state.ghost, pending.ghost.from),
      oldLines: splitLines(removed).length,
      newStart: lineAt(state.shadow, pending.shadow.from),
      newLines: splitLines(added).length,
      removed: splitLines(removed),
      added: splitLines(added),
      status: pending.status,
      author: pending.author.agentId
        ? agentIdentity(pending.author.agentId, pending.author.name, Math.max(0, ids.indexOf(pending.author.agentId)))
        : null,
      source: 'buffer',
      inline: !removed.includes('\n\n') && !added.includes('\n\n'),
      saved: !unsavedRanges.some((range) => rangesTouch(range, pending.shadow))
    }
  })
}

function documentView(session: OpenDocumentSession, store: GhostStore): DocumentView {
  const ids = Object.keys(session.attachments)
  const attachments: AttachmentView[] = ids.map((id, index) => {
    const attachment = session.attachments[id]!
    return {
      agent: agentIdentity(id, attachment.name, index),
      attachedAt: attachment.attachedAt,
      state: attachmentDisplayState(attachment),
      queuedDeliveries: attachment.deliveries.map((delivery) => delivery.id),
      queuedSendCount: attachment.deliveries.filter((delivery) => !isMessageDelivery(delivery)).length
    }
  })
  return {
    path: session.path,
    bufferPath: store.pathsForDocument(session.path).buffer,
    leadAgentId: session.leadAgentId,
    content: session.state.shadow,
    sourceMode: session.sourceMode,
    sourceOnly: session.sourceOnly,
    readOnly: session.readOnly,
    dirty: session.state.shadow !== session.state.disk,
    deleted: session.deleted,
    invalidUtf8: session.invalidUtf8,
    lastSavedAt: session.lastSavedAt,
    historyStep: session.historyStep,
    pendingHunks: hunkViews(session.state, session.attachments),
    saves: session.saves.map((save) => ({
      time: save.time,
      authors: save.authors.map((author) => ({ ...author })),
    })),
    annotations: annotationView(session.annotations, session.attachments),
    attachments,
    canSend:
      session.state.segments.some((segment, index) =>
        session.segmentOffset + index > session.lastSentSegmentIndex
        && segment.author === 'user'
        && sendableSegment(segment, Object.keys(session.attachments)),
      )
      || session.annotations.events.some((event) =>
        event.seq > session.lastSentAnnotationSeq && sendableToSomeone(event, Object.keys(session.attachments)),
      ),
    ...(session.recovery ? { recovery: session.recovery } : {}),
    conflicts: session.state.conflicts.map((conflict) => ({
      id: conflict.id,
      label: `${conflict.author.agentId ? conflict.author.name : 'Someone else'} changed this block`,
      mine: session.state.shadow.slice(conflict.shadow.from, conflict.shadow.to),
      incoming: conflict.incoming
    }))
  }
}

function explorerView(scan: ExplorerScanResult, sessions: Map<string, OpenDocumentSession>): ExplorerFolderView[] {
  return scan.roots.map((root) => ({
    path: root.path,
    name: basename(root.path),
    files: scan.files.filter((file) => file.root === root.path).map((file) => ({
      path: file.path,
      name: basename(file.path),
      relativePath: file.relativePath,
      folder: root.path,
      missing: file.missing,
      pendingCount: sessions.get(file.path)?.state.pendingHunks.length ?? 0
    }))
  }))
}

function settingsView(settings: Settings): Omit<AppSettingsView, 'theme'> {
  return {
    animatedBackground: settings.ambientMotion,
    attachmentIdleHours: settings.attachmentIdleTimeoutMs / (60 * 60 * 1_000),
    panelSizes: { ...settings.panels },
    zoom: { ...settings.zoom }
  }
}

function indexedSegments(state: DocumentState, segmentOffset = 0): IndexedSegment[] {
  return state.segments.map((segment, index) => {
    const before = state.snapshots[segment.beforeSnapshotId] ?? ''
    const after = state.snapshots[segment.afterSnapshotId] ?? ''
    return {
      index: segmentOffset + index,
      id: segment.id,
      author: segment.author,
      ...(segment.attribution?.agentId ? { tag: { agent: segment.attribution.agentId, name: segment.attribution.name } } : {}),
      hunks: computeHunks(before, after).map((hunk) => ({
        oldStart: hunk.oldStartLine,
        oldLines: hunk.removedLines,
        newStart: hunk.newStartLine,
        newLines: hunk.addedLines,
        removed: splitLines(hunk.removed),
        added: splitLines(hunk.added)
      }))
    }
  })
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function attachKey(file: string, agent: string): string {
  return `${file}\0${agent}`
}

function deliverySnapshot(session: OpenDocumentSession) {
  return {
    snapshotId: contentHash(session.state.shadow),
    segmentIndex: currentSegmentIndex(session),
    cursor: session.annotations.nextSeq - 1,
    document: session.state.shadow
  }
}

function currentSegmentIndex(session: OpenDocumentSession): number {
  return session.segmentOffset + session.state.segments.length - 1
}

async function openTrackedDocument(path: string): Promise<{
  handle: FileHandle
  identity: { dev: bigint; ino: bigint }
}> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat({ bigint: true })
    return { handle, identity: { dev: info.dev, ino: info.ino } }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function pathForTrackedDocument(session: OpenDocumentSession): Promise<string | null> {
  if (!session.documentHandle) return null
  try {
    const candidate = await pathForDescriptor(session.documentHandle.fd)
    if (!candidate) return null
    const [handleInfo, candidateInfo] = await Promise.all([
      session.documentHandle.stat({ bigint: true }),
      stat(candidate, { bigint: true }),
    ])
    return handleInfo.dev === candidateInfo.dev && handleInfo.ino === candidateInfo.ino
      ? candidate
      : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function closeTrackedDocument(session: OpenDocumentSession): Promise<void> {
  const handle = session.documentHandle
  delete session.documentHandle
  await handle?.close()
}

async function releaseSessionResources(session: OpenDocumentSession): Promise<void> {
  const results = await Promise.allSettled([
    session.watcher?.stop(),
    session.lock?.release(),
    closeTrackedDocument(session),
  ])
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}

function withoutAgent<T extends { agent?: string }>(payload: T): Omit<T, 'agent'> {
  const { agent: _agent, ...rest } = payload
  return rest
}
