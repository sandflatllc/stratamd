import { useContextCompaction } from '../useContextCompaction'
import type { EngineThreadView, EngineView } from '../../shared/contracts'
import './context-compaction.css'

export function ContextCompactionNotice({ engine, thread }: { engine: EngineView; thread: EngineThreadView }) {
  const action = useContextCompaction(engine, thread, { instanceId: thread.providerInstanceId, model: thread.model, effort: thread.effort, options: thread.options ?? [], access: thread.access }, engine.projects.find(project => project.id === thread.projectId)?.workspaceRoot)
  const result = thread.compaction
  if (!result) return null
  const counts = result.beforeTokens !== undefined && result.afterTokens !== undefined ? ` · ${result.beforeTokens.toLocaleString()} → ${result.afterTokens.toLocaleString()} tokens` : ''
  return <div className="context-compaction-notice" data-state={result.state} role={result.state === 'failed' ? 'alert' : 'status'}>
    {result.state === 'working' ? 'Compacting context… Your draft stays available.' : result.state === 'done' ? `Context compacted${counts}. Conversation history is still available.` : 'Could not compact context. Your conversation and draft are unchanged.'}
    {result.state === 'failed' && <><p>{action.error ?? result.error}</p><button type="button" disabled={!!action.disabledReason} title={action.disabledReason ?? undefined} onClick={() => void action.execute()}>Retry compaction</button></>}
  </div>
}
