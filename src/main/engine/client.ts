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
  approvalRespondCommand,
  userInputRespondCommand,
  dispatchResult,
  T3_CONTRACT_REVISION,
  T3_HTTP,
  T3_RPC,
  serverConfigSlice,
  type T3ShellSnapshot,
  type T3ThreadDetailSnapshot,
} from './t3-contract'
import { accountViews, chooseInstance, emptyAccountsStore, providerInstancesOf, readAccountsStore, recordMeasurements, terminalShimTargets, writeAccountsStore, type AccountsStore, type EngineProviderInstance } from './accounts'
import { writeTerminalShims } from '../account-shims'
import { logError } from '../log'
import type { EngineProjectView, EngineThreadView, EngineView } from '../../shared/contracts'
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
}

export interface EngineClientOptions {
  dataDirectory: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  pollMs?: number
  webSocket?: typeof WebSocket
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
  startTurn(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access']; messageId?: string; commandId?: string; attachment?: { name: string; text: string } }): Promise<void>
  interrupt(threadId: string): Promise<void>
  respondApproval(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'): Promise<void>
  respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>
  createThread?(input: { projectId: string; title: string; model: string; effort: string | null; access: EngineThreadView['access']; instanceId?: string | null }): Promise<string>
  createProject?(input: { title: string; workspaceRoot: string }): Promise<string>
  actOnThread?(threadId: string, action: 'archive' | 'settle' | 'delete'): Promise<void>
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
  readonly #pollMs: number
  readonly #credentialPath: string
  readonly #readingPath: string
  readonly #commandsPath: string
  readonly #accountsPath: string
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
  #reading: EngineReadingState = { formatVersion: 1, activeThreadId: null, lastVisited: {} }
  #shell: T3ShellSnapshot | null = null
  #detail: T3ThreadDetailSnapshot | null = null
  #state: EngineView['state'] = 'unpaired'
  #problem: string | null = null
  #serverVersion: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #running = false
  #polling: Promise<void> | null = null
  #pendingCommands: Array<{ key: string; command: unknown; messageId?: string }> = []

  constructor(options: EngineClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#pollMs = options.pollMs ?? 400
    this.#credentialPath = join(options.dataDirectory, 'engine-credential.json')
    this.#readingPath = join(options.dataDirectory, 'engine-reading.json')
    this.#commandsPath = join(options.dataDirectory, 'engine-commands.json')
    this.#accountsPath = join(options.dataDirectory, 'engine-accounts.json')
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
    if (!this.#credential) return
    this.#running = true
    await this.reconnect()
    await this.#retryPendingCommands()
  }

  async shutdown(): Promise<void> {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    await this.#polling
  }

  subscribe(listener: (view: EngineView) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  view(): EngineView {
    const detailThread = this.#detail?.thread
    const projects: EngineProjectView[] = (this.#shell?.projects ?? []).map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      threads: (this.#shell?.threads ?? []).filter((thread) => thread.projectId === project.id).map((thread) => {
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
          pendingApprovals: thread.hasPendingApprovals,
          pendingUserInput: thread.hasPendingUserInput,
          activeTurnId: thread.session?.activeTurnId ?? null,
          turnStartedAt: typeof latestTurn?.startedAt === 'string'
            ? latestTurn.startedAt
            : typeof latestTurn?.requestedAt === 'string' ? latestTurn.requestedAt : null,
          messages,
          activities,
          items: (() => { const explicit = postedMessageItems(messages, thread.id); return [...explicit, ...messages.flatMap((message) => inferredMessageItems(message, thread.id, explicit))] })(),
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
    await this.#rpc(T3_RPC.refreshProviders, {}, 'provider refresh').catch(() => undefined)
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

  async reconnect(): Promise<void> {
    if (!this.#credential) {
      this.#state = 'unpaired'
      this.#publish()
      return
    }
    this.#state = 'connecting'
    this.#problem = null
    this.#publish()
    await this.#refresh()
    this.#schedule()
  }

  async openThread(threadId: string): Promise<void> {
    const known = this.#shell?.threads.some((thread) => thread.id === threadId)
    if (!known) throw new Error(`Thread was not found: ${threadId}`)
    this.#reading.activeThreadId = threadId
    this.#reading.lastVisited[threadId] = this.#now()
    await this.#writeReading()
    await this.#refreshThread(threadId)
    this.#publish()
  }

  async startTurn(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access']; messageId?: string; commandId?: string; attachment?: { name: string; text: string } }): Promise<void> {
    const thread = this.#shell?.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Thread was not found: ${threadId}`)
    const attachments = input.attachment ? [await this.#uploadTextAttachment(input.attachment)] : []
    const command = turnStartCommand.parse({
      type: 'thread.turn.start', commandId: input.commandId ?? randomUUID(), threadId, createdAt: new Date(this.#now()).toISOString(),
      message: { messageId: input.messageId ?? randomUUID(), role: 'user', text: input.text.trim(), attachments },
      modelSelection: { instanceId: thread.modelSelection.instanceId, model: input.model, options: input.effort ? { effort: input.effort } : {} },
      runtimeMode: input.access, interactionMode: thread.interactionMode,
    })
    await this.#dispatch(command, `turn:${command.message.messageId}`, command.message.messageId)
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
    if (!this.#shell?.projects.some((project) => project.id === projectId)) throw new Error(`The engine did not list the new project for ${input.workspaceRoot}`)
    return projectId
  }

  async actOnThread(threadId: string, action: 'archive' | 'settle' | 'delete'): Promise<void> {
    await this.#dispatch(threadActionCommand.parse({ type: `thread.${action}`, commandId: randomUUID(), threadId }))
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

  async #refresh(): Promise<void> {
    if (!this.#credential) return
    if (this.#polling) return this.#polling
    this.#polling = (async () => {
      try {
        const response = await this.#request(T3_HTTP.shell)
        this.#serverVersion = response.headers.get('x-t3-version') ?? response.headers.get('server-version')
        this.#shell = shellSnapshot.parse(await response.json())
        const active = this.#reading.activeThreadId
        if (active && this.#shell.threads.some((thread) => thread.id === active)) await this.#refreshThread(active)
        else if (active) {
          this.#reading.activeThreadId = null
          this.#detail = null
          await this.#writeReading()
        }
        this.#state = this.#serverVersion && this.#serverVersion !== T3_SUPPORTED_VERSION ? 'mismatch' : 'connected'
        this.#problem = this.#state === 'mismatch'
          ? `Server ${this.#serverVersion} is outside the tested ${T3_SUPPORTED_VERSION} contract (${T3_CONTRACT_REVISION.slice(0, 8)}).`
          : null
        if (this.#now() - this.#configFetchedAt >= this.#configRefreshMs) await this.#refreshConfig()
      } catch (error) {
        this.#state = 'disconnected'
        this.#problem = error instanceof Error ? error.message : 'The engine is unreachable'
      } finally {
        this.#polling = null
        this.#publish()
      }
    })()
    return this.#polling
  }

  /**
   * Provider instances and usage come from `server.getConfig` (§5.13). Live
   * usage is folded into the persisted measurements; a failure keeps the last
   * measurement on screen and never marks the engine disconnected.
   */
  async #refreshConfig(): Promise<void> {
    this.#configFetchedAt = this.#now()
    try {
      const config = serverConfigSlice.parse(await this.#rpc(T3_RPC.getServerConfig, {}))
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
    this.#detail = threadDetailSnapshot.parse(await response.json())
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
    await this.#refresh()
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

  /**
   * One request over T3's Effect RPC socket: a ticket, a `Request` frame, and
   * the matching `Exit`. Uploads and the server config both go this way.
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
    if (this.#pendingCommands.length) { await this.#refresh(); await this.#settleAcknowledgedCommands() }
  }

  async #settleAcknowledgedCommands(): Promise<void> {
    const ids = new Set(this.#detail?.thread.messages.map((message) => message.id) ?? [])
    const next = this.#pendingCommands.filter((pending) => !pending.messageId || !ids.has(pending.messageId))
    if (next.length === this.#pendingCommands.length) return
    this.#pendingCommands = next
    await this.#writeCommands()
  }

  #schedule(): void {
    if (!this.#running) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#refresh().finally(() => this.#schedule())
    }, this.#pollMs)
    this.#timer.unref?.()
  }

  #publish(): void {
    const view = this.view()
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
      return { formatVersion: 1, activeThreadId: value.activeThreadId ?? null, lastVisited: value.lastVisited as Record<string, number> }
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
