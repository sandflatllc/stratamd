import { resolveLocalLink } from './local-link'
import { captureStrataEngine, restoreStrataEngine, documentBinding } from './engine/strata-backup'
import { hostname, networkInterfaces } from 'node:os'
import { readTailscale, readServeEndpoint } from './engine/tailscale'
import { T3Connect } from './engine/connect'
import { runConnectSetup, type ConnectSetupAction } from './engine/connect-setup'
import { ConnectReadiness, liveConnectStatus } from './engine/connect-readiness'
import type { ComputerRequest, ComputerView } from '../shared/computer'
import { ProviderSetupJobs } from './engine/provider-setup'
import { measureLocalUsage } from './engine/local-usage'
import { LocalEngineManager } from './engine/manager'
import { connectionIdentity } from './engine/identity'
import { conversationDelivery, renderConversationDelivery } from '../core/conversation-delivery'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { pathForDescriptor } from '../platform/descriptor-path'
import type {
  EngineThreadChange,
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
  BufferOrigin,
  CreateAnnotationRequest,
  CreateDraftRequest,
  DraftView,
  DocumentProblem,
  ReadingState,
  TableViewState,
  WalkthroughAction,
  HeadingReference,
  LocalLinkTarget,
  LocalMarkdownPreview,
  VisualPageCapture,
  VisualPageProposal,
  VisualShowResult,
  LocalImageResolution,
  PairEngineRequest,
  QuickSendRequest,
  RecipientView,
  StartThreadFromDocumentInput,
  StartThreadInput,
} from '../shared/contracts'
import { resolvePairingTarget } from './engine/pairing'
import { isDarwin } from '../platform/runtime'
import { createDraftStore, discardDraft as removeDraft, holdDraft as addHeldDraft, relocateDraft, type DraftStore } from '../core/drafts'
import { blockOutcomeLines, parseStrataBlock, resolveBlock } from '../core/blocks'
import { deriveItems } from '../core/items'
import { logError } from './log'
import {
  acceptAllSuggestions as acceptAllAnnotationSuggestions,
  answerDecision as answerAnnotationDecision,
  acceptSuggestion as acceptAnnotationSuggestion,
  AnnotationAnchorError,
  annotationDeliverySlice,
  annotationStepChanges,
  redoAnnotationStep,
  undoAnnotationStep,
  type AnnotationStepChanges,
  clearResolvedAnnotations as clearResolvedAnnotationLog,
  createAnnotation,
  createAnnotationLog,
  describeQuoteFailure,
  locateQuote,
  locateEdit,
  mapAnnotationsThroughEdit,
  quoteCandidateForLines,
  type QuoteFailure,
  withAttachmentNames,
  nearestQuoteStart,
  pruneResolvedAnnotations,
  relocateAnnotation,
  relocateOpenAnnotations,
  rejectAllSuggestions as rejectAllAnnotationSuggestions,
  rejectSuggestion as rejectAnnotationSuggestion,
  replyToAnnotation,
  reopenDecision as reopenAnnotationDecision,
  requoteAnnotation,
  resolveAnnotation as resolveAnnotationThread,
  isHunkVerdict,
  lastAnnotationEvent,
  recordHunkVerdict,
  verdictQuote,
  type Annotation,
  type LogEvent,
  type AnnotationLog
} from '../core/annotations'
import { toDeliveredAnnotation } from '../core/annotations'
import {
  acknowledgeDelivery,
  collectOldest,
  createAttachment,
  createInitialPayload,
  deliveryStart,
  enqueueDelivery,
  freezeDelivery,
  freezeQuickSend,
  isMessageDelivery,
  type Attachment,
  type DeliverySource,
  type FrozenDelivery,
  type IndexedSegment
} from '../core/delivery'
import { createPayload, PAYLOAD_VERSION, type PayloadSegment } from '../core/payload'
import { computeHunks, contentHash, contextHunks, mapOldPositionToNew, mapOldRangeToNew, rangesTouch, type TextRange } from '../core/diff'
import {
  acceptAgentReplacement,
  acceptUserReplacement,
  applyExternalChange,
  applySavedContent,
  applyUserEdit,
  createDocumentState,
  discardOnClose,
  keepHunk as keepPendingHunk,
  markReviewed as reviewAll,
  markSendBoundary,
  persistPendingHunkAnchors,
  prepareSave,
  recomputePendingHunks,
  recordMirrorWrite,
  resolveExternalConflict,
  revertHunk as revertPendingHunk,
  restoreReviewFrame,
  reviewFrame,
  segmentSnapshotIds,
  type ExternalAttribution,
  type ExternalChangeResult,
  type ExternalSource,
  type PendingHunkAnchor,
  type DocumentState,
  type ReviewFrame
} from '../core/state'
import { parseMarkdown } from '../core/markdown'
import { analyzeComponentNode, annotatedScreenshotData, type ComponentAstNode } from '../core/markdown/components'
import { findMarkdownByIdentity, readExplorerRoots, scanAndSeedExplorer, scanExplorer, type ExplorerScanResult } from './explorer'
import { readDiskState, readDocument, resolveAllowedLocalPath, resolveDocumentPath, saveDocumentWithHashCheck, seedGhostFromGit } from './files'
import { IMAGE_HEADER_BYTES, imageDimensionsFromHeader } from './image-dimensions'
import { readDraftStore, writeDraftStore } from './drafts'
import { localImageUrl } from './protocols'
import { lineAt, stableValue } from './view-stability'
import { SessionRegistry } from './session'
import { DEFAULT_SETTINGS, SettingsStore, type Settings, type SettingsRecovery } from './settings'
import { BUILT_IN_THEME, listInstalledFonts, ThemeBrokenError, ThemeStore, type LoadedTheme, type ThemeSummary } from './themes'
import { readSparseValue, THEME_KEY_BY_NAME, THEME_SCHEMA_VERSION, writeSparseValue, normalizeThemeValue, type SparseTheme } from '../shared/theme-keys'
import { readFile } from 'node:fs/promises'
import { THEME_SAMPLE_FILE_NAME, THEME_SAMPLE_MARKDOWN } from '../shared/theme-sample'
import { atomicWriteFile } from './storage'
import { CURRENT_READING_VERSION, DEFAULT_READING_STATE, normalizeHeadingReference, normalizeReadingState, readReadingState, writeReadingState } from './reading'
import { applyWalkthroughAction, buildWalkthroughIndex, reconcileFoldedHeadings, reconcileWalkthroughState, updateWalkthroughIndex, type WalkthroughIndex, type WalkthroughUpdate } from './walkthrough'
import { reconcileTableViews } from './tables'
import { upsertTableView } from '../shared/tables'
import { CURRENT_META_VERSION, DEFAULT_LOCK_TIMEOUT_MS, GhostStore, type AttachmentMeta, type DeliveryMeta, type DocumentLock, type DocumentMeta, type PendingHunkMeta, type SaveAuthorMeta, type SaveMeta, type SegmentMeta } from './storage'
import { DebouncedMirror, HashReconciler, WatchCoordinator, watchDirectory, type DirectorySubscription } from './watcher'
import { T3EngineClient, type EngineReadClient } from './engine/client'
import { PreviewHost } from './preview/host'
import { locateScript, scrollScript as pageScrollScript } from './preview/inspect'
import { withCleanPage } from './preview/clean-capture'
import { nativeImage } from 'electron'
import { visualSendRefusal, type VisualCommentRecord, type VisualRevision } from '../core/visual-comments'
import { visualImageUrl } from '../shared/visual-urls'

/** A window of a PNG in page pixels, cut at the capture's own scale and clamped to it. */
function cropPng(bytes: Uint8Array, window: { x: number; y: number; width: number; height: number }, scale: number, size: { width: number; height: number }): { bytes: Uint8Array; width: number; height: number } | null {
  const x = Math.max(0, Math.min(size.width - 1, Math.round(window.x * scale)))
  const y = Math.max(0, Math.min(size.height - 1, Math.round(window.y * scale)))
  const width = Math.max(1, Math.min(size.width - x, Math.round(window.width * scale)))
  const height = Math.max(1, Math.min(size.height - y, Math.round(window.height * scale)))
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) return null
  const cropped = image.crop({ x, y, width, height })
  if (cropped.isEmpty()) return null
  const cropSize = cropped.getSize()
  return { bytes: new Uint8Array(cropped.toPNG()), width: cropSize.width, height: cropSize.height }
}

