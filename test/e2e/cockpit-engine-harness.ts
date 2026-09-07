import { usageFixture } from '../support/usage-fixture'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { Scenario } from './harness'

const at = '2026-09-03T12:00:00.000Z'

export interface FakeEngineOptions {
  settings?: Record<string, unknown>
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
  /** A real-shaped owner reply between the progress and final answer of one turn. */
  conversationSteering?: boolean
  previousWorktree?: boolean
  longHistory?: boolean
  /** Whether `t1` starts with an open approval and an open user-input request; defaults to true. False leaves it plainly running. */
  pendingRequests?: boolean
  /** T3 background liveness per seeded thread (§6.9 thread states): `monitoring` draws the robot, `working` the pulse after the turn settles. */
  liveness?: Partial<Record<'t1' | 't2', 'working' | 'monitoring'>>
  /** Accepts Strata as a preview automation host and lets a test send it browser requests (docs/plans/open/visual-review, phase 2). Off by default, so shell baselines never show Browser shared. */
  previewAutomation?: boolean
  /** Seeds `t1`'s running turn with seven subagents across two clusters, one of them nested, plus one background command (§6.9 Agents). */
  agentTasks?: boolean
}

/** T3's `task.*` shapes for seven Claude subagents and a background command, as recorded from t3 0.0.38. */
function agentTaskActivities(at: string): unknown[] {
  const agent = (id: string, title: string, model: string, toolUseId: string) => ({ taskId: id, taskType: 'local_agent', agentKind: 'agent', title, role: 'general-purpose', model, effort: 'high', toolUseId })
  const stamp = (offset: number) => new Date(Date.parse(at) + offset * 1_000).toISOString()
  const spawn = (index: number, id: string, title: string, model: string, main = true) => [
    ...(main ? [{ id: `call-${id}`, tone: 'tool', kind: 'tool.started', summary: 'Started agent', payload: { itemType: 'collab_agent_tool_call', toolCallId: `toolu-${id}`, status: 'inProgress' }, turnId: 'turn-1', createdAt: stamp(index * 10) }] : []),
    { id: `task-${id}-start`, tone: 'info', kind: 'task.started', summary: 'local_agent task started', payload: agent(id, title, model, main ? `toolu-${id}` : `inner-${id}`), turnId: 'turn-1', createdAt: stamp(index * 10 + 1) },
  ]
  return [
    ...spawn(0, 'ag1', 'Audit unit test value', 'claude-opus-5'),
    ...spawn(1, 'ag2', 'Analyze e2e harness flakiness', 'claude-fable-5-1'),
    ...spawn(2, 'ag3', 'Read the Known flakes table', 'claude-haiku-4-5-20251001', false),
    ...spawn(3, 'ag4', 'Survey prior art', 'claude-opus-5'),
    ...spawn(4, 'ag5', 'Audit e2e spec value', 'claude-opus-5'),
    ...spawn(5, 'ag6', 'Time the six-worker run', 'claude-opus-5'),
    ...spawn(6, 'ag7', 'Draft findings', 'claude-fable-5-1'),
    { id: 'task-bash-start', tone: 'info', kind: 'task.started', summary: 'local_bash task started', payload: { taskId: 'bash1', taskType: 'local_bash', agentKind: 'background', title: 'Run the experiment at six workers', model: 'claude-fable-5-1', effort: 'high', toolUseId: 'toolu-bash1' }, turnId: 'turn-1', createdAt: stamp(70) },
    { id: 'task-ag2-progress', tone: 'info', kind: 'task.progress', summary: 'Task progress', payload: { ...agent('ag2', 'Analyze e2e harness flakiness', 'claude-fable-5-1', 'toolu-ag2'), detail: 'Running Check reduced-motion coverage', lastToolName: 'Bash', usage: { total_tokens: 181_901, tool_uses: 52, duration_ms: 454_792 } }, turnId: 'turn-1', createdAt: stamp(80) },
    { id: 'task-ag1-complete', tone: 'info', kind: 'task.completed', summary: 'Task completed', payload: { ...agent('ag1', 'Audit unit test value', 'claude-opus-5', 'toolu-ag1'), status: 'completed', summary: 'Of 126 files, 31 assert nothing a type check would not catch.', usage: { total_tokens: 269_338, tool_uses: 40, duration_ms: 426_526 } }, turnId: 'turn-1', createdAt: stamp(90) },
    { id: 'task-ag4-complete', tone: 'error', kind: 'task.completed', summary: 'Task completed', payload: { ...agent('ag4', 'Survey prior art', 'claude-opus-5', 'toolu-ag4'), status: 'failed', summary: 'Agent terminated early due to an API error: session limit reached', error: 'Agent terminated early due to an API error: session limit reached' }, turnId: 'turn-1', createdAt: stamp(100) },
    { id: 'task-ag5-complete', tone: 'info', kind: 'task.completed', summary: 'Task completed', payload: { ...agent('ag5', 'Audit e2e spec value', 'claude-opus-5', 'toolu-ag5'), status: 'completed', summary: 'All 76 spec files read.', usage: { total_tokens: 290_705, tool_uses: 40, duration_ms: 818_714 } }, turnId: 'turn-1', createdAt: stamp(110) },
  ]
}

