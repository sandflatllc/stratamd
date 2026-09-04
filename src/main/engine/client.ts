import { chmod, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { atomicWriteFile, PRIVATE_FILE_MODE } from '../storage'
import {
  shellSnapshot,
  threadDetailSnapshot,
  tokenExchangeResult,
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
  T3_CONTRACT_REVISION,
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
import { applyConversationState, emptyConversationState, readConversationsStore, renderItemReplies, writeConversationsStore, type ConversationsStore } from './conversation-state'
import { accountViews, chooseInstance, emptyAccountsStore, providerInstancesOf, readAccountsStore, recordMeasurements, terminalShimTargets, writeAccountsStore, type AccountsStore, type EngineProviderInstance } from './accounts'
import { writeTerminalShims } from '../account-shims'
import { logError } from '../log'
import type { EngineProjectView, EngineThreadChange, EngineThreadView, EngineView } from '../../shared/contracts'
import { assertSupportedPlatform } from '../../platform/runtime'
import { mapMarkdownBlocks, parseStrataBlock } from '../../core/blocks'
import { postedMessageItems } from '../../core/items'
import { inferredMessageItems } from '../../core/inference'

export const T3_SUPPORTED_VERSION = '0.0.33'

interface EngineCredential {
  formatVersion: 1
  server: string
  accessToken: string
  expiresAt: number
}

interface EngineReadingState {
  formatVersion: 1
  activeThreadId: string | null
  lastVisited: Record<string, number>
  /** Badge counts per thread (§5.2), cleared when the thread opens. */
  attention: Record<string, number>
}

export interface EngineNotification { threadId: string; title: string; body: string }

export interface EngineClientOptions {
  dataDirectory: string
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
  startTurn(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access']; messageId?: string; commandId?: string; attachment?: { name: string; text: string } }): Promise<void>
  interrupt(threadId: string): Promise<void>
  respondApproval(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'): Promise<void>
  respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>
  createThread?(input: { projectId: string; title: string; model: string; effort: string | null; access: EngineThreadView['access']; instanceId?: string | null }): Promise<string>
  createProject?(input: { title: string; workspaceRoot: string }): Promise<string>
  actOnThread?(threadId: string, action: 'archive' | 'settle' | 'delete'): Promise<void>
  updateThread?(threadId: string, change: EngineThreadChange): Promise<void>
  queueItemReply?(threadId: string, itemId: string, text: string): Promise<void>
  discardItemReply?(threadId: string, itemId: string): Promise<void>
  dismissItem?(threadId: string, itemId: string): Promise<void>
  parkAccount?(instanceId: string, parked: boolean): Promise<void>
  setTerminalDefault?(driver: string, selection: string | null): Promise<void>
  refreshAccounts?(): Promise<void>
}

const EMPTY_ENGINE: EngineView = {
  state: 'unpaired',
  server: null,
  serverVersion: null,
  supportedVersion: T3_SUPPORTED_VERSION,
  problem: null,
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

function cleanServer(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The engine address must use http or https')
  return url.origin
}

function effortOf(thread: T3ShellSnapshot['threads'][number]): string | null {
  const value = thread.modelSelection.options?.effort ?? thread.modelSelection.options?.reasoningEffort
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
  #conversations: ConversationsStore = { formatVersion: 1, threads: {} }
  readonly #WebSocket: typeof WebSocket
  readonly #configRefreshMs: number
  readonly #shimDirectory: string | null
  readonly #writeShims: typeof writeTerminalShims
  #accounts: AccountsStore = emptyAccountsStore()
  #providers: EngineProviderInstance[] = []
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
  #serverVersion: string | null = null
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
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectAttempt = 0
  #publishTimer: ReturnType<typeof setTimeout> | null = null
  #configTimer: ReturnType<typeof setTimeout> | null = null
  #connecting: Promise<void> | null = null
  readonly #shellWaiters = new Set<() => void>()

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
    this.#WebSocket = options.webSocket ?? WebSocket
    this.#configRefreshMs = options.configRefreshMs ?? 30_000
    this.#shimDirectory = options.terminalShimDirectory ?? null
    this.#writeShims = options.writeShims ?? writeTerminalShims
  }

  async initialize(): Promise<void> {
    this.#credential = await this.#readCredential()
    this.#reading = await this.#readReading()
    this.#pendingCommands = await this.#readCommands()
    this.#accounts = await readAccountsStore(this.#accountsPath)
    this.#conversations = await readConversationsStore(this.#conversationsPath)
    if (!this.#credential) return
    this.#running = true
    await this.reconnect()
    await this.#retryPendingCommands()
  }

  async shutdown(): Promise<void> {
    this.#running = false
    this.#clearReconnect()
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
      threads: (this.#shell?.threads ?? []).filter((thread) => thread.projectId === project.id).map((thread) => {
        const detailThread = this.#threads.get(thread.id)?.detail?.thread
        const messages = detailThread?.id === thread.id ? detailThread.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          turnId: message.turnId,
          streaming: message.streaming,
          createdAt: message.createdAt,
          attachmentCount: message.attachments?.length ?? 0,
          ...(!message.streaming && message.role === 'assistant' ? (() => { const prose = parseStrataBlock(message.text)?.prose ?? message.text; return { prose, blocks: mapMarkdownBlocks(`message:${message.id}`, prose).blocks } })() : {}),
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
        const visited = this.#reading.lastVisited[thread.id] ?? 0
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
          effort: effortOf(thread),
          access: thread.runtimeMode,
          status: statusOf(thread),
          updatedAt: thread.updatedAt,
          unread: Date.parse(thread.updatedAt) > visited && thread.id !== this.#reading.activeThreadId,
          pinnedAt: thread.pinnedAt ?? null,
          snoozedUntil: thread.snoozedUntil ?? null,
          attention: this.#reading.attention[thread.id] ?? 0,
          pendingWork: 0,
          pendingApprovals: thread.hasPendingApprovals,
          pendingUserInput: thread.hasPendingUserInput,
          activeTurnId: thread.session?.activeTurnId ?? null,
          turnStartedAt: typeof latestTurn?.startedAt === 'string'
            ? latestTurn.startedAt
            : typeof latestTurn?.requestedAt === 'string' ? latestTurn.requestedAt : null,
          messages,
          activities,
          items: (() => { const explicit = postedMessageItems(messages, thread.id); return applyConversationState([...explicit, ...messages.flatMap((message) => inferredMessageItems(message, thread.id, explicit))], this.#conversations.threads[thread.id]) })(),
          documents,
        }
      }),
    }))
    return {
      state: this.#state,
      server: this.#credential?.server ?? null,
      serverVersion: this.#serverVersion,
      supportedVersion: T3_SUPPORTED_VERSION,
      problem: this.#problem,
      projects,
      activeThreadId: this.#reading.activeThreadId,
      accounts: this.#accountViews(),
      terminalDefaults: { ...this.#accounts.terminalDefaults },
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
      scope: 'orchestration:read orchestration:operate',
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
    const token = tokenExchangeResult.parse(await response.json())
    this.#credential = {
      formatVersion: 1,
      server: origin,
      accessToken: token.access_token,
      expiresAt: this.#now() + token.expires_in * 1_000,
    }
    await atomicWriteFile(this.#credentialPath, `${JSON.stringify(this.#credential, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
    await chmod(this.#credentialPath, PRIVATE_FILE_MODE)
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
      try {
        await this.#subscribe()
        this.#reconnectAttempt = 0
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

  /** The active thread plus every watched thread the shell still lists. */
  #followedThreadIds(): string[] {
    const ids = new Set<string>(this.#watched)
    if (this.#reading.activeThreadId) ids.add(this.#reading.activeThreadId)
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

  async startTurn(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access']; messageId?: string; commandId?: string; attachment?: { name: string; text: string } }): Promise<void> {
    const thread = this.#shell?.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Thread was not found: ${threadId}`)
    // A conversation Send carries the queued item replies as its attachment (§5.4), keyed by item id; the text stays the owner's note.
    const state = this.#conversations.threads[threadId]
    const queued = !input.attachment && state && Object.keys(state.replies).length > 0 ? state.replies : null
    const messageId = input.messageId ?? randomUUID()
    const text = input.text.trim() || (queued ? `Replies to ${Object.keys(queued).length} item${Object.keys(queued).length === 1 ? '' : 's'}.` : '')
    if (!text) throw new Error('Write a message or queue a reply before sending')
    const attachment = input.attachment ?? (queued ? { name: `replies-${messageId}.md`, text: renderItemReplies(queued) } : undefined)
    if (queued) {
      this.#conversations.threads[threadId] = { ...state!, replies: {}, pending: [...state!.pending, { deliveryId: messageId, itemIds: Object.keys(queued), replies: queued }] }
      await writeConversationsStore(this.#conversationsPath, this.#conversations)
      this.#publish()
    }
    const attachments = attachment ? [await this.#uploadTextAttachment(attachment)] : []
    const command = turnStartCommand.parse({
      type: 'thread.turn.start', commandId: input.commandId ?? (queued ? `strata-${messageId}` : randomUUID()), threadId, createdAt: new Date(this.#now()).toISOString(),
      message: { messageId, role: 'user', text, attachments },
      modelSelection: { instanceId: thread.modelSelection.instanceId, model: input.model, options: input.effort ? { effort: input.effort } : {} },
      runtimeMode: input.access, interactionMode: thread.interactionMode,
    })
    await this.#dispatch(command, `turn:${command.message.messageId}`, command.message.messageId)
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

  async createThread(input: { projectId: string; title: string; model: string; effort: string | null; access: EngineThreadView['access']; instanceId?: string | null }): Promise<string> {
    if (!this.#shell?.projects.some((project) => project.id === input.projectId)) throw new Error(`Project was not found: ${input.projectId}`)
    const threadId = randomUUID()
    const instanceId = await this.#resolveInstance(input.projectId, input.instanceId ?? null)
    await this.#dispatch(threadCreateCommand.parse({ type: 'thread.create', commandId: randomUUID(), threadId, projectId: input.projectId, title: input.title,
      modelSelection: { instanceId, model: input.model, options: input.effort ? { effort: input.effort } : {} }, runtimeMode: input.access,
      interactionMode: 'default', branch: null, worktreePath: null, createdAt: new Date(this.#now()).toISOString() }))
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

  async createProject(input: { title: string; workspaceRoot: string }): Promise<string> {
    const projectId = randomUUID()
    await this.#dispatch(projectCreateCommand.parse({
      type: 'project.create', commandId: randomUUID(), projectId, title: input.title, workspaceRoot: input.workspaceRoot,
      createdAt: new Date(this.#now()).toISOString(),
    }))
    await this.#waitForShell((shell) => shell.projects.some((project) => project.id === projectId))
    if (!this.#shell?.projects.some((project) => project.id === projectId)) throw new Error(`The engine did not list the new project for ${input.workspaceRoot}`)
    return projectId
  }

  async actOnThread(threadId: string, action: 'archive' | 'settle' | 'delete'): Promise<void> {
    await this.#dispatch(threadActionCommand.parse({ type: `thread.${action}`, commandId: randomUUID(), threadId }))
  }

  /** Pin, snooze, and rename are T3's own commands (§5.2); the shell stream reflects them. */
  async updateThread(threadId: string, change: EngineThreadChange): Promise<void> {
    if (!this.#shell?.threads.some((thread) => thread.id === threadId)) throw new Error(`Thread was not found: ${threadId}`)
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
        this.#serverVersion = response.headers.get('x-t3-version') ?? response.headers.get('server-version')
        this.#shell = shellSnapshot.parse(await response.json())
        this.#shellSequence = this.#shell.snapshotSequence
        const active = this.#reading.activeThreadId
        if (active && !this.#shell.threads.some((thread) => thread.id === active)) {
          this.#reading.activeThreadId = null
          this.#threads.delete(active)
          await this.#writeReading()
        }
        for (const id of this.#followedThreadIds()) await this.#refreshThread(id)
        this.#state = this.#serverVersion && this.#serverVersion !== T3_SUPPORTED_VERSION ? 'mismatch' : 'connected'
        this.#problem = this.#state === 'mismatch'
          ? `Server ${this.#serverVersion} is outside the tested ${T3_SUPPORTED_VERSION} contract (${T3_CONTRACT_REVISION.slice(0, 8)}).`
          : null
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
    return this.#state === 'connected' || this.#state === 'mismatch'
  }

  #onSocketClosed(socket: EngineSocket, reason: string): void {
    if (this.#socket !== socket) return
    this.#socket = null
    this.#shellStream = null
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
  async #rpcOrSocket(tag: string, payload: unknown, what: string): Promise<unknown> {
    if (this.#socket && !this.#socket.closed) return this.#socket.request(tag, payload)
    return this.#rpc(tag, payload, what)
  }

  /**
   * One request over its own T3 RPC socket: a ticket, a `Request` frame, and
   * the matching `Exit`. Uploads go this way so a large attachment never
   * blocks the subscription socket.
   */
  async #rpc(tag: string, payload: unknown, what = 'request'): Promise<unknown> {
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
      const timeout = setTimeout(() => { socket.close(); reject(new Error(`The engine ${what} timed out`)) }, 5_000)
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

  async #uploadTextAttachment(input: { name: string; text: string }): Promise<{ type: 'file'; id: string; name: string; mimeType: string; sizeBytes: number }> {
    if (!this.#credential) throw new Error('No engine is paired')
    const bytes = new TextEncoder().encode(input.text)
    if (bytes.byteLength === 0) throw new Error('A delivery attachment cannot be empty')
    const upload = attachmentUploadResult.parse(await this.#rpc(T3_RPC.createAttachmentUploadUrl, { type: 'file', name: input.name, mimeType: 'text/markdown', sizeBytes: bytes.byteLength }, 'attachment upload'))
    const response = await this.#fetch(new URL(upload.relativeUrl, this.#credential.server), {
      method: 'PUT', headers: { 'content-type': 'text/markdown', 'content-length': String(bytes.byteLength) }, body: bytes,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`The engine refused the attachment bytes (${response.status})`)
    return { type: 'file', id: upload.attachmentId, name: input.name, mimeType: 'text/markdown', sizeBytes: bytes.byteLength }
  }

  async #retryPendingCommands(): Promise<void> {
    for (const pending of this.#pendingCommands) await this.#postCommand(pending.command)
    if (this.#pendingCommands.length) await this.#settleAcknowledgedCommands()
  }

  async #settleAcknowledgedCommands(): Promise<void> {
    const ids = new Set([...this.#threads.values()].flatMap((entry) => entry.detail?.thread.messages.map((message) => message.id) ?? []))
    const next = this.#pendingCommands.filter((pending) => !pending.messageId || !ids.has(pending.messageId))
    const commandsChanged = next.length !== this.#pendingCommands.length
    if (commandsChanged) this.#pendingCommands = next
    // Replies in flight become answered once the engine lists the message that carried them (§5.4).
    let repliesChanged = false
    for (const [threadId, entry] of this.#threads) {
      const listed = new Set(entry.detail?.thread.messages.map((message) => message.id) ?? [])
      const state = this.#conversations.threads[threadId]
      if (!state || !state.pending.some((pending) => listed.has(pending.deliveryId))) continue
      const acknowledged = state.pending.filter((pending) => listed.has(pending.deliveryId))
      this.#conversations.threads[threadId] = {
        ...state,
        pending: state.pending.filter((pending) => !listed.has(pending.deliveryId)),
        answered: [...new Set([...state.answered, ...acknowledged.flatMap((pending) => pending.itemIds)])],
      }
      repliesChanged = true
    }
    if (repliesChanged) this.#publishSoon()
    // The in-memory state is already current; the files catch up.
    if (commandsChanged) await this.#writeCommands()
    if (repliesChanged) await writeConversationsStore(this.#conversationsPath, this.#conversations)
  }

  #publish(): void {
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

  async #readCredential(): Promise<EngineCredential | null> {
    try {
      const value = JSON.parse(await readFile(this.#credentialPath, 'utf8')) as Partial<EngineCredential>
      if (value.formatVersion !== 1 || typeof value.server !== 'string' || typeof value.accessToken !== 'string' || typeof value.expiresAt !== 'number') return null
      return { formatVersion: 1, server: cleanServer(value.server), accessToken: value.accessToken, expiresAt: value.expiresAt }
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

  async #writeReading(): Promise<void> {
    await atomicWriteFile(this.#readingPath, `${JSON.stringify(this.#reading, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
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
