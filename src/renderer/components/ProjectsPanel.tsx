import { useState } from 'react'
import type { EngineThreadChange, EngineThreadView, EngineView } from '../../shared/contracts'

interface ProjectsPanelProps {
  engine: EngineView
  onOpenThread(threadId: string): void
  onReconnect(): void
  /** New thread from here opens the picker with no document (§5.2). */
  onNewThread(): void
  onAction(threadId: string, action: 'archive' | 'settle' | 'delete'): void
  /** T3's other row actions (§5.2): pin, snooze, rename. */
  onUpdate(threadId: string, change: EngineThreadChange): void
  onRename(thread: EngineThreadView): void
  /** Opens the engine dialog: pairing, server, version, and connection state (§5.1). */
  onOpenEngine?(): void
  /** Opens the Accounts modal (§5.13), the same one the top bar's engine status opens. */
  onOpenAccounts?(): void
  now?: () => number
}

/** Snooze presets, as T3 offers them: the wake time is what the server stores. */
export function snoozeUntil(choice: 'hour' | 'tomorrow' | 'week', nowMs: number): string {
  const date = new Date(nowMs)
  if (choice === 'hour') return new Date(nowMs + 3_600_000).toISOString()
  date.setDate(date.getDate() + (choice === 'tomorrow' ? 1 : 7))
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}

/** Pinned threads first in pin order, then the rest as T3 lists them (§5.2). */
export function orderThreads(threads: readonly EngineThreadView[]): EngineThreadView[] {
  return [...threads].sort((a, b) => {
    if (a.pinnedAt && b.pinnedAt) return a.pinnedAt.localeCompare(b.pinnedAt)
    if (a.pinnedAt) return -1
    if (b.pinnedAt) return 1
    return 0
  })
}

function isSnoozed(thread: EngineThreadView, nowMs: number): boolean {
  return thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > nowMs
}

function stateLine(thread: EngineThreadView, nowMs: number): string {
  const parts: string[] = [thread.status]
  if (thread.pendingApprovals) parts.push('approval')
  if (thread.pendingUserInput) parts.push('answer needed')
  if (isSnoozed(thread, nowMs)) parts.push(`snoozed until ${new Date(thread.snoozedUntil!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`)
  if (thread.pendingWork > 0) parts.push(`${thread.pendingWork} pending`)
  return parts.join(' · ')
}

export function ProjectsPanel({ engine, onOpenThread, onReconnect, onNewThread, onAction, onUpdate, onRename, onOpenEngine, onOpenAccounts, now = Date.now }: ProjectsPanelProps) {
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null)
  if (engine.state === 'unpaired') return (
    <div className="engine-empty" data-testid="engine-unpaired">
      No engine paired.
      <small>Pair StrataMD with your T3 server to see its projects.</small>
      {onOpenEngine && <button type="button" onClick={onOpenEngine}>Pair engine</button>}
    </div>
  )
  if (engine.state === 'disconnected' || engine.state === 'connecting') return (
    <div className="engine-empty" data-testid="engine-disconnected">
      {engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.
      <button type="button" onClick={onReconnect}>Reconnect</button>
    </div>
  )
  const nowMs = now()
  return <div className="projects-panel">
    <button type="button" onClick={onNewThread}>New thread</button>
    {onOpenAccounts && <button type="button" onClick={onOpenAccounts}>Accounts</button>}
    {engine.projects.map((project) => <section className="project-group" key={project.id}>
      <h3>{project.title}</h3>
      <small>{project.workspaceRoot}</small>
      {orderThreads(project.threads).map((thread) => {
        const snoozed = isSnoozed(thread, nowMs)
        return <div className={`project-thread ${thread.id === engine.activeThreadId ? 'active' : ''}`} data-thread={thread.id} data-pinned={thread.pinnedAt !== null} data-snoozed={snoozed} key={thread.id}>
          <button type="button" aria-label={`Open ${thread.title}`} onClick={() => onOpenThread(thread.id)}>
            <span>{thread.unread && <i className="unread-dot" aria-label="Unread" />}{thread.pinnedAt && <i className="pin-mark" aria-label="Pinned" title="Pinned">📌</i>}{thread.title}{thread.attention > 0 && <span className="tab-badge attention-badge" aria-label={`${thread.attention} new`}>{thread.attention}</span>}</span>
            <small>{stateLine(thread, nowMs)}</small>
          </button>
          <span className="project-row-actions">
            <button type="button" aria-label={`${thread.pinnedAt ? 'Unpin' : 'Pin'} ${thread.title}`} onClick={() => onUpdate(thread.id, { pinned: !thread.pinnedAt })}>{thread.pinnedAt ? 'Unpin' : 'Pin'}</button>
            <button type="button" aria-label={`Rename ${thread.title}`} onClick={() => onRename(thread)}>Rename</button>
            {snoozed
              ? <button type="button" aria-label={`Unsnooze ${thread.title}`} onClick={() => onUpdate(thread.id, { snoozedUntil: null })}>Unsnooze</button>
              : <button type="button" aria-label={`Snooze ${thread.title}`} aria-expanded={snoozeMenu === thread.id} onClick={() => setSnoozeMenu(snoozeMenu === thread.id ? null : thread.id)}>Snooze</button>}
            <button type="button" aria-label={`Settle ${thread.title}`} onClick={() => onAction(thread.id, 'settle')}>Settle</button>
            <button type="button" aria-label={`Archive ${thread.title}`} onClick={() => onAction(thread.id, 'archive')}>Archive</button>
            <button type="button" aria-label={`Delete ${thread.title}`} onClick={() => onAction(thread.id, 'delete')}>Delete</button>
          </span>
          {snoozeMenu === thread.id && <div className="snooze-menu" role="menu" aria-label={`Snooze ${thread.title} until`}>
            {([['hour', 'An hour'], ['tomorrow', 'Tomorrow morning'], ['week', 'Next week']] as const).map(([choice, label]) => <button type="button" role="menuitem" key={choice} onClick={() => { setSnoozeMenu(null); onUpdate(thread.id, { snoozedUntil: snoozeUntil(choice, nowMs) }) }}>{label}</button>)}
          </div>}
        </div>
      })}
      {project.threads.length === 0 && <div className="empty-subtle">No threads. <button type="button" onClick={onNewThread}>Start one</button></div>}
    </section>)}
  </div>
}
