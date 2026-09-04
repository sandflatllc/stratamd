import { chmod, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteFile, PRIVATE_FILE_MODE } from '../storage'
import {
  shellSnapshot,
  threadDetailSnapshot,
  tokenExchangeResult,
  turnStartCommand,
  turnInterruptCommand,
  approvalRespondCommand,
  userInputRespondCommand,
  dispatchResult,
  T3_CONTRACT_REVISION,
  T3_HTTP,
  type T3ShellSnapshot,
  type T3ThreadDetailSnapshot,
} from './t3-contract'
import type { EngineProjectView, EngineThreadView, EngineView } from '../../shared/contracts'
import { assertSupportedPlatform } from '../../platform/runtime'

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
}

export interface EngineReadClient {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  view(): EngineView
  subscribe(listener: (view: EngineView) => void): () => void
  pair(server: string, pairingCode: string): Promise<void>
  reconnect(): Promise<void>
  openThread(threadId: string): Promise<void>
  startTurn(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access'] }): Promise<void>
  interrupt(threadId: string): Promise<void>
  respondApproval(threadId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'): Promise<void>
  respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>
}

const EMPTY_ENGINE: EngineView = {
  state: 'unpaired',
  server: null,
  serverVersion: null,
  supportedVersion: T3_SUPPORTED_VERSION,
  problem: null,
  projects: [],
  activeThreadId: null,
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
  readonly #pollMs: number
  readonly #credentialPath: string
  readonly #readingPath: string
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

  constructor(options: EngineClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#pollMs = options.pollMs ?? 400
    this.#credentialPath = join(options.dataDirectory, 'engine-credential.json')
    this.#readingPath = join(options.dataDirectory, 'engine-reading.json')
  }

  async initialize(): Promise<void> {
    this.#credential = await this.#readCredential()
    this.#reading = await this.#readReading()
    if (!this.#credential) return
    this.#running = true
    await this.reconnect()
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
    }
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

  async startTurn(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access'] }): Promise<void> {
    const thread = this.#shell?.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error(`Thread was not found: ${threadId}`)
    const command = turnStartCommand.parse({
      type: 'thread.turn.start', commandId: randomUUID(), threadId, createdAt: new Date(this.#now()).toISOString(),
      message: { messageId: randomUUID(), role: 'user', text: input.text.trim(), attachments: [] },
      modelSelection: { instanceId: thread.modelSelection.instanceId, model: input.model, options: input.effort ? { effort: input.effort } : {} },
      runtimeMode: input.access, interactionMode: thread.interactionMode,
    })
    await this.#dispatch(command)
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

  async #dispatch(command: unknown): Promise<void> {
    if (!this.#credential) throw new Error('No engine is paired')
    const response = await this.#fetch(`${this.#credential.server}${T3_HTTP.dispatch}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#credential.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(response.status === 401 ? 'The engine pairing has expired' : `The engine refused the command (${response.status})`)
    dispatchResult.parse(await response.json())
    await this.#refresh()
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
}

export { EMPTY_ENGINE }
