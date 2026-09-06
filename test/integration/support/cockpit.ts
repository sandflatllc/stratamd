import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { createStrataApplication as createApplication, type ApplicationOptions, type StrataApplication } from '../../../src/main/application'
import type { EngineReadClient } from '../../../src/main/engine/client'
import type { EngineMessageView, EngineView } from '../../../src/shared/contracts'
import type { Attachment } from '../../../src/core/delivery'
import type { AnnotationLog } from '../../../src/core/annotations'
import { GhostStore } from '../../../src/main/storage'
import { SettingsStore } from '../../../src/main/settings'

/**
 * The cockpit's engine as tests see it: threads whose transcripts the test
 * writes. A delivery is a turn the application starts; the engine
 * acknowledges it by listing the delivery's message, and an agent acts by
 * posting an assistant message whose strata block Strata applies (§5.9).
 */
/** The Markdown a delivery carried: its first text attachment. */
export function deliveryText(turn: { attachments?: Array<{ kind: string; text?: string }> } | undefined): string | undefined {
  return turn?.attachments?.find((attachment) => attachment.kind === 'text')?.text
}

export class FakeEngine implements EngineReadClient {
  readonly turns: Array<{ threadId: string; input: Parameters<EngineReadClient['startTurn']>[1] }> = []
  readonly #listeners = new Set<(view: EngineView) => void>()
  readonly #threads = new Map<string, { title: string; messages: EngineMessageView[]; status: EngineView['projects'][number]['threads'][number]['status'] }>()
  #activeThreadId: string | null
  #counter = 0
  identity: string | undefined
  changeIdentity(identity: string) { this.identity = identity; this.#publish() }

  constructor(threads: ReadonlyArray<{ id: string; title: string }> = [{ id: 't1', title: 'Reviewer' }]) {
    for (const thread of threads) this.#threads.set(thread.id, { title: thread.title, messages: [], status: 'idle' })
    this.#activeThreadId = threads[0]?.id ?? null
  }

  initialize = async () => {}
  shutdown = async () => {}
  pair = async () => {}
  reconnect = async () => {}
  interrupt = async () => {}
  respondApproval = async () => {}
  respondUserInput = async () => {}
  async openThread(threadId: string) { this.#activeThreadId = threadId; this.#publish() }
  subscribe(listener: (view: EngineView) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  view(): EngineView {
    return {
      ...(this.identity ? { identity: this.identity } : {}),
      state: 'connected', server: 'http://engine.test', problem: null, credential: null, activeThreadId: this.#activeThreadId, accounts: [], terminalDefaults: {}, terminalShimDirectory: null,
      projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', threads: [...this.#threads.entries()].map(([id, thread]) => ({
        id, projectId: 'p1', title: thread.title, model: 'gpt-5.6', providerInstanceId: 'codex', effort: 'medium', access: 'full-access', status: thread.status,
        updatedAt: new Date(0).toISOString(), unread: false, pendingApprovals: false, pendingUserInput: false, activeTurnId: null, turnStartedAt: null, latestTurn: null, pinnedAt: null, snoozedUntil: null, lifecycle: 'active', archived: false, attention: 0, pendingWork: 0,
        messages: thread.messages, activities: [],
      })) }],
    }
  }

  async startTurn(threadId: string, input: Parameters<EngineReadClient['startTurn']>[1]) {
    if (!this.#threads.has(threadId)) throw new Error(`Thread was not found: ${threadId}`)
    this.turns.push({ threadId, input: structuredClone(input) })
  }

  /** Deliveries the application started for one thread, oldest first. */
  deliveries(threadId: string) {
    return this.turns.filter((turn) => turn.threadId === threadId).map((turn) => turn.input)
  }

  /** The engine lists the delivery message: Strata's acknowledgment (§5.14). */
  acknowledge(threadId: string, messageId: string, text = 'Delivery') {
    const thread = this.#threads.get(threadId)!
    if (!thread.messages.some((message) => message.id === messageId)) thread.messages = [...thread.messages, { id: messageId, role: 'user', text, turnId: `turn-${++this.#counter}`, streaming: false, createdAt: new Date(0).toISOString(), attachmentCount: 1 }]
    this.#publish()
  }

  /** Acknowledges every delivery started so far for the thread. */
  acknowledgeAll(threadId: string) {
    for (const turn of this.deliveries(threadId)) if (turn.messageId) this.acknowledge(threadId, turn.messageId, turn.text)
  }

  /** The agent replies; a strata block in the reply is what it did (§5.9). Returns the message id. */
  assistant(threadId: string, text: string, messageId = `assistant-${++this.#counter}`): string {
    const thread = this.#threads.get(threadId)!
    thread.messages = [...thread.messages, { id: messageId, role: 'assistant', text, turnId: `turn-${this.#counter}`, streaming: false, createdAt: new Date(0).toISOString(), attachmentCount: 0 }]
    this.#publish()
    return messageId
  }

  #publish() {
    const view = this.view()
    for (const listener of this.#listeners) listener(view)
  }
}

const applications: StrataApplication[] = []

export async function createStrataApplication(options: ApplicationOptions = {}): Promise<StrataApplication> {
  const app = await createApplication(options)
  applications.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.shutdown()))
})

export interface Fixture {
  root: string
  path: string
  store: GhostStore
  settingsStore: SettingsStore
  engine: FakeEngine
  app: StrataApplication
  /** A new application over the same store and engine, after shutting the current one down. */
  restart(options?: ApplicationOptions): Promise<StrataApplication>
}

