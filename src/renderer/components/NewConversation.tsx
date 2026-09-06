import { useEffect, useState } from 'react'
import type { ConversationInput, CreateDraftRequest, DocumentView, EngineView } from '../../shared/contracts'
import { initialSelection, readDraft, writeDraft } from '../conversationDrafts'
import { ConversationComposer } from './ConversationComposer'
import { WorkspaceControls, type WorkspaceChoice } from './WorkspaceControls'
import { AddProjectDialog } from './AddProjectDialog'
import { ProjectPicker } from './ProjectPicker'
import { projectForPath } from '../model'

export function NewConversation({ engine, projectId: initialProjectId, document, comment, onStarted, onBeforeSend, onProjectChange }: {
  engine: EngineView
  projectId?: string
  document?: DocumentView | null
  comment?: CreateDraftRequest
  onProjectChange(projectId: string): void
  onStarted(threadId: string): void
  onBeforeSend(): Promise<void>
}) {
  const containing = document ? projectForPath(engine, document.path) : null
  const [projectId, setProjectId] = useState(initialProjectId ?? containing?.id ?? engine.projects.find((project) => project.threads.some((thread) => thread.id === engine.activeThreadId))?.id ?? engine.projects[0]?.id ?? '')
  useEffect(() => { if (!projectId && engine.projects[0]) setProjectId(engine.projects[0].id) }, [projectId, engine.projects])
  useEffect(() => { if (projectId) onProjectChange(projectId) }, [projectId])
  const [adding, setAdding] = useState(false)
  const project = engine.projects.find((candidate) => candidate.id === projectId)
  const draftKey = document ? `document:${document.path}:${projectId}` : `new:${projectId}`
  const [workspace, setWorkspace] = useState<WorkspaceChoice>(() => readDraft(draftKey).workspace ?? { kind: 'current' })
  useEffect(() => {
    let active = true
    const stored = readDraft(draftKey)
    setWorkspace(stored.workspace ?? { kind: 'current' })
    if (!stored.workspace && !stored.threadId && project) void Promise.all([window.strata.readEngineSettings(), window.strata.listEngineRefs(project.workspaceRoot, '')]).then(([settings, refs]) => {
      if (!active || readDraft(draftKey).workspace || settings.defaultThreadEnvMode !== 'worktree' || !refs.isRepo) return
      setWorkspace({ kind: 'worktree', baseBranch: refs.refs.find(ref => ref.isDefault && !ref.isRemote)?.name ?? refs.refs.find(ref => ref.current)?.name ?? '', startFromOrigin: settings.newWorktreesStartFromOrigin === true && refs.hasPrimaryRemote })
    }).catch(() => undefined)
    return () => { active = false }
  }, [draftKey, project?.workspaceRoot])
  const changeWorkspace = (value: WorkspaceChoice) => { setWorkspace(value); writeDraft(draftKey, { ...readDraft(draftKey), workspace: value }) }
  const send = async (input: ConversationInput) => {
    if (workspace.kind === 'worktree' && !workspace.baseBranch) throw new Error('Choose the branch to start the worktree from.')
    await onBeforeSend()
    const settings = { ...(workspace.kind === 'worktree' ? { workspace } : workspace.kind === 'previous' ? { branch: workspace.branch, worktreePath: workspace.worktreePath } : {}), projectId, title: 'New thread', model: input.model, effort: input.effort, access: input.access, ...(input.instanceId ? { instanceId: input.instanceId } : {}), ...(input.options ? { options: input.options } : {}) }
    const threadId = readDraft(draftKey).threadId ?? crypto.randomUUID()
    writeDraft(draftKey, { ...readDraft(draftKey), threadId })
    await window.strata.createEngineThread({ ...settings, threadId })
    if (document) await window.strata.startThreadFromDocument(document.path, { ...settings, threadId, note: input.text, ...(comment ? { comment } : {}) })
    else await window.strata.startConversationTurn(threadId, input)
    await window.strata.openConversation(threadId)
    onStarted(threadId)
  }
  return <section className="new-conversation" aria-label="New conversation">
    <header><span>Project</span><ProjectPicker projects={engine.projects} value={projectId} onChange={setProjectId} onAdd={() => setAdding(true)} /></header>
    {adding && <AddProjectDialog engine={engine} onClose={() => setAdding(false)} onAdded={setProjectId} />}
    <div className="new-conversation-body">
      <h1>What would you like to work on{project ? <> in <span>{project.title}</span></> : null}?</h1>
      {document && !containing && <p>No project contains {document.path}. Choose a project or add its folder.</p>}
      <ConversationComposer key={draftKey} engine={engine} projectId={projectId} draftKey={draftKey} initial={initialSelection(engine, projectId)} centered workspaceControls={project ? <WorkspaceControls key={draftKey} project={project} value={workspace} onChange={changeWorkspace} disabled={!!readDraft(draftKey).threadId} /> : undefined} canSendContext={!!document} context={document ? <><span title={document.path}>▤ {document.path.split('/').at(-1)}</span>{document.drafts.length > 0 && <span>{document.drafts.length} held draft{document.drafts.length === 1 ? '' : 's'}</span>}{comment && <span title={comment.text}>Comment: {comment.text}</span>}</> : undefined} onSend={send} />
    </div>
  </section>
}
