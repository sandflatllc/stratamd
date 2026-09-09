import type { BrowserEvidenceView } from './browser-evidence'
import type { EngineSettingsEdit, ProviderEdit, ProviderEnvironment, EngineSupport } from './engine-settings'
export type AnnotationKind = 'comment' | 'question' | 'suggestion' | 'decision'
export type AnnotationStatus = 'open' | 'resolved' | 'orphaned'
export type AnnotationAnchorKind = 'quote' | 'heading' | 'document'
export type AttachmentState = 'idle' | 'starting' | 'running' | 'ready' | 'interrupted' | 'stopped' | 'error' | 'disconnected'
export type PendingHunkStatus = 'pending' | 'mixed'

export interface TableAnnotationContext {
  kind: 'table-row' | 'table-cell'
  heading: string | null
  columns: string[]
  column: { index: number; label: string } | null
}

export interface ScreenshotPinAnnotationContext {
  kind: 'screenshot-pin'
  component: 'AnnotatedScreenshot'
  componentLine: number
  image: string
  pin: number
}

export type AnnotationContext = TableAnnotationContext | ScreenshotPinAnnotationContext

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
  /** When the change was recorded (ms epoch); the rail shows it as relative time. */
  changedAt: number
  itemSource?: { threadId: string; turnId: string; messageId: string }
}

export interface ReplyView {
  id: string
  author: 'user' | AgentIdentity
  text: string
  /** When the reply was made, once the annotation log records it; absent until then. */
  createdAt?: number
}

export interface DecisionAnswer {
  seq: number
  option: string | null
  other?: string
  author: 'user'
  answeredAt: number
}

export interface DecisionData {
  options: readonly string[]
  answers: readonly DecisionAnswer[]
}

export interface AnnotationView {
  id: string
  seq: number
  kind: AnnotationKind
  status: AnnotationStatus
  anchor?: AnnotationAnchorKind
  author: 'user' | AgentIdentity
  quote: string
  text: string
  label?: string
  line: number | null
  from: number | null
  to: number | null
  replacement?: string
  context?: AnnotationContext
  decision?: DecisionData
  /** False when a suggestion's text cannot be shown inline (a multi-paragraph replacement); the rail row then carries Accept and Reject. */
  inline?: boolean
  /** When the annotation was made, once the annotation log records it; absent until then. */
  createdAt?: number
  replies: ReplyView[]
  /** Event sequence for each reply, parallel to replies; used to show Drafted until delivery acknowledgment. */
  replySeqs?: number[]
  source?: { threadId: string; turnId: string; messageId: string }
  review?: 'unreviewed' | 'reviewed' | 'revisit'
}

export type ItemKind = 'decision' | 'question' | 'suggestion' | 'edit' | 'comment'
export type ItemStatus = 'open' | 'drafted' | 'done'

export interface StoredAsk { id: string; quote: string; from: number; to: number; sourceHash?: string | undefined; retained?: boolean | undefined }
export interface StoredAskScan { sourceHash: string; state: 'done' | 'cancelled'; asks: StoredAsk[]; reason?: string | undefined }
export interface AskScanView { messageId: string; state: 'working' | 'done' | 'cancelled'; count: number; reason?: string | undefined }

export interface ItemView {
  askRange?: { from: number; to: number } | undefined
  answerDraft?: string | undefined
  source?: { kind: "message"; anchor: import("../core/conversation-delivery").MessageAnchor } | { kind: "document"; path: string }
  options?: string[]
  discussion?: Array<{ author: "user" | "agent"; text: string }>
  unavailable?: boolean
  id: string
  kind: ItemKind
  status: ItemStatus
  review: 'unreviewed' | 'reviewed' | 'revisit'
  text: string
  quote: string
  order: number
  threadId: string | null
  turnId: string | null
  messageId: string | null
  annotationId: string | null
  hunkId: string | null
  inferred: boolean
  /** The reply queued for the next Send (§5.4 Drafted); absent once delivered or when none. */
  draftReply?: string
}

export type DraftKind = 'comment' | 'question' | 'suggestion'

/** A private held comment. It is not an annotation until Send materializes it. */
export interface DraftView {
  id: string
  kind: DraftKind
  quote: string
  prefix: string
  suffix: string
  text: string
  from: number | null
  to: number | null
  status: 'attached' | 'orphaned'
  context?: AnnotationContext
  createdAt: number
}

/**
 * One recipient pill (§5.6): a thread attached to the document, or the active
 * conversation in the same project, which the first Send attaches.
 */
export interface RecipientView {
  id: string
  name: string
  color: AgentIdentity['color']
  attached: boolean
}

