import { useRef, useState } from 'react'
import { useDialogFocus } from '../useDialogFocus'
import { agentRunElapsedMs, clusterAgentRuns, formatTokenCount, orderAgentRuns, summarizeAgentRuns, type AgentRun, type AgentRunState, type BackgroundTask } from '../../core/agent-activity'
import { formatWorkDuration } from '../../core/work-log'

// Subagent clusters (§6.9 Agents, decided 2026-09-06): one bot per six agents
// in the conversation title row, one arc per agent coloured by state, and the
// Agents dialog behind a click. docs/design/subagent-activity holds the mockup.

const STATE_LABEL: Record<AgentRunState, string> = { working: 'working', done: 'done', failed: 'failed', waiting: 'waiting on you' }

/** Arc for slot `index` of six, clockwise from the top. Depth shortens the dash: level 1 is 40°, level 2 26°, deeper 14°. */
function arcPath(index: number, depth: number): string {
  const span = depth <= 1 ? 40 : depth === 2 ? 26 : 14
  const centre = -90 + index * 60
  const from = (centre - span / 2) * Math.PI / 180
  const to = (centre + span / 2) * Math.PI / 180
  const radius = 11
  const origin = 13
  const point = (angle: number) => `${(origin + radius * Math.cos(angle)).toFixed(2)} ${(origin + radius * Math.sin(angle)).toFixed(2)}`
  return `M${point(from)} A${radius} ${radius} 0 0 1 ${point(to)}`
}

function Bot() {
  return <g className="conversation-agent-bot" aria-hidden="true">
    <rect x="8.5" y="10.5" width="9" height="7.5" rx="2" />
    <path d="M13 10.5V7.5" />
    <circle cx="13" cy="6.8" r=".9" data-fill />
    <circle cx="11.2" cy="14.3" r=".9" data-fill />
    <circle cx="14.8" cy="14.3" r=".9" data-fill />
  </g>
}

function clusterLabel(runs: readonly AgentRun[], first: number): string {
  const counts = summarizeAgentRuns(runs)
  const parts = (['working', 'waiting', 'failed', 'done'] as const).filter((state) => counts[state] > 0).map((state) => `${counts[state]} ${STATE_LABEL[state]}`)
  return `Agents ${first + 1} to ${first + runs.length}: ${parts.join(', ')}`
}

export function AgentClusters({ runs, collapsed, onToggle, onOpen, maxClusters = 12 }: {
  runs: readonly AgentRun[]
  collapsed: boolean
  onToggle(): void
  onOpen(focus?: string): void
  /** Beyond this many clusters the row folds to the summary bot on its own; the side placement passes a smaller number. */
  maxClusters?: number
}) {
  if (runs.length === 0) return null
  const clusters = clusterAgentRuns(runs)
  const summary = summarizeAgentRuns(runs)
  const forced = clusters.length > maxClusters
  const folded = collapsed || forced
  const summaryLabel = `${summary.total} ${summary.total === 1 ? 'agent' : 'agents'}: ${(['working', 'waiting', 'failed', 'done'] as const).filter((state) => summary[state] > 0).map((state) => `${summary[state]} ${STATE_LABEL[state]}`).join(', ')}`
  return <div className="conversation-agents" data-collapsed={folded || undefined} data-working={summary.working > 0 || undefined} role="group" aria-label="Agents in this turn">
    {folded
      ? <button type="button" className="conversation-agent-cluster" aria-label={summaryLabel} title={summaryLabel} onClick={() => onOpen()}>
        <svg viewBox="0 0 26 26"><Bot />{summary.working > 0 && <path className="conversation-agent-arc" data-state="working" d={arcPath(0, 1)} />}</svg>
      </button>
      : clusters.map((cluster, clusterIndex) => {
        const label = clusterLabel(cluster, clusterIndex * 6)
        return <button type="button" className="conversation-agent-cluster" key={cluster[0]!.id} aria-label={label} title={label} onClick={() => onOpen(cluster[0]!.id)}>
          <svg viewBox="0 0 26 26"><Bot />{cluster.map((run, index) => <path className="conversation-agent-arc" key={run.id} data-state={run.state} data-depth={Math.min(run.depth, 3)} d={arcPath(index, run.depth)}><title>{`${run.title} · level ${run.depth} · ${STATE_LABEL[run.state]}`}</title></path>)}</svg>
        </button>
      })}
    {/* Past the placement's cap the row folds on its own and the chevron would change nothing; it stays only to clear a saved fold. */}
    {(!forced || collapsed) && <button type="button" className="conversation-agents-toggle" aria-expanded={!collapsed} aria-label={collapsed ? 'Show agent clusters' : 'Hide agent clusters'} title={collapsed ? 'Show agent clusters' : 'Hide agent clusters'} onClick={onToggle}>
      <svg viewBox="0 0 12 12" aria-hidden="true">{collapsed ? <path d="M4 2.5 7.5 6 4 9.5" /> : <path d="M2.5 4.5 6 8l3.5-3.5" />}</svg>
    </button>}
  </div>
}

type Filter = 'all' | AgentRunState

