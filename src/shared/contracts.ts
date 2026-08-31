export type AnnotationKind = 'comment' | 'question' | 'suggestion'
export type AnnotationStatus = 'open' | 'resolved' | 'orphaned'
export type AttachmentState = 'waiting' | 'working' | 'pending'
export type PendingHunkStatus = 'pending' | 'mixed'

export interface AgentIdentity {
  id: string
  name: string
  color: 'grape' | 'sky' | 'mint' | 'tangerine'
}

export interface HunkView {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  removed: string[]
  added: string[]
  status: PendingHunkStatus
  author: AgentIdentity | null
  source: 'buffer' | 'document'
  inline: boolean
  /** True when this hunk's region already matches the saved file (PRD §6.9 save-state groups). */
  saved: boolean
}

export interface ReplyView {
  id: string
  author: 'user' | AgentIdentity
  text: string
  createdAt: number
}

export interface AnnotationView {
  id: string
  seq: number
  kind: AnnotationKind
  status: AnnotationStatus
  author: 'user' | AgentIdentity
  quote: string
  text: string
  label?: string
  line: number | null
  from: number | null
  to: number | null
  replacement?: string
  replies: ReplyView[]
}

export interface AttachmentView {
  agent: AgentIdentity
  attachedAt: number
  state: AttachmentState
  queuedDeliveries: string[]
  /** Queued non-message deliveries: what a disconnect would discard (PRD §6.6). */
  queuedSendCount: number
}

export interface ExplorerFileView {
  path: string
  name: string
  relativePath: string
  folder: string
  missing: boolean
  pendingCount: number
}

export interface ExplorerFolderView {
  path: string
  name: string
  files: ExplorerFileView[]
}

export interface DocumentTabView {
  path: string
  name: string
  pendingCount: number
  pendingColor?: AgentIdentity['color']
  active: boolean
  dirty: boolean
}

export interface DocumentView {
  path: string
  bufferPath: string
  /** One source, mirroring the session's field; rows compare ids against it (PRD §6.6). */
  leadAgentId: string | null
  content: string
  sourceMode: boolean
  sourceOnly: boolean
  readOnly: boolean
  dirty: boolean
  deleted: boolean
  invalidUtf8: boolean
  lastSavedAt: number | null
  /** Increases once per application step (Keep, Revert, Accept, merge); never on undo or redo. */
  historyStep: number
  pendingHunks: HunkView[]
  /** Save history summaries, oldest first (PRD §6.7); hunks come from saveRound on demand. */
  saves: SaveRoundView[]
  annotations: AnnotationView[]
  attachments: AttachmentView[]
  canSend: boolean
  recovery?: {
    diskUpdatedAt: number
    bufferUpdatedAt: number
  }
  conflicts: ConflictView[]
}

export interface ConflictView {
  id: string
  label: string
  mine: string
  incoming: string
}

export interface SaveRoundAuthorView {
  name: string
  user: boolean
}

/** One Save's summary row: when, and who was active in the round (PRD §6.7). */
export interface SaveRoundView {
  time: number
  authors: SaveRoundAuthorView[]
}

/** A read-only hunk of a past save round; not reviewable and not jumpable. */
export interface RoundHunkView {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  removed: string[]
  added: string[]
}

export interface ThemePanelGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelSize {
  width: number
  /** -1 sizes to content until the user resizes. */
  height: number
}

export interface PanelSizes {
  explorerWidth: number
  rightRailWidth: number
  changesHeight: number
  annotationsHeight: number
  documentMeasure: number
  themePanel: ThemePanelGeometry
  threadPanel: PanelSize
  annotationComposer: PanelSize
  sendComposer: PanelSize
}

export interface ThemeProblemView {
  key: string
  reason: string
}

export interface ThemeSummaryView {
  id: string
  name: string
  builtIn: boolean
  broken: boolean
  missing: boolean
  problems: ThemeProblemView[]
}

export interface ActiveThemeView {
  id: string
  name: string
  builtIn: boolean
  missing: boolean
  path: string | null
  /** The file as written: nested groups, only set keys. */
  sparse: Record<string, unknown>
  /** Every key resolved against the built-in values. */
  values: Record<string, string | number>
  problems: ThemeProblemView[]
}

export interface ThemeView {
  active: ActiveThemeView
  available: ThemeSummaryView[]
  /** Bumped whenever the active theme changed on disk from outside the app. */
  externalRevision: number
}

export type PaneId = 'explorer' | 'editor' | 'rightRail' | 'composer'
export type PaneZoom = Record<PaneId, number>

export interface AppSettingsView {
  animatedBackground: boolean
  attachmentIdleHours: number
  panelSizes: PanelSizes
  zoom: PaneZoom
  theme: ThemeView
}

export interface AppView {
  tabs: DocumentTabView[]
  activeDocument: DocumentView | null
  explorer: ExplorerFolderView[]
  settings: AppSettingsView
}

/**
 * The document state a preview was computed against: snapshot, segment index,
 * and annotation cursor. One token covers every recipient — the from side of a
 * delivery cannot move while the composer is open — and send refuses a request
 * whose token no longer matches, so the frozen delivery always equals the
 * preview the user saw.
 */
export interface SendDocumentToken {
  snapshotId: string
  segmentIndex: number
  cursor: number
}

export interface SendPreviewRequest {
  recipients: string[]
  note: string
  includeExternal: boolean
  /** Hunk items the user unchecked, as `segmentId:hunkIndex` keys. */
  excludedHunks?: string[]
  /** Annotation event seqs the user unchecked. */
  excludedEvents?: number[]
  token?: SendDocumentToken
}

/** One change the composer can include or leave out, keyed `segmentId:hunkIndex`. */
export interface SendChangeItem {
  key: string
  author: 'user' | 'external'
  /** The agent the change came from or through, when known. */
  name?: string
  oldStart: number
  newStart: number
  removed: string[]
  added: string[]
}