export interface AttachmentView {
  agent: AgentIdentity
  attachedAt: number
  state: AttachmentState
  queuedDeliveries: string[]
  /** Deliveries still awaiting an engine message-sent acknowledgment. */
  queuedSendCount: number
  cursor?: number
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

/** The left window's tabs (§6.9): Projects always; Conversation and Contents while a document is in the center. */
export type NavigationTab = 'projects' | 'conversation' | 'contents'
export type ReviewTab = 'changes' | 'annotations'

export type EngineConnectionState = 'unpaired' | 'connecting' | 'connected' | 'disconnected'

export interface EngineMessageView {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  turnId: string | null
  streaming: boolean
  createdAt: string
  /** T3's last write to the message; the end of a turn's final answer when timing a fold. */
  updatedAt?: string
  documentAttachments?: Array<{ id: string; name: string; threadId: string }>
  attachmentCount: number
  /** Exact passage feedback from this message's frozen delivery. */
  sentComments?: import("../core/sent-comments").SentComments
  /** Immutable markdown blocks, namespaced by the stable message id. */
  blocks?: Array<{ id: string; from: number; to: number; text: string }>
  prose?: string
  /** Visual comments this completed reply answered, from its strata block; the conversation shows a chip for each. */
  visualReplies?: Array<{ id: string; revision?: number; ready: boolean }>
}

export interface EngineActivityView {
  id: string
  tone: 'info' | 'tool' | 'approval' | 'error'
  kind: string
  summary: string
  payload: unknown
  turnId: string | null
  createdAt: string
}

export interface ModelOption { id: string; value: string | boolean }
export interface ModelOptionDescriptor {
  description?: string | undefined
  promptInjectedValues?: string[] | undefined
  id: string
  label: string
  type: 'select' | 'boolean'
  currentValue?: string | boolean | undefined
  options?: Array<{ id: string; label: string; description?: string | undefined; isDefault?: boolean | undefined }> | undefined
}
export interface EngineModelView {
  order?: number
  favorite?: boolean
  hidden?: boolean
  instanceId: string
  accountName: string
  driver: string
  slug: string
  name: string
  isDefault?: boolean
  options: ModelOptionDescriptor[]
}
export interface WorktreeRequest { kind: 'worktree'; baseBranch: string; startFromOrigin: boolean }
export interface EngineRef { name: string; current: boolean; isDefault: boolean; worktreePath: string | null; isRemote?: boolean | undefined; remoteName?: string | undefined }
export interface EngineRefs { refs: EngineRef[]; isRepo: boolean; hasPrimaryRemote: boolean }
export interface ConversationInput {
  workspace?: WorktreeRequest
  comments?: Record<string, number>
  /** Explicit frozen reply selection. Omission selects no private replies. */
  replies?: Record<string, string>
  messageId?: string
  commandId?: string
  text: string
  model: string
  effort: string | null
  access: EngineThreadView['access']
  instanceId?: string | null
  options?: ModelOption[]
  /** At most 8 with Strata's generated context file (§6.0); images and binary files reference bytes the main process staged. */
  attachments?: ConversationAttachment[]
  /** Held visual comments to send: each freezes one revision and carries its marked screenshots. */
  visual?: string[]
}

/** A file the composer sends with a turn: text travels inline, images and binary files by the id the main process staged it under. */
export type ConversationAttachment =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'image'; id: string; name: string; mimeType: string; sizeBytes: number }
  | { kind: 'binary'; id: string; name: string; mimeType: string; sizeBytes: number }

/** T3's latest turn: the fold label, timing, and the stopped state come from here (§6.9). */
export interface EngineTurnView {
  id: string
  state: 'running' | 'completed' | 'interrupted' | 'error'
  startedAt: string | null
  completedAt: string | null
}

export interface EngineThreadView {
  recovery?: import("./thread-recovery").ThreadRecovery

  compaction?: import("./context-compaction").ContextCompactionView
  engineIdentity?: string | undefined
  askScan?: AskScanView | undefined
  worktreePath?: string | null
  id: string
  projectId: string
  title: string
  model: string
  providerInstanceId: string
  options?: ModelOption[]
  branch?: string | null
  effort: string | null
  access: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
  status: 'idle' | 'starting' | 'running' | 'ready' | 'interrupted' | 'stopped' | 'error'
  updatedAt: string
  /**
   * When the thread last changed hands: the owner's latest send or the latest turn's completion, whichever is
   * later, and creation before either. Mid-turn activity, streaming, and waits leave it alone, so Recent order
   * and the row's time hold still while an agent works (§6.9).
   */
  lastExchangeAt: string
  unread: boolean
  pendingApprovals: boolean
  pendingUserInput: boolean
  activeTurnId: string | null
  turnStartedAt: string | null
  latestTurn: EngineTurnView | null
  comments?: import("../core/conversation-delivery").MessageComment[]
  outcomes?: import("../core/conversation-delivery").ConversationOutcome[]
  deliveries?: Array<{ messageId: string; text: string; phase: 'uploading' | 'prepared' }>
  messages: EngineMessageView[]
  activities: EngineActivityView[]
  items?: ItemView[]
  documents?: Array<{ path: string; turnId: string; additions: number; deletions: number; markdown: boolean }>
  /** T3's pin and snooze states (§5.2). */
  pinnedAt: string | null
  snoozedUntil: string | null
  /** Server-owned lifecycle classification; snooze takes precedence over explicit settlement. */
  lifecycle: 'active' | 'snoozed' | 'settled'
  /** Archived threads remain in snapshots but never render in the Projects rail. */
  archived: boolean
  /** Turns finished, items posted, and approvals that arrived while the owner was elsewhere, cleared when the thread opens (§5.2). */
  attention: number
  /** Pending hunks and open items across the thread's open documents (§5.2). */
  pendingWork: number
  /** T3's background liveness: work alive after the turn settles. `working` while subagents or workflows run, `monitoring` when watch loops are the only live work. Optional so older servers interoperate; absent means none. */
  backgroundLiveness?: 'working' | 'monitoring' | null
}

/** T3's row actions beyond settle, archive, and delete (§5.2). */
export interface EngineThreadChange {
  pinned?: boolean
  /** An ISO wake time, or null to unsnooze. */
  snoozedUntil?: string | null
  title?: string
  /** Strata-local reading state used by the Projects context menu. */
  unread?: boolean
}

export interface EngineProjectView {
  id: string
  title: string
  workspaceRoot: string
  defaultThreadEnvMode?: 'local' | 'worktree' | null
  defaultModelSelection?: { instanceId: string; model: string; options?: ModelOption[] } | null
  threads: EngineThreadView[]
  /** Visual comments owned by this project: private drafts and sent revisions over an image or a captured page. */
  visualComments?: VisualCommentView[]
}

