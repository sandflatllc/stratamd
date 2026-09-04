import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
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
  BufferOrigin,
  CreateAnnotationRequest,
  CreateDraftRequest,
  DraftView,
  DocumentProblem,
  ReadingState,
  TableViewState,
  WalkthroughAction,
  HeadingReference,
  LocalMarkdownPreview,
  LocalImageResolution,
  QuickSendRequest,
} from '../shared/contracts'
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
  locateEdit,
  mapAnnotationsThroughEdit,
  quoteCandidateForLines,
  type QuoteFailure,
  withAttachmentNames,
  nearestQuoteStart,
  pruneResolvedAnnotations,
  relocateAnnotation,
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
  freezeQuickSend,
  freezeMessage,
  isMessageDelivery,
  noteAttachCall,
  prepareClipboardDelivery,
  type Attachment,
  type ClipboardRecipient,
  type DeliverySource,
  type FrozenDelivery,
  type IndexedSegment
} from '../core/delivery'
import { createPayload, PAYLOAD_VERSION, trimPayload, type PayloadAttachment, type PayloadSegment } from '../core/payload'
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
  setExternalTag,
  type ExternalAttribution,
  type ExternalChangeResult,
  type ExternalSource,
  type PendingHunkAnchor,
  type DocumentState,
  type ReviewFrame
} from '../core/state'
import { parseMarkdown } from '../core/markdown'
import { analyzeComponentNode, annotatedScreenshotData, type ComponentAstNode } from '../core/markdown/components'
import { findMarkdownByIdentity, scanAndSeedExplorer, scanExplorer, type ExplorerScanResult } from './explorer'
import { readDiskState, readDocument, resolveAllowedLocalPath, resolveDocumentPath, saveDocumentWithHashCheck, seedGhostFromGit } from './files'
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
import { AttachWaitRegistry } from './socket'
import { CommandFailure, type CommandArguments, type CommandRequest, type SocketCommandHandler } from '../cli/protocol'
import { toDeliveredAnnotation } from '../core/annotations'
import { T3EngineClient, type EngineReadClient } from './engine/client'

/** One QUOTE_INVALID entry: the unified failure plus which input it was (PRD §6.8). */
interface QuoteFailureEntry extends QuoteFailure {
  index: number
  quote: string
}

/** One failure's message is the top-level error; several get the summary. */
function quoteFailureCommand(failures: readonly QuoteFailureEntry[], noun: 'quote' | 'match'): CommandFailure {
  const message = failures.length === 1
    ? failures[0]!.message
    : noun === 'match' ? 'One or more matches are invalid' : 'One or more quotes are invalid'
  return new CommandFailure(message, 3, 'QUOTE_INVALID', failures)
}

function attachmentNotFound(agent: string, file: string, hint = 'run stratamd attach first'): CommandFailure {
  return new CommandFailure(`Attachment ${agent} is not attached to ${file}; ${hint}`, 2, 'ATTACHMENT_NOT_FOUND', { agent, file })
}