/** One comment, reply, resolution, or verdict the composer can include or leave out, keyed by event seq. */
export interface SendEventItem {
  seq: number
  kind: 'annotation' | 'reply' | 'resolution' | 'verdict'
  annotationKind?: 'comment' | 'question' | 'suggestion'
  author?: 'user' | 'agent'
  name?: string
  text: string
  quote?: string
}

export interface SendItems {
  changes: SendChangeItem[]
  events: SendEventItem[]
}

export interface SendPreview {
  recipient: AgentIdentity | { id: 'clipboard'; name: 'Clipboard'; color: 'grape' }
  text: string
  token: SendDocumentToken
  /** Everything this recipient could receive, independent of the current selection. */
  items: SendItems
  /** True when this recipient's baseline is gone: it gets the whole document and item selection cannot apply. */
  resync?: boolean
  queuedAfter?: string
  dependentExternalHunks: number
}

export interface AcceptAllSuggestionsView {
  accepted: string[]
  skipped: string[]
}

export type CloseDecision = 'save' | 'discard' | 'cancel'
export type ConflictDecision = 'mine' | 'incoming'
export type UndoResult = 'undone' | 'empty'
export type RedoResult = 'redone' | 'empty'
/** Whether a buffer update is a new edit or the editor replaying its own history. */
export type BufferOrigin = 'edit' | 'history'

/** A right-clicked misspelling and Electron's suggestions for it (docs/plans/completed/spellcheck-plan.md). */
export interface SpellingContext {
  word: string
  suggestions: string[]
}

/** A renderer failure headed for the local log (docs/plans/completed/crash-hardening-plan.md §7). */
export interface ErrorReport {
  scope: string
  message: string
  stack?: string
  componentStack?: string
}

export interface StrataApi {
  getState(): Promise<AppView>
  subscribe(listener: (state: AppView) => void): () => void
  openDocument(path?: string): Promise<void>
  /** Renderer-only bridge: preload resolves Electron File objects with webUtils. */
  openDroppedFiles?(files: File[]): Promise<void>
  /** Renderer-only bridge: fire-and-forget failure report into the local log. */
  reportError?(report: ErrorReport): void
  /** Renderer-only bridge: the latest right-click spelling context from the main process. */
  onSpelling?(listener: (spelling: SpellingContext) => void): () => void
  /** Renderer-only bridge: teaches the spellchecker one word; its underline clears everywhere. */
  addDictionaryWord?(word: string): Promise<void>
  closeDocument(path: string, decision?: CloseDecision): Promise<'closed' | 'needs-decision' | 'cancelled'>
  updateBuffer(path: string, content: string, origin: BufferOrigin): Promise<void>
  undo(path: string): Promise<UndoResult>
  redo(path: string): Promise<RedoResult>
  resolveLocalImage(documentPath: string, source: string): Promise<string | null>
  save(path: string): Promise<void>
  setSourceMode(path: string, source: boolean): Promise<void>
  keepHunk(path: string, hunkId: string): Promise<void>
  revertHunk(path: string, hunkId: string, confirmMixed?: boolean): Promise<void>
  markReviewed(path: string): Promise<void>
  /** The read-only hunks of one save round, computed on demand (PRD §6.7). */
  saveRound(path: string, index: number): Promise<{ hunks: RoundHunkView[] }>
  addAnnotation(path: string, annotation: { kind: AnnotationKind; quote: string; text: string; from: number; to: number }): Promise<void>
  requoteAnnotation(path: string, annotationId: string, range: { quote: string; from: number; to: number }): Promise<void>
  reply(path: string, annotationId: string, text: string): Promise<void>
  resolveAnnotation(path: string, annotationId: string): Promise<void>
  acceptSuggestion(path: string, annotationId: string): Promise<void>
  rejectSuggestion(path: string, annotationId: string): Promise<void>
  acceptAllSuggestions(path: string, agentId: string): Promise<AcceptAllSuggestionsView>
  rejectAllSuggestions(path: string, agentId: string): Promise<string[]>
  clearResolvedAnnotations(path: string): Promise<void>
  resolveRecovery(path: string, decision: 'recover' | 'discard'): Promise<void>
  resolveConflict(path: string, conflictId: string, decision: ConflictDecision): Promise<void>
  previewSend(path: string, request: SendPreviewRequest): Promise<SendPreview[]>
  send(path: string, request: SendPreviewRequest): Promise<string[]>
  copyForAgent(path: string, note: string, includeExternal: boolean): Promise<void>
  copyText(text: string): Promise<void>
  nudge(path: string, agentId: string): Promise<void>
  /** Grants, transfers, or revokes (null) the Lead; user actions are authoritative (PRD §6.6). */
  setLead(path: string, agentId: string | null): Promise<void>
  /** Ends an attachment from the panel, the same path as agent detach. */
  disconnectAgent(path: string, agentId: string): Promise<void>
  addFolder(): Promise<void>
  scanFolder(path: string): Promise<void>
  refreshExplorer(): Promise<void>
  forgetDocument(path: string): Promise<void>
  updateSettings(settings: Partial<Omit<AppSettingsView, 'theme'>>): Promise<void>
  selectTheme(id: string): Promise<void>
  createTheme(name: string, fromId: string): Promise<string>
  setThemeValue(key: string, value: string | number | null): Promise<void>
  renameTheme(name: string): Promise<void>
  revertTheme(sparse: Record<string, unknown>): Promise<void>
  deleteTheme(id: string): Promise<void>
  listFonts(): Promise<string[]>
  /** Writes the theme sample document to the config directory and opens it as a tab. */
  openThemeSample(): Promise<void>
}
