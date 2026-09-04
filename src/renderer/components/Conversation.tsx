import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { EngineActivityView, EngineThreadView, EngineView, ItemView } from '../../shared/contracts'
import { InlineMarkdown } from '../inlineMarkdown'

function activeThread(engine: EngineView): { thread: EngineThreadView; project: string } | null {
  for (const project of engine.projects) {
    const thread = project.threads.find((candidate) => candidate.id === engine.activeThreadId)
    if (thread) return { thread, project: project.title }
  }
  return null
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function elapsed(startedAt: string | null, now: number): string {
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function openRequests(activities: EngineActivityView[], kind: 'approval' | 'user-input'): EngineActivityView[] {
  const open = new Map<string, EngineActivityView>()
  for (const activity of activities) {
    const requestId = record(activity.payload).requestId
    if (typeof requestId !== 'string') continue
    if (activity.kind === `${kind}.requested`) open.set(requestId, activity)
    if (activity.kind === `${kind}.resolved` || activity.kind === `provider.${kind}.respond.failed`) open.delete(requestId)
  }
  return [...open.values()]
}

function UserInputCard({ activity, onAnswer }: { activity: EngineActivityView; onAnswer(requestId: string, answers: Record<string, unknown>): void }) {
  const payload = record(activity.payload)
  const questions = Array.isArray(payload.questions) ? payload.questions.map(record) : []
  const first = questions[0] ?? {}
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const questionId = typeof first.id === 'string' ? first.id : typeof first.header === 'string' ? first.header : 'answer'
  const prompt = typeof first.question === 'string' ? first.question : typeof first.prompt === 'string' ? first.prompt : activity.summary
  const options = Array.isArray(first.options) ? first.options.map(record) : []
  const [answer, setAnswer] = useState('')
  return <section className="conversation-request" data-kind="user-input">
    <strong>{prompt}</strong>
    {options.length > 0 && <div className="conversation-actions">{options.map((option, index) => {
      const label = typeof option.label === 'string' ? option.label : typeof option.value === 'string' ? option.value : `Option ${index + 1}`
      return <button type="button" key={label} onClick={() => onAnswer(requestId, { [questionId]: label })}>{label}</button>
    })}</div>}
    <form onSubmit={(event) => { event.preventDefault(); if (answer.trim()) onAnswer(requestId, { [questionId]: answer.trim() }) }}>
      <input aria-label="Answer user input" value={answer} onChange={(event) => setAnswer(event.target.value)} />
      <button type="submit" disabled={!answer.trim()}>Answer</button>
    </form>
  </section>
}

interface ConversationProps {
  engine: EngineView
  placement?: 'side' | 'center'
  passage?: ReactNode
  onReconnect(): void
  onMove(): void
  onStart(threadId: string, input: { text: string; model: string; effort: string | null; access: EngineThreadView['access'] }): void
  onStop(threadId: string): void
  onApproval(threadId: string, requestId: string, decision: 'accept' | 'decline'): void
  onUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): void
  items?: readonly ItemView[]
  onReplyItem?(item: ItemView, text: string): void
  /** Message-anchored replies queue in the main process (§5.4); dismissals are remembered per message (§5.12). */
  onQueueReply?(threadId: string, item: ItemView, text: string): void
  onDismissItem?(threadId: string, item: ItemView): void
  onOpenItem?(item: ItemView): void
  onActItem?(item: ItemView, action: 'accept' | 'reject' | 'keep' | 'revert', option?: string): void
}

function TurnChecklist({ items, onReply, onOpen, onAct, onDismiss }: { items: readonly ItemView[]; onReply?(item: ItemView, text: string): void; onOpen?(item: ItemView): void; onAct?(item: ItemView, action: 'accept' | 'reject' | 'keep' | 'revert', option?: string): void; onDismiss?(item: ItemView): void }) {
  const [replies, setReplies] = useState<Record<string, string>>({})
  const done = items.filter((item) => item.status === 'done').length
  if (items.length === 0) return null
  return <section className="turn-checklist" aria-label="Turn items">
    <header><strong>Items</strong><span>{done} of {items.length} done</span></header>
    {items.map((item) => <div className="turn-item" data-kind={item.kind} data-status={item.status} key={item.id}>
      <button type="button" className="turn-item-open" onClick={() => onOpen?.(item)}><span>{item.status === 'done' ? '✓' : item.status === 'drafted' ? '◌' : '○'}</span><strong>{item.kind}</strong><span>{item.text || item.quote}</span>{item.inferred && <em>inferred</em>}{item.status === 'drafted' && <em>Drafted{item.draftReply ? `: ${item.draftReply}` : ''}</em>}</button>
      <div className="turn-item-actions">
        {item.kind === 'suggestion' && <><button type="button" onClick={() => onAct?.(item, 'accept')}>Accept</button><button type="button" onClick={() => onAct?.(item, 'reject')}>Reject</button></>}
        {item.kind === 'edit' && <><button type="button" onClick={() => onAct?.(item, 'keep')}>Keep</button><button type="button" onClick={() => onAct?.(item, 'revert')}>Revert</button></>}
        <input aria-label={`Reply to ${item.kind}`} value={replies[item.id] ?? ''} onChange={(event) => setReplies((value) => ({ ...value, [item.id]: event.target.value }))} placeholder="Reply" />
        <button type="button" disabled={!(replies[item.id] ?? '').trim()} onClick={() => { const text = (replies[item.id] ?? '').trim(); if (text) { onReply?.(item, text); setReplies((value) => ({ ...value, [item.id]: '' })) } }}>Queue reply</button>
        {item.inferred && <button type="button" onClick={() => onDismiss?.(item)}>Dismiss</button>}
      </div>
    </div>)}
  </section>
}

export function Conversation({ engine, placement = 'side', passage, onReconnect, onMove, onStart, onStop, onApproval, onUserInput, items = [], onReplyItem, onQueueReply, onDismissItem, onOpenItem, onActItem }: ConversationProps) {
  const selected = activeThread(engine)
  const [scope, setScope] = useState<'whole' | 'passage'>(passage ? 'passage' : 'whole')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string | null>(null)
  const [access, setAccess] = useState<EngineThreadView['access']>('approval-required')
  const [now, setNow] = useState(Date.now())
  const thread = selected?.thread

  useEffect(() => { if (passage) setScope('passage') }, [passage])
  useEffect(() => {
    if (!thread) return
    setModel(thread.model)
    setEffort(thread.effort)
    setAccess(thread.access)
  }, [thread?.id, thread?.model, thread?.effort, thread?.access])
  useEffect(() => {
    if (thread?.status !== 'running' && thread?.status !== 'starting') return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [thread?.status])

  const approvals = useMemo(() => thread ? openRequests(thread.activities, 'approval') : [], [thread?.activities])
  const userInputs = useMemo(() => thread ? openRequests(thread.activities, 'user-input') : [], [thread?.activities])
  const turns = useMemo(() => {
    if (!thread) return []
    const ids: string[] = []
    for (const value of [...thread.messages, ...thread.activities]) {
      const id = value.turnId ?? 'thread'
      if (!ids.includes(id)) ids.push(id)
    }
    return ids.map((id) => ({ id, messages: thread.messages.filter((message) => (message.turnId ?? 'thread') === id), activities: thread.activities.filter((activity) => (activity.turnId ?? 'thread') === id) }))
  }, [thread])
  const allItems = useMemo(() => thread ? [...items, ...(thread.items ?? [])] : [...items], [items, thread])
  /** Replies queued in the main process for this thread's message items; they ride the next Send. */
  const queuedCount = thread ? (thread.items ?? []).filter((item) => item.draftReply !== undefined).length : 0

  if (engine.state === 'disconnected' || engine.state === 'connecting') return <div className="engine-empty" data-testid="conversation-disconnected">{engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.<button type="button" onClick={onReconnect}>Reconnect</button></div>
  if (!thread && passage) return <section className="conversation-panel" aria-label="Conversation" data-placement={placement}>
    <header><div className="conversation-scope" role="tablist" aria-label="Conversation scope"><button type="button" role="tab" disabled>Whole thread</button><button type="button" role="tab" aria-selected>This passage</button></div></header>
    <div className="conversation-passage">{passage}</div>
  </section>
  if (!thread || !selected) return <div className="engine-empty">No conversation open.<small>Choose a thread under Projects.</small></div>
  const running = thread.status === 'running' || thread.status === 'starting'
  const send = () => {
    if (!text.trim() && queuedCount === 0) return
    onStart(thread.id, { text: text.trim(), model, effort, access })
    setText('')
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }
  return <section className="conversation-panel" aria-label="Conversation" data-placement={placement}>
    <header>
      <div className="conversation-title"><strong>{thread.title}</strong><button type="button" onClick={onMove}>{placement === 'side' ? 'Open in center' : 'Move to side'}</button></div>
      <small>{selected.project} · {thread.model}{thread.effort ? ` · ${thread.effort}` : ''} · {thread.access}</small>
      <div className="conversation-status"><span>{thread.status}{running ? ` · ${elapsed(thread.turnStartedAt, now)}` : ''}</span>{running && <button type="button" className="stop-button" onClick={() => onStop(thread.id)}>Stop</button>}</div>
      <div className="conversation-scope" role="tablist" aria-label="Conversation scope"><button type="button" role="tab" aria-selected={scope === 'whole'} onClick={() => setScope('whole')}>Whole thread</button><button type="button" role="tab" aria-selected={scope === 'passage'} disabled={!passage} onClick={() => setScope('passage')}>This passage</button></div>
    </header>
    {scope === 'passage' && passage ? <div className="conversation-passage">{passage}</div> : <div className="conversation-messages">
      {turns.map((turn) => {
        const folded = collapsed[turn.id] ?? placement === 'side'
        return <section className="conversation-turn" key={turn.id} data-folded={folded || undefined}>
          <button type="button" className="conversation-fold" aria-expanded={!folded} onClick={() => setCollapsed((value) => ({ ...value, [turn.id]: !folded }))}>{folded ? 'Expand turn' : 'Collapse turn'}</button>
          {turn.messages.map((message) => { const prose = message.prose ?? message.text; const blocks = message.blocks ?? []; return <article className={`conversation-message ${message.role}`} key={message.id} data-message-id={message.id} data-streaming={message.streaming || undefined}><small>{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}{message.role === 'user' && <span className="conversation-chip">{message.attachmentCount > 0 ? `${message.attachmentCount} attached` : 'Message'}</span>}</small><div className={message.role === 'assistant' && folded ? 'conversation-prose-folded' : undefined} data-annotatable={message.role === 'assistant' && !message.streaming || undefined} data-block-ids={blocks.map((block) => block.id).join(' ')}><InlineMarkdown text={prose} /></div></article> })}
          {turn.activities.filter((activity) => !activity.kind.endsWith('.requested') && !activity.kind.endsWith('.resolved')).map((activity) => <article className="conversation-tool" key={activity.id} data-tone={activity.tone}><strong>{activity.summary}</strong></article>)}
          {approvals.filter((activity) => (activity.turnId ?? 'thread') === turn.id).map((activity) => { const payload = record(activity.payload); const requestId = String(payload.requestId ?? ''); return <section className="conversation-request" data-kind="approval" key={activity.id}><strong>{typeof payload.detail === 'string' ? payload.detail : activity.summary}</strong><div className="conversation-actions"><button type="button" onClick={() => onApproval(thread.id, requestId, 'accept')}>Approve</button><button type="button" onClick={() => onApproval(thread.id, requestId, 'decline')}>Decline</button></div></section> })}
          {userInputs.filter((activity) => (activity.turnId ?? 'thread') === turn.id).map((activity) => <UserInputCard key={activity.id} activity={activity} onAnswer={(requestId, answers) => onUserInput(thread.id, requestId, answers)} />)}
          <TurnChecklist items={allItems.filter((item) => item.threadId === thread.id && item.turnId === turn.id)} onReply={(item, value) => { if (item.annotationId && onReplyItem) onReplyItem(item, value); else onQueueReply?.(thread.id, item, value) }} onDismiss={(item) => onDismissItem?.(thread.id, item)} {...(onOpenItem ? { onOpen: onOpenItem } : {})} {...(onActItem ? { onAct: onActItem } : {})} />
        </section>
      })}
    </div>}
    <footer className="conversation-composer">
      <div className="conversation-pills"><label>Model<input aria-label="Conversation model" value={model} onChange={(event) => setModel(event.target.value)} /></label><label>Effort<select aria-label="Conversation effort" value={effort ?? ''} onChange={(event) => setEffort(event.target.value || null)}><option value="">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label><label>Access<select aria-label="Conversation access" value={access} onChange={(event) => setAccess(event.target.value as EngineThreadView['access'])}><option value="approval-required">Ask</option><option value="auto-accept-edits">Auto edits</option><option value="auto">Auto</option><option value="full-access">Full</option></select></label></div>
      {queuedCount > 0 && <small>{queuedCount} answer{queuedCount === 1 ? '' : 's'} queued</small>}
      <div className="conversation-compose-row"><textarea aria-label="Message conversation" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={keyDown} placeholder="Message this thread" /><button type="button" onClick={send} disabled={!text.trim() && queuedCount === 0}>Send</button></div>
    </footer>
  </section>
}