// ---- Visual comments (docs/plans/open/visual-review)

export type VisualStatus = 'held' | 'sending' | 'failed' | 'sent' | 'ready' | 'done'

export interface VisualRectView { x: number; y: number; width: number; height: number }
export interface VisualPointView { x: number; y: number }

/** What the agent needs to find a marked thing again; carried with the mark, shown in no control. */
export interface VisualMarkIdentityView {
  role?: string | null
  name?: string | null
  text?: string | null
  testIds?: string[]
  selector?: string | null
  html?: string | null
  style?: Record<string, string>
  sources?: Array<{ file: string; line: number; column: number; role?: 'definition' | 'usage' | 'candidate' }>
  viewportRect?: VisualRectView
  pageRect?: VisualRectView
}

/** One marked thing as the owner sees it: a plain name, where it sits on the capture, and whether Strata can find it right now. */
export interface VisualMarkView {
  id: string
  kind: 'element' | 'region'
  label: string
  captureId: string
  rect: VisualRectView
  found: boolean | null
  identity?: VisualMarkIdentityView
}

export interface VisualStrokeView {
  id: string
  tool: 'draw' | 'arrow'
  captureId: string
  points: VisualPointView[]
}

/** A requested change on one mark; `label` is the owner's plain words, the property and value are for the record. */
export interface VisualAdjustmentView {
  markId: string
  property: string
  value: string
  label: string
}

export interface VisualCaptureView {
  id: string
  url: string
  width: number
  height: number
  scroll?: VisualPointView
  /** Capture pixels per page pixel; absent means one. */
  scale?: number
  /** The page with the owner's adjustments applied: the requested appearance, a reference beside the marked captures. */
  requested?: boolean
}

/** What Annotate on a page captured: the frame in the evidence store and the page it came from. */
export interface VisualPageCapture {
  tabId: string
  capture: VisualCaptureView
  page: { url: string; title: string; viewport: { width: number; height: number }; preset: string | null; deviceScale: number; document: number }
}

/** What a page says is at a point or in a box; the identity rides along for the record and never for a control. */
export interface VisualPageProposal {
  kind: 'element' | 'region'
  label: string
  /** In page pixels. */
  rect: VisualRectView
  found: boolean | null
  identity?: VisualMarkIdentityView
}

/** Show me: the live tab showed the marked state again, or the saved evidence is the fallback. */
export type VisualShowResult = { shown: true; tabId: string; outlined: string[] } | { shown: false; reason: string; url: string | null }

export interface VisualDestinationView { threadId: string; threadTitle: string }

export interface VisualReplyView {
  agentId?: string
  agentName?: string
  comparison?: VisualComparisonView
  messageId: string
  text: string
  ready: boolean
  file?: string
  at: number
}

export interface VisualComparisonView {
  thenUrl: string
  nowUrl: string | null
  note: string | null
  takenAt: number
}

export interface VisualRevisionView {
  number: number
  /** The immutable comment sheets actually attached to this revision's message. */
  images?: string[]
  text: string
  marks: VisualMarkView[]
  strokes: VisualStrokeView[]
  adjustments: VisualAdjustmentView[]
  destination: VisualDestinationView
  captures: string[]
  deliveryId: string
  sentAt: number
  state: 'sending' | 'sent' | 'failed'
  error?: string
  replies: VisualReplyView[]
  accepted: boolean
  comparison?: VisualComparisonView
}

export interface VisualDraftView {
  requestedCaptureId?: string
  text: string
  marks: VisualMarkView[]
  strokes: VisualStrokeView[]
  adjustments: VisualAdjustmentView[]
  destination: VisualDestinationView
  updatedAt: number
}

export type VisualAnchorView =
  | { kind: 'image'; name: string }
  | { kind: 'page'; url: string; title: string; instance: string; preset: string | null; viewport: { width: number; height: number } }

export interface VisualCommentView {
  id: string
  projectId: string
  status: VisualStatus
  /** The status in plain words: held, sending, send failed, sent, ready for review, done. */
  statusLabel: string
  /** The page or image and the size, in plain words. */
  place: string
  anchor: VisualAnchorView
  title: string
  summary: string
  thumbnail: string | null
  captures: VisualCaptureView[]
  draft?: VisualDraftView
  revisions: VisualRevisionView[]
  createdAt: number
  updatedAt: number
}

/** What the session hands the main process on Hold: the draft and the marked captures it rendered. */
export interface HoldVisualCommentInput {
  id?: string
  projectId: string
  threadId: string
  /** A staged composer image to open the comment over; its bytes move into the evidence store. */
  source?: { staged: string; name: string; width: number; height: number }
  /** A page capture to open the comment over: the frames Annotate stored and the page they came from. */
  page?: { tabId: string; captures: Array<{ id: string; width: number; height: number; scroll: VisualPointView; scale: number; requested?: boolean }>; url: string; title: string; viewport: { width: number; height: number }; preset: string | null; deviceScale: number }
  text: string
  marks: VisualMarkView[]
  strokes: VisualStrokeView[]
  adjustments: VisualAdjustmentView[]
  /** The captures with marks drawn on, as PNG bytes, keyed by capture id; a source image is keyed by its staged id. */
  marked: Array<{ captureId: string; bytes: Uint8Array }>
}

export type VisualCommentAction = 'accept' | 'reopen' | 'discard' | 'retry' | 'compare'

