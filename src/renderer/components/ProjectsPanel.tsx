import { useState } from 'react'
import type { EngineView } from '../../shared/contracts'

interface ProjectsPanelProps {
  engine: EngineView
  onOpenThread(threadId: string): void
  onReconnect(): void
  /** New thread from here opens the picker with no document (§5.2). */
  onNewThread(): void
  onAction(threadId: string, action: 'archive' | 'settle' | 'delete'): void
  /** Opens the engine dialog: pairing, server, version, and connection state (§5.1). */
  onOpenEngine?(): void
  /** Provider instances the owner parked (§5.13); the accounts modal toggles them. */
  parked: ReadonlySet<string>
  onPark(instanceId: string, parked: boolean): void
}

export function ProjectsPanel({ engine, onOpenThread, onReconnect, onNewThread, onAction, onOpenEngine, parked, onPark }: ProjectsPanelProps) {
  const [accounts, setAccounts] = useState(false)
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
  return <div className="projects-panel">
    <button type="button" onClick={onNewThread}>New thread</button>
    <button type="button" onClick={() => setAccounts(true)}>Accounts</button>
    {accounts && <section className="accounts-modal" role="dialog" aria-modal="true" aria-label="Accounts"><h2>Accounts</h2>{[...new Set(engine.projects.flatMap((project) => project.threads.map((thread) => thread.providerInstanceId)))].map((instanceId) => <div key={instanceId}><strong>{instanceId}</strong><span>{parked.has(instanceId) ? 'Parked' : 'Ready · not measured'}</span><button type="button" onClick={() => onPark(instanceId, !parked.has(instanceId))}>{parked.has(instanceId) ? 'Unpark' : 'Park'}</button></div>)}<button type="button" onClick={() => setAccounts(false)}>Close</button></section>}
    {engine.state === 'mismatch' && <p className="engine-mismatch">{engine.problem}</p>}
    {engine.projects.map((project) => <section className="project-group" key={project.id}>
      <h3>{project.title}</h3>
      <small>{project.workspaceRoot}</small>
      {project.threads.map((thread) => <div className={`project-thread ${thread.id === engine.activeThreadId ? 'active' : ''}`} key={thread.id}>
        <button type="button" aria-label={`Open ${thread.title}`} onClick={() => onOpenThread(thread.id)}><span>{thread.unread && <i className="unread-dot" aria-label="Unread" />}{thread.title}</span><small>{thread.status}{thread.pendingApprovals ? ' · approval' : ''}{thread.pendingUserInput ? ' · answer needed' : ''}{thread.items?.length ? ` · ${thread.items.length} items` : ''}</small></button>
        <span className="project-row-actions"><button type="button" aria-label={`Settle ${thread.title}`} onClick={() => onAction(thread.id, 'settle')}>Settle</button><button type="button" aria-label={`Archive ${thread.title}`} onClick={() => onAction(thread.id, 'archive')}>Archive</button><button type="button" aria-label={`Delete ${thread.title}`} onClick={() => onAction(thread.id, 'delete')}>Delete</button></span>
      </div>)}
      {project.threads.length === 0 && <div className="empty-subtle">No threads. <button type="button" onClick={onNewThread}>Start one</button></div>}
    </section>)}
  </div>
}
