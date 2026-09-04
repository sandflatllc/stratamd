import { useState } from 'react'
import type { EngineThreadView, EngineView } from '../../shared/contracts'

interface ProjectsPanelProps {
  engine: EngineView
  onOpenThread(threadId: string): void
  onReconnect(): void
  onCreate(input: { projectId: string; title: string; model: string; effort: string | null; access: EngineThreadView['access'] }): void
  onAction(threadId: string, action: 'archive' | 'settle' | 'delete'): void
}

export function ProjectsPanel({ engine, onOpenThread, onReconnect, onCreate, onAction }: ProjectsPanelProps) {
  const [creating, setCreating] = useState(false)
  const [projectId, setProjectId] = useState(engine.projects[0]?.id ?? '')
  const [title, setTitle] = useState('New thread')
  const [model, setModel] = useState('gpt-5.6')
  const [effort, setEffort] = useState<string | null>('medium')
  const [access, setAccess] = useState<EngineThreadView['access']>('approval-required')
  if (engine.state === 'unpaired') return <div className="engine-empty">No engine paired.<small>Pair StrataMD in Settings to see projects.</small></div>
  if (engine.state === 'disconnected' || engine.state === 'connecting') return (
    <div className="engine-empty" data-testid="engine-disconnected">
      {engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.
      <button type="button" onClick={onReconnect}>Reconnect</button>
    </div>
  )
  return <div className="projects-panel">
    <button type="button" onClick={() => setCreating(true)}>New thread</button>
    {creating && <form className="thread-picker" aria-label="Start thread" onSubmit={(event) => { event.preventDefault(); onCreate({ projectId, title, model, effort, access }); setCreating(false) }}>
      <h3>Start thread</h3>
      <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{engine.projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select></label>
      <label>Name<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <label>Thinking<select value={effort ?? ''} onChange={(event) => setEffort(event.target.value || null)}><option value="">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Access<select value={access} onChange={(event) => setAccess(event.target.value as EngineThreadView['access'])}><option value="approval-required">Ask</option><option value="auto-accept-edits">Auto edits</option><option value="full-access">Full</option></select></label>
      <div><button type="button" onClick={() => setCreating(false)}>Cancel</button><button type="submit">Create</button></div>
    </form>}
    {engine.state === 'mismatch' && <p className="engine-mismatch">{engine.problem}</p>}
    {engine.projects.map((project) => <section className="project-group" key={project.id}>
      <h3>{project.title}</h3>
      <small>{project.workspaceRoot}</small>
      {project.threads.map((thread) => <div className={`project-thread ${thread.id === engine.activeThreadId ? 'active' : ''}`} key={thread.id}>
        <button type="button" aria-label={`Open ${thread.title}`} onClick={() => onOpenThread(thread.id)}><span>{thread.unread && <i className="unread-dot" aria-label="Unread" />}{thread.title}</span><small>{thread.status}{thread.pendingApprovals ? ' · approval' : ''}{thread.pendingUserInput ? ' · answer needed' : ''}{thread.items?.length ? ` · ${thread.items.length} items` : ''}</small></button>
        <span className="project-row-actions"><button type="button" aria-label={`Settle ${thread.title}`} onClick={() => onAction(thread.id, 'settle')}>Settle</button><button type="button" aria-label={`Archive ${thread.title}`} onClick={() => onAction(thread.id, 'archive')}>Archive</button><button type="button" aria-label={`Delete ${thread.title}`} onClick={() => onAction(thread.id, 'delete')}>Delete</button></span>
      </div>)}
      {project.threads.length === 0 && <div className="empty-subtle">No threads. <button type="button" onClick={() => { setProjectId(project.id); setCreating(true) }}>Start one</button></div>}
    </section>)}
  </div>
}