/** A usage window the provider reports or Strata last measured (§5.13). */
export interface UsageWindowView {
  modelScope?: string
  id?: string
  label?: string
  kind?: string
  windowDurationMins?: number | undefined
  usedPercent: number
  resetsAt: string | null
  measuredAt: string
}

export type AccountStateView = 'ready' | 'stale' | 'limited' | 'no-subscription' | 'signed-out' | 'parked' | 'disabled' | 'unknown'

/** One provider instance as Accounts and the picker show it (§5.13). */
export interface AccountView {
  windows?: UsageWindowView[] | undefined
  usageUnsupported?: boolean
  resetCredits?: import('./usage-limits').UsageLimits['resetCredits']
  /** Provider readiness independent of Strata parking. */
  providerReady?: boolean
  installed?: boolean
  enabled?: boolean
  accentColor?: string
  usageAvailable?: boolean
  instanceId: string
  driver: string
  name: string
  homePath: string | null
  email: string | null
  plan: string | null
  state: AccountStateView
  /** Whether Auto or the picker may start a thread on this instance now. */
  usable: boolean
  reason: string | null
  /** When a hit limit lifts, if the provider said. */
  limitedUntil: string | null
  /** The higher of the session and weekly usage, or null when never measured. */
  pressure: number | null
  parked: boolean
  session: UsageWindowView | null
  weekly: UsageWindowView | null
  modelWindows?: Array<UsageWindowView & { model: string }>
  usageProblem?: string | null
  usageRefreshing?: boolean
  /** When the shown usage was measured; null when never. */
  measuredAt: string | null
  /** True when the usage came from the engine on this connection, false when it is Strata's persisted measurement. */
  live: boolean
}

export interface ManagedEngineView { state: 'starting' | 'recovering' | 'running' | 'failed' | 'stopped'; failure?: { at: number; exitCode: number | null; signal: string | null; attempt: number }; version: string | null; nodeVersion: string | null; directory: string; problem: string | null }

export interface EngineView {
  providerCommands?: import("./provider-commands").ProviderCommandCatalog[]
  askScanProblem?: string | null | undefined
  identity?: string
  managed?: ManagedEngineView

  models?: EngineModelView[]
  state: EngineConnectionState
  server: string | null
  problem: string | null
  /** The paired session: when it ends, and whether Strata renews it itself (needs the Manage access permission on the pairing link). */
  credential: { expiresAt: string; renews: boolean } | null
  projects: EngineProjectView[]
  activeThreadId: string | null
  /** Provider accounts on the engine, with Strata's persisted measurements and parking (§5.13). */
  accounts: AccountView[]
  usageLimitSources?: import('./usage-limits').UsageLimitSources
  /** Per driver: `auto`, an instance id, or null for the system default (§5.13 terminal defaults). */
  terminalDefaults: Record<string, string | null>
  /** Per driver: the instance Auto would start a thread on right now, or null when none can take one (§5.13). */
  autoInstanceIds?: Record<string, string | null>
  /** Where Strata writes terminal launchers, or null when this platform gets none. */
  terminalShimDirectory: string | null
}

export interface HeadingReference {
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
  parentText: string | null
  previousText: string | null
  nextText: string | null
}

export type WalkthroughLevel = 'h2' | 'h2-h3'

export interface WalkthroughMarker {
  heading: HeadingReference
  status: 'reviewed' | 'revisit'
  reviewedHash: string | null
  sourceHash: string
}

export interface WalkthroughState {
  active: boolean
  level: WalkthroughLevel
  current: HeadingReference | null
  excluded: HeadingReference[]
  markers: WalkthroughMarker[]
}

export type WalkthroughAction =
  | { type: 'start' }
  | { type: 'leave' }
  | { type: 'set-level'; level: WalkthroughLevel }
  | { type: 'set-current'; heading: HeadingReference }
  | { type: 'set-included'; heading: HeadingReference; included: boolean }
  | { type: 'mark'; heading: HeadingReference; status: 'reviewed' | 'revisit' }

export interface TableReference {
  headingLevel: number | null
  headingText: string | null
  headers: string[]
  occurrence: number
}

export interface TableViewState {
  table: TableReference
  presentation: 'table' | 'focus-row' | 'compare'
  sort: { column: number; direction: 'ascending' | 'descending' } | null
  filter: { column: number; query: string } | null
  hiddenColumns: number[]
  selectedRows: number[]
  focusedRow: number | null
  focusedColumn: number | null
  density: 'comfortable' | 'compact'
  columnWidths: number[]
}

export interface ReadingState {
  formatVersion: 4
  navigationTab: NavigationTab
  reviewTab: ReviewTab
  walkthrough: WalkthroughState
  tables: TableViewState[]
  foldedHeadings: HeadingReference[]
}

export interface LocalLinkTarget {
  kind: 'html' | 'markdown'
  /** The real path of the file. */
  path: string
  /** A `file:` URL for the page, with the link's query and fragment kept. */
  url: string
}

export interface LocalMarkdownPreview {
  path: string
  source: string
  truncated: boolean
}

export interface LocalImageResolution {
  url: string
  path: string
  /** File size and nanosecond mtime; used to require screenshot-pin verification after an image changes. */
  version: string
  /** Intrinsic pixel size from the file header when the format and orientation are understood; absent otherwise, and the image measures itself on load. */
  width?: number
  height?: number
}

/**
 * A background job that failed for an open document: `watch` (outside edits
 * are no longer detected), `mirror` (the copy agents read is stale), or
 * `persist` (review state is not being saved). Cleared when the job next succeeds.
 */
export type DocumentProblem = 'watch' | 'mirror' | 'persist'

