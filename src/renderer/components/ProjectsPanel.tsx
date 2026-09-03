import type { EngineView } from '../../shared/contracts'

interface ProjectsPanelProps {
  engine: EngineView
  onOpenThread(threadId: string): void
  onReconnect(): void
}

export function ProjectsPanel({ engine, onOpenThread, onReconnect }: ProjectsPanelProps) {
  if (engine.state === 'unpaired') return <div className="engine-empty">No engine paired.<small>Pair StrataMD in Settings to see projects.</small></div>
  if (engine.state === 'disconnected' || engine.state === 'connecting') return (
    <div className="engine-empty" data-testid="engine-disconnected">
      {engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.
      <button type="button" onClick={onReconnect}>Reconnect</button>
    </div>
  )
  return <div className="projects-panel">
    {engine.state === 'mismatch' && <p className="engine-mismatch">{engine.problem}</p>}
    {engine.projects.map((project) => <section className="project-group" key={project.id}>
      <h3>{project.title}</h3>
      <small>{project.workspaceRoot}</small>
      {project.threads.map((thread) => <button type="button" className={`project-thread ${thread.id === engine.activeThreadId ? 'active' : ''}`} onClick={() => onOpenThread(thread.id)} key={thread.id}>
        <span>{thread.unread && <i className="unread-dot" aria-label="Unread" />}{thread.title}</span>
        <small>{thread.status}{thread.pendingApprovals ? ' · approval' : ''}{thread.pendingUserInput ? ' · answer needed' : ''}</small>
      </button>)}
    </section>)}
  </div>
}
