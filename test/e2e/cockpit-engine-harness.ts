import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { Scenario } from './harness'

const at = '2026-09-03T12:00:00.000Z'

export interface FakeEngineOptions {
  /** The one-time codes the fake accepts at the token endpoint; each returns a session token derived from it. */
  pairingCodes?: string[]
  /** The workspace root of the one seeded project; a scenario's document folder makes it the containing project (§5.7). */
  workspaceRoot?: string
  /** Provider instances `server.getConfig` reports (§5.13); defaults to a Codex account with usage and a Claude account without. */
  providers?: unknown[]
  /** Titles for the seeded threads `t1` and `t2`, when a test reads better with agent names. */
  titles?: Partial<Record<'t1' | 't2', string>>
  /** Seeds two projects and active, pinned, settled, and snoozed rows for the Projects parity scenario. */
  projectsParity?: boolean
  /** Seeds two completed turns before the running turn for the Conversation parity scenario. */
  conversationParity?: boolean
}

const usageAt = '2026-09-03T11:59:00.000Z'
export const DEFAULT_PROVIDERS: unknown[] = [
  { instanceId: 'codex', driver: 'codex', displayName: 'Codex work', enabled: true, installed: true, version: '0.50.0', status: 'ready', auth: { status: 'authenticated', type: 'chatgpt', label: 'Pro', email: 'owner@example.com' }, checkedAt: usageAt, models: [], usage: { session: { usedPercent: 40, resetsAt: '2026-09-03T16:00:00.000Z', measuredAt: usageAt, source: 'session' }, weekly: { usedPercent: 20, resetsAt: '2026-09-08T00:00:00.000Z', measuredAt: usageAt, source: 'session' }, planLabel: 'Pro', applicable: true } },
  { instanceId: 'claude-main', driver: 'claudeAgent', displayName: 'Claude', enabled: true, installed: true, version: '2.1.0', status: 'ready', auth: { status: 'authenticated', type: 'oauth', label: 'Max' }, checkedAt: usageAt, models: [] },
]

/** One text frame, server to client (unmasked). */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : payload.length < 65_536
      ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b })()])
  return Buffer.concat([header, payload])
}

/** Parses complete client frames from `buffer`; returns them and the unread remainder. */
function readFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f
    const masked = (buffer[offset + 1]! & 0x80) !== 0
    let length = buffer[offset + 1]! & 0x7f
    let cursor = offset + 2
    if (length === 126) { if (buffer.length < cursor + 2) break; length = buffer.readUInt16BE(cursor); cursor += 2 }
    else if (length === 127) { if (buffer.length < cursor + 8) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8 }
    const maskLength = masked ? 4 : 0
    if (buffer.length < cursor + maskLength + length) break
    const mask = buffer.subarray(cursor, cursor + maskLength); cursor += maskLength
    const payload = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) payload[index] = masked ? buffer[cursor + index]! ^ mask[index % 4]! : buffer[cursor + index]!
    frames.push({ opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) }
}

interface CreatedThread { id: string; projectId: string; title: string; modelSelection: unknown; runtimeMode: string }
interface CreatedProject { id: string; title: string; workspaceRoot: string }
interface Subscription { requestId: string; tag: string; threadId: string | null }
interface Connection { socket: Socket; subscriptions: Subscription[] }

export interface FakeEngine {
  server: Server
  origin: string
  commands: Array<Record<string, unknown>>
  uploads: string[]
  /** Upload text by attachment id, so a turn's attachment can be read back regardless of upload order. */
  uploadsById: Map<string, string>
  tokenRequests: string[]
  rpcRequests: Array<{ tag: string; payload: unknown }>
  /** Offline refuses HTTP and drops every socket, as a stopped server would; online again accepts new connections. */
  setOnline(value: boolean): void
  setMessage(value: string): void
  setWorkspaceRoot(value: string): void
  setProviders(value: unknown[]): void
  finish(): void
  /**
   * The agent replies in a thread with a completed assistant message and the
   * transcript streams to the app (§5.9). A strata block in `text` is what
   * the agent did; the app applies it to the attached document. Returns the
   * message id. Posting into `t1` ends its running turn.
   */
  postAssistant(threadId: string, text: string): string
  /** Live sockets right now. */
  connections(): number
  close(): Promise<void>
}