export interface DocumentView {
  path: string
  bufferPath: string
  /** One source, mirroring the session's field; rows compare ids against it (PRD §6.6). */
  leadAgentId: string | null
  content: string
  reading: ReadingState
  sourceMode: boolean
  sourceOnly: boolean
  readOnly: boolean
  dirty: boolean
  deleted: boolean
  invalidUtf8: boolean
  /** Background failures the user must know about (PRD §6.10); empty when everything works. */
  problems: DocumentProblem[]
  lastSavedAt: number | null
  /** Increases once per application step (Keep, Revert, Accept, merge); never on undo or redo. */
  historyStep: number
  pendingHunks: HunkView[]
  /** Save history summaries, oldest first (PRD §6.7); hunks come from saveRound on demand. */
  saves: SaveRoundView[]
  annotations: AnnotationView[]
  items?: ItemView[]
  drafts: DraftView[]
  attachments: AttachmentView[]
  /** Attached threads plus the active conversation in this document's project (§5.6). */
  recipients: RecipientView[]
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
  upperReviewHeight: number
  documentMeasure: number
  themePanel: ThemePanelGeometry
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

export type PaneId = 'explorer' | 'editor' | 'rightRail' | 'composer' | 'themePanel'
export type PaneZoom = Record<PaneId, number>

export interface AppSettingsView {
  engine?: { mode: 'managed' | 'external'; keepRunning: boolean; startAtLogin: boolean }
  animatedBackground: boolean
  panelSizes: PanelSizes
  zoom: PaneZoom
  theme: ThemeView
}

export interface AppView {
  tabs: DocumentTabView[]
  activeDocument: DocumentView | null
  explorer: ExplorerFolderView[]
  settings: AppSettingsView
  engine: EngineView
  /** The preview windows' pages and the browser host's state (docs/plans/open/visual-review, phase 2). */
  preview: PreviewStateView
}

// ---- Preview windows (docs/plans/open/visual-review, phase 2)

export type PreviewViewportView =
  | { mode: 'fill' }
  | { mode: 'preset'; preset: string; label: string; width: number; height: number }
  | { mode: 'freeform'; width: number; height: number }

/** How the owner or an agent asks for a size; the host resolves presets to their sizes. */
export type PreviewViewportRequest = { mode: 'fill' } | { mode: 'preset'; preset: string } | { mode: 'freeform'; width: number; height: number }

export interface PreviewTabView {
  id: string
  projectId: string
  /** The owner's tab, or a tab an agent opened for its own work. */
  kind: 'owner' | 'agent'
  threadId: string | null
  /** The address the tab was opened at; `url` follows navigation. */
  openedUrl: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: PreviewViewportView
  /** The owner took control of an agent tab; new agent actions wait for Resume. */
  paused: boolean
  /** An agent action is running or waiting in this tab. */
  working: boolean
  /** What the agent is doing in this tab, in plain words, for the status pill. */
  activity: string | null
  error: string | null
  openedAt: number
  /** Counts up whenever a new document replaces the page, so a session over a capture knows the live page changed. */
  document: number
}

export interface PreviewStateView {
  evidence?: BrowserEvidenceView[]
  tabs: PreviewTabView[]
  /** Strata is registered with the engine as its browser host. */
  registered: boolean
  /** Threads with a browser request Strata is serving right now. */
  serving: string[]
  /** The tab an agent most recently opened for the owner to see, so its window's pill appears. */
  reveal: { tabId: string; at: number } | null
}

export interface PreviewBoundsReport {
  tabId: string | null
  /** Where the page should sit inside the window, in CSS pixels; null hides it. */
  bounds: { x: number; y: number; width: number; height: number } | null
}

export type PreviewNavigation = { url: string } | { action: 'back' | 'forward' | 'reload' | 'stop' }

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
  conversation?: Record<string, { deliveryId: string; comments: Record<string, number>; replies: Record<string, string> }>
  recipients: string[]
  note: string
  includeExternal: boolean
  /** Hunk items the user unchecked, as `segmentId:hunkIndex` keys. */
  excludedHunks?: string[]
  /** Annotation event seqs the user unchecked. */
  excludedEvents?: number[]
  /** Held comments to materialize into annotations for this Send. */
  draftIds?: string[]
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
  kind: 'annotation' | 'reply' | 'answer' | 'resolution' | 'verdict'
  annotationKind?: AnnotationKind
  author?: 'user' | 'agent'
  name?: string
  text: string
  quote?: string
  /** Present only while this held comment is previewed in Your comments. */
  draftId?: string
}

export type CreateAnnotationRequest =
  | { kind: 'comment' | 'question' | 'suggestion'; quote: string; text: string; from: number; to: number; context?: AnnotationContext }
  | { kind: 'decision'; quote: string; text: string; from: number; to: number; anchor: 'quote' | 'heading'; options: string[] }
  | { kind: 'decision'; quote: ''; text: string; from: 0; to: 0; anchor: 'document'; options: string[] }

export interface CreateDraftRequest {
  kind: DraftKind
  quote: string
  text: string
  from: number
  to: number
  context?: AnnotationContext
}

export interface QuickSendRequest extends CreateDraftRequest {
  recipients: string[]
}

export interface SendItems {
  changes: SendChangeItem[]
  events: SendEventItem[]
}