function AgentRow({ run, now, focused, onShow }: { run: AgentRun; now: number; focused: boolean; onShow?(run: AgentRun): void }) {
  const elapsed = agentRunElapsedMs(run, now)
  const line = run.state === 'working'
    ? <p className="conversation-agent-now"><b>Running</b> {run.detail ?? run.title}{run.lastToolName && <code>{run.lastToolName}</code>}</p>
    : run.state === 'waiting'
      ? <p className="conversation-agent-now" data-tone="waiting"><b>Waiting</b> {run.detail ?? 'The agent needs an answer before it continues.'}</p>
      : run.state === 'failed'
        ? <p className="conversation-agent-now" data-tone="error">{run.error ?? 'The agent stopped with an error.'}</p>
        : run.summary ? <p className="conversation-agent-report">{run.summary}</p> : null
  return <article className="conversation-agent" data-depth={Math.min(run.depth, 3)} data-state={run.state} data-focus={focused || undefined} data-agent-id={run.id}>
    <span className="conversation-agent-dot" data-state={run.state} aria-hidden="true" />
    <div className="conversation-agent-body">
      <h3>
        <span className="conversation-agent-title">{run.title}</span>
        <small className="conversation-agent-level" title={run.depthKnown ? 'Level reported by the engine' : 'Level inferred from which agent was working when this one started'}>L{run.depth}{run.depthKnown ? '' : '?'}</small>
        {run.role && <span className="conversation-agent-tag">{run.role}</span>}
        {run.modelLabel && <span className="conversation-agent-tag">{run.modelLabel}</span>}
        {run.effort && <span className="conversation-agent-tag">{run.effort}</span>}
      </h3>
      {line}
      {onShow && <div className="conversation-agent-actions"><button type="button" onClick={() => onShow(run)}>Show in transcript</button></div>}
    </div>
    <div className="conversation-agent-meta">
      {elapsed !== null && <b>{formatWorkDuration(elapsed)}{run.state === 'working' || run.state === 'waiting' ? ' so far' : ''}</b>}
      {(run.tokens !== null || run.toolUses !== null) && <span>{[run.tokens !== null ? `${formatTokenCount(run.tokens)} tokens` : null, run.toolUses !== null ? `${run.toolUses} tool ${run.toolUses === 1 ? 'use' : 'uses'}` : null].filter(Boolean).join(' · ')}</span>}
    </div>
  </article>
}

export function AgentsDialog({ runs, background, focus, now, onClose, onShow, canShow = () => true }: {
  runs: readonly AgentRun[]
  background: readonly BackgroundTask[]
  focus?: string | undefined
  now: number
  onClose(): void
  onShow?(run: AgentRun): void
  /** Whether the transcript holds a row for the run; Show in transcript is offered only then. */
  canShow?(run: AgentRun): boolean
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState<Filter>('all')
  useDialogFocus(dialogRef, onClose)
  const summary = summarizeAgentRuns(runs)
  const ordered = orderAgentRuns(runs)
  const shown = filter === 'all' ? ordered : ordered.filter((run) => run.state === filter)
  const inferred = runs.some((run) => !run.depthKnown && run.depth > 1)
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} tabIndex={-1} className="modal conversation-agents-modal" role="dialog" aria-modal="true" aria-labelledby="conversation-agents-title">
      <header>
        <h2 id="conversation-agents-title">Agents</h2>
        <p className="modal-subtitle">{summary.total === 1 ? '1 agent' : `${summary.total} agents`} in this turn</p>
        <button type="button" className="conversation-agents-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="conversation-agents-strip" aria-label="Agent counts">
        <span><i className="conversation-agent-dot" data-state="working" aria-hidden="true" />{summary.working} working</span>
        <span><i className="conversation-agent-dot" data-state="done" aria-hidden="true" />{summary.done} done</span>
        {summary.waiting > 0 && <span><i className="conversation-agent-dot" data-state="waiting" aria-hidden="true" />{summary.waiting} waiting</span>}
        <span><i className="conversation-agent-dot" data-state="failed" aria-hidden="true" />{summary.failed} failed</span>
        {summary.tokens > 0 && <span>{formatTokenCount(summary.tokens)} tokens across agents</span>}
        <span>{summary.depth} {summary.depth === 1 ? 'level' : 'levels'} deep</span>
      </div>
      <div className="conversation-agents-filters" role="group" aria-label="Show">
        {(['all', 'working', 'waiting', 'done', 'failed'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </div>
      <div className="conversation-agents-list">
        {shown.length === 0 && <p className="conversation-agents-empty">No agents are {filter} in this turn.</p>}
        {shown.map((run) => <AgentRow key={run.id} run={run} now={now} focused={run.id === focus} {...(onShow && canShow(run) ? { onShow } : {})} />)}
        {background.length > 0 && <>
          <h3 className="conversation-agents-section">Background commands</h3>
          {background.map((task) => {
            const elapsed = agentRunElapsedMs({ durationMs: task.durationMs, startedAt: task.startedAt, endedAt: task.endedAt, state: task.state }, now)
            return <div className="conversation-agent-background" key={task.id}><span className="conversation-agent-dot" data-state={task.state} aria-hidden="true" /><span>{task.title}</span>{elapsed !== null && <small>{formatWorkDuration(elapsed)}</small>}</div>
          })}
        </>}
      </div>
      <footer className="modal-fineprint">{inferred ? 'A level marked ? is inferred from which agent was working when that one started; this engine does not report the tree.' : 'Level shows which agent issued the call. Agents you start sit at L1.'}</footer>
    </section>
  </div>
}
