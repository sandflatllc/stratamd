import type { EngineThreadView, EngineView } from '../../shared/contracts'
import { InlineMarkdown } from '../inlineMarkdown'

function activeThread(engine: EngineView): EngineThreadView | null {
  for (const project of engine.projects) {
    const thread = project.threads.find((candidate) => candidate.id === engine.activeThreadId)
    if (thread) return thread
  }
  return null
}

export function Conversation({ engine, onReconnect }: { engine: EngineView; onReconnect(): void }) {
  if (engine.state === 'disconnected' || engine.state === 'connecting') return <div className="engine-empty" data-testid="conversation-disconnected">{engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.<button type="button" onClick={onReconnect}>Reconnect</button></div>
  const thread = activeThread(engine)
  if (!thread) return <div className="engine-empty">No conversation open.<small>Choose a thread under Projects.</small></div>
  return <section className="conversation-panel" aria-label="Conversation">
    <header><strong>{thread.title}</strong><small>{thread.model}{thread.effort ? ` · ${thread.effort}` : ''} · {thread.access} · {thread.status}</small></header>
    <div className="conversation-messages">
      {thread.messages.map((message) => <article className={`conversation-message ${message.role}`} key={message.id} data-streaming={message.streaming || undefined}>
        <small>{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}</small>
        <div><InlineMarkdown text={message.text} /></div>
      </article>)}
    </div>
  </section>
}