export interface SendPreview {
  recipient: AgentIdentity
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

/** Top-level Markdown character offsets for the exact accompanying buffer text. */
export interface BufferBlockRange { from: number; to: number }
/** Runs at buffer flush; undefined leaves main's existing parse fallback in charge. */
export type PrepareBufferBlockRanges = () => readonly BufferBlockRange[] | undefined

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

/** The picker's choices when a thread starts (§5.7, §5.13). */
export interface StartThreadInput {
  workspace?: WorktreeRequest
  branch?: string | null
  worktreePath?: string | null
  threadId?: string
  projectId: string
  title: string
  model: string
  effort: string | null
  access: EngineThreadView['access']
  /** A provider instance id, or null for Auto (§5.13). */
  instanceId?: string | null
  options?: ModelOption[]
}

/** Start thread from a document (§5.7): the picker's choices plus what the first turn carries. */
export interface StartThreadFromDocumentInput extends StartThreadInput {
  threadId?: string
  note?: string
  /** The popover's pending comment, materialized as the first annotation. */
  comment?: CreateDraftRequest
  /** Held drafts to materialize into the first delivery. */
  draftIds?: string[]
}

/** How the owner pairs (§5.1): a pairing link from T3, or the host plus the code shown beside it. */
export type PairEngineRequest = { link: string } | { host: string; code: string }

export interface EngineSettings {
  continueThreadsAfterServerUpdate?: boolean

  identity?: string | null

  addProjectBaseDirectory?: string | undefined
  newWorktreesStartFromOrigin?: boolean | undefined
  providerInstances: Record<string, ProviderInstanceSettings>
  [key: string]: unknown
}
export interface ProviderInstanceSettings {
  accentColor?: string | undefined
  environment?: ProviderEnvironment[] | undefined

  driver: string
  displayName?: string | undefined
  enabled?: boolean | undefined
  config?: Record<string, unknown> | undefined
  [key: string]: unknown
}
export interface EngineFolderListing { parentPath: string; entries: Array<{ name: string; fullPath: string }> }
export interface EngineRepository { provider: string; nameWithOwner: string; url: string; sshUrl: string }
export type CloneRepositoryInput = { destinationPath: string } & ({ remoteUrl: string } | { provider: 'github'; repository: string })

export interface TerminalTarget { threadId: string; terminalId: string }
export interface TerminalAttachRequest extends TerminalTarget { attachmentId: string; cwd: string; cols: number; rows: number }
export interface TerminalSnapshot extends TerminalTarget { cwd: string; worktreePath: string | null; status: 'starting' | 'running' | 'exited' | 'error'; history: string; label: string; updatedAt: string; sequence?: number | undefined }
export type TerminalEvent =
  | { type: 'snapshot'; snapshot: TerminalSnapshot }
  | (TerminalTarget & { sequence?: number | undefined } & (
      { type: 'restarted'; snapshot: TerminalSnapshot } | { type: 'output'; data: string } |
      { type: 'activity'; hasRunningSubprocess: boolean; label: string } | { type: 'error'; message: string } |
      { type: 'exited'; exitCode: number | null; exitSignal: number | null } | { type: 'cleared' | 'closed' }
    ))
export interface TerminalPush { attachmentId: string; event: TerminalEvent }

export interface StrataApi {
  readEngineUsage(window: import('./usage').UsageWindow): Promise<import('./usage').UsageSummary>
  attachEngineTerminal(input: TerminalAttachRequest): Promise<void>
  detachEngineTerminal(attachmentId: string): Promise<void>
  writeEngineTerminal(input: TerminalTarget & { data: string }): Promise<void>
  resizeEngineTerminal(input: TerminalTarget & { cols: number; rows: number }): Promise<void>
  closeEngineTerminal(input: TerminalTarget): Promise<void>
  onTerminalEvent?(listener: (push: TerminalPush) => void): () => void
  setModelPreference(instanceId: string, slug: string, preference: { favorite?: boolean; hidden?: boolean; order?: string[] }): Promise<void>
  listEngineRefs(cwd: string, query?: string): Promise<EngineRefs>
  engineRecovery?(request: import('./engine-recovery').RecoveryRequest): Promise<import('./engine-recovery').RecoveryView>
  computer?(request: import('./computer').ComputerRequest): Promise<import('./computer').ComputerView>
  providerSetup?(request: import('./provider-setup').ProviderSetupRequest): Promise<import('./provider-setup').ProviderSetupView>
  readEngineSupport(): Promise<EngineSupport>
  readEngineProjectDefaults(projectId: string): Promise<import('./project-defaults').ProjectDefaults>
  editEngineProjectDefaults(edit: import('./project-defaults').ProjectDefaultsEdit): Promise<import('./project-defaults').ProjectDefaults>
  readEngineSettings(): Promise<EngineSettings>
  editEngineSettings(edit: EngineSettingsEdit): Promise<EngineSettings>
  editEngineProvider(edit: ProviderEdit): Promise<void>
  browseEngineFolder(path: string): Promise<EngineFolderListing>
  lookupEngineRepository(repository: string): Promise<EngineRepository>
  cloneEngineRepository(input: CloneRepositoryInput): Promise<{ cwd: string }>