export async function fixture(content = '# Plan\n\nOriginal.\n', options: { threads?: ReadonlyArray<{ id: string; title: string }>; application?: ApplicationOptions; name?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-cockpit-'))
  const path = join(root, options.name ?? 'plan.md')
  await writeFile(path, content)
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const engine = new FakeEngine(options.threads)
  const app = await createStrataApplication({ store, settingsStore, engine, watch: false, ...options.application })
  const value: Fixture = {
    root, path, store, settingsStore, engine, app,
    restart: async (extra = {}) => {
      await value.app.shutdown()
      applications.splice(applications.indexOf(value.app), 1)
      value.app = await createStrataApplication({ store, settingsStore, engine, watch: false, ...options.application, ...extra })
      return value.app
    },
  }
  return value
}

/** Attaches a thread by sending to it (§5.6) and lets the engine acknowledge that first delivery. */
export async function attach(value: Pick<Fixture, 'app' | 'engine' | 'path'>, threadId: string, options: { acknowledge?: boolean } = {}): Promise<string> {
  const [deliveryId] = await value.app.send(value.path, { recipients: [threadId], note: '', includeExternal: false })
  if (options.acknowledge !== false) {
    value.engine.acknowledge(threadId, deliveryId!)
    await settleDeliveries(value, threadId)
  }
  return deliveryId!
}

/** Waits until the thread's queue is empty (every delivery acknowledged) or the timeout passes. */
export async function settleDeliveries(value: Pick<Fixture, 'app' | 'path'>, threadId: string, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const attachment = (await value.app.getState()).activeDocument?.attachments.find((candidate) => candidate.agent.id === threadId)
    if (attachment && attachment.queuedSendCount === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * The agent posts a strata block and Strata applies it. Resolves with the
 * outcome lines Strata will report on the next delivery (§5.9), in entry order.
 */
export async function post(value: Pick<Fixture, 'app' | 'engine' | 'path' | 'store'>, threadId: string, entries: readonly unknown[], prose = 'Done.'): Promise<string[]> {
  const messageId = value.engine.assistant(threadId, `${prose}\n\n\`\`\`strata\n${JSON.stringify(entries)}\n\`\`\``)
  const until = Date.now() + 2_000
  while (Date.now() < until) {
    await value.app.flushPersistence()
    const meta = await value.store.loadMeta(value.path)
    const attachment = meta.attachments[threadId] as { processedMessageIds?: string[]; pendingBlockOutcomes?: string[] } | undefined
    if (attachment?.processedMessageIds?.includes(messageId)) return attachment.pendingBlockOutcomes ?? []
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Strata did not apply the block in ${messageId}`)
}

export interface StoredApplication {
  state: { shadow: string; ghost: string; pendingHunks: readonly unknown[] }
  annotations: AnnotationLog
  attachments: Record<string, Attachment>
}

/** The persisted form the next run would read, with delivery payloads hydrated from their blobs. */
export async function storedApplication(store: GhostStore, path: string): Promise<StoredApplication> {
  await Promise.all(applications.map((app) => app.flushPersistence()))
  const meta = await store.loadMeta(path)
  const attachments: Record<string, Attachment> = {}
  for (const [id, stored] of Object.entries(meta.attachments)) {
    const deliveries = await Promise.all(stored.deliveries.map(async (delivery) => {
      const { payloadBlob, ...rest } = delivery as typeof delivery & { payload?: unknown }
      const payload = payloadBlob ? JSON.parse(await store.getObjectText(payloadBlob)) as unknown : rest.payload
      return { ...rest, payload } as unknown as Attachment['deliveries'][number]
    }))
    attachments[id] = { ...(stored as unknown as Attachment), deliveries }
  }
  return {
    state: {
      shadow: meta.shadowBlob ? await store.getObjectText(meta.shadowBlob) : ((await store.readBuffer(path))?.toString('utf8') ?? ''),
      ghost: await store.getObjectText(meta.ghostBlob),
      pendingHunks: meta.pendingHunks,
    },
    annotations: { annotations: meta.annotations as AnnotationLog['annotations'], events: meta.annotationEvents as AnnotationLog['events'], nextSeq: meta.nextAnnotationSeq as number },
    attachments,
  }
}

/** The queued delivery payloads for one thread, oldest first, without touching the document blobs. */
export async function deliveryPayloads(store: GhostStore, path: string, threadId: string): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  await Promise.all(applications.map((app) => app.flushPersistence()))
  const meta = await store.loadMeta(path)
  const stored = meta.attachments[threadId]
  if (!stored) return []
  return Promise.all(stored.deliveries.map(async (delivery) => {
    const { payloadBlob, ...rest } = delivery as typeof delivery & { payload?: unknown }
    const payload = (payloadBlob ? JSON.parse(await store.getObjectText(payloadBlob)) : rest.payload) as Record<string, unknown>
    return { id: delivery.id, payload }
  }))
}

/** The block id the delivery printed for a line that contains `text`. */
export function blockIdFor(deliveryText: string, text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^- (b[0-9a-f]+): .*${escaped}`, 'mu').exec(deliveryText)
  if (!match) throw new Error(`No block carries ${JSON.stringify(text)} in:\n${deliveryText}`)
  return match[1]!
}
