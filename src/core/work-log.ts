import type { EngineActivityView } from '../shared/contracts'

export type WorkIcon = 'terminal' | 'search' | 'wrench' | 'hammer' | 'bot' | 'tone'

export interface WorkEntry {
  id: string
  turnId: string | null
  createdAt: string
  sourceActivityKind: string
  itemType: string | null
  detail: string | null
  data: unknown
  status: string | null
  /** The engine reported a status itself; a synthesized one does not count. */
  statusReported: boolean
  toolCallId: string | null
  label: string
  heading: string
  command: string | null
  changedFiles: string[]
  preview: string | null
  expandedBody: string | null
  icon: WorkIcon
  tone: EngineActivityView['tone']
  failed: boolean
  active: boolean
}

export interface WorkTurn {
  id: string
  running?: boolean
  finished?: boolean
}

export interface WorkGroupRow {
  id: string
  turnId: string
  createdAt: string
  entries: WorkEntry[]
  hiddenCount: number
  summary: string
  summaryIcon: WorkIcon
  hasFailure: boolean
  live: boolean
  foldedByDefault: boolean
  showWorking: boolean
  showThinking: boolean
}

export interface WorkMessageBoundary {
  id: string
  turnId: string | null
  createdAt: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalized(value: string): string {
  return value.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function title(value: string): string {
  const clean = value.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return clean ? `${clean[0]!.toLocaleUpperCase()}${clean.slice(1)}` : clean
}

function statusOf(activity: EngineActivityView, payload: Record<string, unknown> | null): string | null {
  return text(payload?.status) ?? (activity.kind === 'tool.completed' || activity.kind === 'task.completed' ? 'completed' : activity.kind.endsWith('.updated') ? 'inProgress' : null)
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim()
  const match = /^(?:\/[^\s]+\/)?(?:ba|z|da|fi)?sh\s+-lc\s+([\s\S]+)$/u.exec(trimmed)
  if (!match) return trimmed
  const argument = match[1]!.trim()
  const quote = argument[0]
  const unquoted = (quote === '"' || quote === "'") && argument.at(-1) === quote ? argument.slice(1, -1) : argument
  return unquoted.replace(/\\([\\"'])/gu, '$1')
}

function commandOf(payload: Record<string, unknown> | null, itemType: string | null, detail: string | null): string | null {
  const data = record(payload?.data)
  const item = record(data?.item)
  const input = record(item?.input)
  const result = record(item?.result)
  const candidates = [item?.command, input?.command, result?.command, data?.command]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const parts = candidate.map(String)
      const program = parts[0]?.split('/').at(-1)
      if (program && /^(?:ba|z|da|fi)?sh$/u.test(program) && parts[1] === '-lc' && parts[2]) return parts.slice(2).join(' ')
      return parts.join(' ')
    }
    const value = text(candidate)
    if (value) return unwrapShellCommand(value)
  }
  if (itemType !== 'command_execution' || !detail) return null
  const labelled = /(?:^|\n)(?:command|cmd):\s*([^\n]+)/iu.exec(detail)?.[1]
  const raw = (labelled ?? detail.split('\n')[0] ?? '').replace(/\s*(?:\(|\[)?exit(?:ed)?(?: code)?\s*[:=]?\s*-?\d+(?:\)|\])?\s*$/iu, '').trim()
  return raw ? unwrapShellCommand(raw) : null
}

function filesOf(payload: Record<string, unknown> | null): string[] {
  const data = record(payload?.data)
  const item = record(data?.item)
  const result = record(item?.result)
  const candidates = [payload?.changedFiles, data?.changedFiles, data?.files, result?.changedFiles, result?.files]
  const files: string[] = []
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const value of candidate) {
      const path = text(value) ?? text(record(value)?.path)
      if (path && !files.includes(path)) files.push(path)
    }
  }
  return files
}

function programOf(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? 'command'
  return first.replace(/^['"]|['"]$/gu, '').split('/').at(-1) || 'command'
}

function iconOf(itemType: string | null, task: boolean): WorkIcon {
  if (task) return 'bot'
  if (itemType === 'command_execution') return 'terminal'
  if (itemType === 'web_search') return 'search'
  if (itemType === 'mcp_tool_call') return 'wrench'
  if (itemType === 'dynamic_tool_call') return 'hammer'
  if (itemType === 'file_change') return 'hammer'
  return 'tone'
}

function isAgentSpawn(activity: EngineActivityView, payload: Record<string, unknown> | null): boolean {
  if (activity.kind !== 'task.started') return false
  const taskType = normalized(text(payload?.taskType) ?? '')
  const agentKind = normalized(text(payload?.agentKind) ?? '')
  return taskType.includes('agent') || (agentKind.length > 0 && agentKind !== 'background')
}

function failed(status: string | null, tone: EngineActivityView['tone']): boolean {
  return tone === 'error' || ['error', 'failed', 'declined', 'cancelled', 'canceled'].includes(normalized(status ?? ''))
}

function active(status: string | null): boolean {
  return ['running', 'inprogress', 'in progress', 'pending', 'started'].includes(normalized(status ?? ''))
}

function finish(entry: Omit<WorkEntry, 'heading' | 'preview' | 'expandedBody' | 'icon' | 'failed' | 'active'>): WorkEntry {
  const isTask = entry.sourceActivityKind.startsWith('task.')
  const isActive = active(entry.status)
  const heading = entry.command ? `${isActive ? 'Running' : 'Ran'} ${programOf(entry.command)}` : title(entry.label)
  const preview = entry.command ?? entry.detail ?? (entry.changedFiles.length > 0 ? `${entry.changedFiles[0]}${entry.changedFiles.length > 1 ? ` +${entry.changedFiles.length - 1} more` : ''}` : null)
  const body = [entry.command, entry.detail, entry.changedFiles.length ? entry.changedFiles.join('\n') : null].filter((value): value is string => Boolean(value?.trim())).join('\n\n') || null
  return { ...entry, heading, preview, expandedBody: body, icon: iconOf(entry.itemType, isTask), failed: failed(entry.status, entry.tone), active: isActive }
}

/** A call that never reported completion stops reading as live once its turn has settled. */
function settle(entry: WorkEntry): WorkEntry {
  if (!entry.active) return entry
  return { ...entry, active: false, heading: entry.command ? `Ran ${programOf(entry.command)}` : entry.heading }
}

function fromActivity(activity: EngineActivityView): WorkEntry {
  const payload = record(activity.payload)
  const data = record(payload?.data)
  const itemType = text(payload?.itemType) ?? (activity.kind.startsWith('task.') ? 'agent_task' : null)
  const detail = text(payload?.detail)
  const command = commandOf(payload, itemType, detail)
  return finish({
    id: activity.id,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
    sourceActivityKind: activity.kind,
    itemType,
    detail,
    data: payload?.data,
    status: statusOf(activity, payload),
    statusReported: text(payload?.status) !== null,
    toolCallId: text(payload?.toolCallId) ?? text(data?.toolCallId),
    label: text(payload?.toolTitle) ?? text(payload?.title) ?? activity.summary,
    command,
    changedFiles: filesOf(payload),
    tone: activity.tone,
  })
}

function canCollapse(previous: WorkEntry, next: WorkEntry): boolean {
  if (!['tool.updated', 'tool.completed'].includes(previous.sourceActivityKind) || !['tool.updated', 'tool.completed'].includes(next.sourceActivityKind)) return false
  if (previous.turnId !== next.turnId || previous.sourceActivityKind === 'tool.completed') return false
  if (previous.toolCallId && previous.toolCallId === next.toolCallId) return true
  return previous.toolCallId !== null && next.toolCallId === null && previous.itemType === next.itemType && normalized(previous.label) === normalized(next.label)
}

function merge(previous: WorkEntry, next: WorkEntry): WorkEntry {
  return finish({
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    itemType: next.itemType ?? previous.itemType,
    detail: next.detail ?? previous.detail,
    data: next.data ?? previous.data,
    status: next.status ?? previous.status,
    toolCallId: next.toolCallId ?? previous.toolCallId,
    label: next.label || previous.label,
    command: next.command ?? previous.command,
    changedFiles: [...new Set([...previous.changedFiles, ...next.changedFiles])],
    tone: next.tone === 'error' ? 'error' : previous.tone === 'error' ? 'error' : next.tone,
  })
}

function markerIdentity(entry: WorkEntry): string {
  return [entry.turnId ?? 'no-turn', entry.itemType ?? '', normalized(entry.label)].join('\u001f')
}

/**
 * An update that carries no call id and no reported status is a lifecycle
 * marker. When the same call later reports completion, the marker is the
 * same call seen twice and must not count as a second one (T3's
 * omitSupersededLifecycleMarkers).
 */
function omitSupersededMarkers(entries: readonly WorkEntry[]): WorkEntry[] {
  const terminal = new Set<string>()
  const kept: WorkEntry[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    const identity = markerIdentity(entry)
    const marker = entry.toolCallId === null && !entry.statusReported && entry.sourceActivityKind === 'tool.updated'
    if (marker && terminal.has(identity)) continue
    kept.push(entry)
    if (entry.sourceActivityKind === 'tool.completed' || (entry.statusReported && entry.status !== 'inProgress')) terminal.add(identity)
  }
  return kept.reverse()
}

/** Convert the raw activity feed into one display row per completed or live call. */
export function deriveWorkEntries(activities: readonly EngineActivityView[]): WorkEntry[] {
  const raw: WorkEntry[] = []
  for (const activity of activities) {
    if (activity.kind === 'tool.started' || activity.kind === 'context-window.updated') continue
    if (activity.kind === 'task.started' && !isAgentSpawn(activity, record(activity.payload))) continue
    if (!['tool.updated', 'tool.completed', 'task.started', 'task.updated', 'task.completed', 'runtime.error', 'runtime.warning'].includes(activity.kind)) continue
    raw.push(fromActivity(activity))
  }
  const entries: WorkEntry[] = []
  for (const entry of omitSupersededMarkers(raw)) {
    const previous = entries.at(-1)
    if (previous && canCollapse(previous, entry)) entries[entries.length - 1] = merge(previous, entry)
    else entries.push(entry)
  }
  return entries
}

function workAction(entry: WorkEntry): 'command' | 'edit' | 'search' | 'other' | 'update' {
  if (entry.itemType === 'command_execution') return 'command'
  if (entry.itemType === 'file_change') return 'edit'
  if (entry.itemType === 'web_search') return 'search'
  if (entry.itemType === 'mcp_tool_call' || entry.itemType === 'dynamic_tool_call' || entry.itemType === 'agent_task') return 'other'
  return 'update'
}

function actionLabel(action: ReturnType<typeof workAction>, count: number): string {
  if (action === 'command') return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
  if (action === 'edit') return `Changed ${count} ${count === 1 ? 'file' : 'files'}`
  if (action === 'search') return `Searched the web ${count} ${count === 1 ? 'time' : 'times'}`
  if (action === 'other') return `Used ${count} ${count === 1 ? 'tool' : 'tools'}`
  return `Received ${count} ${count === 1 ? 'update' : 'updates'}`
}

function summarize(entries: readonly WorkEntry[]): string {
  const counts = new Map<ReturnType<typeof workAction>, number>()
  for (const entry of entries) counts.set(workAction(entry), (counts.get(workAction(entry)) ?? 0) + 1)
  const labels = [...counts].map(([action, count]) => actionLabel(action, count))
  if (labels.length < 2) return labels[0] ?? 'Tool updated'
  const sentences = labels.map((label, index) => index === 0 ? label : `${label[0]!.toLocaleLowerCase()}${label.slice(1)}`)
  if (sentences.length === 2) return sentences.join(' and ')
  return `${sentences.slice(0, -1).join(', ')}, and ${sentences.at(-1)}`
}

/** Group consecutive work between prose messages, preserving the transcript's chronology. */
export function groupWorkRows(entries: readonly WorkEntry[], turns: readonly WorkTurn[], messages: readonly WorkMessageBoundary[] = []): WorkGroupRow[] {
  return turns.flatMap((turn) => {
    const timeline = [
      ...entries.filter((entry) => (entry.turnId ?? 'thread') === turn.id).map((entry) => ({ kind: 'work' as const, createdAt: entry.createdAt, id: entry.id, entry })),
      ...messages.filter((message) => (message.turnId ?? 'thread') === turn.id).map((message) => ({ kind: 'message' as const, createdAt: message.createdAt, id: message.id })),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || (left.kind === right.kind ? 0 : left.kind === 'message' ? -1 : 1))
    const segments: WorkEntry[][] = []
    let segment: WorkEntry[] = []
    for (const row of timeline) {
      if (row.kind === 'message') {
        if (segment.length) segments.push(segment)
        segment = []
      } else segment.push(row.entry)
    }
    if (segment.length) segments.push(segment)
    if (segments.length === 0 && turn.running) segments.push([])
    return segments.map((settledEntries, index) => {
      const lastTimelineRow = timeline.at(-1)
      const live = turn.running === true && index === segments.length - 1 && lastTimelineRow?.kind !== 'message'
      const grouped = turn.running ? settledEntries : settledEntries.map(settle)
      const first = grouped[0]
      return {
        id: `${turn.id}:work:${first?.id ?? 'live'}`,
        turnId: turn.id,
        createdAt: first?.createdAt ?? new Date().toISOString(),
        entries: grouped,
        hiddenCount: grouped.length,
        summary: summarize(grouped),
        summaryIcon: grouped[0]?.icon ?? 'tone',
        hasFailure: grouped.some((entry) => entry.failed),
        live,
        foldedByDefault: true,
        showWorking: live,
        showThinking: live && !grouped.some((entry) => entry.active),
      }
    })
  })
}

export interface TurnFoldMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  updatedAt?: string | undefined
  streaming: boolean
}

/** T3's latest turn as the fold reads it (`EngineTurnView`). */
export interface TurnTiming {
  id: string
  state: 'running' | 'completed' | 'interrupted' | 'error'
  startedAt: string | null
  completedAt: string | null
}

export type TurnRow<M extends TurnFoldMessage = TurnFoldMessage> =
  | { kind: 'message'; id: string; createdAt: string; endedAt: string; message: M }
  | { kind: 'work'; id: string; createdAt: string; endedAt: string; group: WorkGroupRow }

export interface TurnFoldInput<M extends TurnFoldMessage = TurnFoldMessage> {
  id: string
  messages: readonly M[]
  groups: readonly WorkGroupRow[]
  /** The session is working on this turn. */
  running: boolean
  latestTurn: TurnTiming | null
}

export interface TurnFold {
  turnId: string
  /** The first hidden row; the disclosure sits where it was. */
  anchorId: string
  hiddenIds: string[]
  label: string
  duration: string | null
  interrupted: boolean
  hasFailure: boolean
}

/** T3's duration format: tenths under ten seconds, whole seconds under a minute, then minutes and seconds. */
export function formatWorkDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms'
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10
    return tenths >= 10 ? '10s' : `${tenths.toFixed(1)}s`
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  if (seconds === 0) return `${minutes}m`
  if (seconds === 60) return `${minutes + 1}m`
  return `${minutes}m ${seconds}s`
}

function elapsedMs(startedAt: string, endedAt: string): number | null {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
}

function laterStamp(left: string, right: string): string {
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (!Number.isFinite(leftMs)) return right
  if (!Number.isFinite(rightMs)) return left
  return rightMs > leftMs ? right : left
}

/** Messages and work groups in transcript order, each with the time it ended. */
export function turnRows<M extends TurnFoldMessage>(messages: readonly M[], groups: readonly WorkGroupRow[]): TurnRow<M>[] {
  const rows: TurnRow<M>[] = [
    ...messages.map((message) => ({ kind: 'message' as const, id: message.id, createdAt: message.createdAt, endedAt: message.updatedAt ?? message.createdAt, message })),
    ...groups.map((group) => ({ kind: 'work' as const, id: group.id, createdAt: group.createdAt, endedAt: group.entries.at(-1)?.createdAt ?? group.createdAt, group })),
  ]
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/**
 * T3's unsettled rule: the session's running turn, the latest turn while it is
 * running or has no completion stamp, and any turn still streaming stay open.
 * Keying on turn lifecycle keeps the previous turn folded in the moment after
 * Send, before the server creates the new turn.
 */
export function turnSettled(turn: TurnFoldInput): boolean {
  if (turn.running) return false
  if (turn.messages.some((message) => message.streaming)) return false
  if (turn.latestTurn?.id === turn.id && (turn.latestTurn.state === 'running' || turn.latestTurn.completedAt === null)) return false
  return true
}

/**
 * A settled turn keeps the owner's messages and its final assistant answer
 * visible; every other row folds behind one disclosure labelled with the
 * whole turn's duration (§6.9). Nothing to hide means no fold.
 */
export function deriveTurnFold<M extends TurnFoldMessage>(turn: TurnFoldInput<M>): TurnFold | null {
  if (!turnSettled(turn)) return null
  const rows = turnRows(turn.messages, turn.groups)
  const terminal = rows.findLast((row) => row.kind === 'message' && row.message.role === 'assistant')
  const hidden = rows.filter((row) => row.id !== terminal?.id && !(row.kind === 'message' && row.message.role === 'user'))
  const anchor = hidden[0]
  const first = rows[0]
  const last = rows.at(-1)
  if (!anchor || !first || !last) return null
  const interrupted = turn.latestTurn?.id === turn.id && turn.latestTurn.state === 'interrupted'
  const timed = turn.latestTurn?.id === turn.id && turn.latestTurn.startedAt && turn.latestTurn.completedAt
    ? elapsedMs(turn.latestTurn.startedAt, turn.latestTurn.completedAt)
    : elapsedMs(first.createdAt, terminal ? laterStamp(terminal.endedAt, last.endedAt) : last.endedAt)
  const duration = timed === null ? null : formatWorkDuration(timed)
  const label = interrupted
    ? duration ? `You stopped after ${duration}` : 'You stopped this response'
    : duration ? `Worked for ${duration}` : 'Worked'
  return {
    turnId: turn.id,
    anchorId: anchor.id,
    hiddenIds: hidden.map((row) => row.id),
    label,
    duration,
    interrupted,
    hasFailure: hidden.some((row) => row.kind === 'work' && row.group.hasFailure),
  }
}