const usageAt = '2026-09-03T11:59:00.000Z'
export const DEFAULT_PROVIDERS: unknown[] = [
  { instanceId: 'codex', driver: 'codex', displayName: 'Codex work', enabled: true, installed: true, version: '0.50.0', status: 'ready', auth: { status: 'authenticated', type: 'chatgpt', label: 'Pro', email: 'owner@example.com' }, checkedAt: usageAt, models: [{ slug: 'gpt-5.6', name: 'GPT-5.6', isDefault: true, capabilities: { optionDescriptors: [{ id: 'effort', label: 'Reasoning', type: 'select', options: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium', isDefault: true }, { id: 'high', label: 'High' }] }] } }], usage: { session: { usedPercent: 40, resetsAt: '2026-09-03T16:00:00.000Z', measuredAt: usageAt, source: 'session' }, weekly: { usedPercent: 20, resetsAt: '2026-09-08T00:00:00.000Z', measuredAt: usageAt, source: 'session' }, planLabel: 'Pro', applicable: true } },
  { instanceId: 'claude-main', driver: 'claudeAgent', displayName: 'Claude', enabled: true, installed: true, version: '2.1.0', status: 'ready', auth: { status: 'authenticated', type: 'oauth', label: 'Max' }, checkedAt: usageAt, models: [{ slug: 'claude-fable-5-1', name: 'Claude Fable 5.1', isDefault: true, capabilities: { optionDescriptors: [{ id: 'effort', label: 'Reasoning', type: 'select', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true }, { id: 'max', label: 'Max' }] }, { id: 'contextWindow', label: 'Context window', type: 'select', options: [{ id: '200k', label: '200k' }, { id: '1m', label: '1M', isDefault: true }] }] } }] },
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

interface CreatedThread { branch?: string | null; worktreePath?: string | null; id: string; projectId: string; title: string; modelSelection: unknown; runtimeMode: string }
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
  /** Each upload's declared content type and byte length, so a spec can tell an image upload from Markdown. */
  uploadRequests: Array<{ attachmentId: string; contentType: string; byteLength: number }>
  tokenRequests: string[]
  rpcRequests: Array<{ tag: string; payload: unknown }>
  /** Offline refuses HTTP and drops every socket, as a stopped server would; online again accepts new connections. */
  failNextTurn(): void
  failNextModelSettings(): void
  setOnline(value: boolean): void
  setMessage(value: string): void
  setWorkspaceRoot(value: string): void
  setSettings(patch: Record<string, unknown>): void
  setProviders(value: unknown[]): void
  finish(): void
  /** The live turn in `t1` completes normally: T3 reports the session idle and the turn completed with both stamps. */
  complete(): void
  /**
   * The agent replies in a thread with a completed assistant message and the
   * transcript streams to the app (§5.9). A strata block in `text` is what
   * the agent did; the app applies it to the attached document. Returns the
   * message id. Posting into `t1` ends its running turn.
   */
  postAssistant(threadId: string, text: string): string
  /** Live sockets right now. */
  connections(): number
  /** The registered browser hosts, oldest first, when `previewAutomation` is on. */
  hosts(): Array<{ clientId: string; environmentId: string; supportedOperations: string[] }>
  /** Sends one browser request to the registered host and resolves with its answer, as T3's broker would. */
  automation(threadId: string, operation: string, input: unknown, options?: { tabId?: string; timeoutMs?: number }): Promise<{ ok: boolean; result?: unknown; error?: { _tag: string; message: string; detail?: unknown } }>
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
  /** How the live turn ended and when; T3 stamps `completedAt` as the session leaves `running`. */
  let outcome: 'interrupted' | 'completed' = 'interrupted'
  let stoppedAt: string | null = null
  const stop = (how: 'interrupted' | 'completed' = 'interrupted') => { status = 'stopped'; outcome = how; stoppedAt = new Date().toISOString() }
  let approvalOpen = options.pendingRequests ?? true
  let inputOpen = options.pendingRequests ?? true
  let sequence = 2
  const commands: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const uploadsById = new Map<string, string>()
  const uploadRequests: FakeEngine['uploadRequests'] = []
  let uploadCount = 0
  let rejectNextTurn = false
  let rejectNextModelSettings = false
  const createdThreads: CreatedThread[] = []
  const createdProjects: CreatedProject[] = []
  /** Pin, snooze, and rename state per thread, as T3 would project it (§5.2). */
  const threadMeta = new Map<string, { pinnedAt?: string | null; snoozedUntil?: string | null; settledOverride?: 'settled' | 'unsettled' | null; archivedAt?: string | null; title?: string; modelSelection?: unknown; backgroundLiveness?: 'working' | 'monitoring' | null }>()
  for (const [id, title] of Object.entries(options.titles ?? {})) if (title) threadMeta.set(id, { title })
  for (const [id, liveness] of Object.entries(options.liveness ?? {})) if (liveness) threadMeta.set(id, { ...threadMeta.get(id), backgroundLiveness: liveness })
  if (options.projectsParity) {
    threadMeta.set('t2', { ...threadMeta.get('t2'), pinnedAt: '2026-09-03T08:00:00.000Z' })
    threadMeta.set('t3', { settledOverride: 'settled' })
    threadMeta.set('t4', { snoozedUntil: '2099-09-04T13:00:00.000Z', settledOverride: 'settled' })
  }
  /** Assistant messages posted by tests, per thread, after the seeded transcript. */
  const posted = new Map<string, Array<Record<string, unknown>>>()
  let postedCount = 0
  const postedMessages = (threadId: string) => posted.get(threadId) ?? []
  const withMeta = <T extends { id: string; title: string }>(thread: T): T & { pinnedAt: string | null; snoozedUntil: string | null; settledOverride: 'settled' | 'unsettled' | null; archivedAt: string | null; backgroundLiveness: 'working' | 'monitoring' | null } => {
    const meta = threadMeta.get(thread.id)
    return { ...thread, ...(meta?.modelSelection ? { modelSelection: meta.modelSelection } : {}), title: meta?.title ?? thread.title, pinnedAt: meta?.pinnedAt ?? null, snoozedUntil: meta?.snoozedUntil ?? null, settledOverride: meta?.settledOverride ?? null, archivedAt: meta?.archivedAt ?? null, backgroundLiveness: meta?.backgroundLiveness ?? null }
  }
  let workspaceRoot = options.workspaceRoot ?? '/tmp/cockpit'
  let providers = options.providers ?? DEFAULT_PROVIDERS
  const terminalHistory = new Map<string, string>()
  const rpcRequests: Array<{ tag: string; payload: unknown }> = []
  const sockets = new Set<Socket>()
  const connections = new Set<Connection>()
  const hosts: Array<{ clientId: string; environmentId: string; supportedOperations: string[]; connectionId: string; connection: Connection; requestId: string }> = []
  const automationWaiters = new Map<string, (response: { ok: boolean; result?: unknown; error?: { _tag: string; message: string; detail?: unknown } }) => void>()
  let automationCount = 0

  const shellThread = (thread: CreatedThread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: 'default', branch: thread.branch ?? null, worktreePath: thread.worktreePath ?? null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: thread.id, status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: thread.runtimeMode, activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: null, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false })
  const shellJson = () => ({
    snapshotSequence: sequence,
    projects: [
      { id: 'p1', title: 'Cockpit project', workspaceRoot, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at },
      ...(options.projectsParity ? [{ id: 'p2', title: 'Second project', workspaceRoot: '/tmp/second', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }] : []),
      ...createdProjects.map((project) => ({ id: project.id, title: project.title, workspaceRoot: project.workspaceRoot, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at })),
    ],
    threads: ([
      ...createdThreads.map(shellThread),
      { id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: { turnId: 'turn-1', state: status === 'running' ? 'running' : outcome, requestedAt: options.conversationParity ? liveAt : at, startedAt: options.conversationParity ? liveAt : at, completedAt: status === 'running' ? null : stoppedAt, assistantMessageId: 'm1' }, createdAt: at, updatedAt: at, session: { threadId: 't1', status: status === 'stopped' && outcome === 'completed' ? 'idle' : status, providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: approvalOpen, hasPendingUserInput: inputOpen, hasActionableProposedPlan: false },
      { id: 't2', projectId: 'p1', title: 'Second engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: options.previousWorktree ? '/worktrees/previous' : null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: 't2', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false },
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
      ...(options.agentTasks ? agentTaskActivities(at) : []),
    ]
    const longMessages = options.longHistory && threadId === 't1' ? Array.from({ length: 100 }, (_, index) => [
      { id: `history-user-${index}`, role: 'user', text: `Request ${index + 1}`, attachments: [], turnId: `history-turn-${index}`, streaming: false, createdAt: at, updatedAt: at },
      { id: `history-agent-${index}`, role: 'assistant', text: `# Answer ${index + 1}\n\n<Callout>\n\nHistory passage ${index + 1}.\n\n</Callout>\n\n` + 'Read this completed answer while new work continues. '.repeat(30), attachments: [], turnId: `history-turn-${index}`, streaming: false, createdAt: at, updatedAt: at },
    ]).flat() : []
    const parityMessages = options.conversationParity && threadId === 't1' ? [
      { id: 'old-user-1', role: 'user', text: 'Inspect the timeline.', attachments: [], turnId: null, streaming: false, createdAt: '2026-09-03T09:00:00.000Z', updatedAt: '2026-09-03T09:00:00.000Z' },
      { id: 'old-agent-1', role: 'assistant', text: 'First finished answer stays fully visible in the narrow placement.', attachments: [], turnId: 'turn-old-1', streaming: false, createdAt: '2026-09-03T09:00:04.000Z', updatedAt: '2026-09-03T09:00:04.000Z' },
      { id: 'old-user-2', role: 'user', text: 'Check the grouping.', attachments: [], turnId: null, streaming: false, createdAt: '2026-09-03T10:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z' },
      { id: 'old-agent-2-progress', role: 'assistant', text: 'Checking the grouping order first.', attachments: [], turnId: 'turn-old-2', streaming: false, createdAt: '2026-09-03T10:00:01.500Z', updatedAt: '2026-09-03T10:00:01.500Z' },
      ...(options.conversationSteering ? [{ id: 'steering-user', role: 'user', text: 'Keep the work collapsible.', attachments: [], turnId: null, streaming: false, createdAt: '2026-09-03T10:00:02.500Z', updatedAt: '2026-09-03T10:00:02.500Z' }] : []),
      { id: 'old-agent-2', role: 'assistant', text: 'Second finished answer also stays visible.', attachments: [], turnId: 'turn-old-2', streaming: false, createdAt: '2026-09-03T10:00:04.000Z', updatedAt: '2026-09-03T10:00:04.000Z' },
      { id: 'live-user', role: 'user', text: 'Run the build.', attachments: [], turnId: null, streaming: false, createdAt: at, updatedAt: at },
      { id: messageId, role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: status === 'running', createdAt: at, updatedAt: at },
      ...sentMessages(threadId, 'turn-1', false),
      ...postedMessages(threadId),
    ] : null
    return { snapshotSequence: sequence, thread: { id: threadId, projectId: threadId === 't4' ? 'p2' : 'p1', title: threadTitle, modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: threadId === 't1' ? { turnId: 'turn-1', state: status === 'running' ? 'running' : outcome, requestedAt: options.conversationParity ? liveAt : at, startedAt: options.conversationParity ? liveAt : at, completedAt: status === 'running' ? null : stoppedAt, assistantMessageId: messageId } : null, createdAt: at, updatedAt: at, session: { threadId, status: threadId === 't1' ? (status === 'stopped' && outcome === 'completed' ? 'idle' : status) : 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: threadId === 't1' && status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, deletedAt: null, messages: parityMessages ?? (threadId === 't1' ? [...longMessages, ...sentMessages('t1', 'turn-1', false), { id: messageId, role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: status === 'running', createdAt: at, updatedAt: at }, ...postedMessages('t1')] : [...sentMessages(threadId, 'turn-1', false), ...postedMessages(threadId)]), activities: threadId === 't1' ? activities : [], checkpoints: threadId === 't1' ? [{ turnId: 'turn-1', checkpointTurnCount: 1, checkpointRef: 'ref', status: 'ready', files: [{ path: 'notes/one.md', kind: 'created', additions: 4, deletions: 0 }, { path: 'src/two.ts', kind: 'created', additions: 8, deletions: 0 }], assistantMessageId: messageId, completedAt: at }] : [] }, page }
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
  let providerInstances: Record<string, Record<string, unknown>> = { codex: { driver: 'codex', config: { homePath: '/home/owner/.codex-work', preserved: 'keep' } } }
  let settings: Record<string, unknown> = { addProjectBaseDirectory: '/home/owner/Projects', newWorktreesStartFromOrigin: true, providerInstances, ...options.settings }
  providerInstances = settings.providerInstances as typeof providerInstances
  function rpcValue(tag: string, payload: Record<string, unknown>): unknown {
    if (tag === 'attachments.createUploadUrl') {
      uploadCount += 1
      const attachmentId = `upload-${uploadCount}`
      return { attachmentId, relativeUrl: `/upload/${attachmentId}`, expiresAt: Date.now() + 60_000 }
    }
    if (tag === 'server.getUsageSummary') return usageFixture(payload as unknown as import('../../src/shared/usage').UsageSummaryInput)
    if (tag === 'server.getSettings') return settings
    if (tag === 'server.updateSettings') { settings = { ...settings, ...payload.patch as object }; providerInstances = settings.providerInstances as typeof providerInstances; return settings }
    if (tag === 'vcs.listRefs') return { refs: ['master', 'develop'].filter(name => !payload.query || name.includes(String(payload.query))).map(name => ({ name, current: name === 'master', isDefault: name === 'master', worktreePath: null })), isRepo: true, hasPrimaryRemote: true, totalCount: 2, nextCursor: null }
    if (tag === 'filesystem.browse') {
      const parentPath = String(payload.partialPath).replace(/\/+$/, '') || '/'
      return { parentPath, entries: parentPath === '/home/owner/Projects' ? [{ name: 'Example app', fullPath: '/home/owner/Projects/Example app' }] : [] }
    }
    if (tag === 'sourceControl.lookupRepository') return { provider: 'github', nameWithOwner: payload.repository, url: `https://github.com/${payload.repository}`, sshUrl: `git@github.com:${payload.repository}.git` }
    if (tag === 'sourceControl.cloneRepository') return { cwd: payload.destinationPath, remoteUrl: payload.remoteUrl ?? `https://github.com/${payload.repository}`, repository: null }
    if (tag === 'server.getConfig') return { providers, settings }
    if (tag === 'server.discoverSourceControl') return { versionControlSystems: [{ label: 'Git', status: 'available' }], sourceControlProviders: [{ label: 'GitHub', status: 'missing', installHint: { _tag: 'Some', value: 'Install and sign in with gh.' } }] }
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
    if (request.url === '/.well-known/t3/environment' && request.method === 'GET') {
      response.end(JSON.stringify({ environmentId: 'env-fake-1', label: 'Fake T3' }))
      return
    }
    if (request.url === '/api/auth/websocket-ticket' && request.method === 'POST') {
      response.end(JSON.stringify({ ticket: 'test-ticket', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      return
    }
    if (request.url?.startsWith('/upload/') && request.method === 'POST') {
      const chunks: Buffer[] = []
      const attachmentId = request.url.slice('/upload/'.length)
      request.on('data', (piece) => chunks.push(Buffer.from(piece)))
      request.on('end', () => {
        const bytes = Buffer.concat(chunks)
        const text = bytes.toString('utf8')
        uploads.push(text); uploadsById.set(attachmentId, text)
        uploadRequests.push({ attachmentId, contentType: String(request.headers['content-type'] ?? ''), byteLength: bytes.byteLength })
        response.statusCode = 204
        response.end()
      })
      return
    }
    if (request.url === '/api/orchestration/dispatch' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (piece) => chunks.push(Buffer.from(piece)))
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        if (command.bootstrap) { response.statusCode = 400; response.end(JSON.stringify({ error: 'Bootstrap requires socket dispatch' })); return }
        // T3 applies a command once per commandId; a retry after a dropped connection is a no-op.
        if (typeof command.commandId === 'string' && commands.some((known) => known.commandId === command.commandId)) { response.end(JSON.stringify({ sequence })); return }
        if (command.type === 'thread.turn.start' && rejectNextTurn) { rejectNextTurn = false; response.statusCode = 400; response.end(JSON.stringify({ error: 'Test refusal' })); return }
        if (command.type === 'thread.meta.update' && command.modelSelection && rejectNextModelSettings) { rejectNextModelSettings = false; response.statusCode = 400; response.end(JSON.stringify({ error: 'Settings refusal' })); return }
        commands.push(command)
        if (command.type === 'thread.turn.start') status = 'running'
        if (command.type === 'thread.turn.interrupt') stop()
        if (command.type === 'thread.approval.respond') approvalOpen = false
        if (command.type === 'thread.user-input.respond') inputOpen = false
        if (command.type === 'thread.create') createdThreads.push({ branch: command.branch as string | null, worktreePath: command.worktreePath as string | null, id: String(command.threadId), projectId: String(command.projectId), title: String(command.title), modelSelection: command.modelSelection, runtimeMode: String(command.runtimeMode) })
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
        if (command.type === 'thread.meta.update') threadMeta.set(threadId, { ...meta, ...(typeof command.title === 'string' ? { title: command.title } : {}), ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}) })
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
        if (rpc.tag === 'orchestration.dispatchCommand') {
          const command = rpc.payload as Record<string, unknown>
          if (rejectNextTurn) { rejectNextTurn = false; send(socket, { _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Failure', cause: 'Test refusal' } }); continue }
          if (!commands.some(known => known.commandId === command.commandId)) commands.push(command)
          if (command.type === 'thread.turn.start') status = 'running'
          broadcast()
          send(socket, { _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: { sequence } } })
          continue
        }
        if (rpc.tag === 'terminal.attach') {
          const input = rpc.payload as { threadId: string; terminalId: string; cwd: string }
          const subscription = { requestId: rpc.id, tag: rpc.tag, threadId: input.threadId }
          connection.subscriptions.push(subscription)
          const history = terminalHistory.get(input.threadId) ?? '\u001b[32mShell ready\u001b[0m\r\n$ '
          terminalHistory.set(input.threadId, history)
          chunk(connection, subscription, [{ type: 'snapshot', snapshot: { ...input, status: 'running', history, worktreePath: null, label: 'bash', updatedAt: at } }])
          continue
        }
        if (rpc.tag === 'terminal.write') {
          const input = rpc.payload as { threadId: string; terminalId: string; data: string }
          terminalHistory.set(input.threadId, (terminalHistory.get(input.threadId) ?? '') + input.data)
          for (const subscription of connection.subscriptions.filter(item => item.tag === 'terminal.attach' && item.threadId === input.threadId)) chunk(connection, subscription, [{ type: 'output', ...input }])
          send(socket, { _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: null } })
          continue
        }
        if (rpc.tag === 'previewAutomation.connect' && options.previewAutomation) {
          const host = rpc.payload as { clientId: string; environmentId: string; supportedOperations?: string[] }
          const connectionId = `conn-${hosts.length + 1}`
          hosts.push({ clientId: host.clientId, environmentId: host.environmentId, supportedOperations: host.supportedOperations ?? [], connectionId, connection, requestId: rpc.id })
          connection.subscriptions.push({ requestId: rpc.id, tag: rpc.tag, threadId: null })
          send(socket, { _tag: 'Chunk', requestId: rpc.id, values: [{ type: 'connected', connectionId }] })
          continue
        }
        if (rpc.tag === 'previewAutomation.respond') {
          const answer = rpc.payload as { requestId: string; ok: boolean; result?: unknown; error?: { _tag: string; message: string; detail?: unknown } }
          automationWaiters.get(answer.requestId)?.({ ok: answer.ok, ...(answer.result !== undefined ? { result: answer.result } : {}), ...(answer.error ? { error: answer.error } : {}) })
          automationWaiters.delete(answer.requestId)
          send(socket, { _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: null } })
          continue
        }
        if (rpc.tag === 'orchestration.subscribeShell' || rpc.tag === 'orchestration.subscribeThread') {
          const subscription: Subscription = { requestId: rpc.id, tag: rpc.tag, threadId: rpc.tag === 'orchestration.subscribeThread' ? String((rpc.payload as { threadId?: unknown }).threadId ?? '') : null }
          connection.subscriptions.push(subscription)
          chunk(connection, subscription, [...snapshotFor(subscription), { kind: 'synchronized' }])
          continue
        }
        send(socket, { _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: rpcValue(rpc.tag, rpc.payload as Record<string, unknown>) } })
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
    uploadRequests,
    tokenRequests,
    rpcRequests,
    setOnline: (value) => { online = value; if (!value) dropSockets() },
    setMessage: (value) => { message = value; broadcast() },
    setWorkspaceRoot: (value) => { workspaceRoot = value; broadcast() },
    failNextTurn: () => { rejectNextTurn = true },
    failNextModelSettings: () => { rejectNextModelSettings = true },
    setSettings: (patch) => { settings = { ...settings, ...patch }; providerInstances = settings.providerInstances as typeof providerInstances },
    setProviders: (value) => { providers = value; broadcast() },
    finish: () => { stop(); broadcast() },
    complete: () => { stop('completed'); broadcast() },
    postAssistant: (threadId, text) => {
      postedCount += 1
      const id = `posted-${postedCount}`
      posted.set(threadId, [...postedMessages(threadId), { id, role: 'assistant', text, attachments: [], turnId: `turn-posted-${postedCount}`, streaming: false, createdAt: at, updatedAt: at }])
      if (threadId === 't1') stop()
      broadcast()
      return id
    },
    connections: () => connections.size,
    hosts: () => hosts.filter((host) => !host.connection.socket.destroyed && connections.has(host.connection)).map(({ clientId, environmentId, supportedOperations }) => ({ clientId, environmentId, supportedOperations })),
    automation: (threadId, operation, input, requestOptions = {}) => new Promise((resolve, reject) => {
      const host = hosts.filter((candidate) => !candidate.connection.socket.destroyed && connections.has(candidate.connection)).at(-1)
      if (!host) { reject(new Error('No browser host is registered')); return }
      automationCount += 1
      const requestId = `req-${automationCount}`
      const timeoutMs = requestOptions.timeoutMs ?? 15_000
      const timer = setTimeout(() => { automationWaiters.delete(requestId); reject(new Error(`The host did not answer ${operation} within ${timeoutMs} ms`)) }, timeoutMs + 5_000)
      automationWaiters.set(requestId, (answer) => { clearTimeout(timer); resolve(answer) })
      send(host.connection.socket, { _tag: 'Chunk', requestId: host.requestId, values: [{ type: 'request', connectionId: host.connectionId, request: { requestId, threadId, ...(requestOptions.tabId ? { tabId: requestOptions.tabId, tabIdExplicit: true } : {}), operation, input, timeoutMs } }] })
    }),
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