/**
 * A fake T3: HTTP for pairing, snapshots, dispatch, and uploads; a real
 * WebSocket server for RPC and the shell and thread subscriptions (§5.1).
 * Every state change pushes fresh snapshot items to subscribers, so the app
 * only learns of changes the way it would from T3, never by polling.
 */
export async function startEngine(options: FakeEngineOptions = {}): Promise<FakeEngine> {
  const liveAt = new Date().toISOString()
  let online = true
  const pairingCodes = new Set(options.pairingCodes ?? ['pair-code-1'])
  const tokenRequests: string[] = []
  let message = 'Read-side conversation from T3.'
  let status: 'running' | 'stopped' = 'running'
  let approvalOpen = true
  let inputOpen = true
  let sequence = 2
  const commands: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const uploadsById = new Map<string, string>()
  let uploadCount = 0
  const createdThreads: CreatedThread[] = []
  const createdProjects: CreatedProject[] = []
  /** Pin, snooze, and rename state per thread, as T3 would project it (§5.2). */
  const threadMeta = new Map<string, { pinnedAt?: string | null; snoozedUntil?: string | null; settledOverride?: 'settled' | 'unsettled' | null; archivedAt?: string | null; title?: string }>()
  for (const [id, title] of Object.entries(options.titles ?? {})) if (title) threadMeta.set(id, { title })
  if (options.projectsParity) {
    threadMeta.set('t2', { ...threadMeta.get('t2'), pinnedAt: '2026-09-03T08:00:00.000Z' })
    threadMeta.set('t3', { settledOverride: 'settled' })
    threadMeta.set('t4', { snoozedUntil: '2099-09-04T13:00:00.000Z', settledOverride: 'settled' })
  }
  /** Assistant messages posted by tests, per thread, after the seeded transcript. */
  const posted = new Map<string, Array<Record<string, unknown>>>()
  let postedCount = 0
  const postedMessages = (threadId: string) => posted.get(threadId) ?? []
  const withMeta = <T extends { id: string; title: string }>(thread: T): T & { pinnedAt: string | null; snoozedUntil: string | null; settledOverride: 'settled' | 'unsettled' | null; archivedAt: string | null } => {
    const meta = threadMeta.get(thread.id)
    return { ...thread, title: meta?.title ?? thread.title, pinnedAt: meta?.pinnedAt ?? null, snoozedUntil: meta?.snoozedUntil ?? null, settledOverride: meta?.settledOverride ?? null, archivedAt: meta?.archivedAt ?? null }
  }
  let workspaceRoot = options.workspaceRoot ?? '/tmp/cockpit'
  let providers = options.providers ?? DEFAULT_PROVIDERS
  const rpcRequests: Array<{ tag: string; payload: unknown }> = []
  const sockets = new Set<Socket>()
  const connections = new Set<Connection>()

  const shellThread = (thread: CreatedThread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: 'default', branch: null, worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: thread.id, status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: thread.runtimeMode, activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: null, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false })
  const shellJson = () => ({
    snapshotSequence: sequence,
    projects: [
      { id: 'p1', title: 'Cockpit project', workspaceRoot, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at },
      ...(options.projectsParity ? [{ id: 'p2', title: 'Second project', workspaceRoot: '/tmp/second', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }] : []),
      ...createdProjects.map((project) => ({ id: project.id, title: project.title, workspaceRoot: project.workspaceRoot, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at })),
    ],
    threads: ([
      ...createdThreads.map(shellThread),
      { id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: { turnId: 'turn-1', state: status === 'running' ? 'running' : 'interrupted', requestedAt: options.conversationParity ? liveAt : at, startedAt: options.conversationParity ? liveAt : at, completedAt: null, assistantMessageId: 'm1' }, createdAt: at, updatedAt: at, session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: approvalOpen, hasPendingUserInput: inputOpen, hasActionableProposedPlan: false },
      { id: 't2', projectId: 'p1', title: 'Second engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: 't2', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false },
      ...(options.projectsParity ? [
        { id: 't3', projectId: 'p1', title: 'Settled engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: null, createdAt: at, updatedAt: '2026-09-02T12:00:00.000Z', session: { threadId: 't3', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false },
        { id: 't4', projectId: 'p2', title: 'Snoozed engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: null, createdAt: at, updatedAt: '2026-09-01T12:00:00.000Z', session: { threadId: 't4', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false },
      ] : []),
    ] as Array<{ id: string; title: string }>).map(withMeta),
    updatedAt: at,
  })
  const sentMessages = (threadId: string, turnId: string, keepAttachments: boolean) => commands
    .filter((command) => command.type === 'thread.turn.start' && command.threadId === threadId)
    .map((command, index) => ({ id: ((command.message as { messageId?: string }).messageId ?? `sent-${index}`), role: 'user', text: (command.message as { text: string }).text, attachments: keepAttachments ? ((command.message as { attachments?: unknown[] }).attachments ?? []) : [], turnId, streaming: false, createdAt: at, updatedAt: at }))
  const threadJson = (threadId: string): unknown => {
    const page = { beforeCursor: null, hasMore: false, snapshotSequence: sequence, threadSequence: sequence }
    const created = createdThreads.find((thread) => thread.id === threadId)
    if (created) {
      return { snapshotSequence: sequence, thread: { ...shellThread(created), deletedAt: null, messages: [...sentMessages(created.id, `turn-${created.id}`, true), ...postedMessages(created.id)], activities: [], checkpoints: [] }, page }
    }
    if (!['t1', 't2', 't3', 't4'].includes(threadId)) return null
    const threadTitle = threadMeta.get(threadId)?.title ?? (threadId === 't2' ? 'Second engine thread' : 'Live engine thread')
    const messageId = threadId === 't2' ? 'm2' : 'm1'
    const activities = options.conversationParity && threadId === 't1' ? [
      { id: 'old-start-1', tone: 'tool', kind: 'tool.started', summary: 'Started command', payload: { itemType: 'command_execution', detail: 'pnpm test', toolCallId: 'call-old-1', status: 'inProgress' }, turnId: 'turn-old-1', createdAt: '2026-09-03T09:00:01.000Z' },
      { id: 'old-update-1', tone: 'tool', kind: 'tool.updated', summary: 'Running command', payload: { itemType: 'command_execution', detail: 'pnpm test', toolCallId: 'call-old-1', status: 'inProgress' }, turnId: 'turn-old-1', createdAt: '2026-09-03T09:00:02.000Z' },
      { id: 'old-complete-1', tone: 'tool', kind: 'tool.completed', summary: 'Ran command', payload: { itemType: 'command_execution', detail: 'pnpm test', toolCallId: 'call-old-1', status: 'completed' }, turnId: 'turn-old-1', createdAt: '2026-09-03T09:00:03.000Z' },
      { id: 'old-start-2', tone: 'tool', kind: 'tool.started', summary: 'Started search', payload: { itemType: 'web_search', detail: 'T3 timeline rules', toolCallId: 'call-old-2', status: 'inProgress' }, turnId: 'turn-old-2', createdAt: '2026-09-03T10:00:01.000Z' },
      { id: 'old-update-2', tone: 'tool', kind: 'tool.updated', summary: 'Searching', payload: { itemType: 'web_search', detail: 'T3 timeline rules', toolCallId: 'call-old-2', status: 'inProgress' }, turnId: 'turn-old-2', createdAt: '2026-09-03T10:00:02.000Z' },
      { id: 'old-complete-2', tone: 'tool', kind: 'tool.completed', summary: 'Searched web', payload: { itemType: 'web_search', detail: 'T3 timeline rules', toolCallId: 'call-old-2', status: 'completed' }, turnId: 'turn-old-2', createdAt: '2026-09-03T10:00:03.000Z' },
      { id: 'live-update', tone: 'tool', kind: 'tool.updated', summary: 'Running build', payload: { itemType: 'command_execution', detail: 'electron-vite build', toolCallId: 'call-live', status: 'inProgress' }, turnId: 'turn-1', createdAt: at },
    ] : [
      ...(approvalOpen ? [{ id: 'a1', tone: 'approval', kind: 'approval.requested', summary: 'Command approval requested', payload: { requestId: 'approval-1', detail: 'Run the cockpit verification?' }, turnId: 'turn-1', createdAt: at }] : [{ id: 'a2', tone: 'approval', kind: 'approval.resolved', summary: 'Approval resolved', payload: { requestId: 'approval-1' }, turnId: 'turn-1', createdAt: at }]),
      ...(inputOpen ? [{ id: 'u1', tone: 'info', kind: 'user-input.requested', summary: 'User input requested', payload: { requestId: 'input-1', questions: [{ id: 'release', question: 'Which release?', options: [{ label: 'Version one' }] }] }, turnId: 'turn-1', createdAt: at }] : [{ id: 'u2', tone: 'info', kind: 'user-input.resolved', summary: 'User input submitted', payload: { requestId: 'input-1' }, turnId: 'turn-1', createdAt: at }]),
      { id: 'tool-1', tone: 'tool', kind: 'tool.completed', summary: 'Updated cockpit files', payload: {}, turnId: 'turn-1', createdAt: at },
    ]
    const parityMessages = options.conversationParity && threadId === 't1' ? [
      { id: 'old-user-1', role: 'user', text: 'Inspect the timeline.', attachments: [], turnId: 'turn-old-1', streaming: false, createdAt: '2026-09-03T09:00:00.000Z', updatedAt: '2026-09-03T09:00:00.000Z' },
      { id: 'old-agent-1', role: 'assistant', text: 'First finished answer stays fully visible in the narrow placement.', attachments: [], turnId: 'turn-old-1', streaming: false, createdAt: '2026-09-03T09:00:04.000Z', updatedAt: '2026-09-03T09:00:04.000Z' },
      { id: 'old-user-2', role: 'user', text: 'Check the grouping.', attachments: [], turnId: 'turn-old-2', streaming: false, createdAt: '2026-09-03T10:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z' },
      { id: 'old-agent-2', role: 'assistant', text: 'Second finished answer also stays visible.', attachments: [], turnId: 'turn-old-2', streaming: false, createdAt: '2026-09-03T10:00:04.000Z', updatedAt: '2026-09-03T10:00:04.000Z' },
      { id: 'live-user', role: 'user', text: 'Run the build.', attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at },
      { id: messageId, role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: status === 'running', createdAt: at, updatedAt: at },
    ] : null
    return { snapshotSequence: sequence, thread: { id: threadId, projectId: threadId === 't4' ? 'p2' : 'p1', title: threadTitle, modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: threadId === 't1' ? { turnId: 'turn-1', state: status === 'running' ? 'running' : 'interrupted', requestedAt: options.conversationParity ? liveAt : at, startedAt: options.conversationParity ? liveAt : at, completedAt: null, assistantMessageId: messageId } : null, createdAt: at, updatedAt: at, session: { threadId, status: threadId === 't1' ? status : 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: threadId === 't1' && status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, deletedAt: null, messages: parityMessages ?? (threadId === 't1' ? [...sentMessages('t1', 'turn-1', false), { id: messageId, role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: status === 'running', createdAt: at, updatedAt: at }, ...postedMessages('t1')] : [...sentMessages(threadId, 'turn-1', false), ...postedMessages(threadId)]), activities: threadId === 't1' ? activities : [], checkpoints: threadId === 't1' ? [{ turnId: 'turn-1', checkpointTurnCount: 1, checkpointRef: 'ref', status: 'ready', files: [{ path: 'notes/one.md', kind: 'created', additions: 4, deletions: 0 }, { path: 'src/two.ts', kind: 'created', additions: 8, deletions: 0 }], assistantMessageId: messageId, completedAt: at }] : [] }, page }
  }

  const send = (socket: Socket, frame: unknown) => { if (!socket.destroyed) socket.write(textFrame(JSON.stringify(frame))) }
  const chunk = (connection: Connection, subscription: Subscription, values: unknown[]) => send(connection.socket, { _tag: 'Chunk', requestId: subscription.requestId, values })
  const snapshotFor = (subscription: Subscription): unknown[] => subscription.threadId
    ? (threadJson(subscription.threadId) ? [{ kind: 'snapshot', snapshot: threadJson(subscription.threadId) }] : [])
    : [{ kind: 'snapshot', snapshot: shellJson() }]
  /** Every state change is a new sequence pushed to every subscriber, the way T3 streams its projections. */
  const broadcast = () => {
    sequence += 1
    for (const connection of connections) for (const subscription of connection.subscriptions) {
      const values = snapshotFor(subscription)
      if (values.length) chunk(connection, subscription, values)
    }
  }
  function rpcValue(tag: string): unknown {
    if (tag === 'attachments.createUploadUrl') {
      uploadCount += 1
      const attachmentId = `upload-${uploadCount}`
      return { attachmentId, relativeUrl: `/upload/${attachmentId}`, expiresAt: Date.now() + 60_000 }
    }
    if (tag === 'server.getConfig') return { providers, settings: { providerInstances: { codex: { config: { homePath: '/home/owner/.codex-work' } } } } }
    if (tag === 'server.refreshProviders') return { providers }
    return null
  }

  const server = createServer((request, response) => {
    if (!online) {
      response.writeHead(503).end('offline')
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/oauth/token' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (piece) => chunks.push(Buffer.from(piece)))
      request.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        const code = form.get('subject_token') ?? ''
        tokenRequests.push(code)
        if (!pairingCodes.has(code)) { response.writeHead(401).end(JSON.stringify({ error: 'invalid_grant' })); return }
        response.end(JSON.stringify({ access_token: `session-for-${code}`, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' }))
      })
      return
    }
    if (request.url === '/api/auth/websocket-ticket' && request.method === 'POST') {
      response.end(JSON.stringify({ ticket: 'test-ticket', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      return
    }
    if (request.url?.startsWith('/upload/') && request.method === 'PUT') {
      const chunks: Buffer[] = []
      const attachmentId = request.url.slice('/upload/'.length)
      request.on('data', (piece) => chunks.push(Buffer.from(piece)))
      request.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); uploads.push(text); uploadsById.set(attachmentId, text); response.end('{}') })
      return
    }
    if (request.url === '/api/orchestration/dispatch' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (piece) => chunks.push(Buffer.from(piece)))
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        // T3 applies a command once per commandId; a retry after a dropped connection is a no-op.
        if (typeof command.commandId === 'string' && commands.some((known) => known.commandId === command.commandId)) { response.end(JSON.stringify({ sequence })); return }
        commands.push(command)
        if (command.type === 'thread.turn.start') status = 'running'
        if (command.type === 'thread.turn.interrupt') status = 'stopped'
        if (command.type === 'thread.approval.respond') approvalOpen = false
        if (command.type === 'thread.user-input.respond') inputOpen = false
        if (command.type === 'thread.create') createdThreads.push({ id: String(command.threadId), projectId: String(command.projectId), title: String(command.title), modelSelection: command.modelSelection, runtimeMode: String(command.runtimeMode) })
        if (command.type === 'project.create') createdProjects.push({ id: String(command.projectId), title: String(command.title), workspaceRoot: String(command.workspaceRoot) })
        const threadId = String(command.threadId)
        const meta = threadMeta.get(threadId) ?? {}
        if (command.type === 'thread.pin') threadMeta.set(threadId, { ...meta, pinnedAt: new Date().toISOString() })
        if (command.type === 'thread.unpin') threadMeta.set(threadId, { ...meta, pinnedAt: null })
        if (command.type === 'thread.snooze') threadMeta.set(threadId, { ...meta, snoozedUntil: String(command.snoozedUntil) })
        if (command.type === 'thread.unsnooze') threadMeta.set(threadId, { ...meta, snoozedUntil: null })
        if (command.type === 'thread.settle') threadMeta.set(threadId, { ...meta, settledOverride: 'settled' })
        if (command.type === 'thread.unsettle') threadMeta.set(threadId, { ...meta, settledOverride: 'unsettled' })
        if (command.type === 'thread.archive') threadMeta.set(threadId, { ...meta, archivedAt: new Date().toISOString() })
        if (command.type === 'thread.meta.update' && typeof command.title === 'string') threadMeta.set(threadId, { ...meta, title: command.title })
        broadcast()
        response.end(JSON.stringify({ sequence }))
      })
      return
    }
    if (request.url === '/api/orchestration/shell') {
      response.end(JSON.stringify(shellJson()))
      return
    }
    const threadMatch = /^\/api\/orchestration\/threads\/([^/?]+)$/u.exec(request.url ?? '')
    const detail = threadMatch ? threadJson(decodeURIComponent(threadMatch[1]!)) : null
    if (detail) {
      response.end(JSON.stringify(detail))
      return
    }
    response.writeHead(404).end('{}')
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket: Socket) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || !online) { socket.destroy(); return }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const connection: Connection = { socket, subscriptions: [] }
    connections.add(connection)
    socket.once('close', () => connections.delete(connection))
    let pending: Buffer = Buffer.alloc(0)
    socket.on('data', (piece) => {
      pending = Buffer.concat([pending, Buffer.from(piece)])
      const { frames, rest } = readFrames(pending)
      pending = rest
      for (const frame of frames) {
        if (frame.opcode === 8) { socket.write(Buffer.from([0x88, 0])); socket.end(); return }
        if (frame.opcode !== 1) continue
        const rpc = JSON.parse(frame.payload.toString('utf8')) as { _tag?: string; id?: string; tag?: string; payload?: unknown; requestId?: string }
        if (rpc._tag === 'Ping') { send(socket, { _tag: 'Pong' }); continue }
        if (rpc._tag === 'Interrupt') { connection.subscriptions = connection.subscriptions.filter((subscription) => subscription.requestId !== rpc.requestId); continue }
        if (rpc._tag !== 'Request' || !rpc.id || !rpc.tag) continue
        rpcRequests.push({ tag: rpc.tag, payload: rpc.payload })
        if (rpc.tag === 'orchestration.subscribeShell' || rpc.tag === 'orchestration.subscribeThread') {
          const subscription: Subscription = { requestId: rpc.id, tag: rpc.tag, threadId: rpc.tag === 'orchestration.subscribeThread' ? String((rpc.payload as { threadId?: unknown }).threadId ?? '') : null }
          connection.subscriptions.push(subscription)
          chunk(connection, subscription, [...snapshotFor(subscription), { kind: 'synchronized' }])
          continue
        }
        send(socket, { _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: rpcValue(rpc.tag) } })
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake engine did not bind')
  const dropSockets = () => { for (const socket of sockets) socket.destroy(); connections.clear() }
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    commands,
    uploads,
    uploadsById,
    tokenRequests,
    rpcRequests,
    setOnline: (value) => { online = value; if (!value) dropSockets() },
    setMessage: (value) => { message = value; broadcast() },
    setWorkspaceRoot: (value) => { workspaceRoot = value; broadcast() },
    setProviders: (value) => { providers = value; broadcast() },
    finish: () => { status = 'stopped'; broadcast() },
    postAssistant: (threadId, text) => {
      postedCount += 1
      const id = `posted-${postedCount}`
      posted.set(threadId, [...postedMessages(threadId), { id, role: 'assistant', text, attachments: [], turnId: `turn-posted-${postedCount}`, streaming: false, createdAt: at, updatedAt: at }])
      if (threadId === 't1') status = 'stopped'
      broadcast()
      return id
    },
    connections: () => connections.size,
    close: async () => {
      dropSockets()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Where the app keeps its engine credential for this scenario. */
export function credentialPath(scenario: Scenario): string {
  return join(String(scenario.env.XDG_DATA_HOME), 'stratamd', 'engine-credential.json')
}

/**
 * A scenario already paired with the fake engine, unless `paired: false`, in
 * which case nothing is written and the app starts unpaired for the pairing UI.
 */
export async function seededScenario(testInfo: TestInfo, origin: string, content = '# Engine-safe document\n\nKeep editing while the engine is down.\n', name = 'cockpit-engine.md', options: { paired?: boolean } = {}): Promise<Scenario> {
  const scenario = await Scenario.create(testInfo, content, name)
  if (options.paired === false) return scenario
  const path = credentialPath(scenario)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ formatVersion: 1, server: origin, accessToken: 'test-session', expiresAt: Date.now() + 3_600_000 })}\n`, { mode: 0o600 })
  return scenario
}