/** The same page, ignoring the fragment: a hash change is not navigation away. */
function samePage(current: string, original: string): boolean {
  const strip = (value: string) => value.replace(/#.*$/, '')
  return strip(current) === strip(original)
}

/** The theme problem key under which a failed file write is reported (plan 4.14). */
const THEME_WRITE_PROBLEM_KEY = 'write'
/** The longest delay a Node timer represents faithfully. */
/** How long typing may go on before its meta reaches disk; the buffer mirror (80 ms) carries the text itself. */
const META_WRITE_DEBOUNCE_MS = 1_000

interface PersistedApplicationState {
  state: DocumentState
  annotations: AnnotationLog
  attachments: Record<string, Attachment>
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
  drafts: DraftStore
  attachments: Record<string, Attachment>
  /** The at-most-one attachment holding the Lead (PRD §6.6); dies with it. */
  leadAgentId: string | null
  engineIdentity: string | undefined
  engineAttachments: Record<string, { attachments: Record<string, Attachment>; leadAgentId: string | null }>
  sourceMode: boolean
  reading: ReadingState
  walkthroughIndex: WalkthroughIndex
  walkthroughUpdate: Pick<WalkthroughUpdate, 'durationMs' | 'hashedSections' | 'rebuilt'>
  readingDirty: boolean
  sourceOnly: boolean
  readOnly: boolean
  invalidUtf8: boolean
  deleted: boolean
  /** Background failures shown to the user until the job next succeeds (PRD §6.10). */
  problems: Set<DocumentProblem>
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
  /** The shadow-versus-disk diff behind hunk save states, reused while neither side changes. */
  unsavedRangesCache?: { disk: string; shadow: string; ranges: TextRange[] }
  /**
   * The entry's stored form as last read or written. Every persist derives the
   * next meta from it and the in-memory state; meta.json is never re-read
   * while the session holds the lock (plan 4.11).
   */
  meta?: DocumentMeta
  /** A debounced meta write is pending; see #persist. */
  metaDirty: boolean
  metaTimer: ReturnType<typeof setTimeout> | null
  /**
   * When each segment was first persisted or scheduled for persisting. A
   * deferred write must not move a segment into a later save round, so the
   * stamp is taken when the change is recorded, not when meta.json is written.
   */
  segmentTimes: Map<string, number>
  /**
   * When each pending hunk was first recorded, by hunk id, stamped in the same
   * #persist pass and with the same clock read as the segments recorded with
   * it. Hunks are stamped directly rather than traced to a segment: a hunk
   * holds no segment reference, its id is reallocated when a later edit
   * re-diffs it, and the segment that produced it is trimmed from the session
   * once persisted, so the trace would fail for exactly the older hunks whose
   * age matters most. Written to meta.json with the hunk and restored from it.
   */
  hunkTimes: Map<string, number>
  /** Provenance for hunks created by an in-the-loop strata edit. */
  hunkItemSources: Map<string, { threadId: string; turnId: string; messageId: string }>
  /** Object ids of delivery payloads proven written this session, by payload identity. */
  payloadBlobs: WeakMap<object, string>
}

interface PersistOptions {
  /** Coalesce with other writes over about a second instead of writing now. */
  debounce?: boolean
}

/** The typed inverse of one application step: only what the step owns. */
interface ApplicationHistoryEntry {
  before: ReviewFrame
  after: ReviewFrame
  annotations: AnnotationStepChanges
}

export interface ApplicationOptions {
  setStartAtLogin?(enabled: boolean): Promise<void>
  store?: GhostStore
  settingsStore?: SettingsStore
  themeStore?: ThemeStore
  listFonts?: () => Promise<string[]>
  clipboardWrite?: (text: string) => Promise<void>
  selectFolder?: () => Promise<string | null>
  now?: () => number
  watch?: boolean
  managedBundle?: string
  engineUsageHelper?: string
  engine?: EngineReadClient
  /** Window focus and the OS notification, supplied by Electron (§5.2). */
  notifications?: { isFocused(): boolean; notify(notification: { threadId: string; title: string; body: string }): void }
}

interface OpenDocumentsRecord {
  formatVersion: 1
  documents: string[]
  focused: string | null
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
  #themeSubscription: DirectorySubscription | null = null
  #themeRelistTimer: ReturnType<typeof setTimeout> | null = null
  #fontsCache: string[] | null = null
  readonly #clipboardWrite: (text: string) => Promise<void>
  readonly #selectFolder: () => Promise<string | null>
  readonly #now: () => number
  readonly #watch: boolean
  readonly #engine: EngineReadClient
  readonly #managedBundle: string | undefined
  #documentBarrier: Promise<void> | null = null
  #connect = new T3Connect()
  #connectReadiness = new ConnectReadiness()
  #computerSnapshot: ComputerView | null = null
  #setStartAtLogin: (enabled: boolean) => Promise<void>
  #providerSetupPreparing = false
  #providerSetup = new ProviderSetupJobs()
  #manager: LocalEngineManager | null = null
  readonly #preview: PreviewHost
  #previewRestored = false
  #followedThreadsKey = ''
  #unsubscribeEngine: (() => void) | null = null
  readonly #engineDispatching = new Set<string>()
  readonly #sessions = new Map<string, OpenDocumentSession>()
  /** The tail of each document's turn queue; see #withSession. */
  readonly #sessionTurns = new Map<string, Promise<void>>()
  readonly #listeners = new Set<(state: AppView) => void>()
  readonly #tabs: SessionRegistry
  #settings: Settings = structuredClone(DEFAULT_SETTINGS)
  #explorer: ExplorerScanResult = { roots: [], files: [] }
  #explorerScan: { controller: AbortController; done: Promise<void> } | null = null
  #shutdown: Promise<void> | null = null
  #lastView: AppView | null = null

  constructor(options: ApplicationOptions = {}) {
    this.#setStartAtLogin = options.setStartAtLogin ?? (async () => { throw new Error('Start at login is unavailable in this build.') })
    this.#managedBundle = options.managedBundle
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
    // The preview host answers the engine's browser requests and shows pages in the window (docs/plans/open/visual-review, phase 2).
    this.#preview = new PreviewHost({
      dataDirectory: this.#store.dataDirectory, now: this.#now,
      resolveProject: (projectId) => { const project = this.#engine.view().projects.find((candidate) => candidate.id === projectId); return project ? { workspaceRoot: project.workspaceRoot, title: project.title } : null },
      resolveThread: (threadId) => { for (const project of this.#engine.view().projects) { const thread = project.threads.find((candidate) => candidate.id === threadId); if (thread) return { projectId: project.id, workingFolder: thread.worktreePath ?? project.workspaceRoot } } return null },
    })
    this.#engine = options.engine ?? new T3EngineClient({
      dataDirectory: this.#store.dataDirectory, now: this.#now,
      reserveLocalSetup: () => { this.#providerSetupPreparing = true },
      localSetupBusy: () => this.#providerSetupPreparing || this.#providerSetup.busy,
      localUsageAvailable: () => this.#manager !== null,
      askRuntime: () => this.#manager?.runtimeContext() ?? null,
      measureUsage: (provider, settings, signal) => measureLocalUsage(this.#manager?.runtimeContext() ?? null, options.engineUsageHelper ?? resolve('resources/engine-helpers/usage.mjs'), provider, settings, signal),
      previewHost: { operations: this.#preview.operations, handle: (request) => this.#preview.handle(request), setRegistered: (registered) => this.#preview.setRegistered(registered), recheckVisual: (comment) => this.#recheckVisual(comment), compareVisual: (comment, revision) => this.#compareVisual(comment, revision) },
      // Terminal launchers are scripts Strata writes on Linux (§5.13); macOS gets none.
      terminalShimDirectory: isDarwin() ? null : join(this.#store.dataDirectory, 'bin'),
      ...(options.notifications ? { isFocused: () => options.notifications!.isFocused(), notify: (notification) => options.notifications!.notify(notification) } : {}),
    })
    this.#tabs = new SessionRegistry({
      canonicalize: resolveDocumentPath,
      now: this.#now,
      onChange: () => { this.#publish(); this.#scheduleOpenDocumentsPersist() }
    })
  }

  /** Where the open tab set lives between runs: a private file beside the ghost store. */
  get #openDocumentsPath(): string {
    return join(this.#store.dataDirectory, 'open-documents.json')
  }

  #openDocumentsWrite: Promise<void> = Promise.resolve()

  /**
   * Remember the open tabs and the focused one so a restart brings them back
   * (the tab pills are the only record of what is open). Writes are queued and
   * atomic; a failure is logged, never thrown into a tab operation.
   */
  #scheduleOpenDocumentsPersist(): void {
    if (this.#shutdown) return
    const snapshot: OpenDocumentsRecord = {
      formatVersion: 1,
      documents: this.#tabs.list().map((tab) => tab.path),
      focused: this.#tabs.focusedPath,
    }
    this.#openDocumentsWrite = this.#openDocumentsWrite
      .then(() => atomicWriteFile(this.#openDocumentsPath, `${JSON.stringify(snapshot, null, 2)}\n`))
      .catch((error: unknown) => logError('main', 'Open documents could not be remembered', error))
  }

  /**
   * Reopen the tabs a previous run left open, in their old order, and focus the
   * one that was focused. Files that no longer exist or cannot open are skipped
   * quietly; a document opened from the command line afterwards takes focus.
   */
  async restoreOpenDocuments(): Promise<string[]> {
    let record: OpenDocumentsRecord | null = null
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#openDocumentsPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as OpenDocumentsRecord).documents)) record = parsed as OpenDocumentsRecord
    } catch {
      return []
    }
    if (!record) return []
    const reopened: string[] = []
    for (const path of record.documents) {
      if (typeof path !== 'string') continue
      try {
        await this.openDocument(path)
        reopened.push(path)
      } catch (error) {
        logError('main', `A previously open document could not be reopened: ${path}`, error)
      }
    }
    if (typeof record.focused === 'string' && reopened.includes(record.focused)) await this.openDocument(record.focused)
    return reopened
  }

  async initialize(): Promise<this> {
    await this.#store.initialize()
    this.#unsubscribeEngine = this.#engine.subscribe((view) => {
      // The owner's preview tabs come back once the engine lists their projects.
      if (!this.#previewRestored && view.projects.length > 0) { this.#previewRestored = true; void this.#preview.restore().catch((error: unknown) => logError('preview', 'Preview tabs could not be restored', error)) }
      this.#publish()
      void this.#reconcileEngineView(view).catch((error: unknown) => logError('engine', 'Engine delivery reconciliation failed', error))
    })
    this.#preview.subscribe(() => this.#publish())
    this.#settings = await this.#settingsStore.load()
    if (this.#settings.engine.startAtLogin) await this.#setStartAtLogin(true).catch(error => logError('startup', 'Start at login could not be updated for this application folder', error))
    if (this.#managedBundle) {
      let configured = false
      try { configured = !!JSON.parse(await readFile(this.#settingsStore.path, 'utf8')).engine?.mode } catch {}
      let paired = false
      try { paired = !!JSON.parse(await readFile(join(this.#store.dataDirectory, 'engine-credential.json'), 'utf8')).server } catch {}
      const savedMode = configured ? this.#settings.engine.mode : paired ? 'external' : 'managed'
      const override = process.env.STRATAMD_ENGINE_MODE
      if (override && override !== 'external' && override !== 'managed') throw new Error(`Invalid STRATAMD_ENGINE_MODE: ${override}. Use managed or external.`)
      if (!configured) this.#settings = await this.#settingsStore.update({ engine: { ...this.#settings.engine, mode: savedMode } })
      const mode = override ?? savedMode
      if (mode === 'managed') {
        await this.#engine.initialize(false)
        this.#manager = this.#createManager()
        void this.#manager.start()
      } else await this.#engine.initialize()
    } else await this.#engine.initialize()
    await this.#themeStore.ensureDirectory()
    await this.#loadActiveTheme(this.#settings.theme)
    await this.#relistThemes()
    if (this.#watch) await this.#watchThemes()
    // Local references need the roots immediately; discovering every file must
    // not hold up restoring documents or creating the window.
    this.#explorer = { roots: await readExplorerRoots(this.#settings.explorerFolders), files: [] }
    if (this.#settings.explorerFolders.length > 0) {
      void this.refreshExplorer().catch(error => logError('explorer', 'Startup folder scan failed', error))
    }
    return this
  }

  // ---- Themes (PRD §6.13)

  get activeTheme(): LoadedTheme {
    return this.#theme
  }

  /** A settings file that could not be read at startup and was moved aside (plan 4.1). */
  get settingsRecovery(): SettingsRecovery | null {
    return this.#settingsStore.recovery
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
    this.#themeSubscription = await watchDirectory(this.#themeStore.directory, (error, filename) => {
      if (error) return
      const activePath = this.#theme.path
      const activeTouched = activePath !== null && (filename === null || filename === basename(activePath))
      if (this.#themeRelistTimer) clearTimeout(this.#themeRelistTimer)
      this.#themeRelistTimer = setTimeout(() => {
        this.#themeRelistTimer = null
        void this.#themesChangedOnDisk(activeTouched).catch(error => logError('theme', 'Could not refresh themes after a file change', error))
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
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.#themeMissing = true
          else {
            if (!(error instanceof ThemeBrokenError)) throw error
            this.#theme = { ...this.#theme, problems: [{ key: 'file', reason: error.detail }] }
          }
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
      .then(
        () => {
          if (this.#theme.id === id && this.#theme.problems.some((problem) => problem.key === THEME_WRITE_PROBLEM_KEY)) {
            this.#theme = { ...this.#theme, problems: this.#theme.problems.filter((problem) => problem.key !== THEME_WRITE_PROBLEM_KEY) }
          }
          this.#publish()
        },
        (error: unknown) => {
          // The edit is live in memory; only the file is stale. Say so where
          // the theme panel already lists problems, and keep the record.
          logError('theme', `Theme file write failed: ${this.#themeStore.pathFor(id)}`, error)
          if (this.#theme.id === id) {
            const reason = `The theme could not be written to ${this.#themeStore.pathFor(id)}: ${error instanceof Error ? error.message : String(error)}`
            this.#theme = {
              ...this.#theme,
              problems: [
                ...this.#theme.problems.filter((problem) => problem.key !== THEME_WRITE_PROBLEM_KEY),
                { key: THEME_WRITE_PROBLEM_KEY, reason },
              ],
            }
          }
          this.#publish()
        },
      )
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
    this.#explorerScan?.controller.abort()
    await this.#explorerScan?.done.catch(() => undefined)
    if (this.#themeRelistTimer) clearTimeout(this.#themeRelistTimer)
    this.#themeRelistTimer = null
    this.#flushThemeWrite()
    await this.#themeWriteQueue
    await this.#themeSubscription?.unsubscribe()
    this.#themeSubscription = null
    this.#unsubscribeEngine?.()
    this.#unsubscribeEngine = null
    await this.#connect.cancel()
    await this.#providerSetup.cancel()
    this.#providerSetupPreparing = true
    await this.#manager?.stop()
    await this.#preview.shutdown()
    await this.#engine.shutdown()
    const sessions = [...this.#sessions.values()]
    this.#listeners.clear()
    const results = await Promise.allSettled(sessions.map((session) => this.#withSession(session.path, async () => {
      // Typing that has not reached the buffer yet is the user's only copy of
      // it until the next open; the mirror flushes before anything is released.
      try {
        await session.mirror?.flush()
      } catch (error) {
        logError('mirror', `Buffer mirror flush failed during shutdown: ${session.path}`, error)
      }
      session.mirror?.cancel()
      try {
        await this.#persist(session)
      } catch (error) {
        logError('persist', `Persisting document state failed during shutdown: ${session.path}`, error)
      }
      await releaseSessionResources(session)
      this.#sessions.delete(session.path)
      this.#tabs.close(session.path)
    })))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    await this.#openDocumentsWrite
    if (failed) throw failed.reason
  }

  async openDocument(path?: string): Promise<void> {
    if (!path) {
      if (this.#tabs.focusedPath) this.#tabs.focus(this.#tabs.focusedPath)
      return
    }
    const canonical = await resolveDocumentPath(path)
    // Two opens of one closed document (a double click, a CLI call racing the
    // explorer) queue on the same key; the second finds the session the first
    // built and focuses it (plan 4.7).
    await this.#withSession(canonical, () => this.#openLocked(canonical))
  }

  async pairEngine(request: PairEngineRequest): Promise<void> {
    if (this.#providerSetupPreparing || this.#providerSetup.busy || this.#connect.busy) throw new Error('Finish or cancel provider setup before changing engines.')
    const target = resolvePairingTarget(request)
    if (target.server !== this.#engine.view().server && (this.#engineDispatching.size || this.#engine.view().projects.some(project => project.threads.some(thread => thread.status === 'running' || thread.status === 'starting')))) throw new Error('Wait for active work to finish before changing engines.')
    await Promise.all([...this.#sessionTurns.values()])
    await this.#engine.pair(target.server, target.code)
    await this.#manager?.stop(); this.#manager = null
    if (this.#managedBundle) this.#settings = await this.#settingsStore.update({ engine: { ...this.#settings.engine, mode: 'external' } })
    this.#publish()
  }

  #createManager(): LocalEngineManager {
    return new LocalEngineManager({
          directory: join(this.#store.dataDirectory, 'engine'), bundle: this.#managedBundle!,
          changed: () => this.#publish(),
          network: () => this.#settings.engine,
          reserveChange: async () => {
            if (this.#providerSetupPreparing || this.#providerSetup.busy || this.#connect.busy) throw new Error('Finish the current setup first.')
            await this.#engine.prepareLocalSetup?.()
            let resumeDocuments: (() => void) | undefined
            try {
              resumeDocuments = await this.#pauseDocuments()
              await this.#engine.freezeForBackup?.()
              this.#engine.assertNoPendingSends?.()
              for (const session of this.#sessions.values()) await this.#persist(session)
              const identity = this.#engine.view().identity!
              for (const meta of await this.#store.listDocuments()) if (Object.values(documentBinding(meta, identity).attachments).some(attachment => attachment.deliveries.length)) throw new Error(`Finish queued document deliveries before changing the engine: ${meta.realpath}`)
              await this.#engine.shutdown()
            } catch (error) { resumeDocuments?.(); this.#providerSetupPreparing = false; await this.#engine.resumeAfterMaintenance?.(); throw error }
            return async () => { resumeDocuments?.(); this.#providerSetupPreparing = false; await this.#engine.resumeAfterMaintenance?.(); this.#followedThreadsKey = ''; this.#publish() }
          },
          captureState: async directory => {
            const identity = this.#engine.view().identity
            if (!identity) throw new Error('The engine identity is unavailable for backup.')
            const resume = this.#documentBarrier ? null : await this.#pauseDocuments()
            try { for (const session of this.#sessions.values()) await this.#persist(session); await captureStrataEngine(this.#store, identity, directory) } finally { resume?.() }
          },
          restoreState: async directory => {
            const resume = this.#documentBarrier ? null : await this.#pauseDocuments()
            try {
            await this.#engine.shutdown()
            await restoreStrataEngine(this.#store, directory, async (meta, binding, identity, archiveIdentity) => {
              await (async () => {
                const latest = await this.#store.loadMeta(meta.realpath)
                const bindings = { ...latest.engineAttachments, [archiveIdentity]: documentBinding(latest, identity), [identity]: binding }
                const selected = latest.engineIdentity === identity
                const restored = await this.#store.saveMeta({ ...latest, engineAttachments: bindings, ...(selected ? { attachments: binding.attachments, leadAgentId: binding.leadAgentId } : {}) })
                const session = this.#sessions.get(meta.realpath)
                if (session) {
                  if (selected) { session.engineAttachments[archiveIdentity] = { attachments: session.attachments, leadAgentId: session.leadAgentId }; session.attachments = await restoreAttachments(restored, undefined, this.#store, session.payloadBlobs); session.leadAgentId = binding.leadAgentId }
                  else session.engineAttachments[identity] = { attachments: await restoreAttachments({ ...restored, attachments: binding.attachments }, undefined, this.#store, session.payloadBlobs), leadAgentId: binding.leadAgentId }
                  session.meta = restored; session.applicationUndo = []; session.applicationRedo = []
                }
              })()
            })
            await this.#engine.reloadStoredState?.()
            this.#publish()
            } finally { resume?.() }
          },
          connect: async (address, token, identity) => { await this.#engine.pair(address, token, identity); if (this.#engine.view().state !== 'connected') throw new Error(this.#engine.view().problem ?? 'Engine subscriptions are unavailable') },
          authenticate: async address => {
            try { const credential = JSON.parse(await readFile(join(this.#store.dataDirectory, 'engine-credential.json'), 'utf8')); if (credential.server !== address) return false; return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(3000) })).ok } catch { return false }
          },
          reconnect: async () => { await this.#engine.reconnect(); if (this.#engine.view().state !== 'connected') throw new Error(this.#engine.view().problem ?? 'Engine subscriptions are unavailable') },
        })
  }

  async manageEngine(action: 'restart' | 'use-managed' | 'show-log'): Promise<void> {
    if (action === 'show-log') {
      const path = join(this.#store.dataDirectory, 'engine/log/engine.log')
      const { shell } = await import('electron')
      const error = await shell.openPath(path)
      if (error) throw new Error(`Could not open engine log ${path}: ${error}`)
      return
    }
    if (this.#providerSetupPreparing || this.#providerSetup.busy || this.#connect.busy) throw new Error('Finish or cancel provider setup before changing engines.')
    if (!this.#managedBundle) throw new Error('This build has no bundled engine')
    if (this.#engine.view().projects.some(project => project.threads.some(thread => thread.status === 'running' || thread.status === 'starting'))) throw new Error('Wait for active conversations to finish before restarting the engine.')
    if (this.#engine.view().state === 'connected') await this.#engine.prepareLocalSetup?.()
    try {
    if (action === 'use-managed') {
      await Promise.all([...this.#sessionTurns.values()])
      this.#manager ??= this.#createManager()
      await this.#manager.start()
      if (this.#manager.view().state !== 'running') throw new Error(this.#manager.view().problem ?? 'The local engine could not start')
      this.#settings = await this.#settingsStore.update({ engine: { ...this.#settings.engine, mode: 'managed' } })
      this.#publish()
    } else {
      if (!this.#manager) throw new Error('This connection is an external engine')
      await this.#manager.restart()
      if (this.#manager.view().state !== 'running') throw new Error(this.#manager.view().problem ?? 'The engine could not restart.')
    }
    } finally { this.#providerSetupPreparing = false; await this.#engine.resumeAfterMaintenance?.() }
  }

  async engineRecovery(request: import('../shared/engine-recovery').RecoveryRequest): Promise<import('../shared/engine-recovery').RecoveryView> {
    if (!this.#manager) throw new Error('Recovery applies only to the engine on This computer.')
    if (request.action === 'update') await this.#manager.update()
    else if (request.action === 'restore') await this.#manager.restore(request.backupId)
    return this.#manager.recovery()
  }

  async computer(request: ComputerRequest): Promise<ComputerView> {
    const context = this.#manager?.runtimeContext()
    if (!context || !this.#manager) throw new Error('Start the engine on This computer before managing its connections.')
    if (request.action === 'progress' && this.#computerSnapshot && this.#connect.busy) return { ...this.#computerSnapshot, job: this.#connect.view() }
    const connection = async (action: string, payload?: unknown): Promise<any> => {
      if (!this.#engine.connectionRequest) throw new Error('This engine does not support connection management.')
      return this.#engine.connectionRequest(action, payload)
    }
    let createdLink: ComputerView['createdLink']
    if (request.action === 'cancel') await this.#connect.cancel()
    else if (request.action === 'input') this.#connect.input(request.text)
    else if (request.action === 'use-code') this.#connect.useCode()
    else if (request.action === 'download') this.#connect.download(request.accepted)
    else if (request.action !== 'status' && request.action !== 'progress') {
      if (this.#connect.busy || this.#providerSetupPreparing || this.#providerSetup.busy) throw new Error('Finish or cancel the current setup first.')
      if (request.action === 'preferences') {
        if (request.startAtLogin !== this.#settings.engine.startAtLogin) await this.#setStartAtLogin(request.startAtLogin)
        this.#settings = await this.#settingsStore.update({ engine: { ...this.#settings.engine, keepRunning: request.keepRunning, startAtLogin: request.startAtLogin } })
        this.#publish()
      } else if (request.action === 'create-link') {
        const result = await connection('create-link', { label: request.label || 'Strata pairing', scopes: request.scopes })
        createdLink = { credential: result.credential, expiresAt: result.expiresAt }
      } else if (request.action === 'revoke-link') await connection('revoke-link', { id: request.id })
      else if (request.action === 'revoke-device') await connection('revoke-device', { sessionId: request.id })
      else if (request.action === 'network') {
        await this.#engine.prepareLocalSetup?.()
        const previous = this.#settings.engine
        try {
          this.#settings = await this.#settingsStore.update({ engine: { ...previous, lan: request.lan, tailscale: request.tailscale, tailscalePort: request.port } })
          await this.#manager.restart()
          if (this.#manager.view().state !== 'running') throw new Error(this.#manager.view().problem ?? 'The listener could not start.')
        } catch (error) {
          this.#settings = await this.#settingsStore.update({ engine: previous }); await this.#manager.restart(); throw error
        } finally { this.#providerSetupPreparing = false; this.#publish(); await this.#engine.resumeAfterMaintenance?.() }
      } else {
        if (request.action !== 'configure' && request.action !== 'login' && request.action !== 'logout' && request.action !== 'change-account') throw new Error('Unsupported T3 setup action.')
        const setup: ConnectSetupAction = request.action === 'configure' ? { action: 'configure', remote: request.remote, publish: request.publish }
          : request.action === 'login' ? { action: 'login', ...(request.method ? { method: request.method } : {}) } : { action: request.action }
        this.#connect.start(context, async operation => {
          await this.#connectReadiness.watchLog(join(this.#store.dataDirectory, 'engine/log/engine.log'))
          return runConnectSetup(setup, operation, {
          status: () => this.#connect.status(context),
          install: async (signal, progress) => {
            if (!this.#engine.installRelayClient) throw new Error('This engine cannot install connection support. Update Strata and retry.')
            await this.#engine.installRelayClient(signal, progress)
          },
          prepare: async () => { await this.#engine.prepareLocalSetup?.() },
          stop: () => this.#manager!.stop(),
          start: async () => {
            await this.#manager!.start()
            if (this.#manager!.view().state !== 'running') throw new Error(this.#manager!.view().problem ?? 'The local engine could not restart. Open Advanced and restart it.')
          },
          resume: async () => { this.#providerSetupPreparing = false; await this.#engine.resumeAfterMaintenance?.() },
          })
        })
      }
    }
    const problems: string[] = []
    let connect: ComputerView['connect'] = null
    try { connect = await this.#connect.status(context, request.action === 'status') } catch { problems.push('T3 Connect status is unavailable. Check the network and refresh. Local documents remain available.') }
    let remoteEnabled: boolean | null = null
    let links: ComputerView['links'] = [], devices: ComputerView['devices'] = []
    if (!this.#connect.busy && this.#engine.view().state === 'connected') {
      try {
        const live = await connection('state')
        if (connect) { const updated = liveConnectStatus(connect, live); connect = updated.connect; remoteEnabled = updated.remoteEnabled }
        if (request.action === 'progress') links = this.#computerSnapshot?.links ?? []
        else {
          const rows = await connection('links'); if (!Array.isArray(rows)) throw new Error('Pairing links are unsupported.')
          links = rows.map(row => ({ id: row.id, label: row.label, expiresAt: row.expiresAt, scopes: row.scopes }))
        }
        const sessions = await connection('devices'); if (!Array.isArray(sessions)) throw new Error('Paired devices are unsupported.')
        devices = sessions.map(row => ({ sessionId: row.sessionId, label: row.client?.label ?? row.subject ?? 'Paired device', current: row.current === true, connected: row.connected === true }))
      } catch (error) { problems.push(String(error)) }
    }
    let readiness = this.#connectReadiness.read(connect, remoteEnabled, devices)
    if (readiness.connectionState === 'starting' || readiness.connectionState === 'failed') {
      const failure = await this.#connectReadiness.failure()
      if (failure) readiness = { connectionState: 'failed', connectionMessage: failure }
    }
    if (request.action === 'progress' && this.#computerSnapshot) {
      this.#computerSnapshot = { ...this.#computerSnapshot, connect, remoteEnabled, devices, links, problems, account: this.#connect.account, job: this.#connect.view(), ...readiness }
      return this.#computerSnapshot
    }
    const prefs = this.#settings.engine
    const server = this.#engine.view().server
    const endpoints = server ? [server] : []
    if (prefs.lan && server) for (const entries of Object.values(networkInterfaces())) for (const address of entries ?? []) if (!address.internal && address.family === 'IPv4') endpoints.push(`http://${address.address}:${new URL(server).port}`)
    if (prefs.tailscale && server) {
      const endpoint = await readServeEndpoint(server, prefs.tailscalePort ?? 443)
      if (endpoint) endpoints.push(endpoint)
      else problems.push('Tailscale HTTPS is not forwarding to this engine. Check Serve before using a tailnet pairing link.')
    }
    this.#computerSnapshot = { connect, remoteEnabled, account: this.#connect.account, ...readiness, tailscaleStatus: await readTailscale(), job: this.#connect.view(), preferences: { keepRunning: prefs.keepRunning, startAtLogin: prefs.startAtLogin, lan: prefs.lan === true, tailscale: prefs.tailscale === true, port: prefs.tailscalePort ?? 443 }, environmentName: hostname(), endpoints, links, devices, problems, ...(createdLink ? { createdLink } : {}) }
    return this.#computerSnapshot
  }

  async reconnectEngine(): Promise<void> {
    await this.#engine.reconnect()
  }

  async openConversation(threadId: string): Promise<void> {
    await this.#engine.openThread(threadId)
  }

  async createEngineThread(input: StartThreadInput): Promise<string> {
    if (!this.#engine.createThread) throw new Error('This engine cannot create threads')
    return this.#engine.createThread(input)
  }

  async createEngineProject(input: { title: string; workspaceRoot: string; createWorkspaceRootIfMissing?: boolean }): Promise<string> {
    if (!this.#engine.createProject) throw new Error('This engine cannot add projects')
    return this.#engine.createProject(input)
  }

  /**
   * Start thread from a document (§5.7): the picker's thread is created,
   * attached, and its first turn carries the popover's pending comment, the
   * checked drafts, and the document form §5.14 calls for.
   */
  startThreadFromDocument(path: string, input: StartThreadFromDocumentInput): Promise<string> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      if (!this.#engine.createThread) throw new Error('This engine cannot create threads')
      const { comment, draftIds, threadId: existingThreadId, note, ...picker } = input
      if (existingThreadId && !this.#engine.view().projects.find((project) => project.id === input.projectId)?.threads.some((thread) => thread.id === existingThreadId)) throw new Error(`Thread ${existingThreadId} is not in project ${input.projectId}`)
      const threadId = existingThreadId ?? await this.#engine.createThread(picker)
      const attachment = this.#newThreadAttachment(session, threadId)
      if (!attachment) throw new Error('The engine did not list the new thread')
      session.attachments[threadId] = attachment
      let annotations = session.annotations
      if (comment) {
        if (!comment.text.trim()) throw new Error('Write a comment before starting a thread with it')
        const start = this.#anchorQuote(session, comment)
        annotations = createAnnotation(annotations, session.state.shadow, {
          createdAt: this.#now(),
          id: `a_${randomUUID().slice(0, 12)}`,
          kind: comment.kind,
          author: 'user',
          quote: comment.quote,
          text: comment.text,
          start,
          ...(comment.context ? { context: comment.context } : {}),
        }).log
      }
      await this.#sendLocked(session, { recipients: [threadId], note: note ?? '', includeExternal: false, draftIds: draftIds ?? session.drafts.drafts.map((draft) => draft.id) }, annotations)
      return threadId
    })
  }

  async actOnEngineThread(threadId: string, action: 'archive' | 'settle' | 'unsettle' | 'delete'): Promise<void> {
    if (!this.#engine.actOnThread) throw new Error('This engine cannot change threads')
    await this.#engine.actOnThread(threadId, action)
  }

  async updateEngineThread(threadId: string, change: EngineThreadChange): Promise<void> {
    if (!this.#engine.updateThread) throw new Error('This engine cannot change threads')
    await this.#engine.updateThread(threadId, change)
  }

  async parkAccount(instanceId: string, parked: boolean): Promise<void> {
    if (!this.#engine.parkAccount) throw new Error('This engine has no accounts to park')
    await this.#engine.parkAccount(instanceId, parked)
  }

  async setTerminalDefault(driver: string, selection: string | null): Promise<void> {
    if (!this.#engine.setTerminalDefault) throw new Error('This engine has no terminal defaults')
    await this.#engine.setTerminalDefault(driver, selection)
  }

  async readEngineUsage(window: import('../shared/usage').UsageWindow) {
    if (!this.#engine.usageSummary) throw new Error('The engine does not support usage reporting')
    return this.#engine.usageSummary(window)
  }

  async readEngineSettings() {
    if (!this.#engine.readSettings) throw new Error('The engine does not support readSettings')
    return this.#engine.readSettings()
  }

  async providerSetup(request: import('../shared/provider-setup').ProviderSetupRequest) {
    if (request.identity !== (this.#engine.view().identity ?? null)) throw new Error('The selected engine changed. Reopen Accounts.')
    if (request.action === 'status') return this.#providerSetup.view(request.instanceId)
    if (request.action === 'cancel') { await this.#providerSetup.cancel(); return this.#providerSetup.view(request.instanceId) }
    if (request.action === 'input') { this.#providerSetup.input(request.input ?? ''); return this.#providerSetup.view(request.instanceId) }
    const context = this.#manager?.runtimeContext()
    if (!context) throw new Error('Provider setup is available only for This computer. Set up an external account on its own computer.')
    if (this.#engineDispatching.size || this.#engine.view().projects.some(project => project.threads.some(thread => ['starting', 'running'].includes(thread.status)))) throw new Error('Wait for active conversations before changing provider installation or sign-in.')
    const account = this.#engine.view().accounts.find(value => value.instanceId === request.instanceId)
    if (!account) throw new Error(`Account ${request.instanceId} is unavailable.`)
    if (this.#providerSetupPreparing || this.#providerSetup.busy || this.#connect.busy) throw new Error('Finish or cancel provider setup first.')
    await this.#engine.prepareLocalSetup?.()
    try {
    const settings = await this.readEngineSettings()
    if (request.action === 'use-installed') {
      const binary = this.#providerSetup.view(request.instanceId).installedBinary
      if (!binary) throw new Error('No newly installed tool is available for this account.')
      await this.editEngineProvider({ identity: request.identity, instanceId: request.instanceId, base: settings.providerInstances[request.instanceId]!, patch: { config: { binaryPath: binary } } })
      await this.#engine.refreshAccounts?.()
      return this.#providerSetup.view(request.instanceId)
    }
    return await this.#providerSetup.start(request.action, context, account, settings, join(this.#store.dataDirectory, 'engine/providers'), async binary => {
      const base = settings.providerInstances[request.instanceId]!
      await this.editEngineProvider({ identity: request.identity, instanceId: request.instanceId, base, patch: { config: { binaryPath: binary } } })
    }, async () => { await this.#engine.refreshAccounts?.(); await this.#engine.resumeAfterMaintenance?.() })
    } finally { this.#providerSetupPreparing = false; await this.#engine.resumeAfterMaintenance?.() }
  }

  async readEngineSupport() {
    if (!this.#engine.readSupport) return { sourceControl: [], problems: ['This engine does not report source control readiness.'] }
    return this.#engine.readSupport()
  }

  async reportEngineActivity(activity: import('../shared/engine-settings').EngineActivity) {
    await this.#engine.reportActivity?.(activity, this.#manager !== null)
  }

  async editEngineSettings(edit: Parameters<StrataApi['editEngineSettings']>[0]) {
    if (!this.#engine.editSettings) throw new Error('This engine does not support editing settings')
    return this.#engine.editSettings(edit)
  }

  async editEngineProvider(edit: Parameters<StrataApi['editEngineProvider']>[0]) {
    if (!this.#engine.editProvider) throw new Error('This engine does not support editing providers')
    return this.#engine.editProvider(edit)
  }

  async browseEngineFolder(path: string) {
    if (!this.#engine.browseFolder) throw new Error('The engine does not support browseFolder')
    return this.#engine.browseFolder(path)
  }

  async lookupEngineRepository(repository: string) {
    if (!this.#engine.lookupRepository) throw new Error('The engine does not support lookupRepository')
    return this.#engine.lookupRepository(repository)
  }

  async cloneEngineRepository(input: Parameters<StrataApi['cloneEngineRepository']>[0]) {
    if (!this.#engine.cloneRepository) throw new Error('The engine does not support cloneRepository')
    return this.#engine.cloneRepository(input)
  }



  async setModelPreference(instanceId: string, slug: string, preference: Parameters<StrataApi['setModelPreference']>[2]) {
    if (!this.#engine.setModelPreference) throw new Error('The engine does not support setModelPreference')
    return this.#engine.setModelPreference(instanceId, slug, preference)
  }

  async listEngineRefs(cwd: string, query?: string) {
    if (!this.#engine.listRefs) throw new Error('The engine cannot list refs')
    return this.#engine.listRefs(cwd, query)
  }

  async attachEngineTerminal(input: Parameters<StrataApi['attachEngineTerminal']>[0]) {
    if (!this.#engine.attachTerminal) throw new Error('The engine does not support attachTerminal')
    return this.#engine.attachTerminal(input)
  }

  async detachEngineTerminal(attachmentId: string) {
    if (!this.#engine.detachTerminal) throw new Error('The engine does not support detachTerminal')
    return this.#engine.detachTerminal(attachmentId)
  }

  async writeEngineTerminal(input: Parameters<StrataApi['writeEngineTerminal']>[0]) {
    if (!this.#engine.writeTerminal) throw new Error('The engine does not support writeTerminal')
    return this.#engine.writeTerminal(input)
  }

  async resizeEngineTerminal(input: Parameters<StrataApi['resizeEngineTerminal']>[0]) {
    if (!this.#engine.resizeTerminal) throw new Error('The engine does not support resizeTerminal')
    return this.#engine.resizeTerminal(input)
  }

  async closeEngineTerminal(input: Parameters<StrataApi['closeEngineTerminal']>[0]) {
    if (!this.#engine.closeTerminal) throw new Error('The engine does not support closeTerminal')
    return this.#engine.closeTerminal(input)
  }

  onTerminalEvent(listener: (push: import('../shared/contracts').TerminalPush) => void): () => void {
    return this.#engine.onTerminalEvent?.(listener) ?? (() => undefined)
  }

  async refreshAccounts(): Promise<void> {
    if (!this.#engine.refreshAccounts) throw new Error('This engine does not report accounts')
    await this.#engine.refreshAccounts()
  }

  async startConversationTurn(threadId: string, input: Parameters<EngineReadClient['startTurn']>[1]): Promise<void> {
    await this.#engine.startTurn(threadId, input)
  }

  async stageConversationAttachment(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<{ id: string; sizeBytes: number }> {
    if (!this.#engine.stageAttachment) throw new Error('This engine cannot keep attachments')
    return this.#engine.stageAttachment(input)
  }

  async discardConversationAttachment(id: string): Promise<void> {
    if (!this.#engine.discardAttachment) throw new Error('This engine cannot keep attachments')
    await this.#engine.discardAttachment(id)
  }

  async retainConversationAttachments(ids: string[]): Promise<void> {
    if (!this.#engine.retainAttachments) return
    await this.#engine.retainAttachments(ids)
  }

  async holdMessageComment(threadId: string, input: Parameters<import('../shared/contracts').StrataApi['holdMessageComment']>[1]): Promise<string> {
    if (input.id && [...this.#sessions.values()].some(session => session.attachments[threadId]?.deliveries.some(delivery => delivery.conversationContext?.annotations.some(comment => comment.id === input.id)))) throw new Error(`Comment ${input.id} is queued for delivery`)
    if (!this.#engine.holdMessageComment) throw new Error('This engine cannot hold comments')
    return this.#engine.holdMessageComment(threadId, input)
  }
  async actMessageComment(threadId: string, itemId: string, action: 'resolve' | 'reopen' | 'discard'): Promise<void> {
    if ([...this.#sessions.values()].some(session => session.attachments[threadId]?.deliveries.some(delivery => delivery.conversationContext?.annotations.some(comment => comment.id === itemId)))) throw new Error(`Comment ${itemId} is queued for delivery`)
    if (!this.#engine.actMessageComment) throw new Error('This engine cannot update comments')
    await this.#engine.actMessageComment(threadId, itemId, action)
  }
  async runAskScan(identity: string | null, threadId: string, messageId: string): Promise<void> {
    if (identity !== (this.#engine.view().identity ?? null)) throw new Error('The selected engine changed. Reopen the conversation.')
    if (!this.#engine.runAskScan) throw new Error('This engine cannot scan replies')
    await this.#engine.runAskScan(threadId, messageId)
  }
  async cancelAskScan(identity: string | null, threadId: string): Promise<void> {
    if (identity !== (this.#engine.view().identity ?? null)) throw new Error('The selected engine changed. Reopen the conversation.')
    await this.#engine.cancelAskScan?.(threadId)
  }
  async saveAskDraft(identity: string | null, threadId: string, itemId: string, text: string): Promise<void> {
    if (identity !== (this.#engine.view().identity ?? null)) throw new Error('The selected engine changed. Reopen the conversation.')
    if (!this.#engine.saveAskDraft) throw new Error('This engine cannot save answer drafts')
    await this.#engine.saveAskDraft(threadId, itemId, text)
  }

  async queueItemReply(threadId: string, itemId: string, text: string): Promise<void> {
    if (!this.#engine.queueItemReply) throw new Error('This engine cannot queue replies')
    await this.#engine.queueItemReply(threadId, itemId, text)
  }

  async discardItemReply(threadId: string, itemId: string): Promise<void> {
    if (!this.#engine.discardItemReply) throw new Error('This engine cannot queue replies')
    await this.#engine.discardItemReply(threadId, itemId)
  }

  async dismissItem(threadId: string, itemId: string): Promise<void> {
    if (!this.#engine.dismissItem) throw new Error('This engine cannot dismiss items')
    await this.#engine.dismissItem(threadId, itemId)
  }

  async retainVisualEvidence(owner: string, ids: string[]): Promise<void> { await this.#engine.retainVisualEvidence?.(owner, ids) }

  async holdVisualComment(input: Parameters<StrataApi['holdVisualComment']>[0]): Promise<string> {
    if (!this.#engine.holdVisualComment) throw new Error('This engine cannot hold visual comments')
    return this.#engine.holdVisualComment(input)
  }

  async actVisualComment(id: string, action: Parameters<StrataApi['actVisualComment']>[1]): Promise<void> {
    if (!this.#engine.actVisualComment) throw new Error('This engine cannot update visual comments')
    await this.#engine.actVisualComment(id, action)
  }

  /** Bytes behind a strata-visual URL: a piece of evidence or a staged composer image. */
  async readVisualImage(kind: 'evidence' | 'staged', id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    if (!this.#engine.readVisualImage) return null
    return this.#engine.readVisualImage(kind, id)
  }

  // ---- Preview windows (docs/plans/open/visual-review, phase 2)

  get preview(): PreviewHost {
    return this.#preview
  }

  /** The window the preview host draws pages into; the pages themselves outlive it. */
  attachPreviewWindow(window: import('electron').BrowserWindow): void {
    this.#preview.attachWindow(window)
  }

  async openPreviewTab(input: { projectId: string; url?: string }): Promise<string> {
    return this.#preview.openOwnerTab(input)
  }

  async closePreviewTab(tabId: string): Promise<void> {
    this.#preview.closeTab(tabId)
  }

  async navigatePreview(tabId: string, navigation: Parameters<StrataApi['navigatePreview']>[1]): Promise<void> {
    await this.#preview.navigate(tabId, navigation)
  }

  async resizePreview(tabId: string, viewport: Parameters<StrataApi['resizePreview']>[1]): Promise<void> {
    this.#preview.resize(tabId, viewport)
  }

  async resumePreviewTab(tabId: string): Promise<void> {
    this.#preview.resume(tabId)
  }

  async reportPreviewBounds(report: Parameters<StrataApi['reportPreviewBounds']>[0]): Promise<void> {
    this.#preview.reportBounds(report)
  }

  async reportOverlay(open: boolean): Promise<void> {
    this.#preview.setOverlay(open)
  }

  /** Test probe: a real input landing in a tab, the path an owner's click takes. */
  previewHumanInput(tabId: string, point: { x: number; y: number }): void {
    this.#preview.humanInput(tabId, point)
  }

  // ---- Marking up a running page (docs/plans/open/visual-review, phase 3)

  /** Annotate: the current frame goes into the evidence store and comes back with the page it was taken from. */
  async capturePreviewFrame(tabId: string): Promise<VisualPageCapture> {
    if (!this.#engine.storeVisualCapture) throw new Error('This engine cannot keep captures')
    const frame = await this.#preview.captureFrame(tabId)
    if (frame.width === 0 || frame.height === 0) throw new Error('The page gave no picture to mark up. Try again once it has drawn.')
    const id = await this.#engine.storeVisualCapture({ bytes: frame.bytes, width: frame.width, height: frame.height })
    return { tabId, capture: { id, url: visualImageUrl('evidence', id), width: frame.width, height: frame.height, scroll: frame.scroll, scale: frame.scale }, page: frame.page }
  }

  /** What the live page says is at a point or in a box, in page pixels; the identity rides along for the record. */
  async describePreview(tabId: string, target: { point: { x: number; y: number } } | { rect: { x: number; y: number; width: number; height: number } }): Promise<VisualPageProposal | null> {
    const described = await this.#preview.describe(tabId, target)
    if (!described) return null
    const identity = described.identity
    return { kind: described.kind, label: described.label, rect: described.rect, found: described.kind === 'element', ...(identity ? { identity: { role: identity.role, name: identity.name, text: identity.text, testIds: identity.testIds, selector: identity.selector, html: identity.html, style: identity.style, sources: identity.sources, viewportRect: identity.viewportRect, pageRect: identity.pageRect } } : {}) }
  }

  async scrollPreview(tabId: string, move: { by: { x: number; y: number } } | { to: { x: number; y: number } }): Promise<{ x: number; y: number }> {
    return this.#preview.scroll(tabId, move)
  }

  /** Show me: the original tab when it still shows the page, restored to the size and scroll of the comment, with found things outlined. */
  async showVisualComment(id: string): Promise<VisualShowResult> {
    const comment = this.#engine.visualComment?.(id) ?? null
    if (!comment) throw new Error('That visual comment is gone')
    if (comment.anchor.kind !== 'page') return { shown: false, reason: 'This comment is on a pasted image, not a page.', url: null }
    const anchor = comment.anchor
    const tab = this.#preview.tab(anchor.instance)
    if (!tab) return { shown: false, reason: 'That page is no longer open.', url: anchor.url }
    if (samePage(tab.url, anchor.url) === false) return { shown: false, reason: 'That tab shows a different page now.', url: anchor.url }
    const current = comment.draft ?? comment.revisions.at(-1)
    const marks = (current?.marks ?? []).flatMap((mark) => mark.kind === 'element' && mark.identity ? [{ id: mark.id, identity: { selector: mark.identity.selector ?? null, testIds: mark.identity.testIds ?? [], role: mark.identity.role ?? null, name: mark.identity.name ?? null } }] : [])
    const firstCapture = comment.captures.find((capture) => capture.id === current?.marks[0]?.captureId) ?? comment.captures[0]
    const outlined = await this.#preview.show(tab.id, { viewport: anchor.viewport, scroll: firstCapture?.scroll ?? null, marks })
    return { shown: true, tabId: tab.id, outlined }
  }

  // ---- Comparisons and adjustments (docs/plans/open/visual-review, phase 4)

  /** Adjustments: Strata's whole set of overrides goes onto the live page at once, and the result is captured as the requested appearance. */
  async adjustPreview(tabId: string, targets: Parameters<StrataApi['adjustPreview']>[1]): Promise<VisualPageCapture & { applied: string[] }> {
    const applied = await this.#preview.applyOverrides(tabId, targets.map((target) => ({ markId: target.markId, identity: { selector: target.identity.selector ?? null, testIds: target.identity.testIds ?? [], role: target.identity.role ?? null, name: target.identity.name ?? null }, declarations: target.declarations })))
    const capture = await this.capturePreviewFrame(tabId)
    return { ...capture, capture: { ...capture.capture, requested: true }, applied }
  }

  async clearPreviewOverrides(tabId: string): Promise<void> {
    await this.#preview.clearOverrides(tabId)
  }

  /**
   * Then / now: the original crop of the marked target beside Strata's own capture of the same target now, at the same
   * size and scroll, with no override applied. The live tab serves when it still shows the page at that size; otherwise
   * the page opens out of sight at the original size. When the target is not found, the views differ and the note says so.
   */
  async #compareVisual(comment: VisualCommentRecord, revision: VisualRevision): Promise<{ then: { bytes: Uint8Array; width: number; height: number }; now: { bytes: Uint8Array; width: number; height: number } | null; note: string | null } | null> {
    if (comment.anchor.kind !== 'page' || !this.#engine.readVisualImage) return null
    const anchor = comment.anchor
    const mark = revision.marks.find((candidate) => candidate.kind === 'element' && candidate.identity) ?? revision.marks[0]
    if (!mark) return null
    const capture = comment.captures.find((candidate) => candidate.id === mark.captureId)
    const original = capture ? await this.#engine.readVisualImage('evidence', capture.id) : null
    if (!capture || !original) return null
    const scale = capture.scale ?? 1
    // The same window in both pictures: the mark with room around it, in page pixels, so movement stays visible.
    const margin = 48
    const window = { x: Math.max(0, mark.rect.x / scale - margin), y: Math.max(0, mark.rect.y / scale - margin), width: mark.rect.width / scale + margin * 2, height: mark.rect.height / scale + margin * 2 }
    const then = cropPng(original.bytes, window, scale, { width: capture.width, height: capture.height })
    if (!then) return null
    const identity = mark.kind === 'element' && mark.identity ? { selector: mark.identity.selector ?? null, testIds: mark.identity.testIds ?? [], role: mark.identity.role ?? null, name: mark.identity.name ?? null } : null
    const takeNow = async (contents: import('electron').WebContents): Promise<{ now: { bytes: Uint8Array; width: number; height: number } | null; note: string | null }> => {
      if (capture.scroll) await contents.executeJavaScript(pageScrollScript({ to: capture.scroll }), true).catch(() => undefined)
      if (identity) {
        const match = await contents.executeJavaScript(locateScript(identity), true).catch(() => null) as { matches: number } | null
        if (!match || match.matches !== 1) return { now: null, note: `The views differ: ${mark.label} was not found on the page now.` }
      }
      const frame = await this.#preview.frameOf(contents)
      const now = cropPng(frame.bytes, window, frame.scale, { width: frame.width, height: frame.height })
      return now ? { now, note: null } : { now: null, note: 'The views differ: the page could not be captured now.' }
    }
    const tab = this.#preview.tab(anchor.instance)
    let outcome: { now: { bytes: Uint8Array; width: number; height: number } | null; note: string | null }
    const liveSize = tab && samePage(tab.url, anchor.url) ? await this.#preview.viewportOf(tab.id).catch(() => null) : null
    if (tab && liveSize && liveSize.width === anchor.viewport.width && liveSize.height === anchor.viewport.height) {
      outcome = await this.#preview.compareInPlace(tab.id, takeNow)
    } else {
      const project = this.#engine.view().projects.find((candidate) => candidate.id === comment.projectId)
      const workingFolder = anchor.workingFolder ?? project?.workspaceRoot
      if (!workingFolder) return { then, now: null, note: 'The views differ: the page could not be opened.' }
      outcome = await this.#preview.withScratchView({ workingFolder, url: anchor.url, viewport: anchor.viewport }, contents => withCleanPage(contents, () => takeNow(contents))).catch((error: unknown) => ({ now: null, note: `The views differ: the page could not be opened (${error instanceof Error ? error.message : String(error)}).` }))
    }
    return { then, ...outcome }
  }

  /** The re-check before Send: the page must be the one the marks were made on, and every marked thing must still be there. */
  async #recheckVisual(comment: VisualCommentRecord): Promise<{ refusal: string | null; found: Record<string, boolean> }> {
    if (comment.anchor.kind !== 'page' || !comment.draft) return { refusal: null, found: {} }
    const tab = this.#preview.tab(comment.anchor.instance)
    // A closed tab leaves nothing to check; the saved evidence is what travels.
    if (!tab) return { refusal: null, found: {} }
    if (!samePage(tab.url, comment.anchor.url)) return { refusal: visualSendRefusal({ pageReplaced: true, missing: [] }), found: {} }
    const found: Record<string, boolean> = {}
    const missing: string[] = []
    for (const mark of comment.draft.marks) {
      if (mark.kind !== 'element' || !mark.identity) continue
      const match = await this.#preview.locate(tab.id, { selector: mark.identity.selector ?? null, testIds: mark.identity.testIds ?? [], role: mark.identity.role ?? null, name: mark.identity.name ?? null }).catch(() => null)
      found[mark.id] = match !== null && match.matches === 1
      if (!match || match.matches === 0) missing.push(mark.label)
    }
    return { refusal: visualSendRefusal({ pageReplaced: false, missing }), found }
  }

  async stopConversationTurn(threadId: string): Promise<void> {
    await this.#engine.interrupt(threadId)
  }

  async answerEngineApproval(threadId: string, requestId: string, decision: Parameters<EngineReadClient['respondApproval']>[2]): Promise<void> {
    await this.#engine.respondApproval(threadId, requestId, decision)
  }

  async answerEngineUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
    await this.#engine.respondUserInput(threadId, requestId, answers)
  }

  #newThreadAttachment(session: OpenDocumentSession, threadId: string): Attachment | null {
    const thread = this.#engine.view().projects.flatMap((project) => project.threads).find((candidate) => candidate.id === threadId)
    if (!thread) return null
    const current = deliverySnapshot(session)
    return createAttachment({
      id: threadId,
      name: thread.title,
      now: this.#now(),
      snapshot: { ...current, snapshotId: `unseen:${threadId}:${randomUUID()}`, segmentIndex: -1, cursor: 0 },
    })
  }

  #selectDocumentEngine(session: OpenDocumentSession, identity: string | undefined): boolean {
    if (!identity || identity === session.engineIdentity) return false
    for (const annotation of Object.values(session.annotations.annotations)) {
      if (annotation.source && !annotation.source.engineIdentity) annotation.source = { ...annotation.source, engineIdentity: session.engineIdentity ?? 'legacy' }
    }
    if (session.engineIdentity) session.engineAttachments[session.engineIdentity] = { attachments: session.attachments, leadAgentId: session.leadAgentId }
    else if (Object.keys(session.attachments).length) session.engineAttachments.legacy = { attachments: session.attachments, leadAgentId: session.leadAgentId }
    const selected = session.engineAttachments[identity]
    session.attachments = selected?.attachments ?? {}
    session.leadAgentId = selected?.leadAgentId ?? null
    session.engineIdentity = identity
    delete session.engineAttachments[identity]
    session.hunkItemSources.clear()
    this.#clearApplicationHistory(session)
    this.#followedThreadsKey = ''
    return true
  }

  /** Which document a completed message's strata block attaches, by message id; a completed message rarely changes text. */
  readonly #bootstrapDocuments = new Map<string, { text: string; document: string | null }>()

  #bootstrapDocumentOf(message: AppView['engine']['projects'][number]['threads'][number]['messages'][number]): string | null {
    const cached = this.#bootstrapDocuments.get(message.id)
    if (cached && cached.text === message.text) return cached.document
    const block = parseStrataBlock(message.text)
    const entry = block?.results.length === 1 ? block.results[0]?.entry : undefined
    const document = entry?.verb === 'attach' ? entry.document : null
    this.#bootstrapDocuments.set(message.id, { text: message.text, document })
    return document
  }

  #engineIdentity(): string | undefined {
    return this.#engine.identity ?? this.#engine.view().identity
  }

  async #reconcileEngineView(view: AppView['engine']): Promise<void> {
    const acknowledged = new Set(view.projects.flatMap((project) => project.threads.flatMap((thread) => thread.messages.map((message) => message.id))))
    const listed = new Set(acknowledged)
    for (const id of this.#bootstrapDocuments.keys()) if (!listed.has(id)) this.#bootstrapDocuments.delete(id)
    let anyChanged = false
    for (const session of [...this.#sessions.values()]) {
      await this.#withSession(session.path, async () => {
        if (this.#sessions.get(session.path) !== session || view.identity !== this.#engineIdentity()) return
        let changed = this.#selectDocumentEngine(session, view.identity)
        for (const thread of view.projects.flatMap((project) => project.threads)) {
          if (session.attachments[thread.id]) continue
          const bootstrap = thread.messages.find((message) => message.role === 'assistant' && !message.streaming && this.#bootstrapDocumentOf(message) === session.path)
          if (!bootstrap) continue
          const attachment = this.#newThreadAttachment(session, thread.id)
          if (!attachment) continue
          session.attachments[thread.id] = attachment
          await this.#enqueueDeliveries(session, { recipients: [thread.id], note: '', includeExternal: false }, [thread.id], 'send')
          session.attachments[thread.id] = {
            ...session.attachments[thread.id]!, processedMessageIds: [bootstrap.id], pendingBlockOutcomes: ['1. applied'],
          }
          changed = true
        }
        for (const [threadId, current] of Object.entries(session.attachments)) {
          let attachment = current
          while (attachment.deliveries[0] && acknowledged.has(attachment.deliveries[0].id)) {
            const deliveryId = attachment.deliveries[0].id
            const result = acknowledgeDelivery(attachment, deliveryId)
            if (!result.acknowledged) break
            attachment = result.attachment
            this.#engineDispatching.delete(`${session.path}\0${threadId}\0${deliveryId}`)
            changed = true
          }
          session.attachments[threadId] = attachment
          // Retention off (PRD §6.5): a resolved record goes once every attachment has received it, which an acknowledgment may complete.
          if (changed) session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
          const engineThread = view.projects.flatMap((project) => project.threads).find((thread) => thread.id === threadId)
          for (const message of engineThread?.messages ?? []) {
            if (message.role === 'assistant' && !message.streaming) changed = await this.#applyStrataMessage(session, threadId, message.id, message.turnId ?? message.id, message.text) || changed
          }
        }
        if (changed) { anyChanged = true; await this.#persist(session) }
        await this.#dispatchEngineDeliveries(session)
      })
    }
    // Every engine update already published the application state before this ran.
    if (anyChanged) this.#publish()
  }

  async #applyStrataMessage(session: OpenDocumentSession, threadId: string, messageId: string, turnId: string, text: string): Promise<boolean> {
    let attachment = session.attachments[threadId]
    if (!attachment || attachment.processedMessageIds?.includes(messageId)) return false
    const parsed = parseStrataBlock(text)
    if (!parsed) return false
    const outcomes: Array<{ index: number; status: 'applied' | 'failed'; itemId?: string; reason?: string; candidates?: string[] }> = []
    // Every edit in one message extends the same segment: one message is one round of the agent's work.
    let editedInMessage = false
    for (const result of parsed.results) {
      if (result.conversationTarget) continue
      if (!result.entry) { outcomes.push({ index: result.index, status: 'failed', reason: result.error ?? 'Malformed entry' }); continue }
      const entry = result.entry
      if ('anchor' in entry) {
        if ('message' in entry.anchor) continue
        if ('document' in entry.anchor && entry.anchor.document !== session.path) continue
        if ('item' in entry.anchor && (entry.anchor.item.startsWith('c_') || entry.anchor.item.startsWith('m_') || entry.anchor.item.startsWith('v_') || [...this.#sessions.values()].some(other => other !== session && other.annotations.annotations[(entry.anchor as { item: string }).item]))) continue
      }
      if ('document' in entry && entry.document !== session.path) continue
      try {
        if (entry.verb === 'attach') throw new Error('attach must be the only entry in an unattached thread')
        const holder = session.leadAgentId
        const holderLabel = holder ? `${session.attachments[holder]?.name ?? holder} (${holder})` : null
        const requireLead = () => { if (holder !== threadId) throw new Error(holderLabel ? `NOT_LEAD: ${holderLabel} holds the Lead` : 'NOT_LEAD: no agent holds the Lead') }
        if (entry.verb === 'lead') {
          if (entry.document !== session.path) throw new Error(`document is not open: ${entry.document}`)
          if (entry.action === 'claim') {
            // A claim while another thread holds the Lead is denied naming the holder; the owner transfers it (§5.6).
            if (holder && holder !== threadId) throw new Error(`LEAD_TAKEN: ${holderLabel} already holds the Lead`)
            session.leadAgentId = threadId
          } else if (holder === threadId) session.leadAgentId = null
          outcomes.push({ index: result.index, status: 'applied' })
          continue
        }
        if (entry.verb === 'save') {
          if (entry.document !== session.path) throw new Error(`document is not open: ${entry.document}`)
          requireLead()
          try { await this.#saveLocked(session.path) } catch (error) { throw new Error(`SAVE_BLOCKED: ${error instanceof Error ? error.message : String(error)}`) }
          outcomes.push({ index: result.index, status: 'applied' })
          continue
        }
        if ('item' in entry.anchor) {
          // Item-anchored verbs act on annotations the agent or its peers posted (§5.9); the Lead gates accept, reject, and resolving others' work.
          const annotation = session.annotations.annotations[entry.anchor.item]
          if (!annotation) throw new Error(`item ${entry.anchor.item} was not found`)
          if (entry.verb === 'reply') {
            session.annotations = replyToAnnotation(session.annotations, annotation.id, { id: `r_${randomUUID().slice(0, 12)}`, author: 'agent', agent: threadId, name: attachment.name, text: entry.text, createdAt: this.#now() }).log
            outcomes.push({ index: result.index, status: 'applied', itemId: annotation.id })
            continue
          }
          if (annotation.kind === 'decision' && (entry.verb === 'resolve' || entry.verb === 'accept' || entry.verb === 'reject')) throw new Error('DECISION_OWNER_REQUIRED: decision answers are owner-only')
          if (entry.verb === 'resolve') {
            if (annotation.agent !== threadId || (annotation.source?.engineIdentity && annotation.source.engineIdentity !== session.engineIdentity)) requireLead()
            session.annotations = resolveAnnotationThread(session.annotations, annotation.id, 'agent', threadId).log
            session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
            outcomes.push({ index: result.index, status: 'applied', itemId: annotation.id })
            continue
          }
          if (entry.verb === 'accept') {
            requireLead()
            const accepted = acceptAnnotationSuggestion(session.annotations, session.state.shadow, annotation.id, 'agent', threadId)
            if (accepted.userChange) {
              const change = accepted.userChange
              const beforeHunks = new Set(session.state.pendingHunks.map((hunk) => hunk.id))
              // The Lead's accept lands like any agent edit: one application step the owner can undo (PRD §6.1).
              const author = { agentId: threadId, name: attachment.name }
              await this.#applyApplicationStep(session, () => {
                session.state = acceptAgentReplacement(session.state, { from: change.start, to: change.end, insert: change.added }, author, { extend: editedInMessage })
              })
              editedInMessage = true
              session.mirror?.schedule(session.state.shadow)
              for (const hunk of session.state.pendingHunks) if (!beforeHunks.has(hunk.id)) session.hunkItemSources.set(hunk.id, { threadId, turnId, messageId })
              session.annotations = relocateOpenAnnotations(mapAnnotationsThroughEdit(accepted.log, { start: change.start, deleteCount: change.end - change.start, insertText: change.added }), session.state.shadow)
            } else {
              session.annotations = accepted.log
            }
            session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
            outcomes.push({ index: result.index, status: 'applied', itemId: annotation.id })
            continue
          }
          if (entry.verb === 'reject') {
            requireLead()
            session.annotations = rejectAnnotationSuggestion(session.annotations, annotation.id, 'agent', threadId).log
            session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
            outcomes.push({ index: result.index, status: 'applied', itemId: annotation.id })
            continue
          }
          throw new Error(`${entry.verb} needs a document anchor, not an item`)
        }
        if (entry.verb === 'reply') throw new Error('reply needs an item anchor')
        if (!('document' in entry.anchor) || entry.anchor.document !== session.path) throw new Error('entry does not target this document')
        const block = 'block' in entry.anchor && attachment.blockMap ? resolveBlock(attachment.blockMap, entry.anchor.block) : null
        const quote = 'quote' in entry.anchor ? entry.anchor.quote : block?.text
        // A quoted-text anchor (plan §5.9 fallback) must occur exactly once; otherwise the outcome names the nearest places.
        const start = 'quote' in entry.anchor ? locateQuoteAnchor(session.state.shadow, entry.anchor.quote) : block?.from ?? -1
        if (!quote || start < 0 || session.state.shadow.slice(start, start + quote.length) !== quote) {
          throw new Error(`block ${'block' in entry.anchor ? entry.anchor.block : 'quote'} changed`)
        }
        if (entry.verb === 'comment' || entry.verb === 'question' || entry.verb === 'decision' || entry.verb === 'suggest') {
          const itemId = `a_${randomUUID().slice(0, 12)}`
          const created = createAnnotation(session.annotations, session.state.shadow, {
            createdAt: this.#now(), id: itemId, kind: entry.verb === 'suggest' ? 'suggestion' : entry.verb,
            author: 'agent', agent: threadId, name: attachment.name, quote,
            text: entry.verb === 'suggest' ? entry.replacement : entry.text, start,
            source: { ...(session.engineIdentity ? { engineIdentity: session.engineIdentity } : {}), threadId, turnId, messageId },
            ...(entry.verb === 'decision' ? { anchorKind: 'quote' as const, options: entry.options } : {}),
          })
          session.annotations = created.log
          outcomes.push({ index: result.index, status: 'applied', itemId })
          continue
        }
        if (entry.verb === 'edit') {
          const relative = quote.indexOf(entry.match)
          if (relative < 0 || quote.indexOf(entry.match, relative + Math.max(1, entry.match.length)) >= 0) throw new Error('edit match is missing or ambiguous in the block')
          const from = start + relative
          const beforeHunks = new Set(session.state.pendingHunks.map((hunk) => hunk.id))
          // An agent edit is an application step: the owner's undo walks it in order with their typing (PRD §6.1).
          const author = { agentId: threadId, name: attachment.name }
          await this.#applyApplicationStep(session, () => {
            session.state = acceptAgentReplacement(session.state, { from, to: from + entry.match.length, insert: entry.replace }, author, { extend: editedInMessage })
          })
          editedInMessage = true
          session.mirror?.schedule(session.state.shadow)
          for (const hunk of session.state.pendingHunks) {
            if (!beforeHunks.has(hunk.id)) session.hunkItemSources.set(hunk.id, { threadId, turnId, messageId })
          }
          outcomes.push({ index: result.index, status: 'applied' })
          continue
        }
        throw new Error(`${entry.verb} is not valid for this anchor`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // Nearest block ids help only when the anchor itself failed, not when the Lead or the owner rule refused the verb.
        const candidates = reason.startsWith('block ') ? attachment.blockMap?.blocks.slice(0, 3).map((candidate) => candidate.id) : undefined
        outcomes.push({ index: result.index, status: 'failed', reason, ...(candidates?.length ? { candidates } : {}) })
      }
    }
    attachment = {
      ...session.attachments[threadId]!,
      processedMessageIds: [...(attachment.processedMessageIds ?? []), messageId],
      pendingBlockOutcomes: blockOutcomeLines(outcomes),
    }
    session.attachments[threadId] = attachment
    return true
  }

  async #dispatchEngineDeliveries(session: OpenDocumentSession): Promise<void> {
    for (const threadId of Object.keys(session.attachments)) await this.#dispatchEngineDelivery(session, threadId)
  }

  async #dispatchEngineDelivery(session: OpenDocumentSession, threadId: string): Promise<void> {
    if (session.engineIdentity && session.engineIdentity !== this.#engine.view().identity) return
    const delivery = collectOldest(session.attachments[threadId]!)
    if (!delivery) return
    const thread = this.#engine.view().projects.flatMap((project) => project.threads).find((candidate) => candidate.id === threadId)
    if (!thread) return
    const key = `${session.path}\0${threadId}\0${delivery.id}`
    if (this.#engineDispatching.has(key)) return
    this.#engineDispatching.add(key)
    const changes = delivery.payload.segments?.reduce((total, segment) => total + segment.hunks.length, 0) ?? 0
    const items = (delivery.payload.annotations?.length ?? 0) + (delivery.payload.replies?.length ?? 0)
      + (delivery.payload.answers?.length ?? 0) + (delivery.payload.resolved?.length ?? 0) + (delivery.payload.edits?.length ?? 0)
    const note = `Delivery ${delivery.id}: ${changes} change${changes === 1 ? '' : 's'}, ${items} item${items === 1 ? '' : 's'}.`
    try {
      await this.#engine.startTurn(threadId, {
        ...delivery.conversation,
        ...(delivery.conversationContext ? { context: delivery.conversationContext } : {}),
        text: note,
        model: thread.model,
        effort: thread.effort,
        access: thread.access,
        messageId: delivery.id,
        commandId: `strata-${delivery.id}`,
        attachments: [{ kind: 'text', name: `${delivery.id}.md`, text: delivery.payload.text }],
      })
    } catch (error) {
      this.#engineDispatching.delete(key)
      logError('engine', `Delivery ${delivery.id} could not be dispatched to thread ${threadId}`, error)
    }
  }

  /** The paths of every open document whose buffer differs from the file. */
  dirtyDocumentPaths(): string[] {
    return [...this.#sessions.values()]
      .filter((session) => session.state.shadow !== session.state.disk)
      .map((session) => session.path)
  }

  /**
   * One async turn per document (plan 2.4). Every method that reads and then
   * writes a session across an await runs inside it, including socket
   * commands, watcher merges, and background persists, so no two of them
   * interleave. The lock is not reentrant: a method that needs another
   * session operation calls its #...Locked form.
   */
  async #pauseDocuments(): Promise<() => void> {
    let resume!: () => void
    this.#documentBarrier = new Promise<void>(resolve => { resume = resolve })
    await Promise.all([...this.#sessionTurns.values()])
    return () => { this.#documentBarrier = null; resume() }
  }

  async #withSession<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (this.#documentBarrier) await this.#documentBarrier
    const previous = this.#sessionTurns.get(path) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => turn)
    this.#sessionTurns.set(path, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#sessionTurns.get(path) === tail) this.#sessionTurns.delete(path)
    }
  }

  async #openLocked(canonical: string): Promise<void> {
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
        drafts: createDraftStore(),
        attachments: {},
        leadAgentId: null,
        engineIdentity: this.#engine.view().identity, engineAttachments: {},
        sourceMode: true,
        reading: { ...DEFAULT_READING_STATE },
        walkthroughIndex: { markdown: state.shadow, headings: [], sections: [], nextId: 1 },
        walkthroughUpdate: { durationMs: 0, hashedSections: 0, rebuilt: false },
        readingDirty: false,
        sourceOnly: true,
        readOnly: true,
        invalidUtf8: true,
        deleted: false,
        problems: new Set<DocumentProblem>(),
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
        metaDirty: false,
        metaTimer: null,
        segmentTimes: new Map(),
        hunkTimes: new Map(),
        hunkItemSources: new Map(),
        payloadBlobs: new WeakMap(),
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
    const payloadBlobs = new WeakMap<object, string>()
    const attachments = { ...await restoreAttachments(meta, saved?.attachments, this.#store, payloadBlobs) }
    const engineAttachments: OpenDocumentSession['engineAttachments'] = {}
    for (const [identity, binding] of Object.entries(meta.engineAttachments ?? {})) {
      engineAttachments[identity] = { attachments: await restoreAttachments({ ...meta, attachments: binding.attachments }, undefined, this.#store, payloadBlobs), leadAgentId: binding.leadAgentId }
    }
    let originalIdentity: string | undefined
    try { originalIdentity = JSON.parse(await readFile(join(this.#store.dataDirectory, 'engine-identity.json'), 'utf8')).identity } catch {}
    const storedReading = await readReadingState(this.#store.pathsForDocument(canonical).reading)
    const draftPath = this.#store.pathsForDocument(canonical).drafts
    let drafts = await readDraftStore(draftPath)
    const materializedDraftIds = drafts.drafts
      .filter((draft) => annotations.annotations[draft.id] !== undefined)
      .map((draft) => draft.id)
    if (materializedDraftIds.length > 0) {
      const duplicates = new Set(materializedDraftIds)
      drafts = { ...drafts, drafts: drafts.drafts.filter((draft) => !duplicates.has(draft.id)) }
      for (const id of materializedDraftIds) {
        logError('drafts', `Stored draft ${id} was dropped because its annotation already exists: ${draftPath}`)
      }
      try {
        await writeDraftStore(draftPath, drafts)
      } catch (error) {
        logError('drafts', `Duplicate drafts could not be removed from ${draftPath}`, error)
      }
    }
    const parsedShadow = parseMarkdown(state.shadow)
    const walkthroughIndex = buildWalkthroughIndex(state.shadow, 1, parsedShadow)
    const reconciledWalkthrough = reconcileWalkthroughState(storedReading.walkthrough, walkthroughIndex)
    const reconciledTables = reconcileTableViews(storedReading.tables, state.shadow, parsedShadow)
    const reconciledFolds = reconcileFoldedHeadings(storedReading.foldedHeadings, walkthroughIndex)
    const session: OpenDocumentSession = {
      path: canonical,
      diskHash: disk.hash,
      state,
      segmentOffset: meta.segmentOffset,
      annotations: relocateOpenAnnotations(annotations, state.shadow),
      drafts,
      attachments,
      engineIdentity: meta.engineIdentity ?? originalIdentity, engineAttachments,
      leadAgentId: typeof meta.leadAgentId === 'string' && attachments[meta.leadAgentId] !== undefined
        ? meta.leadAgentId
        : null,
      sourceMode: persistedBoolean(meta.sourceMode) ?? saved?.sourceMode ?? false,
      reading: { ...storedReading, walkthrough: reconciledWalkthrough, tables: reconciledTables, foldedHeadings: reconciledFolds },
      walkthroughIndex,
      walkthroughUpdate: { durationMs: 0, hashedSections: 0, rebuilt: false },
      readingDirty: JSON.stringify(storedReading.walkthrough) !== JSON.stringify(reconciledWalkthrough)
        || JSON.stringify(storedReading.tables) !== JSON.stringify(reconciledTables)
        || JSON.stringify(storedReading.foldedHeadings) !== JSON.stringify(reconciledFolds),
      sourceOnly: false,
      readOnly: false,
      invalidUtf8: false,
      deleted: false,
      problems: new Set<DocumentProblem>(),
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
      attachWaitVersions: {},
      meta,
      metaDirty: false,
      metaTimer: null,
      segmentTimes: new Map(meta.segments.flatMap((segment) => segment.id ? [[segment.id, segment.time] as const] : [])),
      hunkTimes: restoredHunkTimes(meta, state, this.#now()),
      hunkItemSources: new Map(),
      payloadBlobs,
    }
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    const tracked = await openTrackedDocument(canonical)
    session.documentHandle = tracked.handle
    session.identity = tracked.identity
    try {
      session.lock = await this.#store.acquireLock(canonical, DEFAULT_LOCK_TIMEOUT_MS)
    } catch (error) {
      await tracked.handle.close()
      throw error
    }
    this.#sessions.set(canonical, session)
    await this.#tabs.open(canonical)
    void this.#dispatchEngineDeliveries(session)
    void this.#reconcileEngineView(this.#engine.view())

    if (!buffer || (!recovery && bufferText !== disk.text)) {
      await this.#store.writeBuffer(canonical, state.shadow)
    }
    this.#installMirrorAndWatcher(session)
    await session.reconciler?.initialize('open')
    await this.#persist(session)
    this.#publish()
  }

  closeDocument(path: string, decision?: 'save' | 'discard' | 'cancel'): Promise<'closed' | 'needs-decision' | 'cancelled'> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      if (session.state.shadow !== session.state.disk && !decision) return 'needs-decision'
      if (decision === 'cancel') return 'cancelled'
      if (decision === 'save') await this.#saveLocked(path)
      if (decision === 'discard') {
        await session.mirror?.flush()
        this.#clearApplicationHistory(session)
        session.state = discardOnClose(session.state)
        session.mirror?.cancel()
        await this.#store.writeBuffer(path, session.state.disk)
        await this.#persist(session)
      }
      session.mirror?.cancel()
      await releaseSessionResources(session)
      this.#sessions.delete(path)
      this.#tabs.close(path)
      return 'closed'
    })
  }

  updateBuffer(path: string, content: string, origin: BufferOrigin = 'edit'): Promise<void> {
    return this.#withSession(path, async () => {
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
      session.annotations = relocateOpenAnnotations(session.annotations, session.state.shadow)
      session.mirror?.schedule(session.state.shadow)
      await this.#persist(session, { debounce: true })
      this.#publish()
    })
  }

  undo(path: string): Promise<'undone' | 'empty'> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      const entry = session.applicationUndo.pop()
      if (!entry) return 'empty'
      this.#restoreApplicationStep(session, entry.before, undoAnnotationStep(session.annotations, entry.annotations))
      session.applicationRedo.push(entry)
      await this.#changed(session)
      return 'undone'
    })
  }

  redo(path: string): Promise<'redone' | 'empty'> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      const entry = session.applicationRedo.pop()
      if (!entry) return 'empty'
      this.#restoreApplicationStep(session, entry.after, redoAnnotationStep(session.annotations, entry.annotations))
      session.applicationUndo.push(entry)
      await this.#changed(session)
      return 'redone'
    })
  }

  save(path: string): Promise<void> {
    return this.#withSession(path, () => this.#saveLocked(path))
  }

  async #saveLocked(path: string): Promise<void> {
    const session = this.#writable(path)
    await session.reconciler?.wake('before-save')
    if (session.state.conflicts.length > 0) throw new Error('Resolve external changes before saving')
    // The state at the moment of the write is what the save describes. If
    // the shadow moves before the write returns, the clean state is derived
    // from this capture and the session stays dirty by the difference.
    const captured = session.state
    const content = captured.shadow
    const cancelOwnedWrite = session.reconciler?.noteOwnedWrite('document', content)
    const result = await saveDocumentWithHashCheck(
      path,
      content,
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
    const prepared = prepareSave(captured, captured.disk)
    if (prepared.status !== 'saved') throw new Error('The document changed on disk')
    // Record the round before the state flips: the content this save replaced,
    // the content it wrote, and the previous save's time as the round threshold
    // (falling back to lastSavedAt on stores whose history predates the format).
    // A save that changed nothing records nothing (PRD §6.7).
    if (captured.disk !== prepared.content) {
      const beforeBlob = await this.#persistContent(session, captured.disk)
      session.pendingSaveRecord = {
        beforeBlob,
        afterBlob: contentHash(prepared.content),
        threshold: session.saves.at(-1)?.time ?? session.lastSavedAt ?? Number.NEGATIVE_INFINITY,
      }
    }
    session.state = applySavedContent(session.state, prepared.state)
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
  saveRound(path: string, index: number): Promise<{ hunks: RoundHunkView[] }> {
    return this.#withSession(path, async () => {
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
    })
  }

  setSourceMode(path: string, source: boolean): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      session.sourceMode = session.sourceOnly || source
      await this.#persist(session)
      this.#publish()
    })
  }

  updateReadingState(path: string, patch: Partial<Pick<ReadingState, 'navigationTab' | 'reviewTab'>>): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      const next: ReadingState = { ...session.reading, ...patch, formatVersion: CURRENT_READING_VERSION }
      if (!session.invalidUtf8) await writeReadingState(this.#store.pathsForDocument(path).reading, next)
      session.reading = next
      this.#publish()
    })
  }

  updateWalkthrough(path: string, action: WalkthroughAction): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      const walkthrough = applyWalkthroughAction(session.reading.walkthrough, action, session.walkthroughIndex)
      session.reading = {
        ...session.reading,
        ...(action.type === 'start' ? { navigationTab: 'contents' as const } : {}),
        walkthrough,
        formatVersion: CURRENT_READING_VERSION,
      }
      if (!session.invalidUtf8) await writeReadingState(this.#store.pathsForDocument(path).reading, session.reading)
      session.readingDirty = false
      this.#publish()
    })
  }

  updateTableView(path: string, state: TableViewState): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      session.reading = normalizeReadingState({
        ...session.reading,
        tables: upsertTableView(session.reading.tables, state),
        formatVersion: CURRENT_READING_VERSION,
      })
      if (!session.invalidUtf8) await writeReadingState(this.#store.pathsForDocument(path).reading, session.reading)
      session.readingDirty = false
      this.#publish()
    })
  }

  updateFold(path: string, heading: HeadingReference, folded: boolean): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      const existing = reconcileFoldedHeadings(session.reading.foldedHeadings, session.walkthroughIndex)
      // A folded heading keeps its editor source identity while it is renamed.
      // That update reaches this method before the debounced buffer does, so a
      // valid new reference may briefly be absent from the main-process index.
      // The next open reconciles it conservatively against the updated text.
      const canonical = reconcileFoldedHeadings([heading], session.walkthroughIndex)[0]
        ?? normalizeHeadingReference(heading)
      if (!canonical) return
      const key = JSON.stringify(canonical)
      const without = existing.filter((candidate) => JSON.stringify(candidate) !== key)
      session.reading = normalizeReadingState({
        ...session.reading,
        foldedHeadings: folded ? [...without, canonical] : without,
        formatVersion: CURRENT_READING_VERSION,
      })
      if (!session.invalidUtf8) await writeReadingState(this.#store.pathsForDocument(path).reading, session.reading)
      session.readingDirty = false
      this.#publish()
    })
  }

  keepHunk(path: string, hunkId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      await this.#applyApplicationStep(session, () => {
        this.#recordVerdict(session, hunkId, 'hunk-kept')
        session.state = keepPendingHunk(session.state, hunkId)
      })
      await this.#changed(session)
    })
  }

  revertHunk(path: string, hunkId: string, confirmMixed = false): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      await this.#applyApplicationStep(session, () => {
        const result = revertPendingHunk(session.state, hunkId, confirmMixed)
        if (result.status === 'confirmation-required') throw new Error('Reverting this mixed hunk requires confirmation')
        this.#recordVerdict(session, hunkId, 'hunk-reverted')
        session.state = result.state
      })
      await this.#changed(session)
    })
  }

  markReviewed(path: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      await this.#applyApplicationStep(session, () => {
        for (const hunk of session.state.pendingHunks) this.#recordVerdict(session, hunk.id, 'hunk-kept')
        session.state = reviewAll(session.state)
      })
      await this.#changed(session)
    })
  }

  /** The author of a kept or reverted hunk learns the verdict as an event, never as its own text diffed back (PRD §6.3). */
  #recordVerdict(session: OpenDocumentSession, hunkId: string, type: 'hunk-kept' | 'hunk-reverted'): void {
    const hunk = session.state.pendingHunks.find((candidate) => candidate.id === hunkId)
    if (hunk?.author.agentId == null) return
    const added = session.state.shadow.slice(hunk.shadow.from, hunk.shadow.to)
    const removed = session.state.ghost.slice(hunk.ghost.from, hunk.ghost.to)
    session.annotations = recordHunkVerdict(session.annotations, type, hunk.author.agentId, verdictQuote(removed, added))
  }

  addAnnotation(path: string, annotation: CreateAnnotationRequest): Promise<string> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      const start = annotation.kind === 'decision' && annotation.anchor === 'document'
        ? 0
        : this.#anchorQuote(session, annotation)
      const id = `a_${randomUUID().slice(0, 12)}`
      session.annotations = createAnnotation(session.annotations, session.state.shadow, {
        createdAt: this.#now(),
        id,
        kind: annotation.kind,
        author: 'user',
        quote: annotation.quote,
        text: annotation.text,
        start,
        ...(annotation.kind !== 'decision' && annotation.context ? { context: annotation.context } : {}),
        ...(annotation.kind === 'decision' ? { anchorKind: annotation.anchor, options: annotation.options } : {}),
      }).log
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
      return id
    })
  }

  holdDraft(path: string, draft: CreateDraftRequest): Promise<string> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      if (!draft.text.trim()) throw new Error('Write a comment before holding it')
      const start = this.#anchorQuote(session, draft)
      const id = `d_${randomUUID().slice(0, 12)}`
      session.drafts = addHeldDraft(session.drafts, session.state.shadow, {
        ...draft,
        id,
        from: start,
        to: start + draft.quote.length,
        createdAt: this.#now(),
      })
      await writeDraftStore(this.#store.pathsForDocument(path).drafts, session.drafts)
      this.#publish()
      return id
    })
  }

  discardDraft(path: string, draftId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      const next = removeDraft(session.drafts, draftId)
      if (next === session.drafts) return
      session.drafts = next
      await writeDraftStore(this.#store.pathsForDocument(path).drafts, session.drafts)
      this.#publish()
    })
  }

  quickSend(path: string, draft: QuickSendRequest): Promise<string[]> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      if (draft.recipients.length === 0) throw new Error('Select at least one recipient')
      if (!draft.text.trim()) throw new Error('Write a comment before sending it')
      await session.mirror?.flush()
      for (const recipient of new Set(draft.recipients)) {
        if (!session.attachments[recipient]) {
          const created = this.#newThreadAttachment(session, recipient)
          if (!created) throw new Error(`Thread ${recipient} was not found`)
          session.attachments[recipient] = created
        }
      }
      const start = this.#anchorQuote(session, draft)
      const id = `a_${randomUUID().slice(0, 12)}`
      const created = createAnnotation(session.annotations, session.state.shadow, {
        createdAt: this.#now(),
        id,
        kind: draft.kind,
        author: 'user',
        quote: draft.quote,
        text: draft.text,
        start,
        ...(draft.context ? { context: draft.context } : {}),
      })
      const recipients = [...new Set(draft.recipients)]
      const annotation = toDeliveredAnnotation(created.annotation)
      const deliveries = recipients.map((recipient) => freezeQuickSend(session.attachments[recipient]!, {
        file: session.path,
        buffer: this.#store.pathsForDocument(session.path).buffer,
        annotation,
        now: this.#now(),
      }))
      const selected = new Map(recipients.map((recipient, index) => [recipient, deliveries[index]!]))
      session.annotations = created.log
      session.attachments = Object.fromEntries(Object.entries(session.attachments).map(([id, attachment]) => {
        const settled = attachment.deliveredSeqs.includes(created.event.seq)
          ? attachment.deliveredSeqs
          : [...attachment.deliveredSeqs, created.event.seq]
        const delivery = selected.get(id)
        const next = { ...attachment, deliveredSeqs: settled }
        return [id, delivery === undefined ? next : enqueueDelivery(next, delivery)]
      }))
      await this.#persist(session)
      for (const recipient of recipients) void this.#dispatchEngineDelivery(session, recipient)
      this.#publish()
      return deliveries.map((delivery) => delivery.id)
    })
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

  #materializeDrafts(session: OpenDocumentSession, ids: readonly string[], base: AnnotationLog = session.annotations): AnnotationLog {
    let log = base
    for (const id of [...new Set(ids)]) {
      const draft = session.drafts.drafts.find((item) => item.id === id)
      if (!draft) throw new Error(`Draft ${id} was not found`)
      const location = relocateDraft(draft, session.state.shadow)
      if (location.status !== 'attached' || location.from === null) {
        throw new Error(`Draft ${id} no longer matches its quoted text`)
      }
      log = createAnnotation(log, session.state.shadow, {
        createdAt: draft.createdAt,
        id: draft.id,
        kind: draft.kind,
        author: 'user',
        quote: draft.anchor.quote,
        text: draft.text,
        start: location.from,
        ...(draft.context ? { context: draft.context } : {}),
      }).log
    }
    return log
  }

  requoteAnnotation(path: string, annotationId: string, range: { quote: string; from: number; to: number }): Promise<void> {
    return this.#withSession(path, async () => {
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
    })
  }

  reply(path: string, annotationId: string, text: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      session.annotations = replyToAnnotation(session.annotations, annotationId, {
        createdAt: this.#now(),
        id: `r_${randomUUID().slice(0, 12)}`,
        author: 'user',
        text
      }).log
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
    })
  }

  resolveAnnotation(path: string, annotationId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      session.annotations = resolveAnnotationThread(session.annotations, annotationId).log
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
    })
  }

  answerDecision(path: string, annotationId: string, answer: { option: string | null; other?: string }): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      session.annotations = answerAnnotationDecision(session.annotations, annotationId, {
        ...answer,
        answeredAt: this.#now(),
      }).log
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
    })
  }

  reopenDecision(path: string, annotationId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      session.annotations = reopenAnnotationDecision(session.annotations, annotationId).log
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
    })
  }

  acceptSuggestion(path: string, annotationId: string): Promise<void> {
    return this.#withSession(path, async () => {
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
    })
  }

  rejectSuggestion(path: string, annotationId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      session.annotations = rejectAnnotationSuggestion(session.annotations, annotationId).log
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
    })
  }

  acceptAllSuggestions(path: string, agentId: string): Promise<{ accepted: string[]; skipped: string[] }> {
    return this.#withSession(path, async () => {
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
    })
  }

  rejectAllSuggestions(path: string, agentId: string): Promise<string[]> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      const result = rejectAllAnnotationSuggestions(session.annotations, agentId)
      session.annotations = result.log
      session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
      return [...result.rejected]
    })
  }

  clearResolvedAnnotations(path: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      session.annotations = clearResolvedAnnotationLog(session.annotations)
      session.applicationRedo = []
      await this.#persist(session)
      this.#publish()
    })
  }

  resolveRecovery(path: string, decision: 'recover' | 'discard'): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      if (session.readOnly) throw new Error('This document is read-only')
      if (!session.recovery) return
      this.#clearApplicationHistory(session)
      if (decision === 'recover') {
        const buffer = await this.#store.readBuffer(path)
        if (buffer) {
          const meta = session.meta ?? await this.#store.loadMeta(path)
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
    })
  }

  resolveConflict(path: string, conflictId: string, decision: 'mine' | 'incoming'): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      await this.#applyApplicationStep(session, () => {
        session.state = resolveExternalConflict(session.state, conflictId, decision)
      })
      await this.#changed(session)
    })
  }

  previewSend(path: string, request: SendPreviewRequest): Promise<SendPreview[]> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      const token = this.#documentToken(session)
      const annotations = this.#materializeDrafts(session, request.draftIds ?? [])
      return Promise.all(request.recipients.map(async (id) => {
        const attachment = session.attachments[id] ?? this.#newThreadAttachment(session, id)
        if (!attachment) throw new Error(`Thread ${id} was not found`)
        const delivery = freezeDelivery(attachment, await this.#deliverySource(session, request, id, 'send', annotations, attachment))
        return {
          recipient: agentIdentity(id, attachment.name, Object.keys(session.attachments).indexOf(id)),
          text: delivery.payload.text + (() => {
            const context = this.#conversationContext(id, delivery.id, request)
            return context ? '\n' + renderConversationDelivery(context) : ''
          })(),
          token,
          items: delivery.payload.event === 'resync' ? { changes: [], events: [] } : this.#sendItems(session, attachment, annotations, new Set(request.draftIds ?? [])),
          ...(delivery.payload.event === 'resync' ? { resync: true } : {}),
          ...(attachment.deliveries.at(-1) ? { queuedAfter: attachment.deliveries.at(-1)!.id } : {}),
          dependentExternalHunks: dependentExternalHunkCount(
            session.state,
            deliveryStart(attachment).segmentIndex,
            session.segmentOffset,
          )
        }
      }))
    })
  }

  send(path: string, request: SendPreviewRequest): Promise<string[]> {
    return this.#withSession(path, async () => {
      const session = this.#writable(path)
      if (request.recipients.length === 0) throw new Error('Select at least one recipient')
      return this.#sendLocked(session, request)
    })
  }

  /** One Send inside the session turn: attach unknown recipients, freeze, persist, dispatch. */
  async #sendLocked(session: OpenDocumentSession, request: SendPreviewRequest, annotations: AnnotationLog = session.annotations): Promise<string[]> {
    {
      const path = session.path
      await session.mirror?.flush()
      for (const recipient of new Set(request.recipients)) {
        if (!session.attachments[recipient]) {
          const created = this.#newThreadAttachment(session, recipient)
          if (!created) throw new Error(`Thread ${recipient} was not found`)
          session.attachments[recipient] = created
        }
      }
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
      const materializedIds = [...new Set(request.draftIds ?? [])]
      const nextAnnotations = this.#materializeDrafts(session, materializedIds, annotations)
      let nextDrafts = session.drafts
      for (const id of materializedIds) nextDrafts = removeDraft(nextDrafts, id)
      const deliveries = await this.#enqueueDeliveries(session, request, request.recipients, 'send', nextAnnotations)
      session.annotations = nextAnnotations
      session.drafts = nextDrafts
      session.state = markSendBoundary(session.state)
      session.lastSentSegmentIndex = currentSegmentIndex(session)
      session.lastSentAnnotationSeq = session.annotations.nextSeq - 1
      this.#clearApplicationHistory(session)
      await Promise.all([
        this.#persist(session),
        ...(materializedIds.length > 0
          ? [writeDraftStore(this.#store.pathsForDocument(path).drafts, session.drafts)]
          : []),
      ])
      for (const id of request.recipients) void this.#dispatchEngineDelivery(session, id)
      this.#publish()
      return deliveries.map((delivery) => delivery.id)
    }
  }

  async copyText(text: string): Promise<void> {
    await this.#clipboardWrite(text)
  }

  async addFolder(): Promise<void> {
    const folder = await this.#selectFolder()
    if (!folder) return
    this.#settings = await this.#settingsStore.update({ explorerFolders: [...this.#settings.explorerFolders, folder] })
    await this.scanFolder(folder)
  }

  async removeFolder(path: string): Promise<void> {
    const target = resolve(path)
    const folders = this.#settings.explorerFolders.filter((folder) => folder !== target)
    if (folders.length === this.#settings.explorerFolders.length) return
    this.#settings = await this.#settingsStore.update({ explorerFolders: folders })
    await this.refreshExplorer()
  }

  async scanFolder(path: string): Promise<void> {
    const folders = [...new Set([...this.#settings.explorerFolders, resolve(path)])]
    if (folders.length !== this.#settings.explorerFolders.length) this.#settings = await this.#settingsStore.update({ explorerFolders: folders })
    await this.#scanExplorer(true)
  }

  refreshExplorer(): Promise<void> {
    return this.#scanExplorer(false)
  }

  #scanExplorer(seed: boolean): Promise<void> {
    if (this.#shutdown) return Promise.resolve()
    const previous = this.#explorerScan
    previous?.controller.abort()
    const controller = new AbortController()
    const { signal } = controller
    const folders = this.#settings.explorerFolders
    const done = (async () => {
      // A newer folder change cancels and drains the old scan, so stale results
      // cannot put a removed folder back or race ghost creation.
      await previous?.done.catch(() => undefined)
      signal.throwIfAborted()
      const scan = seed
        ? await scanAndSeedExplorer(folders, this.#store, signal)
        : await scanExplorer(folders, { knownDocuments: await this.#store.listDocuments(), signal })
      signal.throwIfAborted()
      this.#explorer = scan
      this.#publish()
    })().catch(error => {
      if (!signal.aborted) throw error
    }).finally(() => {
      if (this.#explorerScan?.controller === controller) this.#explorerScan = null
    })
    this.#explorerScan = { controller, done }
    return done
  }

  async forgetDocument(path: string): Promise<void> {
    if (this.#sessions.has(path)) throw new Error('Close the document before forgetting it')
    await this.#store.forgetDocument(path)
    // Forgetting runs the object-store garbage collector, so every session
    // re-proves its blobs on the next persist instead of trusting a cache.
    for (const session of this.#sessions.values()) {
      session.persistedBlobs = new Set()
      session.persistedContentBlobs = new Map()
      session.payloadBlobs = new WeakMap()
    }
    await this.refreshExplorer()
  }

  async updateSettings(settings: Partial<Omit<AppSettingsView, 'theme'>>): Promise<void> {
    this.#settings = await this.#settingsStore.update({
      ...(settings.animatedBackground === undefined ? {} : { ambientMotion: settings.animatedBackground }),
      ...(settings.panelSizes === undefined ? {} : { panels: settings.panelSizes }),
      ...(settings.zoom === undefined ? {} : { zoom: settings.zoom })
    })
    this.#publish()
  }

  /** Header dimensions by canonical path and file version; shared in flight and bounded so a long transcript cannot grow it. */
  readonly #imageMetadata = new Map<string, Promise<{ width: number; height: number } | null>>()

  async resolveLocalImage(documentPath: string, source: string): Promise<LocalImageResolution | null> {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//') || source.includes('\0')) return null
    // A conversation's synthetic document resolves against its project's
    // workspace, like its Markdown links do (§6.15); no session is created for it.
    const projectBase = this.#engine.view().projects.some(project => join(project.workspaceRoot, '.conversation.md') === documentPath)
    const basePath = projectBase ? documentPath : this.#require(documentPath).path
    try {
      const safe = await resolveAllowedLocalPath(source, basePath, this.#settings.explorerFolders)
      if (!safe) return null
      const details = await stat(safe, { bigint: true })
      const version = `${details.size}:${details.mtimeNs}`
      const dimensions = await this.#imageDimensions(safe, version)
      return { url: localImageUrl(safe), path: safe, version, ...(dimensions ?? {}) }
    } catch {
      return null
    }
  }

  #imageDimensions(path: string, version: string): Promise<{ width: number; height: number } | null> {
    const key = `${path}\0${version}`
    const cached = this.#imageMetadata.get(key)
    if (cached) return cached
    const pending = (async () => {
      const handle = await open(path, 'r')
      try {
        const bytes = Buffer.alloc(IMAGE_HEADER_BYTES)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        return imageDimensionsFromHeader(bytes.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    })().catch(() => null)
    // Older versions of the same file are superseded; the newest entries stay.
    for (const existing of [...this.#imageMetadata.keys()]) if (existing.startsWith(`${path}\0`)) this.#imageMetadata.delete(existing)
    this.#imageMetadata.set(key, pending)
    if (this.#imageMetadata.size > 512) this.#imageMetadata.delete(this.#imageMetadata.keys().next().value!)
    return pending
  }

  async resolveLocalLink(input: { projectId: string | null; href: string; documentPath?: string }): Promise<LocalLinkTarget> {
    const projects = this.#engine.view().projects
    const project = input.projectId ? projects.find((candidate) => candidate.id === input.projectId) : null
    // A relative link in a document resolves against that document's folder, as its Markdown references and the
    // copy menu do. The base is trusted only when it names an open document or a project's conversation file.
    const documentPath = input.documentPath
    const trustedDocument = documentPath !== undefined && (projects.some(candidate => join(candidate.workspaceRoot, '.conversation.md') === documentPath) || this.#sessions.has(documentPath))
    return resolveLocalLink(input.href, trustedDocument ? dirname(documentPath) : project?.workspaceRoot ?? null)
  }

  async resolveLocalMarkdown(documentPath: string, source: string): Promise<LocalMarkdownPreview | null> {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//') || source.includes('\0')) return null
    const projectBase = this.#engine.view().projects.some(project => join(project.workspaceRoot, '.conversation.md') === documentPath)
    const basePath = projectBase ? documentPath : this.#require(documentPath).path
    let request: string
    try {
      request = decodeURIComponent(source.split(/[?#]/u, 1)[0] ?? '')
    } catch {
      return null
    }
    if (!request || !['.md', '.markdown'].includes(extname(request).toLowerCase())) return null
    try {
      const safe = await resolveAllowedLocalPath(request, basePath, this.#settings.explorerFolders)
      if (!safe || !['.md', '.markdown'].includes(extname(safe).toLowerCase())) return null
      const limit = 256 * 1024
      const handle = await open(safe, 'r')
      try {
        const bytes = Buffer.alloc(limit + 1)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        let end = Math.min(bytesRead, limit)
        let source: string | null = null
        while (end >= Math.max(0, Math.min(bytesRead, limit) - 3)) {
          try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
            break
          } catch {
            end -= 1
          }
        }
        return source === null ? null : { path: safe, source, truncated: bytesRead > limit }
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  async recheckFocused(): Promise<void> {
    const path = this.#tabs.focusedPath
    if (!path) return
    await this.#withSession(path, async () => {
      await this.#sessions.get(path)?.reconciler?.wake('focus')
    })
  }

  /** The user's transfer or revoke from the attachments panel; authoritative over agent claims. */
  setLead(path: string, agentId: string | null): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      if (agentId !== null && !session.attachments[agentId]) {
        throw new Error(`Attachment ${agentId} was not found`)
      }
      session.leadAgentId = agentId
      await this.#persist(session)
      this.#publish()
    })
  }

  /** Ends only this document/thread link; the engine thread is untouched. */
  detachThread(path: string, agentId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      if (!session.attachments[agentId]) throw new Error(`Attachment ${agentId} was not found`)
      this.#removeAttachment(session, agentId)
      await this.#persist(session)
      this.#publish()
    })
  }

  #removeAttachment(session: OpenDocumentSession, agentId: string): void {
    delete session.attachments[agentId]
    if (session.leadAgentId === agentId) session.leadAgentId = null
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
  }

  async #mergeExternalText(
    session: OpenDocumentSession,
    source: ExternalSource,
    incoming: string,
  ): Promise<ExternalChangeResult['status']> {
    let status: ExternalChangeResult['status'] = 'ignored'
    await this.#applyApplicationStep(session, () => {
      const result = applyExternalChange(
        session.state,
        source,
        incoming,
        {
          blockRanges: markdownBlockRanges(
            source === 'disk' ? session.state.disk : session.state.mirror,
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
      status = result.status
      return result.status === 'applied'
    })
    return status
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
        await this.#mergeExternalText(session, change.source === 'document' ? 'disk' : 'buffer', incoming)
        if (change.source === 'document') {
          session.diskHash = change.current.hash
          session.deleted = false
          await this.#replaceDocumentHandle(session, session.path)
          session.mirror?.schedule(session.state.shadow)
        }
        await this.#persist(session, { debounce: true })
        this.#publish()
      }
    })
    session.reconciler = reconciler
    session.mirror = new DebouncedMirror({
      writer: { write: async (content) => {
        const cancelOwnedWrite = reconciler.noteOwnedWrite('buffer', content)
        await this.#store.writeBuffer(session.path, content).catch((error: unknown) => {
          cancelOwnedWrite()
          throw error
        })
      } },
      onWritten: (content) => {
        // The mirror is what agents can read; it moves only once the write
        // landed, so a failed write never claims the buffer holds new text.
        this.#persistInBackground(session, () => {
          session.state = recordMirrorWrite(session.state, content)
          if (session.problems.delete('mirror')) this.#publish()
        }, { debounce: true })
      },
      onError: (error) => {
        this.#reportProblem(session, 'mirror', 'Buffer mirror write failed', error)
      }
    })
    if (this.#watch) {
      session.watcher = new WatchCoordinator({
        documentPath: session.path,
        bufferPath: paths.buffer,
        // Every wake runs as a turn on the document, so a merge from disk
        // never interleaves with a save or an edit in flight.
        reconcile: (reason) => this.#withSession(session.path, () => reconciler.wake(reason)),
        onError: (error) => {
          this.#reportProblem(session, 'watch', 'File watcher reported an error', error)
        }
      })
      session.watcher.start().then(
        () => { if (session.problems.delete('watch')) this.#publish() },
        (error: unknown) => {
          this.#reportProblem(session, 'watch', 'File watcher could not start', error)
        },
      )
    }
  }

  /**
   * Records a background failure on the session, logs it, and shows it in the
   * window. Background jobs (mirror writes, watching, persisting) run outside
   * any user action, so this banner is their only path to the user.
   */
  #reportProblem(session: OpenDocumentSession, kind: DocumentProblem, message: string, error: unknown): void {
    logError(kind, `${message}: ${session.path}`, error)
    if (!session.problems.has(kind)) {
      session.problems.add(kind)
      this.#publish()
    }
  }

  /**
   * A persist nobody awaits, run as its own turn on the document so it never
   * writes a state another operation is halfway through changing. Its
   * failure is reported instead of dropped. A session closed in the meantime
   * is left alone: its final state was written by the close.
   */
  #persistInBackground(session: OpenDocumentSession, before?: () => void, options: PersistOptions = {}): void {
    this.#withSession(session.path, async () => {
      if (this.#sessions.get(session.path) !== session) return
      before?.()
      await this.#persist(session, options)
    }).catch((error: unknown) => {
      this.#reportProblem(session, 'persist', 'Persisting document state failed', error)
    })
  }

  /**
   * The tracked descriptor answers first; failing that, only the document's
   * own directory is searched. Walking every explorer root on each missing
   * file was a full tree scan per event; a move across roots is picked up by
   * an explicit explorer refresh instead (plan 4.4).
   */
  async #findRename(session: OpenDocumentSession): Promise<string | null> {
    if (!session.identity) return null
    const trackedPath = await pathForTrackedDocument(session)
    if (trackedPath && trackedPath !== session.path) return trackedPath
    return findMarkdownByIdentity([dirname(session.path)], session.identity, [session.path])
  }

  async #followRename(session: OpenDocumentSession, target: string): Promise<void> {
    const previous = session.path
    await session.watcher?.stop()
    session.mirror?.cancel()
    session.meta = await this.#store.moveDocument(previous, target, session.lock)
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

  /**
   * Bring meta.json up to date with the session. Typing, mirror writes, and
   * watcher merges ask for a debounced write: they arrive many times a second
   * and the buffer mirror already carries the text. Everything else (a save,
   * a send, an annotation, a close) writes at once.
   */
  async #persist(session: OpenDocumentSession, options: PersistOptions = {}): Promise<void> {
    if (session.invalidUtf8) return
    const walkthrough = updateWalkthroughIndex(session.walkthroughIndex, session.state.shadow, session.reading.walkthrough)
    session.walkthroughIndex = walkthrough.index
    session.walkthroughUpdate = { durationMs: walkthrough.durationMs, hashedSections: walkthrough.hashedSections, rebuilt: walkthrough.rebuilt }
    if (walkthrough.changed) {
      session.reading = { ...session.reading, walkthrough: walkthrough.state }
      session.readingDirty = true
    }
    if (session.readingDirty) {
      await writeReadingState(this.#store.pathsForDocument(session.path).reading, session.reading)
      session.readingDirty = false
    }
    // One clock read stamps this pass's new segments and any save entry it
    // lands, so a round threshold of strict greater-than never splits a save
    // from the segments persisted with it.
    const now = this.#now()
    for (const segment of session.state.segments) {
      if (!session.segmentTimes.has(segment.id)) session.segmentTimes.set(segment.id, now)
    }
    for (const hunk of session.state.pendingHunks) {
      if (!session.hunkTimes.has(hunk.id)) session.hunkTimes.set(hunk.id, now)
    }
    if (options.debounce) {
      session.metaDirty = true
      if (!session.metaTimer) {
        session.metaTimer = setTimeout(() => {
          session.metaTimer = null
          this.#persistInBackground(session)
        }, META_WRITE_DEBOUNCE_MS)
        session.metaTimer.unref?.()
      }
      return
    }
    await this.#flushMeta(session, now)
  }

  /** Test hook: resolves once every pending meta write for `path` (or all documents) has reached disk. */
  async flushPersistence(path?: string): Promise<void> {
    const sessions = path === undefined
      ? [...this.#sessions.values()]
      : [this.#sessions.get(path)].filter((session): session is OpenDocumentSession => session !== undefined)
    await Promise.all(sessions.map((session) => this.#withSession(session.path, async () => {
      if (this.#sessions.get(session.path) !== session) return
      if (session.metaDirty || session.metaTimer) await this.#flushMeta(session)
    })))
  }

  async #flushMeta(session: OpenDocumentSession, persistNow = this.#now()): Promise<void> {
    if (session.metaTimer) {
      clearTimeout(session.metaTimer)
      session.metaTimer = null
    }
    session.metaDirty = false
    session.meta ??= await this.#store.loadMeta(session.path)
    const existing = session.meta
    const ghostBlob = await this.#persistContent(session, session.state.ghost)
    const diskBlob = await this.#persistContent(session, session.state.disk)
    const shadowBlob = await this.#persistContent(session, session.state.shadow)
    const mirrorBlob = await this.#persistContent(session, session.state.mirror)
    // Snapshots live only as long as something names them: a segment
    // boundary, a delivery baseline, the current contents. Anything else is a
    // keystroke's leftover and is dropped here rather than written (plan 2.6).
    session.state = pruneSnapshots(session, [ghostBlob, diskBlob, shadowBlob, mirrorBlob])
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
    const segments: SegmentMeta[] = session.state.segments.map((segment) => ({
      id: segment.id,
      beforeBlob: segment.beforeSnapshotId,
      afterBlob: segment.afterSnapshotId,
      author: segment.author,
      ...(segment.attribution ? { tag: segment.attribution } : {}),
      time: session.segmentTimes.get(segment.id) ?? previousSegmentTimes.get(segment.id) ?? persistNow,
    }))
    const liveSegmentIds = new Set(session.state.segments.map((segment) => segment.id))
    for (const id of [...session.segmentTimes.keys()]) {
      if (!liveSegmentIds.has(id)) session.segmentTimes.delete(id)
    }
    // A hunk's stamp lives as long as an undo or redo could bring the hunk back;
    // otherwise Keep, undo, Keep would show the hunk as brand new.
    const pendingHunks: PendingHunkMeta[] = persistPendingHunkAnchors(session.state).map((anchor) => ({
      ...anchor,
      changedAt: session.hunkTimes.get(anchor.id) ?? persistNow,
    }))
    const liveHunkIds = new Set([
      session.state.pendingHunks,
      ...[...session.applicationUndo, ...session.applicationRedo].flatMap((entry) => [entry.before.pendingHunks, entry.after.pendingHunks]),
    ].flat().map((hunk) => hunk.id))
    for (const id of [...session.hunkTimes.keys()]) {
      if (!liveHunkIds.has(id)) session.hunkTimes.delete(id)
    }
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
    const attachments: Record<string, AttachmentMeta> = {}
    for (const [id, attachment] of Object.entries(session.attachments)) {
      attachments[id] = await persistAttachment(this.#store, session.payloadBlobs, attachment)
    }
    const engineAttachments: Record<string, { attachments: Record<string, AttachmentMeta>; leadAgentId: string | null }> = {}
    for (const [identity, binding] of Object.entries(session.engineAttachments)) {
      const stored: Record<string, AttachmentMeta> = {}
      for (const [id, attachment] of Object.entries(binding.attachments)) stored[id] = await persistAttachment(this.#store, session.payloadBlobs, attachment)
      engineAttachments[identity] = { attachments: stored, leadAgentId: binding.leadAgentId }
    }
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
      pendingHunks,
      segments,
      conflicts: session.state.conflicts,
      nextId: session.state.nextId,
      forceNewUserSegment: session.state.forceNewUserSegment,
      attachments,
      leadAgentId: session.leadAgentId,
      ...(session.engineIdentity ? { engineIdentity: session.engineIdentity } : {}),
      engineAttachments,
      annotationEvents: session.annotations.events,
      annotations: session.annotations.annotations,
      nextAnnotationSeq: session.annotations.nextSeq,
      sourceMode: session.sourceMode,
      lastSavedAt: session.lastSavedAt,
      lastSentSegmentIndex: session.lastSentSegmentIndex,
      lastSentAnnotationSeq: session.lastSentAnnotationSeq,
    })
    session.meta = persisted
    const removedCount = persisted.segmentOffset - session.segmentOffset
    if (removedCount > 0) {
      session.state = { ...session.state, segments: session.state.segments.slice(removedCount) }
      session.segmentOffset = persisted.segmentOffset
      session.state = pruneSnapshots(session, [ghostBlob, diskBlob, shadowBlob, mirrorBlob])
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
    if (session.problems.delete('persist')) this.#publish()
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

  #conversationContext(threadId: string, deliveryId: string, request: SendPreviewRequest) {
    const thread = this.#engine.view().projects.flatMap(project => project.threads).find(thread => thread.id === threadId)
    if (!thread) return null
    const selection = request.conversation?.[threadId]
    const comments = Object.entries(selection?.comments ?? {}).map(([id, revision]) => {
      const comment = thread.comments?.find(comment => comment.id === id && comment.revision === revision && comment.state === 'held')
      if (!comment) throw new Error(`Comment ${id} changed. Review the delivery again.`)
      return comment
    })
    const replies = Object.fromEntries(Object.entries(selection?.replies ?? {}).map(([id, text]) => {
      if (thread.items?.find(item => item.id === id)?.draftReply !== text) throw new Error(`Reply ${id} changed. Review the delivery again.`)
      return [id, { text }]
    }))
    if (!comments.length && !Object.keys(replies).length && !thread.outcomes?.length) return null
    return structuredClone(conversationDelivery(threadId, deliveryId, comments, replies, thread.messages, thread.outcomes ?? []))
  }

  async #enqueueDeliveries(
    session: OpenDocumentSession,
    request: SendPreviewRequest,
    recipients: readonly string[],
    event: 'send' = 'send',
    annotations: AnnotationLog = session.annotations,
  ) {
    const prepared = await Promise.all(recipients.map(async (id) => {
      const attachment = session.attachments[id]
      if (!attachment) throw new Error(`Attachment ${id} was not found`)
      const delivery = freezeDelivery(attachment, await this.#deliverySource(session, request, id, event, annotations))
      const context = this.#conversationContext(id, delivery.id, request)
      return { id, attachment, delivery: { ...delivery, ...(request.conversation?.[id] ? { conversation: request.conversation[id] } : {}), ...(context ? { conversationContext: context } : {}) } }
    }))
    // Validate every recipient before consuming any selection or action outcomes.
    for (const { id, attachment, delivery } of prepared) {
      session.attachments[id] = enqueueDelivery(attachment, delivery)
      if (attachment.pendingBlockOutcomes?.length) session.attachments[id] = { ...session.attachments[id]!, pendingBlockOutcomes: [] }
    }
    const deliveries = prepared.map(entry => entry.delivery)
    return deliveries
  }

  async #deliverySource(
    session: OpenDocumentSession,
    request: SendPreviewRequest,
    recipient: string,
    event: 'send' = 'send',
    annotations: AnnotationLog = session.annotations,
    attachmentOverride?: Attachment,
  ): Promise<DeliverySource> {
    const targetAttachment = attachmentOverride ?? session.attachments[recipient]!
    const cursor = annotations.nextSeq - 1
    const fromCursor = deliveryStart(targetAttachment).cursor
    const start = deliveryStart(targetAttachment)
    const baselineWithinHistory = start.segmentIndex >= session.segmentOffset - 1
    const baselineAvailable = baselineWithinHistory && await this.#store.hasObject(start.snapshotId)
    const skippedEvents = !baselineAvailable
      ? new Set<number>()
      : new Set(targetAttachment.deliveredSeqs)
    const slice = annotationDeliverySlice(
      annotations,
      baselineAvailable ? fromCursor : 0,
      recipient,
      new Set(request.excludedEvents ?? []),
      skippedEvents,
    )
    return {
      ...(request.conversation?.[recipient] ? { id: request.conversation[recipient].deliveryId } : {}),
      file: session.path,
      buffer: this.#store.pathsForDocument(session.path).buffer,
      snapshot: {
        snapshotId: contentHash(session.state.shadow),
        segmentIndex: currentSegmentIndex(session),
        cursor,
        document: session.state.shadow
      },
      segments: indexedSegments(session.state, session.segmentOffset, session.state.shadow),
      annotations: withAttachmentNames(slice.annotations, this.#attachmentName(session)),
      replies: slice.replies,
      answers: slice.answers,
      resolved: slice.resolved,
      edits: slice.edits,
      note: [request.note, ...(targetAttachment.pendingBlockOutcomes?.length ? ['Strata block outcomes:', ...targetAttachment.pendingBlockOutcomes] : [])].filter(Boolean).join('\n'),
      includeExternal: request.includeExternal,
      excludedHunks: request.excludedHunks ?? [],
      eventsLeftOut: slice.excluded > 0,
      event,
      now: this.#now(),
      baselineAvailable,
    }
  }

  #attachmentName(session: OpenDocumentSession): (agent: string) => string | undefined {
    return (agent) => session.attachments[agent]?.name
  }

  /** Everything one recipient could receive, independent of the current selection, for the composer's checkboxes. */
  #sendItems(session: OpenDocumentSession, attachment: Attachment, annotations: AnnotationLog = session.annotations, draftIds: ReadonlySet<string> = new Set()): SendItems {
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
    const slice = annotationDeliverySlice(
      annotations,
      start.cursor,
      attachment.id,
      new Set(),
      new Set(attachment.deliveredSeqs),
    )
    const requoted = new Set(slice.resolved.filter((item) => item.resolution === 'requoted').map((item) => item.id))
    const answerItems = new Map(slice.answers.map((answer) => [answer.seq, {
      seq: answer.seq,
      kind: 'answer' as const,
      annotationKind: 'decision' as const,
      author: 'user' as const,
      text: answer.option === null ? `Other: ${answer.other ?? ''}` : answer.option,
      quote: answer.parent.text,
    }]))
    for (const annotation of slice.annotations) {
      if (annotation.kind !== 'decision' || annotation.decision === undefined) continue
      for (const answer of annotation.decision.answers) {
        if (answer.seq <= start.cursor) continue
        answerItems.set(answer.seq, {
          seq: answer.seq,
          kind: 'answer',
          annotationKind: 'decision',
          author: 'user',
          text: answer.option === null ? `Other: ${answer.other ?? ''}` : answer.option,
          quote: annotation.text,
        })
      }
    }
    const events: SendEventItem[] = [
      ...slice.annotations.filter((annotation) => !requoted.has(annotation.id)).map((annotation) => ({
        seq: annotation.seq,
        kind: 'annotation' as const,
        annotationKind: annotation.kind,
        author: annotation.author,
        ...agentName(annotation.agent),
        text: annotation.text,
        quote: annotation.quote,
        ...(draftIds.has(annotation.id) ? { draftId: annotation.id } : {}),
      })),
      ...slice.replies.map((reply) => ({
        seq: reply.seq,
        kind: 'reply' as const,
        author: reply.author,
        ...agentName(reply.agent),
        text: reply.text,
      })),
      ...answerItems.values(),
      ...slice.resolved.map((resolution) => ({
        seq: resolution.seq,
        kind: 'resolution' as const,
        annotationKind: resolution.kind,
        text: resolution.resolution,
        ...(resolution.resolution === 'requoted'
          ? { quote: annotations.annotations[resolution.id]?.quote ?? '' }
          : {}),
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

  #themeSummary(): { id: string; name: string; path: string | null } {
    return { id: this.#theme.id, name: this.#theme.name, path: this.#theme.path }
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

  /** Save and Send end the application-step history. */
  #clearApplicationHistory(session: OpenDocumentSession): void {
    session.applicationUndo = []
    session.applicationRedo = []
  }

  #view(): AppView {
    const raw = this.#rawView()
    const last = this.#lastView
    const next = last === null ? raw : {
      tabs: stableValue(last.tabs, raw.tabs),
      activeDocument: stableValue(last.activeDocument, raw.activeDocument),
      explorer: stableValue(last.explorer, raw.explorer),
      settings: stableValue(last.settings, raw.settings),
      engine: stableValue(last.engine, raw.engine),
      preview: stableValue(last.preview, raw.preview),
    }
    this.#lastView = next
    return next
  }

  /** The count of pending hunks and open items across the thread's open documents (§5.2). */
  #pendingWork(threadId: string): number {
    let count = 0
    for (const session of this.#sessions.values()) {
      if (!session.attachments[threadId]) continue
      count += session.state.pendingHunks.filter((hunk) => hunk.author.agentId === threadId).length
      count += Object.values(session.annotations.annotations).filter((annotation) => annotation.author === 'agent' && annotation.agent === threadId && annotation.status === 'open').length
    }
    return count
  }

  #rawView(): AppView {
    const focused = this.#tabs.focusedPath
    const base = this.#engine.view()
    const managed = this.#manager?.view()
    const raw: AppView['engine'] = managed ? { ...base, managed, state: managed.state === 'starting' || managed.state === 'recovering' ? 'connecting' : managed.state === 'failed' || managed.state === 'stopped' ? 'disconnected' : base.state } : base
    const engine: AppView['engine'] = { ...raw, projects: raw.projects.map((project) => ({ ...project, threads: project.threads.map((thread) => ({ ...thread, pendingWork: this.#pendingWork(thread.id) })) })) }
    return {
      preview: this.#preview.view(),
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
      activeDocument: focused ? documentView(this.#sessions.get(focused)!, this.#store, this.#now(), engine) : null,
      explorer: explorerView(this.#explorer, this.#sessions),
      settings: { ...settingsView(this.#settings), theme: this.#themeView() },
      engine
    }
  }

  #publish(): void {
    const state = this.#view()
    for (const listener of this.#listeners) listener(state)
    this.#followAttachedThreads()
  }

  /** Every thread attached to an open document is followed live, so its blocks and acknowledgments arrive whether or not it is the active conversation (§5.9). */
  #followAttachedThreads(): void {
    if (!this.#engine.watchThreads || this.#providerSetupPreparing) return
    const ids = [...new Set([...this.#sessions.values()].flatMap((session) => session.engineIdentity && session.engineIdentity !== this.#engine.view().identity ? [] : Object.keys(session.attachments)))].sort()
    const key = ids.join('\0')
    if (key === this.#followedThreadsKey) return
    this.#followedThreadsKey = key
    void this.#engine.watchThreads(ids).catch((error: unknown) => logError('engine', 'Attached threads could not be followed', error))
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
  const cursors = Object.values(session.attachments).map((attachment) => attachment.cursor)
  const removable = new Set(
    Object.values(session.annotations.annotations)
      .filter((annotation) =>
        annotation.status === 'resolved'
        && cursors.every((cursor) => cursor >= lastAnnotationEvent(session.annotations, annotation.id).seq),
      )
      .map((annotation) => annotation.id),
  )
  return pruneResolvedAnnotations(session.annotations, removable)
}

/** Where a quoted anchor sits, or a failure that lists the nearest excerpts the way the annotation core describes them. */
function locateQuoteAnchor(document: string, quote: string): number {
  try {
    return locateQuote(document, quote).start
  } catch (error) {
    if (!(error instanceof AnnotationAnchorError)) throw error
    const failure = describeQuoteFailure(document, quote, error)
    const places = failure.candidates.slice(0, 3).map((candidate) => `line ${candidate.line}: ${JSON.stringify(candidate.quote)}`).join(' | ')
    throw new Error(`quote ${failure.reason}${failure.total > 1 ? ` (${failure.total} places)` : ''}: ${JSON.stringify(quote)}${places ? `; nearest: ${places}` : ''}`)
  }
}

/** An agent's own annotation events are never delivered back to it, so they alone do not enable Send. */
function sendableToSomeone(event: LogEvent, attachmentIds: readonly string[]): boolean {
  if (isHunkVerdict(event)) return attachmentIds.includes(event.targetAgentId)
  if (event.author !== 'agent') return true
  return attachmentIds.some((id) => id !== event.agent)
}

function eventSettledForEveryAttachment(
  event: LogEvent,
  attachments: Readonly<Record<string, Attachment>>,
): boolean {
  const recipients = Object.values(attachments)
  return recipients.length > 0 && recipients.every((attachment) => attachment.deliveredSeqs.includes(event.seq))
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

/**
 * Hunk stamps from the stored entry. A hunk the entry never timed (metadata
 * from before stamps were written, or a hunk re-diffed on open) takes the
 * newest segment time, the last moment the document is known to have changed;
 * an entry with no segments falls back to the open time.
 */
function restoredHunkTimes(meta: DocumentMeta, state: DocumentState, openedAt: number): Map<string, number> {
  const times = new Map<string, number>()
  for (const hunk of meta.pendingHunks) {
    if (typeof hunk.changedAt === 'number' && hunk.changedAt > 0) times.set(hunk.id, hunk.changedAt)
  }
  const newestSegment = Math.max(0, ...meta.segments.map((segment) => segment.time))
  const fallback = newestSegment > 0 ? newestSegment : openedAt
  for (const hunk of state.pendingHunks) {
    if (!times.has(hunk.id)) times.set(hunk.id, fallback)
  }
  return times
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
  const snapshots: Record<string, string> = {}
  for (const id of snapshotIds) {
    // An attachment created from a thread's first turn carries an `unseen:` baseline
    // until its first delivery is acknowledged; it names no object.
    if (!/^[a-f0-9]{64}$/.test(id)) continue
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
    nextId: meta.nextId ?? base.nextId,
    forceNewUserSegment: meta.forceNewUserSegment ?? false,
    conflicts: Array.isArray(meta.conflicts)
      ? structuredClone(meta.conflicts) as DocumentState['conflicts']
      : [],
  }
}

/**
 * Queued deliveries come back with their payloads: by hash from the object
 * store (format 3), or inline from older entries. A payload object that is
 * missing leaves its delivery out and is logged; nothing can be handed to
 * the agent without it, and the next Send freezes a fresh one.
 */
async function restoreAttachments(
  meta: DocumentMeta,
  legacy: Record<string, Attachment> | undefined,
  store: GhostStore,
  payloadBlobs: WeakMap<object, string>,
): Promise<Record<string, Attachment>> {
  if (Object.keys(meta.attachments).length === 0) {
    return Object.fromEntries(Object.entries(structuredClone(legacy ?? {})).map(([id, attachment]) => [
      id,
      { ...attachment, deliveredSeqs: attachment.deliveredSeqs ?? [] },
    ]))
  }
  const attachments: Record<string, Attachment> = {}
  for (const [id, stored] of Object.entries(meta.attachments)) {
    const deliveries: FrozenDelivery[] = []
    for (const entry of stored.deliveries) {
      const { snapshotBlob: _snapshotBlob, payloadBlob, ...rest } = entry as DeliveryMeta & Record<string, unknown>
      let delivery = rest as unknown as FrozenDelivery
      if (typeof payloadBlob === 'string') {
        try {
          const payload = JSON.parse(await store.getObjectText(payloadBlob)) as FrozenDelivery['payload']
          delivery = { ...delivery, payload }
          payloadBlobs.set(payload, payloadBlob)
        } catch (error) {
          logError('persist', `Queued delivery ${delivery.id} for ${id} lost its payload ${payloadBlob}: ${meta.realpath}`, error)
          continue
        }
      } else if (delivery.payload === undefined) {
        logError('persist', `Queued delivery ${delivery.id} for ${id} has no payload: ${meta.realpath}`)
        continue
      }
      deliveries.push(delivery)
    }
    attachments[id] = {
      id: stored.id ?? id,
      name: stored.name ?? id,
      attachedAt: stored.attachedAt ?? 0,
      baseline: { snapshotId: stored.baselineBlob, segmentIndex: stored.segmentIndex },
      cursor: stored.cursor,
      deliveredSeqs: Array.isArray(stored.deliveredSeqs)
        ? stored.deliveredSeqs.filter((seq): seq is number => typeof seq === 'number')
        : [],
      deliveries,
      ...(stored.blockMap && typeof stored.blockMap === 'object' ? { blockMap: stored.blockMap as NonNullable<Attachment['blockMap']> } : {}),
      processedMessageIds: Array.isArray(stored.processedMessageIds) ? stored.processedMessageIds.filter((id): id is string => typeof id === 'string') : [],
      pendingBlockOutcomes: Array.isArray(stored.pendingBlockOutcomes) ? stored.pendingBlockOutcomes.filter((line): line is string => typeof line === 'string') : [],
    }
  }
  return attachments
}

/** The stored form: delivery payloads go to the object store once and are named by hash (plan 4.11). */
async function persistAttachment(
  store: GhostStore,
  payloadBlobs: WeakMap<object, string>,
  attachment: Attachment,
): Promise<AttachmentMeta> {
  const deliveries: DeliveryMeta[] = []
  for (const delivery of attachment.deliveries) {
    const { payload, ...rest } = delivery
    let payloadBlob = payloadBlobs.get(payload)
    if (payloadBlob === undefined) {
      payloadBlob = await store.putObject(JSON.stringify(payload))
      payloadBlobs.set(payload, payloadBlob)
    }
    deliveries.push({ ...rest, snapshotBlob: delivery.to.snapshotId, payloadBlob })
  }
  return {
    id: attachment.id,
    name: attachment.name,
    attachedAt: attachment.attachedAt,
    baselineBlob: attachment.baseline.snapshotId,
    segmentIndex: attachment.baseline.segmentIndex,
    cursor: attachment.cursor,
    deliveredSeqs: attachment.deliveredSeqs,
    blockMap: attachment.blockMap,
    processedMessageIds: attachment.processedMessageIds ?? [],
    pendingBlockOutcomes: attachment.pendingBlockOutcomes ?? [],
    deliveries,
  }
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

function annotationView(log: AnnotationLog, attachments: Record<string, Attachment>, document: string, engineIdentity?: string): AnnotationView[] {
  const ids = Object.keys(attachments)
  return Object.values(log.annotations).map((annotation) => ({
    id: annotation.id,
    seq: annotation.seq,
    kind: annotation.kind,
    status: annotation.status,
    anchor: annotation.anchor.kind ?? 'quote',
    author: annotation.author === 'user'
      ? 'user'
      : agentIdentity(annotation.agent ?? 'agent', attachments[annotation.agent ?? '']?.name ?? annotation.agent ?? 'agent', Math.max(0, ids.indexOf(annotation.agent ?? ''))),
    quote: annotation.quote,
    text: annotation.text,
    ...(annotation.label ? { label: annotation.label } : {}),
    ...(annotation.context ? { context: annotation.context } : {}),
    ...(annotation.decision ? { decision: annotation.decision } : {}),
    line: annotation.status === 'orphaned' ? null : annotation.line,
    from: annotation.status === 'orphaned' || annotation.anchor.kind === 'document' ? null : annotation.anchor.start,
    to: annotation.status === 'orphaned' || annotation.anchor.kind === 'document' ? null : annotation.anchor.end,
    ...(annotation.kind === 'suggestion' ? { replacement: annotation.text, inline: suggestionRendersInline(annotation.quote, annotation.text) } : {}),
    ...optionalTime(annotation),
    ...(annotation.source && (!annotation.source.engineIdentity || annotation.source.engineIdentity === engineIdentity) ? { source: annotation.source } : {}),
    review: annotation.reviewedText === undefined
      ? 'unreviewed'
      : annotation.anchor.kind === 'document' || document.slice(annotation.anchor.start, annotation.anchor.end) === annotation.reviewedText ? 'reviewed' : 'revisit',
    replySeqs: annotation.replies.map((reply) => reply.seq),
    replies: annotation.replies.map((reply) => ({
      id: reply.id,
      author: reply.author === 'user'
        ? 'user'
        : agentIdentity(reply.agent ?? 'agent', attachments[reply.agent ?? '']?.name ?? reply.agent ?? 'agent', Math.max(0, ids.indexOf(reply.agent ?? ''))),
      text: reply.text,
      ...optionalTime(reply)
    }))
  }))
}

/** The same inline rule as hunks: a paragraph break in either side cannot render as track changes. */
function suggestionRendersInline(quote: string, replacement: string): boolean {
  return !quote.includes('\n\n') && !replacement.includes('\n\n')
}

/** The record's creation time when the annotation log carries one; nothing otherwise, so the view stays honest. */
function optionalTime(record: object): { createdAt: number } | Record<string, never> {
  const value = (record as { createdAt?: unknown }).createdAt
  return typeof value === 'number' && value > 0 ? { createdAt: value } : {}
}

function hunkViews(session: OpenDocumentSession, now: number): HunkView[] {
  const { state, attachments } = session
  const ids = Object.keys(attachments)
  // Save-state classification (PRD §6.9): a hunk is saved when its shadow
  // region already matches the file, read off the shadow-vs-disk diff. With
  // nothing pending there is nothing to classify, so plain typing never diffs.
  // The diff is kept while neither side changes: every publish rebuilds the
  // view, and a document with pending hunks would otherwise diff per keystroke
  // of unrelated state (plan 4.15).
  let unsavedRanges: TextRange[]
  if (state.pendingHunks.length === 0 || state.disk === state.shadow) {
    unsavedRanges = []
  } else if (session.unsavedRangesCache?.disk === state.disk && session.unsavedRangesCache.shadow === state.shadow) {
    unsavedRanges = session.unsavedRangesCache.ranges
  } else {
    unsavedRanges = computeHunks(state.disk, state.shadow).map((hunk) => hunk.after)
    session.unsavedRangesCache = { disk: state.disk, shadow: state.shadow, ranges: unsavedRanges }
  }
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
      saved: !unsavedRanges.some((range) => rangesTouch(range, pending.shadow)),
      // Every change persists before it publishes, so a hunk without a stamp
      // was recorded since the last #persist pass: it is new.
      changedAt: session.hunkTimes.get(pending.id) ?? now,
      ...(session.hunkItemSources.has(pending.id) ? { itemSource: session.hunkItemSources.get(pending.id)! } : {}),
    }
  })
}

function documentView(session: OpenDocumentSession, store: GhostStore, now: number, engine: AppView['engine']): DocumentView {
  const ids = Object.keys(session.attachments)
  const attachments: AttachmentView[] = ids.map((id, index) => {
    const attachment = session.attachments[id]!
    const thread = engine.projects.flatMap((project) => project.threads).find((candidate) => candidate.id === id)
    return {
      agent: agentIdentity(id, attachment.name, index),
      attachedAt: attachment.attachedAt,
      state: engine.state === 'connected' ? (thread?.status ?? 'idle') : 'disconnected',
      queuedDeliveries: attachment.deliveries.map((delivery) => delivery.id),
      queuedSendCount: attachment.deliveries.filter((delivery) => !isMessageDelivery(delivery)).length,
      cursor: deliveryStart(attachment).cursor
    }
  })
  const drafts: DraftView[] = session.drafts.drafts.map((draft) => {
    const location = relocateDraft(draft, session.state.shadow)
    return {
      id: draft.id,
      kind: draft.kind,
      quote: draft.anchor.quote,
      prefix: draft.anchor.prefix,
      suffix: draft.anchor.suffix,
      text: draft.text,
      from: location.from,
      to: location.to,
      status: location.status,
      ...(draft.context ? { context: draft.context } : {}),
      createdAt: draft.createdAt,
    }
  })
  const recipients: RecipientView[] = attachments.map((attachment) => ({ id: attachment.agent.id, name: attachment.agent.name, color: attachment.agent.color, attached: true }))
  const activeConversation = activeConversationInProject(session.path, engine)
  if (activeConversation && !session.attachments[activeConversation.id]) {
    recipients.push({ id: activeConversation.id, name: activeConversation.title, color: agentIdentity(activeConversation.id, activeConversation.title, ids.length).color, attached: false })
  }
  return {
    path: session.path,
    bufferPath: store.pathsForDocument(session.path).buffer,
    leadAgentId: session.leadAgentId,
    content: session.state.shadow,
    reading: { ...session.reading },
    sourceMode: session.sourceMode,
    sourceOnly: session.sourceOnly,
    readOnly: session.readOnly,
    dirty: session.state.shadow !== session.state.disk,
    deleted: session.deleted,
    invalidUtf8: session.invalidUtf8,
    problems: [...session.problems],
    lastSavedAt: session.lastSavedAt,
    historyStep: session.historyStep,
    pendingHunks: hunkViews(session, now),
    saves: session.saves.map((save) => ({
      time: save.time,
      authors: save.authors.map((author) => ({ ...author })),
    })),
    annotations: annotationView(session.annotations, session.attachments, session.state.shadow, session.engineIdentity),
    items: deriveItems({
      documentPath: session.path,
      annotations: annotationView(session.annotations, session.attachments, session.state.shadow, session.engineIdentity),
      hunks: hunkViews(session, now),
      attachments,
    }),
    drafts,
    attachments,
    recipients,
    canSend:
      session.state.segments.some((segment, index) =>
        session.segmentOffset + index > session.lastSentSegmentIndex
        && segment.author === 'user'
        && sendableSegment(segment, Object.keys(session.attachments)),
      )
      || session.annotations.events.some((event) =>
        event.seq > session.lastSentAnnotationSeq
        && sendableToSomeone(event, Object.keys(session.attachments))
        && !eventSettledForEveryAttachment(event, session.attachments),
      )
      || (drafts.length > 0 && Object.keys(session.attachments).length > 0),
    ...(session.recovery ? { recovery: session.recovery } : {}),
    conflicts: session.state.conflicts.map((conflict) => ({
      id: conflict.id,
      label: `${conflict.author.agentId ? conflict.author.name : 'Someone else'} changed this block`,
      mine: session.state.shadow.slice(conflict.shadow.from, conflict.shadow.to),
      incoming: conflict.incoming
    }))
  }
}

/** The active conversation when its project's workspace contains the document (§5.6, §5.7). */
function activeConversationInProject(path: string, engine: AppView['engine']): { id: string; title: string } | null {
  if (!engine.activeThreadId) return null
  for (const project of engine.projects) {
    const thread = project.threads.find((candidate) => candidate.id === engine.activeThreadId)
    if (!thread) continue
    return pathWithin(path, project.workspaceRoot) ? { id: thread.id, title: thread.title } : null
  }
  return null
}

/** True when `path` sits inside `root` (or is it), by path segments, never by prefix alone. */
export function pathWithin(path: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
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
    engine: settings.engine,
    animatedBackground: settings.ambientMotion,
    panelSizes: { ...settings.panels },
    zoom: { ...settings.zoom }
  }
}

function lineStartOffset(text: string, line: number): number {
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return text.length
    offset = next + 1
  }
  return Math.min(offset, text.length)
}

/**
 * Each segment's hunks against its own before state, with one context line
 * either side. When `delivered` is given (the shadow a delivery snapshots),
 * every hunk's `line` is mapped forward through the later segments and any
 * unsegmented tail, so it points into the document the recipient reads.
 */
function indexedSegments(state: DocumentState, segmentOffset = 0, delivered?: string): IndexedSegment[] {
  const texts = state.segments.map((segment) => ({
    before: state.snapshots[segment.beforeSnapshotId] ?? '',
    after: state.snapshots[segment.afterSnapshotId] ?? '',
  }))
  // Hop k maps offsets in segment k's after text into segment k+1's after
  // text (its own change included); the last hop lands in the delivered document.
  const hops = delivered === undefined
    ? []
    : texts.map((text, index) => {
        const target = index + 1 < texts.length ? texts[index + 1]!.after : delivered
        return text.after === target ? [] : computeHunks(text.after, target)
      })
  return state.segments.map((segment, index) => {
    const { before, after } = texts[index]!
    return {
      index: segmentOffset + index,
      id: segment.id,
      author: segment.author,
      ...(segment.attribution?.agentId ? { tag: { agent: segment.attribution.agentId, name: segment.attribution.name } } : {}),
      hunks: contextHunks(before, after).map((hunk) => {
        if (delivered === undefined) return hunk
        let offset = lineStartOffset(after, hunk.line)
        for (let hop = index; hop < hops.length; hop += 1) {
          if (hops[hop]!.length > 0) offset = mapOldPositionToNew(offset, hops[hop]!, -1)
        }
        return { ...hunk, line: lineAt(delivered, Math.min(offset, delivered.length)) }
      })
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

/** Everything outside the segments that still names a snapshot, so persist keeps exactly what reopen can use. */
function pruneSnapshots(session: OpenDocumentSession, current: readonly string[]): DocumentState {
  const referenced = segmentSnapshotIds(session.state)
  for (const id of current) referenced.add(id)
  for (const attachment of Object.values(session.attachments)) {
    referenced.add(attachment.baseline.snapshotId)
    for (const delivery of attachment.deliveries) {
      referenced.add(delivery.from.snapshotId)
      referenced.add(delivery.to.snapshotId)
    }
  }
  for (const save of session.saves) {
    referenced.add(save.beforeBlob)
    referenced.add(save.afterBlob)
  }
  const snapshots = session.state.snapshots
  const keys = Object.keys(snapshots)
  if (keys.every((id) => referenced.has(id))) return session.state
  return {
    ...session.state,
    snapshots: Object.fromEntries(keys.filter((id) => referenced.has(id)).map((id) => [id, snapshots[id]!])),
  }
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
