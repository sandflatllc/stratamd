import { useEffect, useState } from 'react'
import type { ConversationInput, CreateDraftRequest, DocumentView, EngineView } from '../../shared/contracts'
import { initialSelection, readDraft, writeDraft } from '../conversationDrafts'
import { ConversationComposer } from './ConversationComposer'
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
  const [folder, setFolder] = useState(document?.path.slice(0, document.path.lastIndexOf('/')) ?? '')
  const [error, setError] = useState('')
  const project = engine.projects.find((candidate) => candidate.id === projectId)
  const draftKey = document ? `document:${document.path}:${projectId}` : `new:${projectId}`
  const send = async (input: ConversationInput) => {
    await onBeforeSend()
    const settings = { projectId, title: 'New thread', model: input.model, effort: input.effort, access: input.access, ...(input.instanceId ? { instanceId: input.instanceId } : {}), ...(input.options ? { options: input.options } : {}) }
    const threadId = readDraft(draftKey).threadId ?? crypto.randomUUID()
    writeDraft(draftKey, { ...readDraft(draftKey), threadId })
    await window.strata.createEngineThread({ ...settings, threadId })
    if (document) await window.strata.startThreadFromDocument(document.path, { ...settings, threadId, note: input.text, ...(comment ? { comment } : {}) })
    else await window.strata.startConversationTurn(threadId, input)
    await window.strata.openConversation(threadId)
    onStarted(threadId)
  }
  return <section className="new-conversation" aria-label="New conversation">
    <header><label>Project<select aria-label="Conversation project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{engine.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><button type="button" className="text-action" onClick={() => setAdding(!adding)}>Add project</button></header>
    {adding && <form className="new-conversation-project" aria-label="Add project" onSubmit={async (event) => {
      event.preventDefault(); setError('')
      try { const id = await window.strata.createEngineProject({ title: folder.trim().split('/').filter(Boolean).at(-1) ?? 'Project', workspaceRoot: folder.trim() }); setProjectId(id); setAdding(false) } catch (failure) { setError(String(failure)) }
    }}><label>Project folder<input aria-label="Project folder" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/path/to/project" /></label><button type="submit" disabled={!folder.trim()}>Add</button>{error && <p role="alert">{error}</p>}</form>}
    <div className="new-conversation-body">
      <h1>What would you like to work on{project ? <> in <span>{project.title}</span></> : null}?</h1>
      {document && !containing && <p>No project contains {document.path}. Choose a project or add its folder.</p>}
      <ConversationComposer key={draftKey} engine={engine} projectId={projectId} draftKey={draftKey} initial={initialSelection(engine, projectId)} centered workspace={project?.workspaceRoot ?? ''} canSendContext={!!document} context={document ? <><span title={document.path}>▤ {document.path.split('/').at(-1)}</span>{document.drafts.length > 0 && <span>{document.drafts.length} held draft{document.drafts.length === 1 ? '' : 's'}</span>}{comment && <span title={comment.text}>Comment: {comment.text}</span>}</> : undefined} onSend={send} />
    </div>
  </section>
}
