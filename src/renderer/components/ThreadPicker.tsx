import { useEffect, useRef, useState } from 'react'
import type { EngineThreadView, EngineView, StartThreadInput } from '../../shared/contracts'
import { useDialogFocus } from '../useDialogFocus'
import { projectForPath } from '../model'

export interface ThreadPickerProps {
  engine: EngineView
  /** The document the thread starts from, if any; its containing project is preselected (§5.7). */
  documentPath?: string
  /** What the first turn carries, named so the owner knows what Confirm sends. */
  carries?: string
  onCancel(): void
  onConfirm(input: StartThreadInput): void
  /** Adds a T3 project for the document's folder when no project contains it (§5.7). */
  onAddProject?(input: { title: string; workspaceRoot: string }): Promise<string>
  /** Provider instances that cannot take a new thread right now (parked, limited, signed out) (§5.13). */
  unavailableInstanceIds?: ReadonlySet<string>
}

/** Provider instances the picker offers beside Auto, from the engine's threads. */
export function pickerInstanceIds(engine: EngineView): string[] {
  return [...new Set(engine.projects.flatMap((project) => project.threads.map((thread) => thread.providerInstanceId)))]
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

/**
 * The picker (§1, §5.7): project, name, model, thinking level, access, and the
 * account. Shown every time a thread starts, from Projects or from a document.
 */
export function ThreadPicker({ engine, documentPath, carries, onCancel, onConfirm, onAddProject, unavailableInstanceIds }: ThreadPickerProps) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  const containing = documentPath ? projectForPath(engine, documentPath) : null
  const [projectId, setProjectId] = useState(containing?.id ?? engine.projects[0]?.id ?? '')
  const [title, setTitle] = useState(documentPath ? `Review ${documentPath.split('/').pop() ?? 'document'}` : 'New thread')
  const [model, setModel] = useState(engine.projects.flatMap((project) => project.threads)[0]?.model ?? 'gpt-5.6')
  const [effort, setEffort] = useState<string | null>('medium')
  const [access, setAccess] = useState<EngineThreadView['access']>('approval-required')
  const [instanceId, setInstanceId] = useState('auto')
  const [addingProject, setAddingProject] = useState(false)
  const [projectFolder, setProjectFolder] = useState(documentPath ? folderOf(documentPath) : '')
  const [projectTitle, setProjectTitle] = useState(documentPath ? (folderOf(documentPath).split('/').pop() || 'Project') : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const needsProject = documentPath !== undefined && containing === null
  useEffect(() => { if (containing && !projectId) setProjectId(containing.id) }, [containing, projectId])
  const addProject = async () => {
    if (!onAddProject || busy) return
    setBusy(true)
    setError('')
    try {
      const id = await onAddProject({ title: projectTitle.trim() || 'Project', workspaceRoot: projectFolder.trim() })
      setProjectId(id)
      setAddingProject(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The project could not be added')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section ref={dialogRef} tabIndex={-1} className="modal thread-picker-modal" role="dialog" aria-modal="true" aria-labelledby="thread-picker-title">
        <form className="thread-picker" aria-label="Start thread" onSubmit={(event) => { event.preventDefault(); if (!projectId) return; onConfirm({ projectId, title: title.trim() || 'New thread', model: model.trim(), effort, access, instanceId: instanceId === 'auto' ? null : instanceId }) }}>
          <h2 id="thread-picker-title">Start thread</h2>
          {carries && <p className="modal-subtitle">{carries}</p>}
          {needsProject && !addingProject && <p className="thread-picker-note" data-testid="picker-no-project">No project contains this file.{onAddProject && <> <button type="button" className="text-action" onClick={() => setAddingProject(true)}>Add project</button></>}</p>}
          {addingProject ? (
            <fieldset className="thread-picker-project"><legend>Add project</legend>
              <label>Folder<input aria-label="Project folder" value={projectFolder} onChange={(event) => setProjectFolder(event.target.value)} /></label>
              <label>Title<input aria-label="Project title" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /></label>
              <div><button type="button" className="quiet-button" onClick={() => setAddingProject(false)}>Back</button><button type="button" className="primary-button" disabled={busy || !projectFolder.trim()} onClick={() => void addProject()}>{busy ? 'Adding…' : 'Add project'}</button></div>
            </fieldset>
          ) : (
            <label>Project<select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{engine.projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select></label>
          )}
          <label>Name<input aria-label="Name" data-dialog-initial-focus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Model<input aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <label>Thinking<select aria-label="Thinking" value={effort ?? ''} onChange={(event) => setEffort(event.target.value || null)}><option value="">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label>
          <label>Access<select aria-label="Access" value={access} onChange={(event) => setAccess(event.target.value as EngineThreadView['access'])}><option value="approval-required">Ask</option><option value="auto-accept-edits">Auto edits</option><option value="auto">Auto</option><option value="full-access">Full</option></select></label>
          <label>Account<select aria-label="Account" value={instanceId} onChange={(event) => setInstanceId(event.target.value)}><option value="auto">Auto</option>{pickerInstanceIds(engine).map((id) => <option value={id} key={id} disabled={unavailableInstanceIds?.has(id) ?? false}>{id}{unavailableInstanceIds?.has(id) ? ' · parked' : ''}</option>)}</select></label>
          {error && <div className="send-error" role="alert">{error}</div>}
          <div className="modal-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={!projectId || addingProject}>{documentPath ? 'Start thread' : 'Create'}</button></div>
        </form>
      </section>
    </div>
  )
}
