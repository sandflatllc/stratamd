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

/** Convert the raw activity feed into one display row per completed or live call. */
export function deriveWorkEntries(activities: readonly EngineActivityView[]): WorkEntry[] {
  const entries: WorkEntry[] = []
  for (const activity of activities) {
    if (activity.kind === 'tool.started' || activity.kind === 'context-window.updated') continue
    if (activity.kind === 'task.started' && !isAgentSpawn(activity, record(activity.payload))) continue
    if (!['tool.updated', 'tool.completed', 'task.started', 'task.updated', 'task.completed', 'runtime.error', 'runtime.warning'].includes(activity.kind)) continue
    const entry = fromActivity(activity)
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
    return segments.map((grouped, index) => {
      const lastTimelineRow = timeline.at(-1)
      const live = turn.running === true && index === segments.length - 1 && lastTimelineRow?.kind !== 'message'
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
        foldedByDefault: !live,
        showWorking: live,
        showThinking: live && !grouped.some((entry) => entry.active),
      }
    })
  })
}
