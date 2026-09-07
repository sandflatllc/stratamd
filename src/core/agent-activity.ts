import type { EngineActivityView } from '../shared/contracts'

/**
 * Subagents from T3's `task.*` activities (docs/design/subagent-activity).
 * One run per task id; the title row draws one arc per run, six to a
 * cluster, and the Agents dialog lists them as a tree.
 */

export type AgentRunState = 'working' | 'done' | 'failed' | 'waiting'

export interface AgentRun {
  /** T3's task id. */
  id: string
  turnId: string | null
  /** Activity ids that fed this run, first is the spawn; Show in transcript finds the work row by them. */
  activityIds: string[]
  /** The `Agent` tool call that started it, when T3 reports one. */
  toolUseId: string | null
  title: string
  role: string | null
  model: string | null
  modelLabel: string | null
  effort: string | null
  state: AgentRunState
  status: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  tokens: number | null
  toolUses: number | null
  lastToolName: string | null
  /** What it is doing now, from the latest progress line. */
  detail: string | null
  /** Its report, from completion. */
  summary: string | null
  error: string | null
  parentId: string | null
  depth: number
  /** Codex reports the exact tree; Claude runs are placed by inference (see `deriveAgentRuns`). */
  depthKnown: boolean
}

export interface BackgroundTask {
  id: string
  title: string
  state: AgentRunState
  startedAt: string
  endedAt: string | null
  durationMs: number | null
}

export interface AgentSummary {
  total: number
  working: number
  done: number
  failed: number
  waiting: number
  tokens: number
  depth: number
}