function annotationNotFound(annotation: string, file: string): CommandFailure {
  return new CommandFailure(`Annotation ${annotation} was not found in ${file}`, 2, 'ANNOTATION_NOT_FOUND', { annotation, file })
}
/** The theme problem key under which a failed file write is reported (plan 4.14). */
const THEME_WRITE_PROBLEM_KEY = 'write'
/** The longest delay a Node timer represents faithfully. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
/** How long typing may go on before its meta reaches disk; the buffer mirror (80 ms) carries the text itself. */
const META_WRITE_DEBOUNCE_MS = 1_000

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
  drafts: DraftStore
  attachments: Record<string, Attachment>
  /** The at-most-one attachment holding the Lead (PRD §6.6); dies with it. */
  leadAgentId: string | null
  clipboardRecipient: ClipboardRecipient
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
  store?: GhostStore
  settingsStore?: SettingsStore
  themeStore?: ThemeStore
  listFonts?: () => Promise<string[]>
  clipboardWrite?: (text: string) => Promise<void>
  selectFolder?: () => Promise<string | null>
  now?: () => number
  watch?: boolean
  engine?: EngineReadClient
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
  #unsubscribeEngine: (() => void) | null = null
  readonly #engineDispatching = new Set<string>()
  readonly #sessions = new Map<string, OpenDocumentSession>()
  /** The tail of each document's turn queue; see #withSession. */
  readonly #sessionTurns = new Map<string, Promise<void>>()
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
    this.#engine = options.engine ?? new T3EngineClient({ dataDirectory: this.#store.dataDirectory, now: this.#now })
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
      this.#publish()
      void this.#reconcileEngineView(view).catch((error: unknown) => logError('engine', 'Engine delivery reconciliation failed', error))
    })
    await this.#engine.initialize()
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
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
    if (this.#themeRelistTimer) clearTimeout(this.#themeRelistTimer)
    this.#themeRelistTimer = null
    this.#flushThemeWrite()
    await this.#themeWriteQueue
    await this.#themeSubscription?.unsubscribe()
    this.#themeSubscription = null
    this.#attachWaits.rejectAll(new Error('StrataMD is shutting down'))
    this.#unsubscribeEngine?.()
    this.#unsubscribeEngine = null
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

  async pairEngine(server: string, pairingCode: string): Promise<void> {
    await this.#engine.pair(server, pairingCode)
  }

  async reconnectEngine(): Promise<void> {
    await this.#engine.reconnect()
  }

  async openConversation(threadId: string): Promise<void> {
    await this.#engine.openThread(threadId)
  }

  async startConversationTurn(threadId: string, input: Parameters<EngineReadClient['startTurn']>[1]): Promise<void> {
    await this.#engine.startTurn(threadId, input)
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

  async #reconcileEngineView(view: AppView['engine']): Promise<void> {
    const acknowledged = new Set(view.projects.flatMap((project) => project.threads.flatMap((thread) => thread.messages.map((message) => message.id))))
    for (const session of [...this.#sessions.values()]) {
      await this.#withSession(session.path, async () => {
        if (this.#sessions.get(session.path) !== session) return
        let changed = false
        for (const thread of view.projects.flatMap((project) => project.threads)) {
          if (session.attachments[thread.id]) continue
          const bootstrap = thread.messages.find((message) => {
            if (message.role !== 'assistant' || message.streaming) return false
            const block = parseStrataBlock(message.text)
            return block?.results.length === 1 && block.results[0]?.entry?.verb === 'attach' && block.results[0].entry.document === session.path
          })
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
          const engineThread = view.projects.flatMap((project) => project.threads).find((thread) => thread.id === threadId)
          for (const message of engineThread?.messages ?? []) {
            if (message.role === 'assistant' && !message.streaming) changed = await this.#applyStrataMessage(session, threadId, message.id, message.turnId ?? message.id, message.text) || changed
          }
        }
        if (changed) await this.#persist(session)
        await this.#dispatchEngineDeliveries(session)
      })
    }
    this.#publish()
  }

  async #applyStrataMessage(session: OpenDocumentSession, threadId: string, messageId: string, turnId: string, text: string): Promise<boolean> {
    let attachment = session.attachments[threadId]
    if (!attachment || attachment.processedMessageIds?.includes(messageId)) return false
    const parsed = parseStrataBlock(text)
    if (!parsed) return false
    const outcomes: Array<{ index: number; status: 'applied' | 'failed'; itemId?: string; reason?: string; candidates?: string[] }> = []
    for (const result of parsed.results) {
      if (!result.entry) { outcomes.push({ index: result.index, status: 'failed', reason: result.error ?? 'Malformed entry' }); continue }
      const entry = result.entry
      try {
        if (entry.verb === 'attach') throw new Error('attach must be the only entry in an unattached thread')
        if (entry.verb === 'lead') {
          if (entry.document !== session.path) throw new Error(`document is not open: ${entry.document}`)
          session.leadAgentId = entry.action === 'claim' ? threadId : session.leadAgentId === threadId ? null : session.leadAgentId
          outcomes.push({ index: result.index, status: 'applied' })
          continue
        }
        if ('item' in entry.anchor) throw new Error(`item ${entry.anchor.item} was not found`)
        if (!('document' in entry.anchor) || entry.anchor.document !== session.path) throw new Error('entry does not target this document')
        const block = 'block' in entry.anchor && attachment.blockMap ? resolveBlock(attachment.blockMap, entry.anchor.block) : null
        const quote = 'quote' in entry.anchor ? entry.anchor.quote : block?.text
        const start = block?.from ?? (quote ? session.state.shadow.indexOf(quote) : -1)
        if (!quote || start < 0 || session.state.shadow.slice(start, start + quote.length) !== quote) {
          throw new Error(`block ${'block' in entry.anchor ? entry.anchor.block : 'quote'} changed`)
        }
        if (entry.verb === 'comment' || entry.verb === 'question' || entry.verb === 'decision' || entry.verb === 'suggest') {
          const itemId = `a_${randomUUID().slice(0, 12)}`
          const created = createAnnotation(session.annotations, session.state.shadow, {
            createdAt: this.#now(), id: itemId, kind: entry.verb === 'suggest' ? 'suggestion' : entry.verb,
            author: 'agent', agent: threadId, name: attachment.name, quote,
            text: entry.verb === 'suggest' ? entry.replacement : entry.text, start,
            source: { threadId, turnId, messageId },
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
          session.state = setExternalTag(session.state, threadId, attachment.name, this.#now())
          await this.#mergeExternalText(session, 'buffer', session.state.shadow.slice(0, from) + entry.replace + session.state.shadow.slice(from + entry.match.length))
          for (const hunk of session.state.pendingHunks) {
            if (!beforeHunks.has(hunk.id)) session.hunkItemSources.set(hunk.id, { threadId, turnId, messageId })
          }
          outcomes.push({ index: result.index, status: 'applied' })
          continue
        }
        throw new Error(`${entry.verb} is not valid for this anchor`)
      } catch (error) {
        const candidates = attachment.blockMap?.blocks.slice(0, 3).map((candidate) => candidate.id)
        outcomes.push({ index: result.index, status: 'failed', reason: error instanceof Error ? error.message : String(error), ...(candidates?.length ? { candidates } : {}) })
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
        text: note,
        model: thread.model,
        effort: thread.effort,
        access: thread.access,
        messageId: delivery.id,
        commandId: `strata-${delivery.id}`,
        attachment: { name: `${delivery.id}.md`, text: delivery.payload.text },
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
  async #withSession<T>(path: string, operation: () => Promise<T>): Promise<T> {
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
        clipboardRecipient: createClipboardRecipient(),
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
    // The expiry filter runs before the Lead is restored, so a holder that aged
    // past the idle timeout while the app was closed comes back with no Lead.
    const payloadBlobs = new WeakMap<object, string>()
    const attachments = { ...expireIdleAttachments(
      await restoreAttachments(meta, saved?.attachments, this.#store, payloadBlobs),
      this.#now(),
      this.#settings.attachmentIdleTimeoutMs
    ) }
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
      leadAgentId: typeof meta.leadAgentId === 'string' && attachments[meta.leadAgentId] !== undefined
        ? meta.leadAgentId
        : null,
      clipboardRecipient: restoreClipboardRecipient(meta.clipboardRecipient, saved?.clipboardRecipient),
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
    this.#scheduleIdleExpiry()
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
      if (Object.keys(session.attachments).length > 0) {
        await this.#enqueueDeliveries(
          session,
          { recipients: Object.keys(session.attachments), note: '', includeExternal: false },
          Object.keys(session.attachments),
          'closed'
        )
        // Persist before waking any blocked attach: a delivery handed out
        // before it is durable could be acknowledged against a store that never
        // held it.
        await this.#persist(session)
        for (const [agent, attachment] of Object.entries(session.attachments)) {
          const delivery = collectOldest(attachment)
          if (delivery) this.#attachWaits.deliver(attachKey(path, agent), delivery.payload)
        }
      }
      session.mirror?.cancel()
      await releaseSessionResources(session)
      this.#sessions.delete(path)
      this.#tabs.close(path)
      this.#scheduleIdleExpiry()
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
      for (const annotation of Object.values(session.annotations.annotations)) {
        if (annotation.status !== 'resolved') session.annotations = relocateAnnotation(session.annotations, annotation.id, session.state.shadow).log
      }
      session.mirror?.schedule(session.state.shadow)
      await this.#persist(session, { debounce: true })
      this.#scheduleIdleExpiry()
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
      this.#scheduleIdleExpiry()
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

  #materializeDrafts(session: OpenDocumentSession, ids: readonly string[]): AnnotationLog {
    let log = session.annotations
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
          text: delivery.payload.text,
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
      const nextAnnotations = this.#materializeDrafts(session, materializedIds)
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
      this.#scheduleIdleExpiry()
      this.#publish()
      return deliveries.map((delivery) => delivery.id)
    })
  }

  async copyText(text: string): Promise<void> {
    await this.#clipboardWrite(text)
  }

  copyForAgent(path: string, note: string, includeExternal: boolean): Promise<void> {
    return this.#withSession(path, async () => {
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
    })
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
      session.payloadBlobs = new WeakMap()
    }
    await this.refreshExplorer()
  }

  async updateSettings(settings: Partial<Omit<AppSettingsView, 'theme'>>): Promise<void> {
    this.#settings = await this.#settingsStore.update({
      ...(settings.animatedBackground === undefined ? {} : { ambientMotion: settings.animatedBackground }),
      ...(settings.attachmentIdleHours === undefined ? {} : { attachmentIdleTimeoutMs: Math.round(settings.attachmentIdleHours * 60 * 60 * 1_000) }),
      ...(settings.panelSizes === undefined ? {} : { panels: settings.panelSizes }),
      ...(settings.zoom === undefined ? {} : { zoom: settings.zoom })
    })
    this.#scheduleIdleExpiry()
    this.#publish()
  }

  async resolveLocalImage(documentPath: string, source: string): Promise<LocalImageResolution | null> {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) return null
    const session = this.#require(documentPath)
    try {
      const safe = await resolveAllowedLocalPath(source, session.path, this.#settings.explorerFolders)
      if (!safe) return null
      const details = await stat(safe, { bigint: true })
      return { url: localImageUrl(safe), path: safe, version: `${details.size}:${details.mtimeNs}` }
    } catch {
      return null
    }
  }

  async resolveLocalMarkdown(documentPath: string, source: string): Promise<LocalMarkdownPreview | null> {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//') || source.includes('\0')) return null
    const session = this.#require(documentPath)
    let request: string
    try {
      request = decodeURIComponent(source.split(/[?#]/u, 1)[0] ?? '')
    } catch {
      return null
    }
    if (!request || !['.md', '.markdown'].includes(extname(request).toLowerCase())) return null
    try {
      const safe = await resolveAllowedLocalPath(request, session.path, this.#settings.explorerFolders)
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

  commandHandler(): SocketCommandHandler {
    return async (request, context) => {
      try {
        return await this.#handleCommand(request, context.signal)
      } catch (error) {
        if (error instanceof CommandFailure) throw error
        if (error instanceof AnnotationAnchorError) {
          throw quoteFailureCommand([{ index: 0, quote: '', ...describeQuoteFailure('', '', error) }], 'quote')
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const file = (request.args as { file?: unknown }).file
          throw new CommandFailure(
            typeof file === 'string' ? `Document not found: ${file}` : 'Document not found',
            2,
            'NOT_FOUND',
            typeof file === 'string' ? { file } : undefined,
          )
        }
        throw error
      }
    }
  }

  async #handleCommand(request: CommandRequest, signal: AbortSignal): Promise<unknown> {
    if (request.command === 'docs') return this.#docsPayload()
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
        await this.#withSession(file, async () => {
          // The offline handler leaves every difference between the new ghost
          // and the text as a pending hunk, so `changes` agrees online and off.
          open.state = recomputePendingHunks({
            ...open.state,
            ghost: seed.content.toString('utf8'),
            pendingHunks: [],
            conflicts: [],
          })
          await this.#persist(open)
          this.#publish()
        })
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
      return trimPayload(await this.#closedStatePayload(file), request.args)
    }
    if ((request.command === 'ack' || request.command === 'detach') && !this.#sessions.has(file)) {
      return this.#withSession(file, () => this.#closedAttachmentCommand(request, file, signal))
    }
    if (request.command === 'attach') return this.#attachCommand(request.args, file, signal)
    return this.#withSession(file, async () => {
      if (!this.#sessions.has(file)) await this.#openLocked(file)
      const session = this.#require(file)
      try {
        return await this.#dispatch(request, session, file, signal)
      } catch (error) {
        if (error instanceof AnnotationAnchorError) throw this.#anchorFailure(session, error)
        throw error
      }
    })
  }

  /**
   * `ack` and `detach` for a document that is not open work on the stored
   * attachment alone (plan 2.7). Opening the document to acknowledge its own
   * `closed` delivery would put the tab straight back; the CLI's final ack
   * after the user closed a document must leave it closed.
   */
  async #closedAttachmentCommand(
    request: CommandRequest<'ack'> | CommandRequest<'detach'>,
    file: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    // An open that was queued ahead of this turn may have finished by now.
    if (this.#sessions.has(file)) return this.#dispatch(request, this.#require(file), file, signal)
    const agent = request.args.agent
    const notAttached = new CommandFailure(`Attachment ${agent} was not found for ${file}`, 2, 'ATTACHMENT_NOT_FOUND', { agent, file })
    if (!await this.#store.hasDocument(file)) throw notAttached
    return this.#store.withLock(file, async () => {
      const meta = await this.#store.loadMeta(file)
      const payloadBlobs = new WeakMap<object, string>()
      const attachment = (await restoreAttachments(meta, persistedApplication(meta)?.attachments, this.#store, payloadBlobs))[agent]
      if (!attachment) throw notAttached
      if (request.command === 'ack') {
        const result = acknowledgeDelivery(attachment, request.args.deliveryId)
        if (!result.acknowledged) throw unknownDeliveryFailure(attachment, request.args.deliveryId)
        await this.#store.saveMeta({
          ...meta,
          attachments: { ...meta.attachments, [agent]: await persistAttachment(this.#store, payloadBlobs, result.attachment) },
        })
        return { acknowledged: true }
      }
      const { [agent]: _removed, ...remaining } = meta.attachments
      await this.#store.saveMeta({
        ...meta,
        attachments: remaining,
        leadAgentId: meta.leadAgentId === agent ? null : meta.leadAgentId ?? null,
      })
      this.#attachWaits.cancel(attachKey(file, agent), new Error('Attachment detached'))
      return { detached: true }
    }, DEFAULT_LOCK_TIMEOUT_MS)
  }

  /**
   * `attach` blocks until a delivery arrives, and that delivery comes from
   * another turn on the same document (a Send, a close). The wait therefore
   * sits between two locked phases instead of inside one.
   */
  async #attachCommand(
    attach: CommandArguments['attach'],
    file: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const trim = { textOnly: attach.textOnly === true }
    const registered = await this.#withSession(file, async () => {
      if (!this.#sessions.has(file)) await this.#openLocked(file)
      const session = this.#require(file)
      let attachment = session.attachments[attach.agent]
      if (!attachment) {
        const snapshot = deliverySnapshot(session)
        attachment = createAttachment({ id: attach.agent, name: attach.name, now: this.#now(), snapshot })
        session.attachments[attach.agent] = attachment
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { payload: trimPayload(createInitialPayload(
          attachment,
          file,
          this.#store.pathsForDocument(file).buffer,
          snapshot,
          withAttachmentNames(Object.values(session.annotations.annotations).map(toDeliveredAnnotation), this.#attachmentName(session))
        ), trim) }
      }
      attachment = noteAttachCall(attachment, this.#now())
      session.attachments[attach.agent] = attachment
      const queued = collectOldest(attachment)
      if (queued) {
        session.attachments[attach.agent] = finishAttachCall(attachment, this.#now())
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { payload: trimPayload(queued.payload, trim) }
      }
      const waitVersion = (session.attachWaitVersions[attach.agent] ?? 0) + 1
      session.attachWaitVersions[attach.agent] = waitVersion
      // The wait must be registered before this handler yields: a delivery
      // enqueued during the persist below would call deliver() against an
      // empty registry and the attach would sit blind until its timeout.
      const wait = this.#attachWaits.wait(attachKey(file, attach.agent), attach.timeout * 1_000, signal)
      try {
        await this.#persist(session)
      } catch (error) {
        this.#attachWaits.cancel(attachKey(file, attach.agent), error)
        wait.catch(() => {})
        throw error
      }
      this.#scheduleIdleExpiry()
      this.#publish()
      return { wait, waitVersion, session }
    })
    if ('payload' in registered) return registered.payload
    const { wait, waitVersion, session } = registered
    try {
      const result = await wait
      if (result.event === 'delivery') return trimPayload(result.value, trim)
      return createPayload({
        file,
        buffer: this.#store.pathsForDocument(file).buffer,
        agent: attach.agent,
        event: result.event
      })
    } finally {
      await this.#withSession(file, async () => {
        if (session.attachWaitVersions[attach.agent] !== waitVersion) return
        const current = session.attachments[attach.agent]
        if (current) session.attachments[attach.agent] = finishAttachCall(current, this.#now())
        // The document may have closed while the call waited; its state is
        // already durable and a closed session is not written again.
        if (this.#sessions.get(file) !== session) return
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
      })
    }
  }

  /** Anchor failures outside annotate and edit take the same shape those two report. */
  #anchorFailure(session: OpenDocumentSession, error: AnnotationAnchorError, quote = ''): CommandFailure {
    return quoteFailureCommand([{ index: 0, quote, ...describeQuoteFailure(session.state.shadow, quote, error) }], 'quote')
  }

  /**
   * A Lead accept whose suggestion text moved: the most useful candidate is
   * whatever now stands on the lines the suggestion anchored to.
   */
  #movedSuggestionFailure(session: OpenDocumentSession, suggestion: Annotation, error: AnnotationAnchorError): CommandFailure {
    const shadow = session.state.shadow
    const described = describeQuoteFailure(shadow, suggestion.quote, error)
    const here = quoteCandidateForLines(shadow, suggestion.anchor.start, suggestion.anchor.end)
    return quoteFailureCommand([{
      index: 0,
      quote: suggestion.quote,
      ...described,
      candidates: [here, ...described.candidates.filter((candidate) => candidate.line !== here.line)],
      hint: 'The text this suggestion quotes moved; candidates show what stands there now: run stratamd state to read the current buffer, or reject the suggestion.',
    }], 'quote')
  }

  /** The name an attachment has now, for annotations written before names were recorded. */
  #attachmentName(session: OpenDocumentSession): (agent: string) => string | undefined {
    return (agent) => session.attachments[agent]?.name
  }

  #attachmentRows(session: OpenDocumentSession): PayloadAttachment[] {
    return Object.entries(session.attachments).map(([id, attachment]) => ({
      agent: id,
      name: attachment.name,
      state: attachmentDisplayState(attachment),
      lead: id === session.leadAgentId
    }))
  }

  /** Every open document, from the tab registry (order and focus) and the sessions (dirty, attachments). */
  #docsPayload(): unknown {
    const focused = this.#tabs.focusedPath
    const documents = this.#tabs.list().map((tab) => {
      const session = this.#require(tab.path)
      return {
        file: tab.path,
        buffer: this.#store.pathsForDocument(tab.path).buffer,
        focused: tab.path === focused,
        dirty: session.state.shadow !== session.state.disk,
        attachments: this.#attachmentRows(session)
      }
    })
    const lines = documents.length === 0
      ? ['No document is open.']
      : documents.flatMap((document) => [
          `${document.file}${document.focused ? ' (focused)' : ''}${document.dirty ? ' (unsaved changes)' : ''}`,
          ...document.attachments.map((row) =>
            `  ${row.name} (${row.agent}): ${row.state}${row.lead ? ', Lead' : ''}`),
        ])
    return { version: PAYLOAD_VERSION, event: 'docs', documents, text: lines.join('\n') }
  }

  async #dispatch(
    request: CommandRequest,
    session: OpenDocumentSession,
    file: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (request.command) {
      case 'ack': {
        const ack = request.args
        const attachment = session.attachments[ack.agent]
        if (!attachment) throw attachmentNotFound(ack.agent, file, 'nothing is queued for it')
        const result = acknowledgeDelivery(attachment, ack.deliveryId)
        if (!result.acknowledged) throw unknownDeliveryFailure(attachment, ack.deliveryId)
        session.attachments[ack.agent] = result.attachment
        session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { acknowledged: result.acknowledged }
      }
      case 'detach': {
        if (!session.attachments[request.args.agent]) {
          throw attachmentNotFound(request.args.agent, file, 'there is nothing to detach')
        }
        this.#removeAttachment(session, request.args.agent)
        await this.#persist(session)
        this.#scheduleIdleExpiry()
        this.#publish()
        return { detached: true }
      }
      case 'state': {
        const snapshot = deliverySnapshot(session)
        return trimPayload({
          ...withoutAgent(createPayload({
            file,
            buffer: this.#store.pathsForDocument(file).buffer,
            agent: 'state',
            event: 'state',
            open: true,
            cursor: snapshot.cursor,
            document: snapshot.document,
            annotations: withAttachmentNames(Object.values(session.annotations.annotations).map(toDeliveredAnnotation), this.#attachmentName(session)),
            attachments: this.#attachmentRows(session)
          })),
          theme: this.#themeSummary()
        }, request.args)
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
        const author = session.attachments[request.args.agent]
        if (!author) throw attachmentNotFound(request.args.agent, file)
        let next = session.annotations
        const created: Array<{ id: string; kind: string; quote: string }> = []
        const failures: QuoteFailureEntry[] = []
        for (const [index, annotation] of request.args.annotations.entries()) {
          const id = `a_${randomUUID().slice(0, 12)}`
          const quote = annotation.kind === 'decision'
            ? (annotation.heading ?? annotation.quote ?? '')
            : annotation.quote
          try {
            next = createAnnotation(next, session.state.shadow, {
              createdAt: this.#now(),
              id,
              kind: annotation.kind,
              author: 'agent',
              agent: request.args.agent,
              name: author.name,
              quote,
              text: annotation.text ?? '',
              ...(annotation.kind !== 'decision' && annotation.label ? { label: annotation.label } : {}),
              ...(annotation.kind === 'decision' ? {
                anchorKind: annotation.document === true ? 'document' : annotation.heading !== undefined ? 'heading' : 'quote',
                options: annotation.options,
              } : {}),
              // An empty context is a document boundary, so undefined is the only "absent".
              ...(annotation.precededBy === undefined ? {} : { precededBy: annotation.precededBy }),
              ...(annotation.followedBy === undefined ? {} : { followedBy: annotation.followedBy })
            }).log
            created.push({ id, kind: annotation.kind, quote })
          } catch (error) {
            if (!(error instanceof AnnotationAnchorError)) throw error
            failures.push({ index, quote, ...describeQuoteFailure(session.state.shadow, quote, error) })
          }
        }
        if (failures.length > 0) throw quoteFailureCommand(failures, 'quote')
        session.annotations = next
        await this.#persist(session)
        this.#publish()
        return { created }
      }
      case 'edit':
        return this.#editCommand(session, request.args)
      case 'pin':
        return this.#pinCommand(session, request.args)
      case 'reply': {
        const replier = session.attachments[request.args.agent]
        if (!replier) throw attachmentNotFound(request.args.agent, file)
        if (!session.annotations.annotations[request.args.annotation]) {
          throw annotationNotFound(request.args.annotation, file)
        }
        const id = `r_${randomUUID().slice(0, 12)}`
        session.annotations = replyToAnnotation(session.annotations, request.args.annotation, {
          createdAt: this.#now(),
          id,
          author: 'agent',
          agent: request.args.agent,
          name: replier.name,
          text: request.args.text
        }).log
        await this.#persist(session)
        this.#publish()
        return { replied: id, annotation: request.args.annotation }
      }
      case 'answer': {
        const action = request.args
        const decision = session.annotations.annotations[action.decision]
        if (!decision) throw annotationNotFound(action.decision, file)
        if (decision.kind !== 'decision') {
          throw new CommandFailure(`${action.decision} is not a decision`, 3, 'NOT_A_DECISION', { annotation: action.decision })
        }
        throw new CommandFailure(
          `Only the user can answer decision ${action.decision}. Reply to its thread to clarify or recommend a choice.`,
          3,
          'DECISION_OWNER_REQUIRED',
          { decision: action.decision, action: 'reply' },
        )
      }
      case 'send': {
        const message = request.args
        const sender = session.attachments[message.agent]
        if (!sender) throw attachmentNotFound(message.agent, file)
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
          throw new CommandFailure(`Recipient ${missing.join(', ')} is not attached to ${file}`, 2, 'ATTACHMENT_NOT_FOUND', { recipients: missing, file })
        }
        // All-or-nothing: every sender→recipient slot is checked before anything
        // is enqueued, so a failed send never double-delivers on retry.
        const blocked = recipients.filter((id) => session.attachments[id]!.deliveries.some(
          (delivery) => isMessageDelivery(delivery) && delivery.payload.from?.agent === message.agent,
        ))
        if (blocked.length > 0) {
          throw new CommandFailure(
            `Your earlier message to ${blocked.join(', ')} has not been collected yet. Retry after they attach, or send only to the others with --to.`,
            3,
            'MESSAGE_PENDING',
            { recipients: blocked, others: recipients.filter((id) => !blocked.includes(id)) },
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
        await this.#persist(session)
        for (const { agent } of sent) {
          const delivery = collectOldest(session.attachments[agent]!)
          if (delivery) this.#attachWaits.deliver(attachKey(file, agent), delivery.payload)
        }
        this.#scheduleIdleExpiry()
        this.#publish()
        return { sent }
      }
      case 'lead': {
        const claim = request.args
        if (!session.attachments[claim.agent]) throw attachmentNotFound(claim.agent, file)
        if (session.leadAgentId !== null && session.leadAgentId !== claim.agent) {
          const holder = this.#leadHolder(session)!
          throw new CommandFailure(`${holder.name} (${holder.agent}) already holds the Lead`, 3, 'LEAD_TAKEN', { holder })
        }
        session.leadAgentId = claim.agent
        await this.#persist(session)
        this.#publish()
        return { lead: claim.agent }
      }
      case 'accept': {
        const action = request.args
        this.#requireLead(session, action.agent)
        const suggestion = session.annotations.annotations[action.annotation]
        if (!suggestion) throw annotationNotFound(action.annotation, file)
        try {
          await this.#acceptSuggestionAsLead(session, action.annotation, action.agent)
        } catch (error) {
          if (error instanceof AnnotationAnchorError) throw this.#movedSuggestionFailure(session, suggestion, error)
          throw error
        }
        return { accepted: action.annotation }
      }
      case 'reject': {
        const action = request.args
        this.#requireLead(session, action.agent)
        if (!session.annotations.annotations[action.annotation]) throw annotationNotFound(action.annotation, file)
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
        const record = session.annotations.annotations[action.annotation]
        if (!record) throw annotationNotFound(action.annotation, file)
        if (record.kind === 'decision') {
          throw new CommandFailure(
            `Only the user can answer or reopen decision ${action.annotation}. Reply to its thread instead.`,
            3,
            'DECISION_OWNER_REQUIRED',
            { decision: action.annotation, action: 'reply' },
          )
        }
        if (!session.attachments[action.agent]) throw attachmentNotFound(action.agent, file)
        if (record.agent !== action.agent && session.leadAgentId !== action.agent) {
          throw this.#notLead(session, `Only the Lead may resolve annotations it did not author; ${action.annotation} belongs to ${record.agent ?? 'the user'}`)
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
          await this.#saveLocked(file)
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

  /** The panel's disconnect: the same path as agent `detach`, cancelling a blocked attach call. */
  disconnectAgent(path: string, agentId: string): Promise<void> {
    return this.#withSession(path, async () => {
      const session = this.#require(path)
      if (!session.attachments[agentId]) throw new Error(`Attachment ${agentId} was not found`)
      this.#removeAttachment(session, agentId)
      await this.#persist(session)
      this.#scheduleIdleExpiry()
      this.#publish()
    })
  }

  #removeAttachment(session: OpenDocumentSession, agentId: string): void {
    delete session.attachments[agentId]
    if (session.leadAgentId === agentId) session.leadAgentId = null
    session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
    this.#attachWaits.cancel(attachKey(session.path, agentId), new Error('Attachment detached'))
  }

  #leadHolder(session: OpenDocumentSession): { agent: string; name: string } | null {
    const id = session.leadAgentId
    if (id === null) return null
    return { agent: id, name: session.attachments[id]?.name ?? id }
  }

  /** NOT_LEAD always says who holds it, or that nobody does and how to claim it. */
  #notLead(session: OpenDocumentSession, message: string): CommandFailure {
    const holder = this.#leadHolder(session)
    const who = holder === null ? 'no agent holds the Lead; run stratamd lead to claim it' : `${holder.name} (${holder.agent}) holds the Lead`
    return new CommandFailure(`${message}: ${who}`, 3, 'NOT_LEAD', { holder })
  }

  #requireLead(session: OpenDocumentSession, agentId: string): void {
    if (!session.attachments[agentId]) throw attachmentNotFound(agentId, session.path)
    if (session.leadAgentId !== agentId) throw this.#notLead(session, 'This action needs the Lead')
  }

  /**
   * A compare-and-swap edit: each match is located in the live shadow with
   * annotate's rules, then the whole replacement lands through the same path
   * as a tagged buffer write, so it is a pending hunk in the agent's name and
   * the ghost never moves. The mirror is flushed first so the merge compares
   * against exactly the text the matches were found in.
   */
  async #editCommand(session: OpenDocumentSession, edit: CommandArguments['edit']): Promise<unknown> {
    if (session.readOnly) throw new CommandFailure('This document is read-only', 3, 'READ_ONLY')
    if (session.recovery) {
      throw new CommandFailure('The user must choose Recover or Discard before the buffer can change', 3, 'RECOVERY_PENDING')
    }
    if (!session.attachments[edit.agent]) throw attachmentNotFound(edit.agent, session.path)
    await session.mirror?.flush()
    const shadow = session.state.shadow
    const located: Array<{ index: number; start: number; end: number; replace: string }> = []
    const failures: QuoteFailureEntry[] = []
    for (const [index, input] of edit.edits.entries()) {
      try {
        const anchor = locateEdit(shadow, input)
        located.push({ index, start: anchor.start, end: anchor.end, replace: input.replace })
      } catch (error) {
        if (!(error instanceof AnnotationAnchorError)) throw error
        failures.push({ index, quote: input.match, ...describeQuoteFailure(shadow, input.match, error, 'match') })
      }
    }
    if (failures.length > 0) throw quoteFailureCommand(failures, 'match')
    located.sort((left, right) => left.start - right.start || left.index - right.index)
    for (let position = 1; position < located.length; position += 1) {
      const previous = located[position - 1]!
      const current = located[position]!
      // Two zero-width inserts at one point are fine; anything sharing text is not.
      if (current.start < previous.end) {
        throw new CommandFailure(
          `Edits ${previous.index + 1} and ${current.index + 1} overlap in the buffer`,
          3,
          'EDITS_OVERLAP',
          {
            edits: [previous.index, current.index],
            matches: [edit.edits[previous.index]!.match, edit.edits[current.index]!.match],
          },
        )
      }
    }
    if (edit.dryRun === true) {
      return {
        located: located
          .slice()
          .sort((left, right) => left.index - right.index)
          .map((entry) => ({ line: lineAt(shadow, entry.start), match: edit.edits[entry.index]!.match })),
      }
    }

    let next = ''
    let cursor = 0
    const applied: Array<{ index: number; line: number; match: string; replace: string }> = []
    for (const entry of located) {
      next += shadow.slice(cursor, entry.start)
      applied.push({
        index: entry.index,
        line: next.split('\n').length,
        match: edit.edits[entry.index]!.match,
        replace: entry.replace,
      })
      next += entry.replace
      cursor = entry.end
    }
    next += shadow.slice(cursor)

    const name = edit.name ?? session.attachments[edit.agent]?.name ?? edit.agent
    session.state = setExternalTag(session.state, edit.agent, name, this.#now())
    await this.#mergeExternalText(session, 'buffer', next)
    await this.#changed(session)
    await session.mirror?.flush()
    return {
      applied: applied
        .sort((left, right) => left.index - right.index)
        .map(({ line, match, replace }) => ({ line, match, replace })),
    }
  }

  async #pinCommand(session: OpenDocumentSession, input: CommandArguments['pin']): Promise<unknown> {
    if (session.readOnly) throw new CommandFailure('This document is read-only', 3, 'READ_ONLY')
    if (session.recovery) {
      throw new CommandFailure('The user must choose Recover or Discard before the buffer can change', 3, 'RECOVERY_PENDING')
    }
    const attachment = session.attachments[input.agent]
    if (!attachment) throw attachmentNotFound(input.agent, session.path)
    await session.mirror?.flush()
    const parsed = parseMarkdown(session.state.shadow)
    const block = parsed.blocks.find((candidate) => {
      const node = candidate.node as unknown as ComponentAstNode
      return candidate.span.start.line === input.componentLine
        && node.type === 'mdxJsxFlowElement'
        && node.name === 'AnnotatedScreenshot'
    })
    if (!block) {
      throw new CommandFailure(
        `No AnnotatedScreenshot opens on line ${input.componentLine} in ${session.path}`,
        2,
        'COMPONENT_NOT_FOUND',
        { file: session.path, line: input.componentLine, component: 'AnnotatedScreenshot' },
      )
    }
    const node = block.node as unknown as ComponentAstNode
    const analysis = analyzeComponentNode(node)
    const screenshot = annotatedScreenshotData(node)
    if (!analysis.valid || !screenshot || screenshot.tableEnd === null) {
      throw new CommandFailure(
        `AnnotatedScreenshot on line ${input.componentLine} needs valid image and pin-table syntax`,
        3,
        'COMPONENT_INVALID',
        { file: session.path, line: input.componentLine, problems: analysis.problems },
      )
    }
    let image: string | undefined
    try {
      image = await resolveAllowedLocalPath(screenshot.imageSource, session.path, this.#settings.explorerFolders)
    } catch {
      // The command exposes one stable not-found result for missing and disallowed image paths.
    }
    if (!image) {
      throw new CommandFailure(
        `The image in AnnotatedScreenshot on line ${input.componentLine} is unavailable`,
        2,
        'IMAGE_NOT_FOUND',
        { file: session.path, line: input.componentLine, source: screenshot.imageSource },
      )
    }
    let version: string
    try {
      const details = await stat(image, { bigint: true })
      version = `${details.size}:${details.mtimeNs}`
    } catch {
      throw new CommandFailure(
        `The image ${image} is unavailable`,
        2,
        'IMAGE_NOT_FOUND',
        { file: session.path, line: input.componentLine, source: screenshot.imageSource, path: image },
      )
    }
    if (screenshot.pins.some((pin) => pin.version !== version)) {
      throw new CommandFailure(
        `The image ${screenshot.imageSource} in ${session.path} at line ${input.componentLine} changed; verify existing pin positions in StrataMD before adding another pin`,
        3,
        'IMAGE_VERIFICATION_REQUIRED',
        { file: session.path, line: input.componentLine, source: screenshot.imageSource },
      )
    }
    const pin = Math.max(0, ...screenshot.pins.map((entry) => entry.pin)) + 1
    const note = input.note.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\\', '\\\\').replaceAll('|', '\\|').trim()
    if (!note) throw new CommandFailure('--note must contain visible text', 1, 'USAGE')
    const tableEnd = screenshot.tableEnd
    if (tableEnd < block.span.start.offset || tableEnd > block.span.end.offset) {
      throw new CommandFailure(`AnnotatedScreenshot pin table on line ${input.componentLine} has no source end`, 3, 'COMPONENT_INVALID')
    }
    const lineEnding = block.source.includes('\r\n') ? '\r\n' : '\n'
    const row = `| ${pin} | ${input.x.toFixed(1)} | ${input.y.toFixed(1)} | ${version} | ${note} |`
    const next = session.state.shadow.slice(0, tableEnd)
      + lineEnding + row
      + session.state.shadow.slice(tableEnd)
    const name = input.name ?? attachment.name
    session.state = setExternalTag(session.state, input.agent, name, this.#now())
    await this.#mergeExternalText(session, 'buffer', next)
    await this.#changed(session)
    await session.mirror?.flush()
    return { pinned: pin, component: input.componentLine, x: input.x, y: input.y, note: input.note }
  }

  /** One external merge as an application step: the watcher's path, shared with `edit`. */
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

  async #enqueueDeliveries(
    session: OpenDocumentSession,
    request: SendPreviewRequest,
    recipients: readonly string[],
    event: 'send' | 'closed' = 'send',
    annotations: AnnotationLog = session.annotations,
  ) {
    const deliveries = await Promise.all(recipients.map(async (id) => {
      const attachment = session.attachments[id]
      if (!attachment) throw new Error(`Attachment ${id} was not found`)
      const delivery = freezeDelivery(
        attachment,
        await this.#deliverySource(session, request, id, event, annotations),
      )
      session.attachments[id] = enqueueDelivery(attachment, delivery)
      if (attachment.pendingBlockOutcomes?.length) session.attachments[id] = { ...session.attachments[id]!, pendingBlockOutcomes: [] }
      return delivery
    }))
    return deliveries
  }

  async #deliverySource(
    session: OpenDocumentSession,
    request: SendPreviewRequest,
    recipient: string | 'clipboard',
    event: 'send' | 'closed' = 'send',
    annotations: AnnotationLog = session.annotations,
    attachmentOverride?: Attachment,
  ): Promise<DeliverySource> {
    const targetAttachment = recipient === 'clipboard' ? null : (attachmentOverride ?? session.attachments[recipient]!)
    const cursor = annotations.nextSeq - 1
    const fromCursor = recipient === 'clipboard'
      ? (session.clipboardRecipient.pending?.to.cursor ?? session.clipboardRecipient.cursor)
      : deliveryStart(targetAttachment!).cursor
    const start = recipient === 'clipboard'
      ? deliveryStartForClipboard(session.clipboardRecipient)
      : deliveryStart(targetAttachment!)
    const baselineWithinHistory = start.segmentIndex >= session.segmentOffset - 1
    const baselineAvailable = recipient === 'clipboard' && session.clipboardRecipient.baseline === null
      ? true
      : baselineWithinHistory && await this.#store.hasObject(start.snapshotId)
    const skippedEvents = recipient === 'clipboard' || !baselineAvailable
      ? new Set<number>()
      : new Set(targetAttachment!.deliveredSeqs)
    const slice = annotationDeliverySlice(
      annotations,
      baselineAvailable ? fromCursor : 0,
      recipient,
      new Set(request.excludedEvents ?? []),
      skippedEvents,
    )
    return {
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
      note: [request.note, ...(targetAttachment?.pendingBlockOutcomes?.length ? ['Strata block outcomes:', ...targetAttachment.pendingBlockOutcomes] : [])].filter(Boolean).join('\n'),
      includeExternal: request.includeExternal,
      excludedHunks: request.excludedHunks ?? [],
      eventsLeftOut: slice.excluded > 0,
      event,
      now: this.#now(),
      baselineAvailable,
    }
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

  async #closedStatePayload(file: string) {
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
    return {
      ...withoutAgent(createPayload({
        file,
        buffer: this.#store.pathsForDocument(file).buffer,
        agent: 'state',
        event: 'state',
        open: false,
        cursor: annotations.nextSeq - 1,
        document,
        annotations: Object.values(annotations.annotations).map(toDeliveredAnnotation),
      })),
      theme: this.#themeSummary(),
    }
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
    // setTimeout treats a delay beyond 2^31-1 ms as 1 ms; a long idle window
    // would then expire attachments at once. Wait in bounded steps and re-arm.
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - this.#now()))
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      void this.#expireIdleAttachmentsLive()
    }, delay)
    this.#idleTimer.unref?.()
  }

  async #expireIdleAttachmentsLive(): Promise<void> {
    const now = this.#now()
    let changed = false
    for (const session of [...this.#sessions.values()]) {
      await this.#withSession(session.path, async () => {
        if (this.#sessions.get(session.path) !== session) return
        const retained = expireIdleAttachments(
          session.attachments,
          now,
          this.#settings.attachmentIdleTimeoutMs,
        )
        if (Object.keys(retained).length === Object.keys(session.attachments).length) return
        session.attachments = { ...retained }
        if (session.leadAgentId !== null && session.attachments[session.leadAgentId] === undefined) {
          session.leadAgentId = null
        }
        session.annotations = retainConfiguredResolvedAnnotations(session, this.#settings.keepResolvedAnnotations)
        changed = true
        await this.#persist(session)
      })
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
      settings: stableValue(last.settings, raw.settings),
      engine: stableValue(last.engine, raw.engine)
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
      activeDocument: focused ? documentView(this.#sessions.get(focused)!, this.#store, this.#now()) : null,
      explorer: explorerView(this.#explorer, this.#sessions),
      settings: { ...settingsView(this.#settings), theme: this.#themeView() },
      engine: this.#engine.view()
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
        && cursors.every((cursor) => cursor >= lastAnnotationEvent(session.annotations, annotation.id).seq),
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
      lastCallAt: stored.lastCallAt ?? stored.attachedAt ?? 0,
      waiting: false,
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
    lastCallAt: attachment.lastCallAt,
    waiting: attachment.waiting ?? false,
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

function annotationView(log: AnnotationLog, attachments: Record<string, Attachment>, document: string): AnnotationView[] {
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
    ...(annotation.source ? { source: annotation.source } : {}),
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

function documentView(session: OpenDocumentSession, store: GhostStore, now: number): DocumentView {
  const ids = Object.keys(session.attachments)
  const attachments: AttachmentView[] = ids.map((id, index) => {
    const attachment = session.attachments[id]!
    return {
      agent: agentIdentity(id, attachment.name, index),
      attachedAt: attachment.attachedAt,
      state: attachmentDisplayState(attachment),
      queuedDeliveries: attachment.deliveries.map((delivery) => delivery.id),
      queuedSendCount: attachment.deliveries.filter((delivery) => !isMessageDelivery(delivery)).length,
      // Metadata from before calls were timed restores as zero; that is no time at all.
      lastCallAt: attachment.lastCallAt > 0 ? attachment.lastCallAt : null
      ,cursor: deliveryStart(attachment).cursor
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
    annotations: annotationView(session.annotations, session.attachments, session.state.shadow),
    items: deriveItems({
      annotations: annotationView(session.annotations, session.attachments, session.state.shadow),
      hunks: hunkViews(session, now),
      attachments,
    }),
    drafts,
    attachments,
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
  if (session.clipboardRecipient.baseline) referenced.add(session.clipboardRecipient.baseline.snapshotId)
  if (session.clipboardRecipient.pending) {
    referenced.add(session.clipboardRecipient.pending.from.snapshotId)
    referenced.add(session.clipboardRecipient.pending.to.snapshotId)
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

/** An ack that names no queued delivery is refused, never silently absorbed (plan 4.5). */
function unknownDeliveryFailure(attachment: Attachment, deliveryId: string): CommandFailure {
  const head = attachment.deliveries[0]?.id ?? null
  const message = head === null
    ? `No delivery ${deliveryId} is queued for ${attachment.id}; nothing is waiting to be acknowledged`
    : `No delivery ${deliveryId} is at the head of ${attachment.id}'s queue; acknowledge ${head} first`
  return new CommandFailure(message, 2, 'DELIVERY_NOT_FOUND', {
    deliveryId,
    agent: attachment.id,
    queued: attachment.deliveries.map((delivery) => delivery.id),
  })
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