  /** Renderer bridge to the system browser. */
  openExternal?(url: string): Promise<void>
  /** A local .html or Markdown link from a reply, resolved to a file that exists; relative links resolve against the project folder. */
  resolveLocalLink(input: { projectId: string | null; href: string; documentPath?: string }): Promise<LocalLinkTarget>
  getState(): Promise<AppView>
  subscribe(listener: (state: AppView) => void): () => void
  pairEngine(request: PairEngineRequest): Promise<void>
  manageEngine?(action: 'restart' | 'use-managed' | 'show-log'): Promise<void>
  reconnectEngine(): Promise<void>
  openConversation(threadId: string): Promise<void>
  /** Sends the owner's note plus every queued item reply as one delivery (§5.4); either may be empty, not both. */
  startConversationTurn(threadId: string, input: ConversationInput): Promise<void>
  /** Keeps a pasted or picked image in the data directory until it is sent or removed (§6.0). */
  readDocument(source: import('./documents').DocumentSource, identity: string | null): Promise<import('./documents').DocumentPreviewData>
  reportDocumentBounds(report: import('./documents').DocumentBounds): Promise<void>
  closeDocumentPreview(id: string): Promise<void>
  openDocumentExternally(id: string): Promise<void>
  stageConversationAttachment(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<{ id: string; sizeBytes: number }>
  discardConversationAttachment(id: string): Promise<void>
  /** The ids every draft still references; staged files nothing references are deleted. */
  retainConversationAttachments(ids: string[]): Promise<void>
  /** Queues a reply to a message-anchored item; the row shows Drafted until the Send carrying it is acknowledged (§5.4). */
  holdMessageComment(threadId: string, input: { id?: string; messageId: string; from: number; to: number; kind: DraftKind; text: string }): Promise<string>
  actMessageComment(threadId: string, itemId: string, action: "resolve" | "reopen" | "discard"): Promise<void>
  runAskScan(identity: string | null, threadId: string, messageId: string): Promise<void>
  cancelAskScan(identity: string | null, threadId: string): Promise<void>
  saveAskDraft(identity: string | null, threadId: string, itemId: string, text: string): Promise<void>
  queueItemReply(threadId: string, itemId: string, text: string): Promise<void>
  discardItemReply(threadId: string, itemId: string): Promise<void>
  /** Hides an inferred item; remembered per message (§5.12). */
  dismissItem(threadId: string, itemId: string): Promise<void>
  /** Holds a visual comment privately: creates it over a staged image or updates its draft, and keeps the marked captures as evidence. */
  retainVisualEvidence?(owner: string, ids: string[]): Promise<void>
  holdVisualComment(input: HoldVisualCommentInput): Promise<string>
  /** Looks right (accept), Still wrong (reopen), discard the draft, or retry a failed send. Accept starts no turn. */
  actVisualComment(id: string, action: VisualCommentAction): Promise<void>
  /** Opens an owner tab in the project's preview window; returns the tab id. */
  openPreviewTab(input: { projectId: string; url?: string }): Promise<string>
  closePreviewTab(tabId: string): Promise<void>
  navigatePreview(tabId: string, navigation: PreviewNavigation): Promise<void>
  resizePreview(tabId: string, viewport: PreviewViewportRequest): Promise<void>
  /** Hands an agent tab back after the owner took control; nothing is replayed. */
  resumePreviewTab(tabId: string): Promise<void>
  previewEvidenceAction(id: string, action: 'open' | 'retry'): Promise<string | null>
  /** Where the shown page sits in the window, whenever layout changes; null hides it. */
  reportPreviewBounds(report: PreviewBoundsReport): Promise<void>
  /** One boolean from the overlay layer: an overlay is open, so the page hides beneath it. */
  reportOverlay(open: boolean): Promise<void>
  /** Annotate on a page (phase 3): capture the frame into the evidence store, ask the page what is somewhere, scroll it, and show a comment's marks again. */
  capturePreviewFrame(tabId: string): Promise<VisualPageCapture>
  describePreview(tabId: string, target: { point: VisualPointView } | { rect: VisualRectView }): Promise<VisualPageProposal | null>
  scrollPreview(tabId: string, move: { by: VisualPointView } | { to: VisualPointView }): Promise<VisualPointView>
  showVisualComment(id: string): Promise<VisualShowResult>
  /** Adjustments (phase 4): apply the whole set of Strata's overrides to the live page and capture the result; remove only those overrides. */
  adjustPreview(tabId: string, targets: Array<{ markId: string; identity: VisualMarkIdentityView; declarations: Record<string, string> }>): Promise<VisualPageCapture & { applied: string[] }>
  clearPreviewOverrides(tabId: string): Promise<void>
  continueInterruptedThread(threadId: string): Promise<void>
  compactContext(threadId: string, input: import("./context-compaction").CompactContextInput): Promise<void>
  stopConversationTurn(threadId: string): Promise<void>
  answerEngineApproval(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'): Promise<void>
  dismissEngineUserInput(threadId: string, requestId: string): Promise<void>
  answerEngineUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>
  createEngineThread(input: StartThreadInput): Promise<string>
  /** Adds a T3 project for a folder no project contains yet (§5.7 Add project); returns its id. */
  scanEngineHistory(): Promise<import('./history-import').HistoryScan>
  importEngineHistory(input: { projectId: string; expectedWorkspaceRoot: string }): Promise<import('./history-import').HistoryImportResult>
  createEngineProject(input: { title: string; workspaceRoot: string; createWorkspaceRootIfMissing?: boolean }): Promise<string>
  /** Creates the thread, attaches it to the document, and sends the pending comment and drafts as its first turn (§5.7, §5.14). */
  startThreadFromDocument(path: string, input: StartThreadFromDocumentInput): Promise<string>
  actOnEngineThread(threadId: string, action: 'archive' | 'settle' | 'unsettle' | 'delete'): Promise<void>
  /** Pin, snooze, rename, or mark a thread unread (§5.2). */
  updateEngineThread(threadId: string, change: EngineThreadChange): Promise<void>
  /** Parks or unparks a provider instance so Auto and the picker skip it (§5.13); persisted in the ghost store. */
  parkAccount(instanceId: string, parked: boolean): Promise<void>
  /** Sets which account a driver's terminal launcher uses: `auto`, an instance id, or null for none (§5.13). */
  setTerminalDefault(driver: string, selection: string | null): Promise<void>
  /** Probes the engine for provider usage now (§5.13 "a probe on open"). */
  consumeResetCredit(input: import('./usage-limits').ConsumeResetCreditInput): Promise<import('./usage-limits').ConsumeResetCreditResult>
  refreshAccounts(): Promise<void>
  openDocument(path?: string): Promise<void>
  /** Renderer-only bridge: preload resolves Electron File objects with webUtils. */
  openDroppedFiles?(files: File[]): Promise<void>
  /** Renderer-only bridge: fire-and-forget failure report into the local log. */
  reportError?(report: ErrorReport): void
  /** Renderer-only bridge: the latest right-click spelling context from the main process. */
  onSpelling?(listener: (spelling: SpellingContext) => void): () => void
  /** Renderer-only bridge: teaches the spellchecker one word; its underline clears everywhere. */
  addDictionaryWord?(word: string): Promise<void>
  /** Renderer-only bridge: asks the window manager for attention while the window is unfocused. */
  flashWindow?(): void
  /** Renderer-only bridge: creates an empty markdown file in `directory` and returns its path. */
  createFile?(directory: string, name?: string): Promise<string>
  /** Renderer-only bridge: renames a file in place; refuses while the document is open. */
  renameFile?(path: string, name: string): Promise<string>
  /** Renderer-only bridge: moves a file to the system trash; refuses while the document is open. */
  trashFile?(path: string): Promise<void>
  /** Renderer-only bridge: shows the file in the system file manager. */
  revealFile?(path: string): Promise<void>
  /** Renderer-only bridge: an open-file dialog; the chosen file opens as a tab. */
  openFileDialog?(): Promise<void>
  /** Renderer-only bridge: a native paste into the focused element, so the editor's own paste handling runs (§5.15). */
  pasteFromClipboard?(): Promise<void>
  closeDocument(path: string, decision?: CloseDecision): Promise<'closed' | 'needs-decision' | 'cancelled'>
  updateBuffer(path: string, content: string, origin: BufferOrigin, blockRanges?: readonly BufferBlockRange[]): Promise<void>
  undo(path: string): Promise<UndoResult>
  redo(path: string): Promise<RedoResult>
  resolveLocalImage(documentPath: string, source: string): Promise<LocalImageResolution | null>
  resolveLocalMarkdown(documentPath: string, source: string): Promise<LocalMarkdownPreview | null>
  save(path: string): Promise<void>
  setSourceMode(path: string, source: boolean): Promise<void>
  updateReadingState(path: string, state: Partial<Pick<ReadingState, 'navigationTab' | 'reviewTab'>>): Promise<void>
  updateWalkthrough(path: string, action: WalkthroughAction): Promise<void>
  updateTableView(path: string, state: TableViewState): Promise<void>
  updateFold(path: string, heading: HeadingReference, folded: boolean): Promise<void>
  keepHunk(path: string, hunkId: string): Promise<void>
  revertHunk(path: string, hunkId: string, confirmMixed?: boolean): Promise<void>
  markReviewed(path: string): Promise<void>
  /** The read-only hunks of one save round, computed on demand (PRD §6.7). */
  saveRound(path: string, index: number): Promise<{ hunks: RoundHunkView[] }>
  addAnnotation(path: string, annotation: CreateAnnotationRequest): Promise<string>
  holdDraft(path: string, draft: CreateDraftRequest): Promise<string>
  discardDraft(path: string, draftId: string): Promise<void>
  quickSend(path: string, draft: QuickSendRequest): Promise<string[]>
  requoteAnnotation(path: string, annotationId: string, range: { quote: string; from: number; to: number }): Promise<void>
  reply(path: string, annotationId: string, text: string): Promise<void>
  resolveAnnotation(path: string, annotationId: string): Promise<void>
  answerDecision(path: string, annotationId: string, answer: { option: string | null; other?: string }): Promise<void>
  reopenDecision(path: string, annotationId: string): Promise<void>
  acceptSuggestion(path: string, annotationId: string): Promise<void>
  rejectSuggestion(path: string, annotationId: string): Promise<void>
  acceptAllSuggestions(path: string, agentId: string): Promise<AcceptAllSuggestionsView>
  rejectAllSuggestions(path: string, agentId: string): Promise<string[]>
  clearResolvedAnnotations(path: string): Promise<void>
  resolveRecovery(path: string, decision: 'recover' | 'discard'): Promise<void>
  resolveConflict(path: string, conflictId: string, decision: ConflictDecision): Promise<void>
  previewSend(path: string, request: SendPreviewRequest): Promise<SendPreview[]>
  send(path: string, request: SendPreviewRequest): Promise<string[]>
  copyText(text: string): Promise<void>
  /** Grants, transfers, or revokes (null) the Lead; user actions are authoritative (PRD §6.6). */
  setLead(path: string, agentId: string | null): Promise<void>
  /** Ends this document/thread link without changing the thread. */
  detachThread(path: string, threadId: string): Promise<void>
  addFolder(): Promise<void>
  /** Removes an explorer folder; ghost entries under it stay until forgotten (PRD §6.4). */
  removeFolder(path: string): Promise<void>
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

/** Desktop window state is independent of document and engine state. */
export interface WindowState {
  revision: number
  chrome: 'custom' | 'traffic-lights' | 'native'
  maximized: boolean
  fullscreen: boolean
  focused: boolean
}

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close'

export interface WindowApi {
  getState(): Promise<WindowState>
  subscribe(listener: (state: WindowState) => void): () => void
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
}