export const CLUSTER_SIZE = 6

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalized(value: string | null): string {
  return (value ?? '').replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function isAgentTask(payload: Record<string, unknown>): boolean {
  const taskType = normalized(text(payload.taskType))
  const agentKind = normalized(text(payload.agentKind))
  if (agentKind === 'background' || taskType.includes('bash') || taskType.includes('command')) return false
  return taskType.includes('agent') || agentKind === 'agent' || (agentKind.length > 0 && taskType.length === 0)
}

function isBackgroundTask(payload: Record<string, unknown>): boolean {
  return normalized(text(payload.agentKind)) === 'background' || normalized(text(payload.taskType)).includes('bash')
}

function stateOf(status: string | null, tone: EngineActivityView['tone'], ended: boolean): AgentRunState {
  const value = normalized(status)
  if (tone === 'error' || ['failed', 'error', 'errored'].includes(value)) return 'failed'
  if (['completed', 'complete', 'succeeded', 'success', 'stopped', 'cancelled', 'canceled', 'killed'].includes(value)) return 'done'
  if (['idle', 'waiting', 'blocked', 'paused', 'needs input', 'input required'].includes(value)) return 'waiting'
  if (ended) return 'done'
  return 'working'
}

/** "claude-fable-5-1" reads "Fable 5.1", "claude-haiku-4-5-20251001" reads "Haiku 4.5", "gpt-6-astra" reads "Astra". */
export function agentModelLabel(slug: string | null): string | null {
  if (!slug || slug.startsWith('<')) return null
  const parts = slug.split(/[-_]/u).filter(Boolean)
  const vendor = parts[0]?.toLowerCase()
  if (vendor === 'claude' || vendor === 'gpt' || vendor === 'codex' || vendor === 'o') parts.shift()
  const words: string[] = []
  const version: string[] = []
  for (const part of parts) {
    if (/^\d{8}$/u.test(part)) continue
    if (/^\d+$/u.test(part)) { version.push(part); continue }
    if (version.length && words.length) break
    words.push(part[0]!.toLocaleUpperCase() + part.slice(1))
  }
  const name = words.join(' ')
  const number = version.join('.')
  if (vendor === 'gpt' && name) return name
  return [name, number].filter(Boolean).join(' ') || slug
}

interface Working { run: AgentRun; agentPath: string | null }

function usageOf(payload: Record<string, unknown>): { durationMs: number | null; tokens: number | null; toolUses: number | null } {
  const usage = record(payload.usage)
  const typed = record(payload.typedUsage)
  return {
    durationMs: number(usage?.duration_ms) ?? number(typed?.durationMs),
    tokens: number(usage?.total_tokens) ?? number(typed?.totalTokens),
    toolUses: number(usage?.tool_uses) ?? number(typed?.toolUses),
  }
}

/**
 * One run per task, in spawn order. Depth comes from Codex's `agentPath`
 * when present. Otherwise a spawn whose tool call is not one of the main
 * thread's own calls, arriving while another run is working, belongs to
 * the shallowest working run, newest first among equals: agents fan out
 * far more often than they chain. Anything else sits at level 1.
 */
export function deriveAgentRuns(activities: readonly EngineActivityView[]): AgentRun[] {
  const mainToolCalls = new Set<string>()
  for (const activity of activities) {
    if (!activity.kind.startsWith('tool.')) continue
    const payload = record(activity.payload)
    const id = text(payload?.toolCallId) ?? text(record(payload?.data)?.toolCallId)
    if (id) mainToolCalls.add(id)
  }
  const runs = new Map<string, Working>()
  const order: string[] = []
  for (const activity of activities) {
    if (!activity.kind.startsWith('task.')) continue
    const payload = record(activity.payload)
    if (!payload || !isAgentTask(payload)) continue
    const taskId = text(payload.taskId) ?? text(payload.toolUseId) ?? activity.id
    const status = text(payload.status)
    const ended = activity.kind === 'task.completed' || text(payload.endedAt) !== null
    const usage = usageOf(payload)
    const agentPath = text(payload.agentPath)
    let working = runs.get(taskId)
    if (!working) {
      const toolUseId = text(payload.toolUseId)
      const run: AgentRun = {
        id: taskId, turnId: activity.turnId, activityIds: [], toolUseId,
        title: text(payload.title) ?? text(payload.detail) ?? activity.summary,
        role: text(payload.role) ?? text(record(record(payload.data)?.input)?.subagent_type),
        model: text(payload.model), modelLabel: agentModelLabel(text(payload.model)), effort: text(payload.effort),
        state: 'working', status: null, startedAt: activity.createdAt, endedAt: null,
        durationMs: null, tokens: null, toolUses: null, lastToolName: null, detail: null, summary: null, error: null,
        parentId: null, depth: 1, depthKnown: false,
      }
      if (agentPath) {
        const segments = agentPath.split('/').filter(Boolean)
        run.depth = Math.max(1, segments.length - 1)
        run.depthKnown = true
        const parentPath = `/${segments.slice(0, -1).join('/')}`
        run.parentId = order.map((id) => runs.get(id)!).find((candidate) => candidate.agentPath === parentPath)?.run.id ?? null
      } else if (!(toolUseId && mainToolCalls.has(toolUseId))) {
        const working = order.map((id) => runs.get(id)!.run).filter((candidate) => candidate.state === 'working')
        const shallowest = Math.min(...working.map((candidate) => candidate.depth))
        const parent = working.filter((candidate) => candidate.depth === shallowest).at(-1)
        if (parent && toolUseId) { run.parentId = parent.id; run.depth = parent.depth + 1 }
      } else run.depthKnown = true
      working = { run, agentPath }
      runs.set(taskId, working)
      order.push(taskId)
    }
    const run = working.run
    run.activityIds.push(activity.id)
    if (agentPath && !working.agentPath) working.agentPath = agentPath
    if (text(payload.title)) run.title = text(payload.title)!
    if (text(payload.role)) run.role = text(payload.role)
    if (text(payload.model) && !run.model) { run.model = text(payload.model); run.modelLabel = agentModelLabel(run.model) }
    if (text(payload.effort)) run.effort = text(payload.effort)
    if (text(payload.toolUseId) && !run.toolUseId) run.toolUseId = text(payload.toolUseId)
    if (usage.durationMs !== null) run.durationMs = usage.durationMs
    if (usage.tokens !== null) run.tokens = usage.tokens
    if (usage.toolUses !== null) run.toolUses = usage.toolUses
    if (text(payload.lastToolName)) run.lastToolName = text(payload.lastToolName)
    if (activity.kind === 'task.progress' && text(payload.detail)) run.detail = text(payload.detail)!.replace(/^Running\s+/u, '')
    if (activity.kind === 'task.completed') {
      run.summary = text(payload.summary) ?? text(payload.detail) ?? run.summary
      run.detail = null
    }
    if (text(payload.error)) run.error = text(payload.error)
    if (text(payload.endedAt)) run.endedAt = text(payload.endedAt)
    else if (activity.kind === 'task.completed' && !run.endedAt) run.endedAt = activity.createdAt
    if (status || ended) {
      run.status = status ?? run.status
      run.state = stateOf(run.status, activity.tone, ended)
      if (run.state === 'failed' && !run.error) run.error = text(payload.summary) ?? text(payload.detail)
    }
  }
  return order.map((id) => runs.get(id)!.run)
}

/** Background commands T3 runs beside the agents, for the dialog's footer section. */
export function deriveBackgroundTasks(activities: readonly EngineActivityView[]): BackgroundTask[] {
  const tasks = new Map<string, BackgroundTask>()
  for (const activity of activities) {
    if (!activity.kind.startsWith('task.')) continue
    const payload = record(activity.payload)
    if (!payload || !isBackgroundTask(payload)) continue
    const id = text(payload.taskId) ?? activity.id
    const ended = activity.kind === 'task.completed' || text(payload.endedAt) !== null
    const status = text(payload.status)
    const existing = tasks.get(id)
    const task: BackgroundTask = existing ?? { id, title: text(payload.title) ?? text(payload.detail) ?? activity.summary, state: 'working', startedAt: activity.createdAt, endedAt: null, durationMs: null }
    if (text(payload.title)) task.title = text(payload.title)!
    if (status || ended) task.state = stateOf(status, activity.tone, ended)
    if (ended) task.endedAt = text(payload.endedAt) ?? activity.createdAt
    task.durationMs = usageOf(payload).durationMs ?? task.durationMs
    tasks.set(id, task)
  }
  return [...tasks.values()]
}

/** Spawn order with each parent's children right after it, so a family fills adjacent slots. */
export function orderAgentRuns(runs: readonly AgentRun[]): AgentRun[] {
  const out: AgentRun[] = []
  const seen = new Set<string>()
  const walk = (parentId: string | null) => {
    for (const run of runs) {
      if ((run.parentId ?? null) !== parentId || seen.has(run.id)) continue
      seen.add(run.id)
      out.push(run)
      walk(run.id)
    }
  }
  walk(null)
  for (const run of runs) if (!seen.has(run.id)) { seen.add(run.id); out.push(run) }
  return out
}

/** Six arcs to a cluster; the seventh run starts the next. */
export function clusterAgentRuns(runs: readonly AgentRun[], size = CLUSTER_SIZE): AgentRun[][] {
  const ordered = orderAgentRuns(runs)
  const clusters: AgentRun[][] = []
  for (let index = 0; index < ordered.length; index += size) clusters.push(ordered.slice(index, index + size))
  return clusters
}

export function summarizeAgentRuns(runs: readonly AgentRun[]): AgentSummary {
  const summary: AgentSummary = { total: runs.length, working: 0, done: 0, failed: 0, waiting: 0, tokens: 0, depth: 0 }
  for (const run of runs) {
    summary[run.state] += 1
    summary.tokens += run.tokens ?? 0
    summary.depth = Math.max(summary.depth, run.depth)
  }
  return summary
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** Elapsed time for a run: T3's reported duration, else the span of its activities, else since it started. */
export function agentRunElapsedMs(run: Pick<AgentRun, 'durationMs' | 'startedAt' | 'endedAt' | 'state'>, now: number): number | null {
  if (run.durationMs !== null) return run.durationMs
  const started = Date.parse(run.startedAt)
  if (Number.isNaN(started)) return null
  if (run.endedAt) { const ended = Date.parse(run.endedAt); return Number.isNaN(ended) ? null : Math.max(0, ended - started) }
  return run.state === 'working' || run.state === 'waiting' ? Math.max(0, now - started) : null
}
