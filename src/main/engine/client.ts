import { makeUsageWindow } from '../../core/usage'
import { usageSummaryInput, usageSummaryResult, usageWindow, terminalAttachInput, terminalWriteInput, terminalResizeInput, terminalTarget, terminalVoidResult, terminalStreamEvent, worktreeRequest, listRefsInput, listRefsResult, updateProviderInstancesInput, browseFolderInput, browseFolderResult, lookupRepositoryInput, repositoryResult, cloneRepositoryInput, cloneRepositoryResult, engineSettingsResult } from './t3-contract'
import type { EngineSettings, EngineFolderListing, EngineRepository, CloneRepositoryInput } from '../../shared/contracts'
import { conversationDelivery, renderConversationDelivery, messageAnchor, isOwnerComment, resolveMessageAnchor, type MessageComment } from '../../core/conversation-delivery'
import { continuationScope, familyLabel, modelFamily, permitsSelection } from '../../shared/modelSelection'
import { chmod, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { atomicWriteFile, PRIVATE_FILE_MODE } from '../storage'
import {
  shellSnapshot,
  threadDetailSnapshot,
  tokenExchangeResult,
  pairingCredentialResult,
  websocketTicketResult,
  attachmentUploadResult,
  turnStartCommand,
  turnInterruptCommand,
  threadCreateCommand,
  projectCreateCommand,
  threadActionCommand,
  threadPinCommand,
  threadUnpinCommand,
  threadSnoozeCommand,
  threadUnsnoozeCommand,
  threadMetaUpdateCommand,
  approvalRespondCommand,
  userInputRespondCommand,
  dispatchResult,
  T3_HTTP,
  T3_RPC,
  serverConfigSlice,
  shellStreamItem,
  threadStreamItem,
  messageSentEvent,
  turnDiffCompletedEvent,
  orchestrationSession,
  orchestrationProjectShell,
  orchestrationThreadShell,
  threadActivity,
  type T3ShellSnapshot,
  type T3ThreadDetailSnapshot,
} from './t3-contract'
import { EngineSocket, type EngineStream } from './socket'
import { decideAttention } from './notifications'
import { applyConversationState, emptyConversationState, readConversationsStore, writeConversationsStore, type ConversationsStore, type PreparedAttachment, type UploadedAttachment } from './conversation-state'
import { StagedAttachmentStore } from './staged-attachments'
import { attachmentLimitMessage, attachmentSummary, MAX_ATTACHMENTS } from '../../core/composer-attachments'
import { accountViews, chooseInstance, emptyAccountsStore, providerInstancesOf, readAccountsStore, recordMeasurements, terminalShimTargets, writeAccountsStore, type AccountsStore, type EngineProviderInstance } from './accounts'
import { writeTerminalShims } from '../account-shims'
import { logError, logWarn } from '../log'
import type { ConversationInput, ModelOption, EngineModelView, StartThreadInput, EngineProjectView, EngineThreadChange, EngineThreadView, EngineView } from '../../shared/contracts'
import { assertSupportedPlatform } from '../../platform/runtime'
import { mapMarkdownBlocks, parseStrataBlock } from '../../core/blocks'
import { postedMessageItems } from '../../core/items'
import { inferredMessageItems } from '../../core/inference'
import { pngSize, VisualEvidenceStore } from './visual-evidence'
import { emptyVisualCommentsStore, readVisualCommentsStore, referencedEvidence, writeVisualCommentsStore, type VisualCommentsStore } from './visual-comments'
import { isVisualCommentId, revisionForReply, sendCapacity, visualAttachmentName, visualBrief, visualCommentView, visualRepliesIn, visualSendSummary, type VisualCapture, type VisualCommentRecord, type VisualRevision } from '../../core/visual-comments'
import { visualImageUrl } from '../../shared/visual-urls'
import { readEngineIdentity } from './identity'
import { z } from 'zod'
import type { HoldVisualCommentInput, VisualCommentAction, VisualCommentView, VisualMarkView } from '../../shared/contracts'

/** A staged image the owner removed or a sweep deleted before its upload; the preparation cannot proceed. */
class MissingStagedAttachmentError extends Error {
  constructor(name: string) { super(`Attachment ${name} is no longer staged. Attach it again and send.`) }
}

/** A marked screenshot the evidence store no longer holds; the frozen revision cannot be sent. */
class MissingEvidenceError extends Error {
  constructor(name: string) { super(`The screenshot ${name} is no longer available. Open the visual comment and mark it again.`) }
}

interface EngineCredential {
  formatVersion: 1
  server: string
  accessToken: string
  expiresAt: number
  /** Scopes the session holds; `access:write` lets Strata renew it (§5.1). */
  scopes: string[]
}

/** A session is renewed once it has less than this left, so a machine that is off for a few days still comes back paired. */
const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
const RENEWAL_CHECK_MS = 6 * 60 * 60 * 1_000
const RENEWAL_SCOPE = 'access:write'

interface EngineReadingState {
  formatVersion: 1
  activeThreadId: string | null
  lastVisited: Record<string, number>
  /** Badge counts per thread (§5.2), cleared when the thread opens. */
  attention: Record<string, number>
}

export interface EngineNotification { threadId: string; title: string; body: string }

/** The preview host the engine's browser requests go to (docs/plans/open/visual-review, phase 2). */
export interface PreviewHostBridge {
  operations: readonly string[]
  handle(request: { requestId: string; threadId: string; tabId?: string | undefined; operation: string; input: unknown; timeoutMs: number }): Promise<{ ok: true; result: unknown } | { ok: false; error: { _tag: string; message: string; detail?: unknown } }>
  setRegistered(registered: boolean): void
  /**
   * The re-check before Send (phase 3): each marked thing on a page comment is looked for again in its tab.
   * Returns a refusal in plain words when navigation replaced the page or a target is gone, else which marks are found now.
   */
  recheckVisual?(comment: VisualCommentRecord): Promise<{ refusal: string | null; found: Record<string, boolean> }>
}

export interface EngineClientOptions {
  dataDirectory: string
  /** Registers with the engine as its preview automation host once the socket is up; absent in tests that have no browser. */
  previewHost?: PreviewHostBridge
  fetch?: typeof globalThis.fetch
  now?: () => number
  webSocket?: typeof WebSocket
  /** Backoff between automatic reconnects after the socket drops; the last delay repeats. */
  reconnectDelaysMs?: number[]
  /** Keepalive on the subscription socket (§5.1); a missed Pong closes it and shows Disconnected. */
  pingMs?: number
  pongTimeoutMs?: number
  /** Stream items publish coalesced after this many ms so a streaming reply does not republish per token. */
  publishDelayMs?: number
  /** Whether the owner is looking at the window; decides badge versus OS notification (§5.2). */
  isFocused?: () => boolean
  /** Shows an OS notification; Electron supplies it, tests observe it. */
  notify?: (notification: EngineNotification) => void
  /** How long a provider usage reading stays fresh before the next refresh asks the engine again (§5.13). */
  configRefreshMs?: number
  /** Where terminal launchers are written, or null to write none (§5.13: Linux only). */
  terminalShimDirectory?: string | null
  writeShims?: typeof writeTerminalShims
}

export interface EngineReadClient {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  view(): EngineView
  subscribe(listener: (view: EngineView) => void): () => void
  pair(server: string, pairingCode: string): Promise<void>
  reconnect(): Promise<void>
  openThread(threadId: string): Promise<void>
  /** Threads whose transcripts Strata must follow besides the active one: every thread attached to an open document (§5.9). */
  watchThreads?(threadIds: readonly string[]): Promise<void>
  startTurn(threadId: string, input: ConversationInput & { messageId?: string; commandId?: string; context?: import("../../core/conversation-delivery").ConversationDelivery }): Promise<void>
  interrupt(threadId: string): Promise<void>
  respondApproval(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'): Promise<void>
  respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>
  createThread?(input: StartThreadInput): Promise<string>
  createProject?(input: { title: string; workspaceRoot: string; createWorkspaceRootIfMissing?: boolean }): Promise<string>
  actOnThread?(threadId: string, action: 'archive' | 'settle' | 'unsettle' | 'delete'): Promise<void>
  updateThread?(threadId: string, change: EngineThreadChange): Promise<void>
  holdMessageComment?(threadId: string, input: { id?: string; messageId: string; from: number; to: number; kind: import("../../shared/contracts").DraftKind; text: string }): Promise<string>
  actMessageComment?(threadId: string, itemId: string, action: "resolve" | "reopen" | "discard"): Promise<void>
  queueItemReply?(threadId: string, itemId: string, text: string): Promise<void>
  discardItemReply?(threadId: string, itemId: string): Promise<void>
  dismissItem?(threadId: string, itemId: string): Promise<void>
  parkAccount?(instanceId: string, parked: boolean): Promise<void>
  setTerminalDefault?(driver: string, selection: string | null): Promise<void>
  updateProviderInstances?(instances: Record<string, import('../../shared/contracts').ProviderInstanceSettings>): Promise<void>
  setModelPreference?(instanceId: string, slug: string, preference: { favorite?: boolean; hidden?: boolean }): Promise<void>
  usageSummary?(window: import('../../shared/usage').UsageWindow): Promise<import('../../shared/usage').UsageSummary>
  attachTerminal?(input: import('../../shared/contracts').TerminalAttachRequest): Promise<void>
  detachTerminal?(attachmentId: string): Promise<void>
  writeTerminal?(input: import('../../shared/contracts').TerminalTarget & { data: string }): Promise<void>
  resizeTerminal?(input: import('../../shared/contracts').TerminalTarget & { cols: number; rows: number }): Promise<void>
  closeTerminal?(input: import('../../shared/contracts').TerminalTarget): Promise<void>
  onTerminalEvent?(listener: (push: import('../../shared/contracts').TerminalPush) => void): () => void
  listRefs?(cwd: string, query?: string): Promise<import('../../shared/contracts').EngineRefs>
  readSettings?(): Promise<EngineSettings>
  browseFolder?(path: string): Promise<EngineFolderListing>
  lookupRepository?(repository: string): Promise<EngineRepository>
  cloneRepository?(input: CloneRepositoryInput): Promise<{ cwd: string }>
  refreshAccounts?(): Promise<void>
  /** Keeps a composer image until it is sent or removed (§6.0). */
  stageAttachment?(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<{ id: string; sizeBytes: number }>
  discardAttachment?(id: string): Promise<void>
  /** Deletes staged images no draft or saved preparation references. */
  retainAttachments?(ids: readonly string[]): Promise<void>
  /** Holds a visual comment privately over a staged image or updates its draft (docs/plans/open/visual-review). */
  holdVisualComment?(input: HoldVisualCommentInput): Promise<string>
  actVisualComment?(id: string, action: VisualCommentAction): Promise<void>
  /** Bytes for the strata-visual protocol: a piece of evidence or a staged composer image. */
  readVisualImage?(kind: 'evidence' | 'staged', id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>
  /** A frame Annotate captured, kept as evidence until it is held or swept (phase 3). */
  storeVisualCapture?(input: { bytes: Uint8Array; width: number; height: number }): Promise<string>
  /** The record behind a visual comment, for Show me and the re-check. */
  visualComment?(id: string): VisualCommentRecord | null
}

const EMPTY_ENGINE: EngineView = {
  state: 'unpaired',
  server: null,
  problem: null,
  credential: null,
  projects: [],
  activeThreadId: null,
  accounts: [],
  terminalDefaults: {},
  terminalShimDirectory: null,
}

/** The launcher names Strata may have written; a driver without a terminal default gets its launcher removed. */
const SHIM_NAMES = ['codex', 'claude']

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

type ShellThread = T3ShellSnapshot['threads'][number]
type DetailThread = T3ThreadDetailSnapshot['thread']

/** The fork's rule for closing a running turn when the session leaves `running`. */
function settledTurnState(status: ShellThread['session'] extends infer S ? S extends { status: infer T } ? T : never : never): 'completed' | 'interrupted' | 'error' | null {
  switch (status) {
    case 'idle': case 'ready': return 'completed'
    case 'error': return 'error'
    case 'interrupted': case 'stopped': return 'interrupted'
    default: return null
  }
}

function sessionApplied<T extends { session: ShellThread['session']; latestTurn: unknown; updatedAt: string }>(thread: T, session: NonNullable<ShellThread['session']>, occurredAt: string): T {
  const latest = thread.latestTurn && typeof thread.latestTurn === 'object' ? thread.latestTurn as Record<string, unknown> : null
  const settled = settledTurnState(session.status)
  const latestTurn = session.status === 'running' && session.activeTurnId !== null
    ? {
        turnId: session.activeTurnId, state: 'running',
        requestedAt: latest?.turnId === session.activeTurnId && typeof latest.requestedAt === 'string' ? latest.requestedAt : session.updatedAt,
        startedAt: latest?.turnId === session.activeTurnId && typeof latest.startedAt === 'string' ? latest.startedAt : session.updatedAt,
        completedAt: null,
        assistantMessageId: latest?.turnId === session.activeTurnId ? latest.assistantMessageId ?? null : null,
      }
    : latest && latest.state === 'running' && settled ? { ...latest, state: settled, completedAt: session.updatedAt } : thread.latestTurn
  return { ...thread, session, latestTurn, updatedAt: occurredAt }
}

/** T3's latest turn as the conversation folds it: id, lifecycle state, and both stamps when it has them (§6.9). */
function turnView(latestTurn: Record<string, unknown> | null): import('../../shared/contracts').EngineTurnView | null {
  if (typeof latestTurn?.turnId !== 'string') return null
  const state = latestTurn.state
  return {
    id: latestTurn.turnId,
    state: state === 'running' || state === 'interrupted' || state === 'error' ? state : 'completed',
    startedAt: typeof latestTurn.startedAt === 'string' ? latestTurn.startedAt : typeof latestTurn.requestedAt === 'string' ? latestTurn.requestedAt : null,
    completedAt: typeof latestTurn.completedAt === 'string' ? latestTurn.completedAt : null,
  }
}

function cleanServer(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The engine address must use http or https')
  return url.origin
}

function optionValue(options: ReadonlyArray<{ id: string; value: unknown }> | undefined, ...ids: string[]): unknown {
  return options?.find((option) => ids.includes(option.id))?.value
}

function effortOf(thread: T3ShellSnapshot['threads'][number]): string | null {
  const value = optionValue(thread.modelSelection.options, 'effort', 'reasoningEffort')
  return typeof value === 'string' ? value : null
}

function statusOf(thread: T3ShellSnapshot['threads'][number]): EngineThreadView['status'] {
  return thread.session?.status ?? 'idle'
}

export class T3EngineClient implements EngineReadClient {
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number
  readonly #credentialPath: string
  readonly #readingPath: string
  readonly #commandsPath: string
  readonly #accountsPath: string
  readonly #conversationsPath: string
  readonly #staged: StagedAttachmentStore
  readonly #evidence: VisualEvidenceStore
  readonly #visualPath: string
  #visual: VisualCommentsStore = emptyVisualCommentsStore()
  #conversations: ConversationsStore = { formatVersion: 1, threads: {} }
  readonly #WebSocket: typeof WebSocket
  readonly #configRefreshMs: number
  readonly #shimDirectory: string | null
  readonly #writeShims: typeof writeTerminalShims
  #terminalStream: import('./socket').EngineStream | null = null
  #terminalAttachment: string | null = null
  readonly #terminalListeners = new Set<(push: import('../../shared/contracts').TerminalPush) => void>()
  #accounts: AccountsStore = emptyAccountsStore()
  #providers: EngineProviderInstance[] = []
  #models: EngineModelView[] = []
  #configFetchedAt = 0
  #configProblem: string | null = null
  readonly #listeners = new Set<(view: EngineView) => void>()
  #credential: EngineCredential | null = null
  #reading: EngineReadingState = { formatVersion: 1, activeThreadId: null, lastVisited: {}, attention: {} }
  #lastThreads: EngineThreadView[] = []
  readonly #isFocused: () => boolean
  readonly #notify: (notification: EngineNotification) => void
  #shell: T3ShellSnapshot | null = null
  /** Thread transcripts Strata follows: the active thread and every watched one, each with its own subscription. */
  readonly #threads = new Map<string, { detail: T3ThreadDetailSnapshot | null; sequence: number; stream: EngineStream | null }>()
  #watched = new Set<string>()
  #state: EngineView['state'] = 'unpaired'
  #problem: string | null = null
  #running = false
  #refreshing: Promise<void> | null = null
  #pendingCommands: Array<{ key: string; command: unknown; messageId?: string }> = []
  readonly #reconnectDelaysMs: number[]
  readonly #pingMs: number
  readonly #pongTimeoutMs: number
  readonly #publishDelayMs: number
  #socket: EngineSocket | null = null
  #shellStream: EngineStream | null = null
  #shellSequence = 0
  #renewalTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectAttempt = 0
  #messageCache = new Map<string, { text: string; prose: string; blocks: ReturnType<typeof mapMarkdownBlocks>["blocks"]; visualReplies: Array<{ id: string; revision?: number; ready: boolean }> }>()
  #publishTimer: ReturnType<typeof setTimeout> | null = null
  #configTimer: ReturnType<typeof setTimeout> | null = null
  #connecting: Promise<void> | null = null
  readonly #shellWaiters = new Set<() => void>()
  readonly #previewHost: PreviewHostBridge | null
  readonly #previewClientId = `strata-${randomUUID()}`
  #previewStream: EngineStream | null = null
  #previewConnectionId: string | null = null
  /** The engine identity the browser registered with; a reconnect registers only with the same one. */
  #previewEnvironmentId: string | null = null

  constructor(options: EngineClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#reconnectDelaysMs = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS
    this.#pingMs = options.pingMs ?? 20_000
    this.#pongTimeoutMs = options.pongTimeoutMs ?? 10_000
    this.#publishDelayMs = options.publishDelayMs ?? 25
    this.#isFocused = options.isFocused ?? (() => true)
    this.#notify = options.notify ?? (() => undefined)
    this.#credentialPath = join(options.dataDirectory, 'engine-credential.json')
    this.#readingPath = join(options.dataDirectory, 'engine-reading.json')
    this.#commandsPath = join(options.dataDirectory, 'engine-commands.json')
    this.#accountsPath = join(options.dataDirectory, 'engine-accounts.json')
    this.#conversationsPath = join(options.dataDirectory, 'engine-conversations.json')
    this.#staged = new StagedAttachmentStore(join(options.dataDirectory, 'composer-attachments'), this.#now)
    this.#evidence = new VisualEvidenceStore(join(options.dataDirectory, 'visual-evidence'), this.#now)
    this.#visualPath = join(options.dataDirectory, 'engine-visual-comments.json')
    this.#WebSocket = options.webSocket ?? WebSocket
    this.#configRefreshMs = options.configRefreshMs ?? 30_000
    this.#shimDirectory = options.terminalShimDirectory ?? null
    this.#writeShims = options.writeShims ?? writeTerminalShims
    this.#previewHost = options.previewHost ?? null
  }

  async initialize(): Promise<void> {
    this.#credential = await this.#readCredential()
    this.#reading = await this.#readReading()
    this.#pendingCommands = await this.#readCommands()
    this.#accounts = await readAccountsStore(this.#accountsPath)
    this.#conversations = await readConversationsStore(this.#conversationsPath)
    this.#visual = await readVisualCommentsStore(this.#visualPath)
    // Evidence outlives its comment only until this sweep; sent comments keep theirs while they exist.
    await this.#evidence.sweep(referencedEvidence(this.#visual)).catch((error: unknown) => logError('engine', 'Visual evidence could not be tidied', error))
    if (!this.#credential) return
    this.#running = true
    await this.reconnect()
    await this.#retryPendingCommands()
  }

  async shutdown(): Promise<void> {
    if (this.#terminalAttachment) await this.detachTerminal(this.#terminalAttachment)
    this.#terminalListeners.clear()
    this.#running = false
    this.#clearReconnect()
    if (this.#renewalTimer) clearTimeout(this.#renewalTimer)
    this.#renewalTimer = null
    if (this.#publishTimer) clearTimeout(this.#publishTimer)
    this.#publishTimer = null
    if (this.#configTimer) clearTimeout(this.#configTimer)
    this.#configTimer = null
    this.#closeSocket()
    await this.#refreshing
    await this.#connecting?.catch(() => undefined)
  }

  subscribe(listener: (view: EngineView) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  view(): EngineView {
    const projects: EngineProjectView[] = (this.#shell?.projects ?? []).map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModelSelection: project.defaultModelSelection ? { ...project.defaultModelSelection, options: publicOptions(project.defaultModelSelection.options) } : null,
      visualComments: this.#visualCommentsFor(project.id),
      threads: (this.#shell?.threads ?? []).filter((thread) => thread.projectId === project.id).map((thread) => {
        const detailThread = this.#threads.get(thread.id)?.detail?.thread
        const messages = detailThread?.id === thread.id ? detailThread.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          turnId: message.turnId,
          streaming: message.streaming,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          attachmentCount: message.attachments?.length ?? 0,
          ...(!message.streaming && message.role === 'assistant' ? (() => { let cached = this.#messageCache.get(message.id); if (!cached || cached.text !== message.text) { const parsed = parseStrataBlock(message.text); const prose = parsed?.prose ?? message.text; cached = { text: message.text, prose, blocks: mapMarkdownBlocks(`message:${message.id}`, prose).blocks, visualReplies: visualRepliesIn(parsed) }; this.#messageCache.set(message.id, cached) } return { prose: cached.prose, blocks: cached.blocks, ...(cached.visualReplies.length ? { visualReplies: cached.visualReplies } : {}) } })() : {}),
        })) : []
        const activities = detailThread?.id === thread.id ? detailThread.activities.map((activity) => ({
          id: activity.id,
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
        })) : []
        const latestTurn = thread.latestTurn && typeof thread.latestTurn === 'object' ? thread.latestTurn as Record<string, unknown> : null
        // Never visited counts as read, as in T3: a fresh pairing must not light every historical thread. Mark unread records a visit at epoch 0.
        const visited = this.#reading.lastVisited[thread.id]
        const snoozed = thread.snoozedUntil !== null && thread.snoozedUntil !== undefined && Date.parse(thread.snoozedUntil) > this.#now()
        const workingRoot = detailThread?.id === thread.id ? detailThread.worktreePath ?? project.workspaceRoot : project.workspaceRoot
        const documents = detailThread?.id === thread.id ? detailThread.checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => {
          const path = isAbsolute(file.path) ? file.path : resolve(workingRoot, file.path)
          return { path, turnId: checkpoint.turnId, additions: file.additions, deletions: file.deletions, markdown: ['.md', '.markdown', '.mdown', '.mkd'].includes(extname(path).toLowerCase()) }
        })) : []
        return {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          model: thread.modelSelection.model,
          providerInstanceId: thread.modelSelection.instanceId,
          options: publicOptions(thread.modelSelection.options),
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          effort: effortOf(thread),
          access: thread.runtimeMode,
          status: statusOf(thread),
          updatedAt: thread.updatedAt,
          unread: visited !== undefined && Date.parse(thread.updatedAt) > visited && thread.id !== this.#reading.activeThreadId,
          pinnedAt: thread.pinnedAt ?? null,
          snoozedUntil: thread.snoozedUntil ?? null,
          lifecycle: snoozed ? 'snoozed' : thread.settledOverride === 'settled' ? 'settled' : 'active',
          archived: thread.archivedAt != null,
          attention: this.#reading.attention[thread.id] ?? 0,
          pendingWork: 0,
          pendingApprovals: thread.hasPendingApprovals,
          pendingUserInput: thread.hasPendingUserInput,
          backgroundLiveness: thread.backgroundLiveness ?? null,
          activeTurnId: thread.session?.activeTurnId ?? null,
          turnStartedAt: typeof latestTurn?.startedAt === 'string'
            ? latestTurn.startedAt
            : typeof latestTurn?.requestedAt === 'string' ? latestTurn.requestedAt : null,
          latestTurn: turnView(latestTurn),
          messages,
          activities,
          comments: this.#conversations.threads[thread.id]?.comments ?? [],
          outcomes: this.#conversations.threads[thread.id]?.outcomes ?? [],
          deliveries: (this.#conversations.threads[thread.id]?.prepared ?? []).map(entry => ({ messageId: entry.messageId, text: entry.attachments.map(a => a.kind === 'text' ? a.text : `[Image ${a.name}]`).join('\n'), phase: entry.attachments.every(a => a.uploaded) ? 'prepared' as const : 'uploading' as const })),
          items: (() => { const explicit = postedMessageItems(messages, thread.id); return applyConversationState([...explicit.filter(item => !this.#conversations.threads[thread.id]?.comments?.some(comment => comment.id === item.id)), ...(this.#conversations.threads[thread.id]?.comments ?? []).map((comment): import("../../shared/contracts").ItemView => ({ id: comment.id, kind: comment.kind, status: comment.state === "held" || comment.state === "pending" ? "drafted" : isOwnerComment(comment) || comment.state === "resolved" ? "done" : "open", review: "unreviewed", text: comment.text, quote: comment.selection, order: 0, threadId: thread.id, turnId: messages.find(message => message.id === comment.anchor.message)?.turnId ?? null, messageId: comment.anchor.message, annotationId: null, hunkId: null, inferred: false, source: { kind: "message", anchor: comment.anchor }, discussion: comment.replies, ...(comment.options ? { options: comment.options } : {}), unavailable: !resolveMessageAnchor(comment, messages.find(message => message.id === comment.anchor.message)) })), ...messages.flatMap((message) => inferredMessageItems(message, thread.id, explicit))], this.#conversations.threads[thread.id]) })(),
          documents,
        }
      }),
    }))
    const accounts = this.#accountViews()
    return {
      state: this.#state,
      server: this.#credential?.server ?? null,
      problem: this.#problem,
      credential: this.#credential ? { expiresAt: new Date(this.#credential.expiresAt).toISOString(), renews: this.#credential.scopes.includes(RENEWAL_SCOPE) } : null,
      projects,
      activeThreadId: this.#reading.activeThreadId,
      accounts,
      models: this.#models.map(model => ({ ...model, favorite: this.#accounts.modelPreferences?.[model.instanceId]?.favorites.includes(model.slug) ?? false, hidden: this.#accounts.modelPreferences?.[model.instanceId]?.hidden.includes(model.slug) ?? false })),
      terminalDefaults: { ...this.#accounts.terminalDefaults },
      autoInstanceIds: Object.fromEntries([...new Set(accounts.map((account) => account.driver))].map((driver) => [driver, chooseInstance(this.#accounts, accounts, null, driver)])),
      terminalShimDirectory: this.#shimDirectory,
    }
  }

  #accountViews() {
    return accountViews(this.#accounts, this.#providers, this.#now())
  }

  /**
   * Parking (§5.13) lives in Strata's ghost store, not on the server, so it
   * survives restarts and never touches T3's settings.
   */
  async parkAccount(instanceId: string, parked: boolean): Promise<void> {
    const current = this.#accounts.parked.includes(instanceId)
    if (current === parked) return
    this.#accounts = { ...this.#accounts, parked: parked ? [...this.#accounts.parked, instanceId] : this.#accounts.parked.filter((id) => id !== instanceId) }
    await writeAccountsStore(this.#accountsPath, this.#accounts)
    this.#publish()
    await this.#syncShims()
  }

  async setTerminalDefault(driver: string, selection: string | null): Promise<void> {
    this.#accounts = { ...this.#accounts, terminalDefaults: { ...this.#accounts.terminalDefaults, [driver]: selection } }
    await writeAccountsStore(this.#accountsPath, this.#accounts)
    this.#publish()
    await this.#syncShims()
  }

  /**
   * The probe on open (§5.13): asks the engine to re-measure every provider,
   * then reads the configuration that carries the fresh usage. A server too
   * old to refresh still answers the read.
   */
  async refreshAccounts(): Promise<void> {
    if (!this.#credential) throw new Error('No engine is paired')
    await this.#rpcOrSocket(T3_RPC.refreshProviders, {}, 'provider refresh').catch(() => undefined)
    this.#configFetchedAt = 0
    await this.#refreshConfig()
    this.#publish()
    if (this.#configProblem) throw new Error(this.#configProblem)
  }

  async pair(server: string, pairingCode: string): Promise<void> {
    const origin = cleanServer(server)
    this.#state = 'connecting'
    this.#problem = null
    this.#publish()
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: pairingCode,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_label: 'StrataMD',
      client_device_type: 'desktop',
      client_os: assertSupportedPlatform(),
    })
    const response = await this.#fetch(`${origin}${T3_HTTP.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) {
      this.#state = 'unpaired'
      this.#problem = `Pairing failed (${response.status})`
      this.#publish()
      throw new Error(this.#problem)
    }
    await this.#writeCredential(origin, await response.json())
    // A new pairing is a new engine as far as the browser host is concerned.
    this.#previewEnvironmentId = null
    this.#running = true
    await this.reconnect()
  }

  /**
   * Connects (§5.1): HTTP snapshots of the shell and the active thread give
   * the first picture, then one socket subscribes to both so the running trace
   * is live. Called on start, after pairing, by the owner's Reconnect, and by
   * the backoff after a dropped socket; each call resubscribes exactly once.
   */
  async reconnect(): Promise<void> {
    if (!this.#credential) {
      this.#state = 'unpaired'
      this.#publish()
      return
    }
    if (this.#connecting) return this.#connecting
    this.#connecting = (async () => {
      this.#clearReconnect()
      this.#closeSocket()
      this.#state = 'connecting'
      this.#problem = null
      this.#publish()
      await this.#refresh()
      if (!this.#reachable()) { this.#scheduleReconnect(); return }
      await this.#renewIfDue()
      try {
        await this.#subscribe()
        this.#reconnectAttempt = 0
        this.#scheduleRenewal()
        // Accounts (§5.13) read over the same socket once it is up; a failure keeps the last measurement.
        await this.#refreshConfig()
        this.#publish()
      } catch (error) {
        this.#state = 'disconnected'
        this.#problem = error instanceof Error ? error.message : 'The engine socket is unreachable'
        this.#publish()
        this.#scheduleReconnect()
      }
    })().finally(() => { this.#connecting = null })
    return this.#connecting
  }

  async openThread(threadId: string): Promise<void> {
    if (!this.#shell?.threads.some((thread) => thread.id === threadId)) await this.#waitForShell((shell) => shell.threads.some((thread) => thread.id === threadId))
    if (!this.#shell?.threads.some((thread) => thread.id === threadId)) throw new Error(`Thread was not found: ${threadId}`)
    this.#reading.activeThreadId = threadId
    this.#reading.lastVisited[threadId] = this.#now()
    delete this.#reading.attention[threadId]
    await this.#writeReading()
    await this.#refreshThread(threadId)
    this.#publish()
    await this.#subscribeThreads()
  }

  async watchThreads(threadIds: readonly string[]): Promise<void> {
    const next = new Set(threadIds)
    const added = [...next].filter((id) => !this.#watched.has(id) && !this.#threads.has(id))
    this.#watched = next
    if (!this.#reachable()) return
    for (const id of added) {
      if (!this.#shell?.threads.some((thread) => thread.id === id)) continue
      try { await this.#refreshThread(id) } catch (error) { logError('engine', `Thread ${id} could not be loaded`, error) }
    }
    await this.#subscribeThreads()
    this.#publish()
  }

  /**
   * The active thread, every watched thread, and any thread with a delivery still awaiting acknowledgment,
   * so a Send from the preview or a card is acknowledged without the conversation being opened.
   */
  #followedThreadIds(): string[] {
    const ids = new Set<string>(this.#watched)
    if (this.#reading.activeThreadId) ids.add(this.#reading.activeThreadId)
    for (const [threadId, state] of Object.entries(this.#conversations.threads)) if (state.pending.length > 0) ids.add(threadId)
    return [...ids].filter((id) => this.#shell?.threads.some((thread) => thread.id === id))
  }

  /** Waits for the shell stream to show something, such as a thread or project a command just created. */
  #waitForShell(predicate: (shell: T3ShellSnapshot) => boolean, timeoutMs = 5_000): Promise<void> {
    if (this.#shell && predicate(this.#shell)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.#shellWaiters.delete(check); resolve() }, timeoutMs)
      timer.unref?.()
      const check = () => { if (this.#shell && predicate(this.#shell)) { clearTimeout(timer); this.#shellWaiters.delete(check); resolve() } }
      this.#shellWaiters.add(check)
    })
  }

  async startTurn(threadId: string, input: ConversationInput & { messageId?: string; commandId?: string; context?: import("../../core/conversation-delivery").ConversationDelivery }): Promise<void> {
    const thread = this.#shell?.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Thread was not found: ${threadId}`)
    const existing = this.#conversations.threads[threadId]?.prepared?.find((entry) => entry.messageId === input.messageId)
    if (existing) { await this.#resumeDelivery(threadId, existing.messageId); return }
    const instanceId = input.instanceId ?? thread.modelSelection.instanceId
    const accounts = this.#accountViews()
    const driverFor = (id: string) => accounts.find(account => account.instanceId === id)?.driver ?? this.#models.find(model => model.instanceId === id)?.driver
    const scope = continuationScope({ instanceId: thread.modelSelection.instanceId, model: thread.modelSelection.model, driver: driverFor(thread.modelSelection.instanceId) })
    const requestedFamily = modelFamily(undefined, input.model)
    if (!permitsSelection(scope, { instanceId, model: input.model, driver: driverFor(instanceId) }) || (requestedFamily !== 'unknown' && requestedFamily !== scope.family)) {
      throw new Error(scope.instanceId
        ? `This ${familyLabel(scope.family)} conversation stays on subscription ${scope.instanceId}. Choose a model in that subscription.`
        : `This ${familyLabel(scope.family)} conversation only supports ${familyLabel(scope.family)} models.`)
    }
    const catalog = this.#models.filter(model => model.instanceId === instanceId)
    if (catalog.length && !catalog.some(model => model.slug === input.model)) throw new Error(`Model ${input.model} is not available on subscription ${instanceId}.`)
    // Validate routing before uploading files or consuming queued replies.
    await this.#resolveInstance(thread.projectId, instanceId)
    // A conversation Send carries the queued item replies as its attachment (§5.4), keyed by item id; the text stays the owner's note.
    const state = this.#conversations.threads[threadId]
    if (input.context && (input.context.threadId !== threadId || input.context.deliveryId !== input.messageId)) throw new Error('Conversation context belongs to another delivery')
    const selection = input.context ? input.context.replies.map(reply => [reply.itemId, reply.text] as [string, string]) : Object.entries(input.replies ?? {})
    for (const [id, text] of selection) if (!input.context && state?.replies[id]?.text !== text) throw new Error(`Reply ${id} changed. Review the selected reply before sending.`)
    const queued = selection.length ? Object.fromEntries(selection.map(([id, text]) => [id, { ...(state?.replies[id] ?? { kind: 'comment' as const, quote: '', messageId: null }), text }])) : null
    const comments = input.context?.annotations ?? Object.entries(input.comments ?? {}).map(([id, revision]) => {
      const comment = state?.comments?.find(comment => comment.id === id)
      if (!comment || comment.state !== 'held' || comment.revision !== revision) throw new Error(`Comment ${id} changed. Review it before sending.`)
      return comment
    })
    const outcomes = input.context?.outcomes ?? state?.outcomes ?? []
    const messages = this.view().projects.flatMap(project => project.threads).find(thread => thread.id === threadId)?.messages ?? []
    const messageId = input.messageId ?? randomUUID()
    const userAttachments = input.attachments ?? []
    // Visual comments (docs/plans/open/visual-review): each held draft freezes one revision; the marked capture for every
    // capture a mark or stroke sits on travels as an image, identical bytes once, and the brief rides in the context file.
    const visualIds = [...new Set(input.visual ?? [])]
    if (visualIds.length && input.context) throw new Error('A document delivery cannot carry visual comments')
    const visualDrafts = visualIds.map((id) => {
      const comment = this.#visual.comments[id]
      if (!comment) throw new Error(`Visual comment ${id} was not found`)
      if (!comment.draft) throw new Error(`Visual comment ${id} has nothing new to send`)
      if (comment.projectId !== thread.projectId) throw new Error(`Visual comment ${id} belongs to another project`)
      return comment
    })
    // A page comment re-checks its marks immediately before Send: refused, with the draft kept, only when the page was
    // replaced or a marked thing is gone; anything else on a live page sends.
    for (const comment of visualDrafts) {
      if (comment.anchor.kind !== 'page' || !this.#previewHost?.recheckVisual) continue
      const check = await this.#previewHost.recheckVisual(comment)
      if (check.refusal) throw new Error(check.refusal)
      for (const mark of comment.draft!.marks) if (mark.id in check.found) mark.found = check.found[mark.id]!
    }
    const evidenceNames = new Map<string, string>()
    const visualAttachments: PreparedAttachment[] = []
    const frozen: Array<{ comment: VisualCommentRecord; revision: VisualRevision; names: Map<string, string> }> = []
    for (const comment of visualDrafts) {
      const draft = comment.draft!
      const referenced = [...new Set([...draft.marks.map((mark) => mark.captureId), ...draft.strokes.map((stroke) => stroke.captureId)])]
      const captureIds = referenced.length ? referenced : comment.captures.slice(0, 1).map((capture) => capture.id)
      const number = comment.revisions.length + 1
      const names = new Map<string, string>()
      for (const [index, captureId] of captureIds.entries()) {
        const capture = comment.captures.find((candidate) => candidate.id === captureId)
        if (!capture) throw new Error(`Visual comment ${comment.id} lost a capture. Open it and mark again.`)
        const evidenceId = capture.markedId ?? capture.id
        let name = evidenceNames.get(evidenceId)
        if (!name) {
          const meta = await this.#evidence.meta(evidenceId)
          if (!meta) throw new MissingEvidenceError(visualAttachmentName(comment.id, number, index))
          name = visualAttachmentName(comment.id, number, index)
          evidenceNames.set(evidenceId, name)
          visualAttachments.push({ kind: 'evidence', id: evidenceId, name, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes })
        }
        names.set(captureId, name)
      }
      const revision: VisualRevision = {
        number, text: draft.text, marks: draft.marks.map((mark) => ({ ...mark })), strokes: draft.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })), adjustments: draft.adjustments.map((adjustment) => ({ ...adjustment })),
        destination: { threadId, engine: comment.engine }, captures: captureIds, evidence: captureIds.map((captureId) => evidenceNames.get(comment.captures.find((capture) => capture.id === captureId)!.markedId ?? captureId) ? (comment.captures.find((capture) => capture.id === captureId)!.markedId ?? captureId) : captureId),
        deliveryId: messageId, sentAt: this.#now(), state: 'sending', replies: [],
      }
      frozen.push({ comment, revision, names })
    }
    const text = input.text.trim() || (frozen.length ? visualSendSummary(frozen.map(({ revision }) => revision)) : queued ? `Replies to ${Object.keys(queued).length} item${Object.keys(queued).length === 1 ? '' : 's'}.` : comments.length ? `Comments on ${comments.length} passages.` : userAttachments.length ? attachmentSummary(userAttachments) : outcomes.length ? 'Conversation outcomes.' : '')
    if (!text) throw new Error('Write a message or queue a reply, or attach a file before sending')
    const contextNeeded = Boolean(queued || comments.length || outcomes.length || frozen.length)
    // T3 refuses a turn with more than eight attachments. The context file keeps its place; the owner's files must make room (§6.0).
    // A selection over capacity stays intact and is refused by name; nothing is trimmed or split across turns.
    if (frozen.length) {
      const capacity = sendCapacity({ files: userAttachments.length, visualImages: visualAttachments.length, visualComments: frozen.length, contextFile: contextNeeded })
      if (capacity.refusal) throw new Error(capacity.refusal)
    } else if (userAttachments.length + (contextNeeded ? 1 : 0) > MAX_ATTACHMENTS) throw new Error(attachmentLimitMessage(contextNeeded ? 1 : 0))
    for (const attachment of userAttachments) if (attachment.kind === 'image' && !(await this.#staged.exists(attachment.id))) throw new Error(`Attachment ${attachment.name} is no longer staged. Attach it again.`)
    const briefs = frozen.map(({ comment, revision, names }) => visualBrief(comment, revision, names))
    const contextFile: PreparedAttachment | undefined = contextNeeded ? { kind: 'text', name: `conversation-${messageId}.md`, text: renderConversationDelivery(input.context ?? conversationDelivery(threadId, messageId, comments, queued ?? {}, messages, outcomes, briefs)) } : undefined
    const attachmentInputs: PreparedAttachment[] = [
      ...userAttachments.map((attachment): PreparedAttachment => attachment.kind === 'image' ? { kind: 'image', id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes } : { kind: 'text', name: attachment.name, text: attachment.text }),
      ...visualAttachments,
      ...(contextFile ? [contextFile] : []),
    ]
    const workspace = input.workspace ?? state?.workspace
    if (workspace && (thread.worktreePath || thread.latestUserMessageAt)) throw new Error(`Thread ${threadId} already has a working copy or a first turn`)
    const command = turnStartCommand.parse({
      ...(workspace ? { bootstrap: { prepareWorktree: { projectCwd: this.#shell!.projects.find(project => project.id === thread.projectId)!.workspaceRoot, baseBranch: workspace.baseBranch, branch: `t3/${randomUUID().replaceAll('-', '').slice(0, 8)}`, startFromOrigin: workspace.startFromOrigin }, runSetupScript: true } } : {}),
      type: 'thread.turn.start', commandId: input.commandId ?? `strata-${messageId}`, threadId, createdAt: new Date(this.#now()).toISOString(),
      message: { messageId, role: 'user', text, attachments: [] },
      modelSelection: { instanceId, model: input.model, options: input.options ?? turnOptions(input, thread) },
      runtimeMode: input.access, interactionMode: thread.interactionMode,
    })
    const current = state ?? emptyConversationState()
    this.#conversations.threads[threadId] = {
      ...current,
      replies: Object.fromEntries(Object.entries(current.replies).filter(([id, reply]) => !queued?.[id] || queued[id]!.text !== reply.text)),
      comments: (current.comments ?? []).map(comment => comments.some(selected => selected.id === comment.id) ? { ...comment, state: 'pending' } : comment),
      pending: [...current.pending, { deliveryId: messageId, itemIds: Object.keys(queued ?? {}), replies: queued ?? {}, commentIds: comments.map(comment => comment.id), outcomeKeys: outcomes.map(outcome => `${outcome.message}:${outcome.index}`), ...(frozen.length ? { visual: frozen.map(({ comment, revision }) => ({ id: comment.id, revision: revision.number })) } : {}) }],
      prepared: [...(current.prepared ?? []), { messageId, command, attachments: attachmentInputs }],
    }
    if (frozen.length) {
      for (const { comment, revision } of frozen) { comment.revisions.push(revision); comment.draft = null; comment.updatedAt = this.#now() }
      await writeVisualCommentsStore(this.#visualPath, this.#visual)
    }
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
    await this.#resumeDelivery(threadId, messageId)
    // The thread is followed until the engine lists the message, which is what acknowledges the delivery.
    if (!this.#threads.has(threadId) && this.#reachable()) {
      try { await this.#refreshThread(threadId); await this.#subscribeThreads() } catch (error) { logError('engine', `Thread ${threadId} could not be followed after Send`, error) }
    }
  }

  /** Resumes a saved preparation and keeps the visual revisions it carries honest: sending while it runs, failed and retryable when it does not. */
  async #resumeDelivery(threadId: string, messageId: string): Promise<void> {
    await this.#markVisual(messageId, 'sending')
    try { await this.#resumePrepared(threadId, messageId) }
    catch (error) { await this.#markVisual(messageId, 'failed', error); throw error }
  }

  async #markVisual(deliveryId: string, state: 'sending' | 'failed' | 'sent', error?: unknown): Promise<void> {
    let changed = false
    for (const comment of Object.values(this.#visual.comments)) {
      for (const revision of comment.revisions) {
        if (revision.deliveryId !== deliveryId || revision.state === state || revision.state === 'sent') continue
        revision.state = state
        if (state === 'failed') revision.error = error instanceof Error ? error.message : error === undefined ? 'The send did not go through.' : String(error)
        else delete revision.error
        comment.updatedAt = this.#now()
        changed = true
      }
    }
    if (!changed) return
    await writeVisualCommentsStore(this.#visualPath, this.#visual)
    this.#publish()
  }

  #visualCommentsFor(projectId: string): VisualCommentView[] {
    const titles = new Map((this.#shell?.threads ?? []).map((thread) => [thread.id, thread.title]))
    return Object.values(this.#visual.comments)
      .filter((comment) => comment.projectId === projectId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((comment) => visualCommentView(comment, { captureUrl: (id) => visualImageUrl('evidence', id), threadTitle: (id) => titles.get(id) ?? 'a closed thread' }))
  }

  async holdVisualComment(input: HoldVisualCommentInput): Promise<string> {
    const now = this.#now()
    const thread = this.#shell?.threads.find((candidate) => candidate.id === input.threadId)
    if (!thread) throw new Error(`Thread was not found: ${input.threadId}`)
    if (thread.projectId !== input.projectId) throw new Error(`Thread ${input.threadId} is not in project ${input.projectId}`)
    let comment = input.id ? this.#visual.comments[input.id] : undefined
    if (input.id && !comment) throw new Error(`Visual comment ${input.id} was not found`)
    const captureIds = new Map<string, string>()
    if (input.source) {
      if (comment) throw new Error('A visual comment keeps its image. Start a new one for a new image.')
      const staged = await this.#staged.read(input.source.staged)
      if (!staged) throw new Error(`Attachment ${input.source.name} is no longer staged. Attach it again.`)
      const evidence = await this.#evidence.put({ bytes: staged.bytes, width: input.source.width, height: input.source.height, mimeType: staged.meta.mimeType })
      comment = { id: `v_${randomUUID()}`, projectId: input.projectId, engine: null, anchor: { kind: 'image', name: input.source.name }, captures: [{ id: evidence.id, width: input.source.width, height: input.source.height, takenAt: now }], draft: null, revisions: [], createdAt: now, updatedAt: now }
      captureIds.set(input.source.staged, evidence.id)
      this.#visual.comments[comment.id] = comment
      // On Hold the image moves into the evidence store; the staged copy leaves so no delivery can consume it.
      await this.#staged.discard(input.source.staged)
    }
    if (input.page) {
      // Annotate on a page: the frames are already in the evidence store; the record says which page instance they came from.
      if (comment && comment.anchor.kind !== 'page') throw new Error('A visual comment keeps its image. Start a new one for a page.')
      const captures: VisualCapture[] = []
      for (const entry of input.page.captures) {
        if (!(await this.#evidence.exists(entry.id))) throw new Error('The captured frame is no longer available. Capture the page again.')
        captures.push({ id: entry.id, width: entry.width, height: entry.height, scroll: entry.scroll, scale: entry.scale, takenAt: now })
      }
      if (!comment) {
        const workingFolder = this.#shell?.projects.find((project) => project.id === input.projectId)?.workspaceRoot ?? null
        comment = { id: `v_${randomUUID()}`, projectId: input.projectId, engine: null, anchor: { kind: 'page', url: input.page.url, title: input.page.title, instance: input.page.tabId, workingFolder, viewport: { width: input.page.viewport.width, height: input.page.viewport.height, preset: input.page.preset }, deviceScale: input.page.deviceScale }, captures, draft: null, revisions: [], createdAt: now, updatedAt: now }
        this.#visual.comments[comment.id] = comment
      } else {
        for (const capture of captures) if (!comment.captures.some((candidate) => candidate.id === capture.id)) comment.captures.push(capture)
      }
    }
    if (!comment) throw new Error('A visual comment needs an image. Paste or capture one first.')
    const remap = (id: string) => captureIds.get(id) ?? id
    for (const mark of input.marks) if (!comment.captures.some((capture) => capture.id === remap(mark.captureId))) throw new Error(`The mark ${mark.label} points at a capture this comment does not have`)
    for (const stroke of input.strokes) if (!comment.captures.some((capture) => capture.id === remap(stroke.captureId))) throw new Error('A drawing points at a capture this comment does not have')
    for (const entry of input.marked) {
      const capture = comment.captures.find((candidate) => candidate.id === remap(entry.captureId))
      if (!capture) continue
      const size = pngSize(entry.bytes) ?? { width: capture.width, height: capture.height }
      const stored = await this.#evidence.put({ bytes: entry.bytes, width: size.width, height: size.height, mimeType: 'image/png' })
      const previous = capture.markedId
      capture.markedId = stored.id
      // A marked version a sent revision carried stays; only an unsent one is replaced.
      if (previous && !comment.revisions.some((revision) => revision.evidence.includes(previous))) await this.#evidence.discard(previous)
    }
    const previous = comment.draft
    const latest = comment.revisions.at(-1)
    const identityOf = (id: string, given: VisualMarkView['identity']) => previous?.marks.find((mark) => mark.id === id)?.identity ?? latest?.marks.find((mark) => mark.id === id)?.identity ?? given
    comment.draft = {
      text: input.text,
      marks: input.marks.map((mark) => { const identity = identityOf(mark.id, mark.identity); return { id: mark.id, kind: mark.kind, label: mark.label, captureId: remap(mark.captureId), rect: mark.rect, found: mark.found, ...(identity ? { identity } : {}) } }),
      strokes: input.strokes.map((stroke) => ({ id: stroke.id, tool: stroke.tool, captureId: remap(stroke.captureId), points: stroke.points.map((point) => ({ x: point.x, y: point.y })) })),
      adjustments: input.adjustments.map((adjustment) => ({ markId: adjustment.markId, property: adjustment.property, value: adjustment.value, label: adjustment.label })),
      // The active conversation when the session opened is the destination; switching conversations while writing does not move it.
      destination: previous?.destination ?? { threadId: input.threadId, engine: comment.engine },
      updatedAt: now,
    }
    comment.updatedAt = now
    await writeVisualCommentsStore(this.#visualPath, this.#visual)
    this.#publish()
    return comment.id
  }

  async actVisualComment(id: string, action: VisualCommentAction): Promise<void> {
    const comment = this.#visual.comments[id]
    if (!comment) throw new Error(`Visual comment ${id} was not found`)
    const latest = comment.revisions.at(-1)
    const now = this.#now()
    if (action === 'accept') {
      // Looks right accepts the latest revision locally and starts no turn.
      if (!latest || latest.state !== 'sent') throw new Error('Nothing has been sent to accept yet')
      latest.accepted = true
      comment.draft = null
    } else if (action === 'reopen') {
      // Still wrong opens the next private note over the same marks; Send transmits it as the next revision.
      if (!latest) throw new Error('Nothing has been sent to reopen')
      comment.draft = { text: '', marks: latest.marks.map((mark) => ({ ...mark })), strokes: latest.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })), adjustments: latest.adjustments.map((adjustment) => ({ ...adjustment })), destination: { ...latest.destination }, updatedAt: now }
    } else if (action === 'discard') {
      if (comment.revisions.length === 0) {
        delete this.#visual.comments[id]
        await writeVisualCommentsStore(this.#visualPath, this.#visual)
        await this.#evidence.sweep(referencedEvidence(this.#visual)).catch((error: unknown) => logError('engine', 'Visual evidence could not be tidied', error))
        this.#publish()
        return
      }
      comment.draft = null
    } else {
      const failed = [...comment.revisions].reverse().find((revision) => revision.state === 'failed')
      if (!failed) throw new Error('Nothing failed to send')
      const prepared = this.#conversations.threads[failed.destination.threadId]?.prepared?.find((entry) => entry.messageId === failed.deliveryId)
      if (!prepared) throw new Error('The frozen send is gone. Open the comment and send it again.')
      await this.#resumeDelivery(failed.destination.threadId, failed.deliveryId)
      return
    }
    comment.updatedAt = now
    await writeVisualCommentsStore(this.#visualPath, this.#visual)
    this.#publish()
  }

  visualComment(id: string): VisualCommentRecord | null {
    return this.#visual.comments[id] ?? null
  }

  /** A frame Annotate captured goes straight into the evidence store; an unheld one is swept at the next start. */
  async storeVisualCapture(input: { bytes: Uint8Array; width: number; height: number }): Promise<string> {
    const stored = await this.#evidence.put({ bytes: input.bytes, width: input.width, height: input.height, mimeType: 'image/png' })
    return stored.id
  }

  async readVisualImage(kind: 'evidence' | 'staged', id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    if (kind === 'evidence') {
      const evidence = await this.#evidence.read(id)
      return evidence ? { bytes: evidence.bytes, mimeType: evidence.meta.mimeType } : null
    }
    const staged = await this.#staged.read(id)
    return staged ? { bytes: staged.bytes, mimeType: staged.meta.mimeType } : null
  }

  async #resumePrepared(threadId: string, messageId: string): Promise<void> {
    const prepared = this.#conversations.threads[threadId]?.prepared?.find((entry) => entry.messageId === messageId)
    if (!prepared) return
    for (const attachment of prepared.attachments) {
      if (attachment.uploaded) continue
      try { attachment.uploaded = await this.#uploadAttachment(attachment) }
      catch (error) {
        if (error instanceof MissingStagedAttachmentError || error instanceof MissingEvidenceError) await this.#abandonPrepared(threadId, messageId)
        throw error
      }
      await writeConversationsStore(this.#conversationsPath, this.#conversations)
    }
    const command = turnStartCommand.parse(prepared.command)
    command.message.attachments = prepared.attachments.map((attachment) => ({ ...attachment.uploaded! }))
    await this.#dispatch(command, `turn:${messageId}`, messageId)
    const state = this.#conversations.threads[threadId]!
    if (command.bootstrap) delete state.workspace
    state.prepared = (state.prepared ?? []).filter((entry) => entry.messageId !== messageId)
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
  }

  async holdMessageComment(threadId: string, input: { id?: string; messageId: string; from: number; to: number; kind: import('../../shared/contracts').DraftKind; text: string }): Promise<string> {
    const message = this.view().projects.flatMap(project => project.threads).find(thread => thread.id === threadId)?.messages.find(message => message.id === input.messageId)
    if (!message) throw new Error(`Message ${input.messageId} was not found`)
    if (!input.text.trim()) throw new Error('Write a comment before holding it')
    const anchor = messageAnchor(message, input.from, input.to)
    const state = this.#conversations.threads[threadId] ?? emptyConversationState()
    const existing = state.comments?.find(comment => comment.id === input.id)
    if (input.id && (!existing || existing.state !== 'held')) throw new Error(`Comment ${input.id} is not a held draft`)
    const source = message.prose ?? message.text
    const comment: MessageComment = { id: existing?.id ?? `c_${randomUUID()}`, kind: input.kind, anchor, source, selection: source.slice(input.from, input.to), text: input.text, revision: (existing?.revision ?? 0) + 1, state: 'held', replies: [] }
    this.#conversations.threads[threadId] = { ...state, comments: [...(state.comments ?? []).filter(value => value.id !== comment.id), comment] }
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
    return comment.id
  }

  async actMessageComment(threadId: string, itemId: string, action: 'resolve' | 'reopen' | 'discard'): Promise<void> {
    const state = this.#conversations.threads[threadId]
    const comment = state?.comments?.find(comment => comment.id === itemId)
    if (!comment || !state) throw new Error(`Comment ${itemId} was not found`)
    if (action !== 'discard' && comment.state === 'held') throw new Error(`Comment ${itemId} is still private`)
    state.answered = state.answered.filter(id => id !== itemId)
    if (action === 'discard' && comment.state !== 'held') throw new Error(`Comment ${itemId} has already been sent`)
    state.comments = action === 'discard' ? state.comments!.filter(value => value !== comment) : state.comments!.map(value => value === comment ? { ...value, state: action === 'resolve' ? 'resolved' : 'open' } : value)
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
  }

  async queueItemReply(threadId: string, itemId: string, text: string): Promise<void> {
    const item = this.#threadItem(threadId, itemId)
    if (!item) throw new Error(`Item was not found: ${itemId}`)
    if (!text.trim()) throw new Error('Write a reply before queueing it')
    const state = this.#conversations.threads[threadId] ?? emptyConversationState()
    this.#conversations.threads[threadId] = { ...state, replies: { ...state.replies, [itemId]: { text: text.trim(), kind: item.kind, quote: item.quote, messageId: item.messageId } } }
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
  }

  async discardItemReply(threadId: string, itemId: string): Promise<void> {
    const state = this.#conversations.threads[threadId]
    if (!state?.replies[itemId]) return
    const { [itemId]: _dropped, ...replies } = state.replies
    this.#conversations.threads[threadId] = { ...state, replies }
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
  }

  /** Dismissals are remembered per message (§5.12): the item id is derived from the message id and the sentence. */
  async dismissItem(threadId: string, itemId: string): Promise<void> {
    const state = this.#conversations.threads[threadId] ?? emptyConversationState()
    if (state.dismissed.includes(itemId)) return
    const { [itemId]: _dropped, ...replies } = state.replies
    this.#conversations.threads[threadId] = { ...state, replies, dismissed: [...state.dismissed, itemId] }
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
  }

  #threadItem(threadId: string, itemId: string) {
    return this.view().projects.flatMap((project) => project.threads).find((thread) => thread.id === threadId)?.items?.find((item) => item.id === itemId) ?? null
  }

  async createThread(input: StartThreadInput): Promise<string> {
    if (!this.#shell?.projects.some((project) => project.id === input.projectId)) throw new Error(`Project was not found: ${input.projectId}`)
    const threadId = input.threadId ?? randomUUID()
    const existing = this.#shell?.threads.find((thread) => thread.id === threadId)
    if (existing) {
      if (existing.projectId !== input.projectId) throw new Error(`Thread ${threadId} is not in project ${input.projectId}`)
      await this.openThread(threadId)
      return threadId
    }
    const instanceId = await this.#resolveInstance(input.projectId, input.instanceId ?? null)
    if (input.workspace) {
      this.#conversations.threads[threadId] = { ...(this.#conversations.threads[threadId] ?? emptyConversationState()), workspace: worktreeRequest.parse(input.workspace) }
      await writeConversationsStore(this.#conversationsPath, this.#conversations)
    }
    await this.#dispatch(threadCreateCommand.parse({ type: 'thread.create', commandId: `strata-create-${threadId}`, threadId, projectId: input.projectId, title: input.title,
      modelSelection: { instanceId, model: input.model, options: input.options ?? (input.effort ? [{ id: 'effort', value: input.effort }] : []) }, runtimeMode: input.access,
      interactionMode: 'default', branch: input.branch ?? null, worktreePath: input.worktreePath ?? null, createdAt: new Date(this.#now()).toISOString() }))
    await this.openThread(threadId)
    return threadId
  }

  /**
   * Auto (§5.13) goes through the fork's ordering over the accounts Strata
   * knows; an explicit choice is honored but refused while unusable. Without
   * any account report the project's existing instance keeps working.
   */
  async #resolveInstance(projectId: string, explicit: string | null): Promise<string> {
    const accounts = this.#accountViews()
    if (explicit) {
      const account = accounts.find((candidate) => candidate.instanceId === explicit)
      if (account && !account.usable) throw new Error(`${account.name} cannot take a thread: ${account.reason ?? account.state}`)
      return explicit
    }
    const chosen = chooseInstance(this.#accounts, accounts, null)
    if (chosen) {
      if (chosen !== this.#accounts.stickyInstanceId) {
        this.#accounts = { ...this.#accounts, stickyInstanceId: chosen }
        await writeAccountsStore(this.#accountsPath, this.#accounts)
      }
      return chosen
    }
    if (accounts.length) throw new Error('No account can take a thread right now. Unpark one or wait for a limit to reset.')
    return this.#shell?.threads.find((thread) => thread.projectId === projectId)?.modelSelection.instanceId ?? this.#shell?.threads[0]?.modelSelection.instanceId ?? 'codex'
  }

  async updateProviderInstances(instances: Record<string, import('../../shared/contracts').ProviderInstanceSettings>): Promise<void> {
    engineSettingsResult.parse(await this.#rpcOrSocket('server.updateSettings', updateProviderInstancesInput.parse({ patch: { providerInstances: instances } }), 'provider settings'))
    // The write is complete even if the subsequent probe cannot reach a provider.
    await this.refreshAccounts().catch(() => undefined)
  }

  async setModelPreference(instanceId: string, slug: string, preference: { favorite?: boolean; hidden?: boolean }): Promise<void> {
    const previous = this.#accounts.modelPreferences?.[instanceId] ?? { favorites: [], hidden: [] }
    const update = (values: string[], selected: boolean | undefined) => selected === undefined ? values : selected ? [...new Set([...values, slug])] : values.filter(value => value !== slug)
    this.#accounts = { ...this.#accounts, modelPreferences: { ...this.#accounts.modelPreferences, [instanceId]: { favorites: update(previous.favorites, preference.favorite), hidden: update(previous.hidden, preference.hidden) } } }
    await writeAccountsStore(this.#accountsPath, this.#accounts)
    this.#publish()
  }

  onTerminalEvent(listener: (push: import('../../shared/contracts').TerminalPush) => void): () => void {
    this.#terminalListeners.add(listener)
    return () => this.#terminalListeners.delete(listener)
  }

  async usageSummary(window: import('../../shared/usage').UsageWindow): Promise<import('../../shared/usage').UsageSummary> {
    const input = makeUsageWindow(usageWindow.parse(window), new Date(this.#now()))
    const summary = usageSummaryResult.parse(await this.#rpcOrSocket('server.getUsageSummary', usageSummaryInput.parse(input), 'usage summary', 60_000))
    return { ...summary, ...(input.sinceTime ? { sinceTime: input.sinceTime } : {}), ...(input.untilTime ? { untilTime: input.untilTime } : {}) }
  }

  async attachTerminal(input: import('../../shared/contracts').TerminalAttachRequest): Promise<void> {
    if (!this.#socket || this.#socket.closed) throw new Error('Connect the engine before opening a terminal')
    this.#terminalStream?.interrupt()
    this.#terminalStream = null
    this.#terminalAttachment = input.attachmentId
    const publish = (event: import('../../shared/contracts').TerminalEvent) => {
      if (this.#terminalAttachment !== input.attachmentId) return
      const target = event.type === 'snapshot' ? event.snapshot : event
      if (target.threadId !== input.threadId || target.terminalId !== input.terminalId) return
      for (const listener of this.#terminalListeners) listener({ attachmentId: input.attachmentId, event })
    }
    const { attachmentId: _, ...target } = input
    const stream = await this.#socket.stream('terminal.attach', terminalAttachInput.parse({ ...target, restartIfNotRunning: true }), raw => {
      const result = terminalStreamEvent.safeParse(raw)
      if (result.success) publish(result.data)
      else publish({ type: 'error', threadId: input.threadId, terminalId: input.terminalId, message: 'The engine sent an unreadable terminal event' })
    }, error => publish({ type: 'error', threadId: input.threadId, terminalId: input.terminalId, message: error?.message ?? 'The terminal stream ended. Reopen the terminal to attach again.' }))
    if (this.#terminalAttachment !== input.attachmentId) stream.interrupt()
    else this.#terminalStream = stream
  }

  async detachTerminal(attachmentId: string): Promise<void> {
    if (attachmentId !== this.#terminalAttachment) return
    this.#terminalAttachment = null
    this.#terminalStream?.interrupt()
    this.#terminalStream = null
  }

  async writeTerminal(input: import('../../shared/contracts').TerminalTarget & { data: string }): Promise<void> {
    terminalVoidResult.parse(await this.#rpcOrSocket('terminal.write', terminalWriteInput.parse(input), 'terminal input'))
  }

  async resizeTerminal(input: import('../../shared/contracts').TerminalTarget & { cols: number; rows: number }): Promise<void> {
    terminalVoidResult.parse(await this.#rpcOrSocket('terminal.resize', terminalResizeInput.parse(input), 'terminal resize'))
  }

  async closeTerminal(input: import('../../shared/contracts').TerminalTarget): Promise<void> {
    terminalVoidResult.parse(await this.#rpcOrSocket('terminal.close', terminalTarget.parse(input), 'terminal close'))
  }

  async listRefs(cwd: string, query?: string): Promise<import('../../shared/contracts').EngineRefs> {
    const refs: import('../../shared/contracts').EngineRef[] = []
    let cursor: number | undefined
    for (;;) {
      const result = listRefsResult.parse(await this.#rpcOrSocket('vcs.listRefs', listRefsInput.parse({ cwd, ...(query?.trim() ? { query: query.trim() } : {}), ...(cursor !== undefined ? { cursor } : {}), limit: 100, includeMatchingRemoteRefs: true }), `refs in ${cwd}`))
      refs.push(...result.refs)
      if (result.nextCursor === null || result.nextCursor === cursor) return { refs, isRepo: result.isRepo, hasPrimaryRemote: result.hasPrimaryRemote }
      cursor = result.nextCursor
    }
  }

  async readSettings(): Promise<EngineSettings> {
    return engineSettingsResult.parse(await this.#rpcOrSocket(T3_RPC.readSettings, {}, 'settings'))
  }

  async browseFolder(path: string): Promise<EngineFolderListing> {
    return browseFolderResult.parse(await this.#rpcOrSocket(T3_RPC.browseFolder, browseFolderInput.parse({ partialPath: path }), `folder ${path}`))
  }

  async lookupRepository(repository: string): Promise<EngineRepository> {
    return repositoryResult.parse(await this.#rpcOrSocket(T3_RPC.lookupRepository, lookupRepositoryInput.parse({ provider: 'github', repository }), `repository ${repository}`))
  }

  async cloneRepository(input: CloneRepositoryInput): Promise<{ cwd: string }> {
    return cloneRepositoryResult.parse(await this.#rpcOrSocket(T3_RPC.cloneRepository, cloneRepositoryInput.parse(input), `clone into ${input.destinationPath}`, 300_000))
  }

  async createProject(input: { title: string; workspaceRoot: string; createWorkspaceRootIfMissing?: boolean }): Promise<string> {
    const projectId = randomUUID()
    await this.#dispatch(projectCreateCommand.parse({
      type: 'project.create', commandId: randomUUID(), projectId, title: input.title, workspaceRoot: input.workspaceRoot,
      ...(input.createWorkspaceRootIfMissing ? { createWorkspaceRootIfMissing: true } : {}),
      createdAt: new Date(this.#now()).toISOString(),
    }))
    await this.#waitForShell((shell) => shell.projects.some((project) => project.id === projectId))
    if (!this.#shell?.projects.some((project) => project.id === projectId)) throw new Error(`The engine did not list the new project for ${input.workspaceRoot}`)
    return projectId
  }

  async actOnThread(threadId: string, action: 'archive' | 'settle' | 'unsettle' | 'delete'): Promise<void> {
    await this.#dispatch(threadActionCommand.parse({ type: `thread.${action}`, commandId: randomUUID(), threadId }))
  }

  /** Pin, snooze, and rename are T3's own commands (§5.2); the shell stream reflects them. */
  async updateThread(threadId: string, change: EngineThreadChange): Promise<void> {
    if (!this.#shell?.threads.some((thread) => thread.id === threadId)) throw new Error(`Thread was not found: ${threadId}`)
    if (change.unread !== undefined) {
      if (change.unread) this.#reading.lastVisited[threadId] = 0
      else this.#reading.lastVisited[threadId] = this.#now()
      await this.#writeReading()
      this.#publish()
    }
    if (change.pinned !== undefined) {
      await this.#dispatch(change.pinned
        ? threadPinCommand.parse({ type: 'thread.pin', commandId: randomUUID(), threadId })
        : threadUnpinCommand.parse({ type: 'thread.unpin', commandId: randomUUID(), threadId }))
    }
    if (change.snoozedUntil !== undefined) {
      await this.#dispatch(change.snoozedUntil
        ? threadSnoozeCommand.parse({ type: 'thread.snooze', commandId: randomUUID(), threadId, snoozedUntil: change.snoozedUntil })
        : threadUnsnoozeCommand.parse({ type: 'thread.unsnooze', commandId: randomUUID(), threadId, reason: 'user' }))
    }
    if (change.title !== undefined) {
      const title = change.title.trim()
      if (!title) throw new Error('A thread needs a name')
      await this.#dispatch(threadMetaUpdateCommand.parse({ type: 'thread.meta.update', commandId: randomUUID(), threadId, title }))
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const thread = this.#shell?.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Thread was not found: ${threadId}`)
    const command = turnInterruptCommand.parse({
      type: 'thread.turn.interrupt', commandId: randomUUID(), threadId,
      ...(thread.session?.activeTurnId ? { turnId: thread.session.activeTurnId } : {}),
      createdAt: new Date(this.#now()).toISOString(),
    })
    await this.#dispatch(command)
  }

  async respondApproval(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'): Promise<void> {
    await this.#dispatch(approvalRespondCommand.parse({
      type: 'thread.approval.respond', commandId: randomUUID(), threadId, requestId, decision,
      createdAt: new Date(this.#now()).toISOString(),
    }))
  }

  async respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
    await this.#dispatch(userInputRespondCommand.parse({
      type: 'thread.user-input.respond', commandId: randomUUID(), threadId, requestId, answers,
      createdAt: new Date(this.#now()).toISOString(),
    }))
  }

  /** HTTP snapshots: the initial picture and the one taken on every reconnect (§5.1). */
  async #refresh(): Promise<void> {
    if (!this.#credential) return
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = (async () => {
      try {
        const response = await this.#request(T3_HTTP.shell)
        this.#shell = shellSnapshot.parse(await response.json())
        this.#shellSequence = this.#shell.snapshotSequence
        const active = this.#reading.activeThreadId
        if (active && !this.#shell.threads.some((thread) => thread.id === active)) {
          this.#reading.activeThreadId = null
          this.#threads.delete(active)
          await this.#writeReading()
        }
        for (const id of this.#followedThreadIds()) await this.#refreshThread(id)
        this.#state = 'connected'
        this.#problem = null
      } catch (error) {
        this.#state = 'disconnected'
        this.#problem = error instanceof Error ? error.message : 'The engine is unreachable'
      } finally {
        this.#refreshing = null
        this.#publish()
      }
    })()
    return this.#refreshing
  }

  /** One socket, two subscriptions: the shell, and the active thread when there is one. */
  async #subscribe(): Promise<void> {
    if (!this.#credential) throw new Error('No engine is paired')
    const ticketResponse = await this.#fetch(`${this.#credential.server}${T3_HTTP.websocketTicket}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.#credential.accessToken}` }, signal: AbortSignal.timeout(3_000),
    })
    if (!ticketResponse.ok) throw new Error(`The engine could not authorize a live connection (${ticketResponse.status})`)
    const ticket = websocketTicketResult.parse(await ticketResponse.json())
    const socketUrl = new URL(T3_HTTP.websocket, this.#credential.server)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    socketUrl.searchParams.set('wsTicket', ticket.ticket)
    const socket = new EngineSocket({
      url: socketUrl, webSocket: this.#WebSocket, pingMs: this.#pingMs, pongTimeoutMs: this.#pongTimeoutMs,
      onClose: (reason) => this.#onSocketClosed(socket, reason),
    })
    this.#socket = socket
    await socket.open()
    this.#shellStream = await socket.stream(T3_RPC.subscribeShell, { afterSequence: this.#shellSequence, requestCompletionMarker: true }, (item) => this.#onShellItem(item), (error) => { if (error && this.#socket === socket) this.#onSocketClosed(socket, error.message) })
    await this.#subscribeThreads()
    this.#scheduleConfigRefresh()
    // Registration repeats on every reconnect; it never blocks the conversation coming up.
    void this.#registerPreviewHost(socket).catch((error: unknown) => logError('engine', 'Strata could not register as the browser host', error))
  }

  /**
   * Registers as the engine's preview automation host the way T3's desktop
   * does, over the socket Strata already holds, advertising the operations it
   * implements. The engine's environment id comes from one identity read; a
   * reconnect registers only with the identity first registered with.
   */
  async #registerPreviewHost(socket: EngineSocket): Promise<void> {
    const host = this.#previewHost
    if (!host || !this.#credential) return
    const identity = await readEngineIdentity(this.#fetch, this.#credential.server).catch(() => null)
    if (!identity) return
    if (this.#previewEnvironmentId && this.#previewEnvironmentId !== identity.environmentId) { logWarn('engine', `The engine now reports another identity (${identity.environmentId}); the browser stays registered only with ${this.#previewEnvironmentId}`); return }
    if (this.#socket !== socket || socket.closed) return
    this.#previewEnvironmentId = identity.environmentId
    this.#previewStream = await socket.stream(T3_RPC.previewAutomationConnect, { clientId: this.#previewClientId, environmentId: identity.environmentId, supportedOperations: [...host.operations] }, (item) => {
      const parsed = previewStreamEvent.safeParse(item)
      if (!parsed.success) return
      if (parsed.data.type === 'connected') { this.#previewConnectionId = parsed.data.connectionId; host.setRegistered(true); return }
      void this.#servePreviewRequest(socket, parsed.data.connectionId, parsed.data.request)
    }, () => { if (this.#socket === socket) { this.#previewStream = null; this.#previewConnectionId = null; host.setRegistered(false) } })
  }

  /** Every request carries its thread id; the host serves it and the answer goes back on the same socket. */
  async #servePreviewRequest(socket: EngineSocket, connectionId: string, request: z.infer<typeof previewStreamEvent> extends infer T ? T extends { type: 'request'; request: infer R } ? R : never : never): Promise<void> {
    const host = this.#previewHost
    if (!host) return
    const outcome = await host.handle({ requestId: request.requestId, threadId: request.threadId, ...(request.tabId !== undefined ? { tabId: request.tabId } : {}), operation: request.operation, input: request.input, timeoutMs: request.timeoutMs })
    const response = { clientId: this.#previewClientId, connectionId, requestId: request.requestId, ...(outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error }) }
    try { await socket.request(T3_RPC.previewAutomationRespond, response, 15_000) }
    catch (error) { logWarn('engine', `The engine did not take the browser answer for ${request.operation}: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** One subscription per followed thread; threads no longer followed are interrupted and forgotten. */
  async #subscribeThreads(): Promise<void> {
    const wanted = new Set(this.#followedThreadIds())
    for (const [id, entry] of [...this.#threads]) {
      if (wanted.has(id)) continue
      entry.stream?.interrupt()
      this.#threads.delete(id)
    }
    const socket = this.#socket
    if (!socket || socket.closed) return
    for (const threadId of wanted) {
      const entry = this.#threads.get(threadId) ?? { detail: null, sequence: 0, stream: null }
      this.#threads.set(threadId, entry)
      if (entry.stream) continue
      entry.stream = await socket.stream(T3_RPC.subscribeThread, { threadId, afterSequence: entry.sequence, requestCompletionMarker: true }, (item) => this.#onThreadItem(threadId, item), (error) => { if (error && this.#socket === socket) this.#onSocketClosed(socket, error.message) })
    }
  }

  #onShellItem(raw: unknown): void {
    const parsed = shellStreamItem.safeParse(raw)
    if (!parsed.success) return
    const item = parsed.data
    if (item.kind === 'synchronized') return
    if (item.kind === 'snapshot') {
      this.#shell = item.snapshot
      this.#shellSequence = item.snapshot.snapshotSequence
    } else {
      if (!this.#shell || item.sequence <= this.#shellSequence) return
      this.#shellSequence = item.sequence
      const shell = this.#shell
      if (item.kind === 'project-upserted') {
        const project = orchestrationProjectShell.safeParse((item as { project?: unknown }).project)
        if (project.success) shell.projects = [...shell.projects.filter((candidate) => candidate.id !== project.data.id), project.data]
      } else if (item.kind === 'project-removed') {
        const projectId = (item as { projectId?: unknown }).projectId
        shell.projects = shell.projects.filter((candidate) => candidate.id !== projectId)
        shell.threads = shell.threads.filter((candidate) => candidate.projectId !== projectId)
      } else if (item.kind === 'thread-upserted') {
        const thread = orchestrationThreadShell.safeParse((item as { thread?: unknown }).thread)
        if (thread.success) {
          const index = shell.threads.findIndex((candidate) => candidate.id === thread.data.id)
          shell.threads = index === -1 ? [...shell.threads, thread.data] : shell.threads.map((candidate, at) => at === index ? thread.data : candidate)
        }
      } else if (item.kind === 'thread-removed') {
        const threadId = (item as { threadId?: unknown }).threadId
        shell.threads = shell.threads.filter((candidate) => candidate.id !== threadId)
        if (typeof threadId === 'string') { this.#threads.get(threadId)?.stream?.interrupt(); this.#threads.delete(threadId) }
        if (this.#reading.activeThreadId === threadId) { this.#reading.activeThreadId = null; void this.#writeReading() }
      }
    }
    for (const waiter of [...this.#shellWaiters]) waiter()
    this.#publishSoon()
  }

  #onThreadItem(threadId: string, raw: unknown): void {
    const entry = this.#threads.get(threadId)
    if (!entry) return
    const parsed = threadStreamItem.safeParse(raw)
    if (!parsed.success) return
    const item = parsed.data
    if (item.kind === 'synchronized') return
    if (item.kind === 'snapshot') {
      if (item.snapshot.thread.id !== threadId) return
      entry.detail = item.snapshot
      entry.sequence = item.snapshot.snapshotSequence
    } else {
      const event = item.event
      if (event.sequence <= entry.sequence) return
      entry.sequence = event.sequence
      if (event.aggregateKind !== 'thread' || event.aggregateId !== threadId || !entry.detail) return
      entry.detail = { ...entry.detail, thread: this.#applyThreadEvent(entry.detail.thread, event) }
    }
    void this.#settleAcknowledgedCommands()
    this.#publishSoon()
  }

  /** Mirrors the fork's projector for the events a conversation shows (§5.1, §5.3). */
  #applyThreadEvent(thread: DetailThread, event: { type: string; sequence: number; occurredAt: string; payload: unknown }): DetailThread {
    switch (event.type) {
      case 'thread.message-sent': {
        const parsed = messageSentEvent.safeParse(event)
        if (!parsed.success) return thread
        const payload = parsed.data.payload
        const incoming = { id: payload.messageId, role: payload.role, text: payload.text, turnId: payload.turnId, streaming: payload.streaming, createdAt: payload.createdAt, updatedAt: payload.updatedAt, ...(payload.attachments ? { attachments: payload.attachments } : {}) }
        const existing = thread.messages.find((message) => message.id === incoming.id)
        const messages = existing
          ? thread.messages.map((message) => message.id !== incoming.id ? message : {
              ...message,
              text: incoming.streaming ? `${message.text}${incoming.text}` : incoming.text.length > 0 ? incoming.text : message.text,
              streaming: incoming.streaming, updatedAt: incoming.updatedAt, turnId: incoming.turnId,
              ...(incoming.attachments ? { attachments: incoming.attachments } : {}),
            })
          : [...thread.messages, incoming]
        return { ...thread, messages, updatedAt: event.occurredAt }
      }
      case 'thread.session-set': {
        const session = orchestrationSession.safeParse((event.payload as { session?: unknown } | null)?.session)
        if (!session.success) return thread
        const next = sessionApplied(thread, session.data, event.occurredAt)
        if (this.#shell) this.#shell.threads = this.#shell.threads.map((candidate) => candidate.id === thread.id ? sessionApplied(candidate, session.data, event.occurredAt) : candidate)
        return next
      }
      case 'thread.activity-appended': {
        const activity = threadActivity.safeParse((event.payload as { activity?: unknown } | null)?.activity)
        if (!activity.success) return thread
        const activities = [...thread.activities.filter((entry) => entry.id !== activity.data.id), activity.data]
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt))
          .slice(-500)
        return { ...thread, activities, updatedAt: event.occurredAt }
      }
      case 'thread.turn-diff-completed': {
        const parsed = turnDiffCompletedEvent.safeParse(event)
        if (!parsed.success) return thread
        const { threadId: _threadId, ...checkpoint } = parsed.data.payload
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId)
        if (existing && existing.status !== 'missing' && checkpoint.status === 'missing') return thread
        const checkpoints = [...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId), checkpoint].sort((a, b) => a.checkpointTurnCount - b.checkpointTurnCount)
        return { ...thread, checkpoints, updatedAt: event.occurredAt }
      }
      case 'thread.deleted':
        this.#reading.activeThreadId = null
        void this.#writeReading()
        return thread
      default:
        return { ...thread, updatedAt: event.occurredAt }
    }
  }

  #reachable(): boolean {
    return this.#state === 'connected'
  }

  #onSocketClosed(socket: EngineSocket, reason: string): void {
    if (this.#socket !== socket) return
    this.#socket = null
    this.#shellStream = null
    this.#previewStream = null
    this.#previewConnectionId = null
    this.#previewHost?.setRegistered(false)
    for (const entry of this.#threads.values()) entry.stream = null
    if (this.#configTimer) clearTimeout(this.#configTimer)
    this.#configTimer = null
    if (!this.#running) return
    this.#state = 'disconnected'
    this.#problem = reason
    this.#publish()
    this.#scheduleReconnect()
  }

  #closeSocket(): void {
    const socket = this.#socket
    this.#socket = null
    this.#shellStream = null
    this.#previewStream = null
    this.#previewConnectionId = null
    this.#previewHost?.setRegistered(false)
    for (const entry of this.#threads.values()) entry.stream = null
    socket?.close()
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer) return
    const delay = this.#reconnectDelaysMs[Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)]!
    this.#reconnectAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.reconnect()
    }, delay)
    this.#reconnectTimer.unref?.()
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
  }

  #scheduleConfigRefresh(): void {
    if (this.#configTimer) clearTimeout(this.#configTimer)
    this.#configTimer = setTimeout(() => {
      this.#configTimer = null
      if (!this.#socket || this.#socket.closed) return
      void this.#refreshConfig().then(() => { this.#publish(); this.#scheduleConfigRefresh() })
    }, this.#configRefreshMs)
    this.#configTimer.unref?.()
  }

  #publishSoon(): void {
    if (this.#publishDelayMs <= 0) { this.#publish(); return }
    if (this.#publishTimer) return
    this.#publishTimer = setTimeout(() => { this.#publishTimer = null; this.#publish() }, this.#publishDelayMs)
    this.#publishTimer.unref?.()
  }

  /**
   * Provider instances and usage come from `server.getConfig` (§5.13). Live
   * usage is folded into the persisted measurements; a failure keeps the last
   * measurement on screen and never marks the engine disconnected.
   */
  async #refreshConfig(): Promise<void> {
    this.#configFetchedAt = this.#now()
    try {
      const config = serverConfigSlice.parse(await this.#rpcOrSocket(T3_RPC.getServerConfig, {}, 'provider report'))
      this.#providers = providerInstancesOf(config)
      this.#models = config.providers.flatMap((provider) => (provider.models ?? []).map((model) => ({ instanceId: provider.instanceId, accountName: provider.displayName ?? provider.instanceId, driver: provider.driver, slug: model.slug, name: model.name, ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}), options: model.capabilities?.optionDescriptors ?? [] })))
      const next = recordMeasurements(this.#accounts, this.#providers, new Date(this.#now()).toISOString())
      if (next !== this.#accounts) {
        this.#accounts = next
        await writeAccountsStore(this.#accountsPath, this.#accounts)
      }
      this.#configProblem = null
      await this.#syncShims()
    } catch (error) {
      this.#configProblem = error instanceof Error ? error.message : 'The engine did not report its providers'
    }
  }

  async #syncShims(): Promise<void> {
    if (!this.#shimDirectory) return
    try {
      await this.#writeShims(this.#shimDirectory, terminalShimTargets(this.#accounts, this.#accountViews()), SHIM_NAMES)
    } catch (error) {
      logError('engine', 'Terminal launchers could not be written', error)
    }
  }

  async #refreshThread(threadId: string): Promise<void> {
    const response = await this.#request(T3_HTTP.thread(threadId))
    const detail = threadDetailSnapshot.parse(await response.json())
    const entry = this.#threads.get(threadId) ?? { detail: null, sequence: 0, stream: null }
    entry.detail = detail
    entry.sequence = detail.snapshotSequence
    this.#threads.set(threadId, entry)
  }

  async #request(path: string): Promise<Response> {
    if (!this.#credential) throw new Error('No engine is paired')
    const response = await this.#fetch(`${this.#credential.server}${path}`, {
      headers: { authorization: `Bearer ${this.#credential.accessToken}` },
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) throw new Error(response.status === 401 ? 'The engine pairing has expired' : `The engine returned ${response.status}`)
    return response
  }

  async #dispatch(command: unknown, key?: string, messageId?: string): Promise<void> {
    if (!this.#credential) throw new Error('No engine is paired')
    if (key && !this.#pendingCommands.some((pending) => pending.key === key)) {
      this.#pendingCommands.push({ key, command, ...(messageId ? { messageId } : {}) })
      await this.#writeCommands()
    }
    await this.#postCommand(command)
    if (!messageId && key) { this.#pendingCommands = this.#pendingCommands.filter((pending) => pending.key !== key); await this.#writeCommands() }
    // The subscriptions deliver the command's effects; nothing is polled here.
    await this.#settleAcknowledgedCommands()
  }

  async #postCommand(command: unknown): Promise<void> {
    if (!this.#credential) throw new Error('No engine is paired')
    const turn = command as { type?: string; threadId?: string; bootstrap?: unknown }
    if (turn.type === 'thread.turn.start' && turn.bootstrap) {
      // T3's HTTP handler dispatches directly to the engine. Worktree preparation
      // lives in the socket handler and may include a remote fetch.
      if (!this.#shell?.threads.find(thread => thread.id === turn.threadId)?.worktreePath) {
        dispatchResult.parse(await this.#rpcOrSocket(T3_RPC.dispatchCommand, command, 'prepare working copy', 300_000))
        return
      }
      // A refused first turn may already have prepared the worktree. Reuse it
      // instead of asking the server to create the same branch a second time.
      const { bootstrap: _, ...preparedTurn } = command as Record<string, unknown>
      command = preparedTurn
    }
    const response = await this.#fetch(`${this.#credential.server}${T3_HTTP.dispatch}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#credential.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(response.status === 401 ? 'The engine pairing has expired' : `The engine refused the command (${response.status})`)
    dispatchResult.parse(await response.json())
  }

  /** The live socket answers when it is up; otherwise a one-shot connection does. */
  async #rpcOrSocket(tag: string, payload: unknown, what: string, timeoutMs?: number): Promise<unknown> {
    if (this.#socket && !this.#socket.closed) return this.#socket.request(tag, payload, timeoutMs)
    return this.#rpc(tag, payload, what, timeoutMs)
  }

  /**
   * One request over its own T3 RPC socket: a ticket, a `Request` frame, and
   * the matching `Exit`. Uploads go this way so a large attachment never
   * blocks the subscription socket.
   */
  async #rpc(tag: string, payload: unknown, what = 'request', timeoutMs = 5_000): Promise<unknown> {
    if (!this.#credential) throw new Error('No engine is paired')
    const ticketResponse = await this.#fetch(`${this.#credential.server}${T3_HTTP.websocketTicket}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.#credential.accessToken}` }, signal: AbortSignal.timeout(3_000),
    })
    if (!ticketResponse.ok) throw new Error(`The engine could not authorize the ${what} (${ticketResponse.status})`)
    const ticket = websocketTicketResult.parse(await ticketResponse.json())
    const socketUrl = new URL(T3_HTTP.websocket, this.#credential.server)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    socketUrl.searchParams.set('wsTicket', ticket.ticket)
    return new Promise<unknown>((resolve, reject) => {
      const socket = new this.#WebSocket(socketUrl)
      const requestId = randomUUID()
      const timeout = setTimeout(() => { socket.close(); reject(new Error(`The engine ${what} timed out`)) }, timeoutMs)
      socket.addEventListener('open', () => socket.send(JSON.stringify({ _tag: 'Request', id: requestId, tag, payload, headers: [] })))
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { _tag?: string; requestId?: string; exit?: { _tag?: string; value?: unknown; cause?: unknown } }
          if (message._tag !== 'Exit' || message.requestId !== requestId) return
          clearTimeout(timeout); socket.close()
          if (message.exit?._tag !== 'Success') reject(new Error(`The engine refused the ${what}`))
          else resolve(message.exit.value)
        } catch (error) { clearTimeout(timeout); socket.close(); reject(error) }
      })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error(`The engine channel for the ${what} is unreachable`)) })
    })
  }

  /** Markdown goes up as a `file`; a staged image as an `image` with its own type, and its staged bytes leave once T3 holds them. Evidence is copied, never consumed. */
  async #uploadAttachment(attachment: PreparedAttachment): Promise<UploadedAttachment> {
    if (attachment.kind === 'evidence') {
      const evidence = await this.#evidence.read(attachment.id)
      if (!evidence) throw new MissingEvidenceError(attachment.name)
      return this.#uploadBytes({ type: 'image', name: attachment.name, mimeType: evidence.meta.mimeType, bytes: evidence.bytes })
    }
    if (attachment.kind === 'image') {
      const staged = await this.#staged.read(attachment.id)
      if (!staged) throw new MissingStagedAttachmentError(attachment.name)
      const uploaded = await this.#uploadBytes({ type: 'image', name: attachment.name, mimeType: attachment.mimeType, bytes: staged.bytes })
      await this.#staged.discard(attachment.id)
      return uploaded
    }
    const bytes = new TextEncoder().encode(attachment.text)
    if (bytes.byteLength === 0) throw new Error('A delivery attachment cannot be empty')
    return this.#uploadBytes({ type: 'file', name: attachment.name, mimeType: 'text/markdown', bytes })
  }

  async #uploadBytes(input: { type: 'file' | 'image'; name: string; mimeType: string; bytes: Uint8Array }): Promise<UploadedAttachment> {
    if (!this.#credential) throw new Error('No engine is paired')
    const upload = attachmentUploadResult.parse(await this.#rpc(T3_RPC.createAttachmentUploadUrl, { type: input.type, name: input.name, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength }, 'attachment upload'))
    const response = await this.#fetch(new URL(upload.relativeUrl, this.#credential.server), {
      method: 'PUT', headers: { 'content-type': input.mimeType, 'content-length': String(input.bytes.byteLength) }, body: new Uint8Array(input.bytes),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`The engine refused the attachment bytes (${response.status})`)
    return { type: input.type, id: upload.attachmentId, name: input.name, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength }
  }

  /** A preparation whose staged bytes are gone cannot be sent; its replies and comments return to the queue so the owner can send again. */
  async #abandonPrepared(threadId: string, messageId: string): Promise<void> {
    const state = this.#conversations.threads[threadId]
    if (!state) return
    const pending = state.pending.find((entry) => entry.deliveryId === messageId)
    for (const [id, reply] of Object.entries(pending?.replies ?? {})) state.replies[id] ??= reply
    for (const comment of state.comments ?? []) if (pending?.commentIds?.includes(comment.id) && comment.state === 'pending') comment.state = 'held'
    state.pending = state.pending.filter((entry) => entry.deliveryId !== messageId)
    state.prepared = (state.prepared ?? []).filter((entry) => entry.messageId !== messageId)
    await writeConversationsStore(this.#conversationsPath, this.#conversations)
    this.#publish()
  }

  async stageAttachment(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<{ id: string; sizeBytes: number }> {
    const record = await this.#staged.stage(input)
    return { id: record.id, sizeBytes: record.sizeBytes }
  }

  async discardAttachment(id: string): Promise<void> {
    await this.#staged.discard(id)
  }

  /** Saved preparations keep their images too; only what neither a draft nor a preparation names is deleted. */
  async retainAttachments(ids: readonly string[]): Promise<void> {
    const keep = new Set(ids)
    for (const state of Object.values(this.#conversations.threads)) for (const prepared of state.prepared ?? []) for (const attachment of prepared.attachments) if (attachment.kind === 'image' && !attachment.uploaded) keep.add(attachment.id)
    await this.#staged.sweep(keep)
  }

  async #retryPendingCommands(): Promise<void> {
    await this.#settleAcknowledgedCommands()
    const resumed = new Set<string>()
    for (const [threadId, state] of Object.entries(this.#conversations.threads)) {
      // Old stores could strand replies before a command existed. Restore only those without a command or transcript receipt.
      const stranded = state.pending.filter((entry) => !state.prepared?.some((prepared) => prepared.messageId === entry.deliveryId) && !this.#pendingCommands.some((command) => command.messageId === entry.deliveryId))
      for (const entry of stranded) for (const [id, reply] of Object.entries(entry.replies)) state.replies[id] ??= reply
      for (const comment of state.comments ?? []) if (stranded.some(entry => entry.commentIds?.includes(comment.id)) && comment.state === 'pending') comment.state = 'held'
      state.pending = state.pending.filter((entry) => !stranded.includes(entry))
      await writeConversationsStore(this.#conversationsPath, this.#conversations)
      for (const prepared of [...(state.prepared ?? [])]) {
        try { await this.#resumeDelivery(threadId, prepared.messageId); resumed.add(prepared.messageId) }
        catch (error) { logError('engine', `Delivery ${prepared.messageId} remains available for retry`, error) }
      }
    }
    for (const pending of this.#pendingCommands) if (!pending.messageId || !resumed.has(pending.messageId)) await this.#postCommand(pending.command)
    if (this.#pendingCommands.length) await this.#settleAcknowledgedCommands()
  }

  async #settleAcknowledgedCommands(): Promise<void> {
    const ids = new Set([...this.#threads.values()].flatMap((entry) => entry.detail?.thread.messages.map((message) => message.id) ?? []))
    const next = this.#pendingCommands.filter((pending) => !pending.messageId || !ids.has(pending.messageId))
    const commandsChanged = next.length !== this.#pendingCommands.length
    if (commandsChanged) this.#pendingCommands = next
    // Replies in flight become answered once the engine lists the message that carried them (§5.4).
    let repliesChanged = false
    let visualChanged = false
    for (const [threadId, entry] of this.#threads) {
      const listed = new Set(entry.detail?.thread.messages.map((message) => message.id) ?? [])
      const state = this.#conversations.threads[threadId]
      if (!state || (!state.pending.some((pending) => listed.has(pending.deliveryId)) && !state.prepared?.some((prepared) => listed.has(prepared.messageId)))) continue
      const acknowledged = state.pending.filter((pending) => listed.has(pending.deliveryId))
      // A visual revision is sent once its delivery is acknowledged; from here the agent's reply decides its state.
      for (const pending of acknowledged) for (const reference of pending.visual ?? []) {
        const comment = this.#visual.comments[reference.id]
        const revision = comment?.revisions.find((candidate) => candidate.number === reference.revision)
        if (!comment || !revision || revision.state === 'sent') continue
        revision.state = 'sent'; delete revision.error; comment.updatedAt = this.#now(); visualChanged = true
      }
      this.#conversations.threads[threadId] = {
        ...state,
        pending: state.pending.filter((pending) => !listed.has(pending.deliveryId)),
        prepared: (state.prepared ?? []).filter((prepared) => !listed.has(prepared.messageId)),
        comments: (state.comments ?? []).map(comment => ({ ...comment, state: acknowledged.some(pending => pending.commentIds?.includes(comment.id)) && comment.state === 'pending' ? 'open' : comment.state, replies: [...comment.replies, ...acknowledged.flatMap(pending => pending.replies[comment.id] ? [{ author: 'user' as const, text: pending.replies[comment.id]!.text }] : [])] })),
        outcomes: (state.outcomes ?? []).filter(outcome => !acknowledged.some(pending => pending.outcomeKeys?.includes(`${outcome.message}:${outcome.index}`))),
        answered: [...new Set([...state.answered, ...acknowledged.flatMap((pending) => pending.itemIds)])],
      }
      repliesChanged = true
    }
    if (repliesChanged || visualChanged) this.#publishSoon()
    // The in-memory state is already current; the files catch up.
    if (commandsChanged) await this.#writeCommands()
    if (repliesChanged) await writeConversationsStore(this.#conversationsPath, this.#conversations)
    if (visualChanged) await writeVisualCommentsStore(this.#visualPath, this.#visual)
  }

  #reconcilingComments = false
  async #reconcileComments(): Promise<void> {
    if (this.#reconcilingComments) return
    this.#reconcilingComments = true
    let changed = false
    let visualChanged = false
    try {
      for (const thread of this.view().projects.flatMap(project => project.threads)) {
        const state = this.#conversations.threads[thread.id] ?? emptyConversationState()
        state.comments ??= []; state.receipts ??= []; state.outcomes ??= []
        for (const message of thread.messages) {
          if (message.role !== 'assistant' || message.streaming) continue
          for (const result of parseStrataBlock(message.text)?.results ?? []) {
            const entry = result.entry
            if (result.error && result.conversationTarget) {
              const key = `${message.id}:${result.index}`
              if (!state.receipts.includes(key)) { state.receipts.push(key); state.outcomes.push({ message: message.id, index: result.index, status: 'failed', reason: result.error }); changed = true }
            }
            if (!entry || !('anchor' in entry)) continue
            const anchor = entry.anchor
            if ('item' in anchor && isVisualCommentId(anchor.item)) {
              // A reply names the revision it answers; ready asks the owner to review, and only on the latest revision does that change the card.
              const key = `${message.id}:${result.index}`
              if (state.receipts.includes(key)) continue
              let reason: string | undefined
              const target = this.#visual.comments[anchor.item]
              try {
                if (!target) throw new Error(`Visual comment ${anchor.item} was not found`)
                if (entry.verb !== 'reply') throw new Error(`Only the owner can ${entry.verb} a visual comment`)
                const revision = revisionForReply(target, entry.revision)
                if (!revision) throw new Error(`Visual comment ${anchor.item} has no revision ${entry.revision}`)
                revision.replies.push({ messageId: message.id, text: entry.text, ready: entry.ready === true, ...(entry.file ? { file: entry.file } : {}), at: this.#now() })
                target.updatedAt = this.#now()
                visualChanged = true
              } catch (error) { reason = error instanceof Error ? error.message : String(error) }
              state.receipts.push(key)
              state.outcomes.push({ message: message.id, index: result.index, status: reason ? 'failed' : 'applied', ...(reason ? { reason } : { itemId: anchor.item }) })
              changed = true
              continue
            }
            const comment = 'item' in anchor ? state.comments.find(comment => comment.id === anchor.item) : undefined
            if (!('message' in anchor) && !comment && !('item' in anchor && /^(c_|m_)/.test(anchor.item))) continue
            const key = `${message.id}:${result.index}`
            if (state.receipts.includes(key)) continue
            let itemId: string | undefined
            let reason: string | undefined
            try {
              if ('message' in anchor) {
                if (!['comment', 'question', 'decision', 'suggest'].includes(entry.verb)) throw new Error(`Unsupported message action ${entry.verb}`)
                const target = thread.messages.find(candidate => candidate.id === anchor.message)
                const block = target?.blocks?.find(block => block.id === anchor.block)
                if (!target || !block) throw new Error(`Message block ${anchor.message}/${anchor.block} was not found`)
                itemId = `m_${message.id}_${result.index}`
                if (!state.comments.some(comment => comment.id === itemId)) state.comments.push({ id: itemId, kind: entry.verb === 'suggest' ? 'suggestion' : entry.verb as MessageComment['kind'], anchor: messageAnchor(target, block.from, block.to), source: target.prose ?? target.text, selection: block.text, text: 'replacement' in entry ? entry.replacement : 'text' in entry ? entry.text : '', revision: 1, state: 'open', replies: [], ...('options' in entry ? { options: entry.options } : {}) })
              } else if (!comment) { throw new Error(`Item ${"item" in anchor ? anchor.item : "unknown"} was not found`) } else if (comment) {
                itemId = comment.id
                if (comment.state === 'held') throw new Error(`Item ${itemId} is private`)
                if (entry.verb === 'reply') comment.replies.push({ author: 'agent', text: entry.text })
                else if (entry.verb === 'resolve' && comment.id.startsWith('m_') && comment.kind !== 'decision') comment.state = 'resolved'
                else throw new Error(`Only the owner can ${entry.verb} item ${itemId}`)
              }
            } catch (error) { reason = error instanceof Error ? error.message : String(error) }
            state.receipts.push(key)
            state.outcomes.push({ message: message.id, index: result.index, status: reason ? 'failed' : 'applied', ...(reason ? { reason } : itemId ? { itemId } : {}) })
            changed = true
          }
        }
        this.#conversations.threads[thread.id] = state
      }
      if (changed) await writeConversationsStore(this.#conversationsPath, this.#conversations)
      if (visualChanged) await writeVisualCommentsStore(this.#visualPath, this.#visual)
    } finally { this.#reconcilingComments = false }
    if (changed) this.#publish()
  }

  #publish(): void {
    void this.#reconcileComments().catch(error => logError('engine', 'Could not save conversation actions', error))
    let view = this.view()
    const threads = view.projects.flatMap((project) => project.threads)
    if (this.#reachable() && this.#lastThreads.length) {
      const decision = decideAttention({ previous: this.#lastThreads, next: threads, activeThreadId: this.#reading.activeThreadId, focused: this.#isFocused() })
      if (decision.badges.length) {
        for (const badge of decision.badges) this.#reading.attention[badge.threadId] = (this.#reading.attention[badge.threadId] ?? 0) + 1
        void this.#writeReading().catch((error: unknown) => logError('engine', 'Attention counts could not be saved', error))
        for (const notification of decision.notifications) this.#notify(notification)
        view = this.view()
      }
    }
    this.#lastThreads = threads
    for (const listener of this.#listeners) listener(view)
  }

  async #writeCredential(server: string, exchange: unknown): Promise<void> {
    const token = tokenExchangeResult.parse(exchange)
    this.#credential = {
      formatVersion: 1,
      server,
      accessToken: token.access_token,
      expiresAt: this.#now() + token.expires_in * 1_000,
      scopes: token.scope.split(' ').filter(Boolean),
    }
    await atomicWriteFile(this.#credentialPath, `${JSON.stringify(this.#credential, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
    await chmod(this.#credentialPath, PRIVATE_FILE_MODE)
  }

  /**
   * Session renewal (§5.1). T3 sessions last a fixed term with no refresh grant,
   * so a client that holds `access:write` issues itself a one-time pairing
   * credential and exchanges it, exactly as the owner's link was exchanged.
   * A failure changes nothing: the current session keeps working and the next
   * check tries again. Without `access:write` the dialog says when to pair again.
   */
  async #renewIfDue(): Promise<void> {
    const credential = this.#credential
    if (!credential || !credential.scopes.includes(RENEWAL_SCOPE) || credential.expiresAt - this.#now() > RENEWAL_WINDOW_MS) return
    try {
      const issued = await this.#fetch(`${credential.server}${T3_HTTP.pairingToken}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'StrataMD', scopes: credential.scopes }),
        signal: AbortSignal.timeout(3_000),
      })
      if (!issued.ok) return
      const pairing = pairingCredentialResult.parse(await issued.json())
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: pairing.credential,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_label: 'StrataMD',
        client_device_type: 'desktop',
        client_os: assertSupportedPlatform(),
      })
      const response = await this.#fetch(`${credential.server}${T3_HTTP.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(3_000),
      })
      if (!response.ok) return
      await this.#writeCredential(credential.server, await response.json())
      this.#publish()
    } catch {
      // The current session is still valid; the next check retries.
    }
  }

  #scheduleRenewal(): void {
    if (this.#renewalTimer) clearTimeout(this.#renewalTimer)
    if (!this.#running) return
    this.#renewalTimer = setTimeout(() => {
      this.#renewalTimer = null
      void this.#renewIfDue().finally(() => this.#scheduleRenewal())
    }, RENEWAL_CHECK_MS)
    this.#renewalTimer.unref?.()
  }

  async #readCredential(): Promise<EngineCredential | null> {
    try {
      const value = JSON.parse(await readFile(this.#credentialPath, 'utf8')) as Partial<EngineCredential>
      if (value.formatVersion !== 1 || typeof value.server !== 'string' || typeof value.accessToken !== 'string' || typeof value.expiresAt !== 'number') return null
      return { formatVersion: 1, server: cleanServer(value.server), accessToken: value.accessToken, expiresAt: value.expiresAt, scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === 'string') : [] }
    } catch {
      return null
    }
  }

  async #readReading(): Promise<EngineReadingState> {
    try {
      const value = JSON.parse(await readFile(this.#readingPath, 'utf8')) as Partial<EngineReadingState>
      if (value.formatVersion !== 1 || (value.activeThreadId !== null && typeof value.activeThreadId !== 'string') || !value.lastVisited || typeof value.lastVisited !== 'object') return this.#reading
      const attention: Record<string, number> = {}
      if (value.attention && typeof value.attention === 'object') for (const [threadId, count] of Object.entries(value.attention)) if (typeof count === 'number' && count > 0) attention[threadId] = count
      return { formatVersion: 1, activeThreadId: value.activeThreadId ?? null, lastVisited: value.lastVisited as Record<string, number>, attention }
    } catch {
      return this.#reading
    }
  }

  #readingWrite: Promise<void> = Promise.resolve()
  async #writeReading(): Promise<void> {
    const bytes = `${JSON.stringify(this.#reading, null, 2)}\n`
    this.#readingWrite = this.#readingWrite.catch(() => undefined).then(() => atomicWriteFile(this.#readingPath, bytes, { mode: PRIVATE_FILE_MODE }))
    await this.#readingWrite
  }

  async #readCommands(): Promise<Array<{ key: string; command: unknown; messageId?: string }>> {
    try {
      const value = JSON.parse(await readFile(this.#commandsPath, 'utf8')) as { formatVersion?: number; pending?: unknown }
      return value.formatVersion === 1 && Array.isArray(value.pending) ? value.pending.filter((item): item is { key: string; command: unknown; messageId?: string } => typeof item === 'object' && item !== null && typeof (item as { key?: unknown }).key === 'string') : []
    } catch { return [] }
  }

  async #writeCommands(): Promise<void> {
    await atomicWriteFile(this.#commandsPath, `${JSON.stringify({ formatVersion: 1, pending: this.#pendingCommands }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
  }
}

export { EMPTY_ENGINE }

const previewRequest = z.object({ requestId: z.string().min(1), threadId: z.string().min(1), tabId: z.string().optional(), tabIdExplicit: z.boolean().optional(), operation: z.string().min(1), input: z.unknown(), timeoutMs: z.number().int().positive() }).passthrough()
const previewStreamEvent = z.union([
  z.object({ type: z.literal('connected'), connectionId: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('request'), connectionId: z.string().min(1), request: previewRequest }).passthrough(),
])

function publicOptions(options: Array<{ id: string; value?: unknown }> | undefined): ModelOption[] {
  return (options ?? []).flatMap(({ id, value }) => typeof value === 'string' || typeof value === 'boolean' ? [{ id, value }] : [])
}

/** Document deliveries carry effort separately; keep context and other saved model options. */
function turnOptions(input: ConversationInput, thread: T3ShellSnapshot['threads'][number]): ModelOption[] {
  const previous = input.model === thread.modelSelection.model ? publicOptions(thread.modelSelection.options) : []
  const effort = previous.find((option) => option.id === 'effort')?.value ?? null
  if (effort === input.effort) return previous
  return [...previous.filter((option) => option.id !== 'effort'), ...(input.effort ? [{ id: 'effort', value: input.effort }] : [])]
}
