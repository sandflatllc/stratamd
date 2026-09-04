import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EngineActivityView, EngineThreadView, EngineView, ItemView } from '../../shared/contracts'
import { deriveWorkEntries, groupWorkRows, type WorkEntry } from '../../core/work-log'
import { ConversationComposer } from './ConversationComposer'
import { ConversationHistory } from './ConversationHistory'
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
  onStart(threadId: string, input: import('../../shared/contracts').ConversationInput): Promise<void>
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

const workIcons = { terminal: '›_', search: '⌕', wrench: '⌘', hammer: '◆', bot: '◇', tone: '•' } as const

function shouldCollapseUserMessage(text: string): boolean {
  return text.length > 420 || text.split('\n').length > 7
}

function WorkEntryRow({ entry }: { entry: WorkEntry }) {
  const [expanded, setExpanded] = useState(false)
  return <article className="conversation-work-entry" data-tone={entry.failed ? 'error' : entry.tone} data-icon={entry.icon} data-active={entry.active || undefined}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="conversation-work-icon" aria-hidden="true">{workIcons[entry.icon]}</span>
      <span className="conversation-work-copy"><strong>{entry.heading}</strong>{entry.preview && <small>{entry.preview}</small>}</span>
      <span className="conversation-work-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
    </button>
    {expanded && entry.expandedBody && <pre>{entry.expandedBody}</pre>}
  </article>
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
        {item.kind === 'suggestion' && <><button type="button" aria-label="Conversation item: Accept" onClick={() => onAct?.(item, 'accept')}>Accept</button><button type="button" aria-label="Conversation item: Reject" onClick={() => onAct?.(item, 'reject')}>Reject</button></>}
        {item.kind === 'edit' && <><button type="button" aria-label="Conversation item: Keep" onClick={() => onAct?.(item, 'keep')}>Keep</button><button type="button" aria-label="Conversation item: Revert" onClick={() => onAct?.(item, 'revert')}>Revert</button></>}
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
  const [expandedWork, setExpandedWork] = useState<Record<string, boolean>>({})
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(Date.now())
  const thread = selected?.thread

  useEffect(() => { if (passage) setScope('passage') }, [passage])
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
  const workEntries = useMemo(() => deriveWorkEntries(thread?.activities ?? []), [thread?.activities])
  const workGroups = useMemo(() => groupWorkRows(
    workEntries,
    turns.map((turn) => ({ id: turn.id, running: Boolean(thread && (thread.status === 'running' || thread.status === 'starting') && (thread.activeTurnId === null || thread.activeTurnId === turn.id)), finished: thread?.activeTurnId !== turn.id })),
    thread?.messages ?? [],
  ), [workEntries, turns, thread?.status, thread?.activeTurnId, thread?.messages])
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
  return <section className="conversation-panel" aria-label="Conversation" data-placement={placement}>
    <header>
      <div className="conversation-title"><strong><span>{selected.project}</span><i aria-hidden="true">/</i>{thread.title}</strong><button type="button" onClick={onMove}>{placement === 'side' ? 'Open in center' : 'Move to side'}</button></div>
      <small>{thread.model}{thread.effort ? ` · ${thread.effort}` : ''} · {thread.access}</small>
      <div className="conversation-status"><span>{thread.status}{running ? ` · ${elapsed(thread.turnStartedAt, now)}` : ''}</span>{running && <button type="button" className="stop-button" onClick={() => onStop(thread.id)}>Stop</button>}</div>
      <div className="conversation-scope" role="tablist" aria-label="Conversation scope"><button type="button" role="tab" aria-selected={scope === 'whole'} onClick={() => setScope('whole')}>Whole thread</button><button type="button" role="tab" aria-selected={scope === 'passage'} disabled={!passage} onClick={() => setScope('passage')}>This passage</button></div>
    </header>
    {scope === 'passage' && passage ? <div className="conversation-passage">{passage}</div> : <ConversationHistory key={thread.id} className="conversation-messages">
      {turns.toReversed().map((turn) => {
        const groups = workGroups.filter((candidate) => candidate.turnId === turn.id)
        const timeline = [
          ...turn.messages.map((message) => ({ kind: 'message' as const, id: message.id, createdAt: message.createdAt, message })),
          ...groups.map((group) => ({ kind: 'work' as const, id: group.id, createdAt: group.createdAt, group })),
        ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).reverse()
        const lastAssistant = turn.messages.findLast((message) => message.role === 'assistant')?.id
        const changedFiles = thread.documents?.filter((file) => file.turnId === turn.id) ?? []
        return <section className="conversation-turn" key={turn.id} data-running={groups.some((group) => group.live) || undefined}>
          {timeline.map((row) => {
            if (row.kind === 'work') {
              const group = row.group
              const expanded = expandedWork[group.id] ?? !group.foldedByDefault
              if (group.live) return <div className="conversation-live-work" data-history-row key={group.id}><div className="conversation-working-row"><span className="working-pulse" aria-hidden="true" />Working <time>{elapsed(thread.turnStartedAt, now)}</time></div>{group.entries.map((entry) => <WorkEntryRow entry={entry} key={entry.id} />)}{group.showThinking && <div className="conversation-thinking"><span aria-hidden="true" />Thinking</div>}</div>
              return <div className="conversation-work-group" data-history-row key={group.id}>
                <button type="button" className="conversation-work-toggle" aria-expanded={expanded} onClick={() => setExpandedWork((value) => ({ ...value, [group.id]: !expanded }))}>
                  <span className="conversation-work-icon" aria-hidden="true">{workIcons[group.summaryIcon]}</span><span>{group.summary}</span>{group.hasFailure && <b aria-label="Failed">!</b>}
                </button>
                {expanded && <div className="conversation-work-list">{group.entries.map((entry) => <WorkEntryRow entry={entry} key={entry.id} />)}</div>}
              </div>
            }
            const message = row.message
            const prose = message.prose ?? message.text
            const blocks = message.blocks ?? []
            const longUserMessage = message.role === 'user' && shouldCollapseUserMessage(prose)
            const messageExpanded = expandedMessages[message.id] ?? false
            return <article className={`conversation-message ${message.role}`} key={message.id} data-history-row data-message-id={message.id} data-streaming={message.streaming || undefined}>
              <small>{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}{message.role === 'user' && <span className="conversation-chip">{message.attachmentCount > 0 ? `${message.attachmentCount} attached` : 'Message'}</span>}{message.role === 'assistant' && <button type="button" className="conversation-copy" aria-label="Copy assistant message" onClick={() => void navigator.clipboard.writeText(prose)}>Copy</button>}</small>
              <div className={longUserMessage && !messageExpanded ? 'conversation-user-collapsed' : undefined} data-annotatable={message.role === 'assistant' && !message.streaming || undefined} data-block-ids={blocks.map((block) => block.id).join(' ')}><InlineMarkdown text={prose} /></div>
              {longUserMessage && <button type="button" className="conversation-message-toggle" aria-expanded={messageExpanded} onClick={() => setExpandedMessages((value) => ({ ...value, [message.id]: !messageExpanded }))}>{messageExpanded ? 'Show less' : 'Show more'}</button>}
              {message.id === lastAssistant && changedFiles.length > 0 && <section className="conversation-changed-files" aria-label="Changed files"><strong>Changed files</strong>{changedFiles.map((file) => <span key={`${file.turnId}:${file.path}`}>{file.path}<small>+{file.additions} −{file.deletions}</small></span>)}</section>}
            </article>
          })}
          {approvals.filter((activity) => (activity.turnId ?? 'thread') === turn.id).map((activity) => { const payload = record(activity.payload); const requestId = String(payload.requestId ?? ''); return <section className="conversation-request" data-kind="approval" key={activity.id}><strong>{typeof payload.detail === 'string' ? payload.detail : activity.summary}</strong><div className="conversation-actions"><button type="button" onClick={() => onApproval(thread.id, requestId, 'accept')}>Approve</button><button type="button" onClick={() => onApproval(thread.id, requestId, 'decline')}>Decline</button></div></section> })}
          {userInputs.filter((activity) => (activity.turnId ?? 'thread') === turn.id).map((activity) => <UserInputCard key={activity.id} activity={activity} onAnswer={(requestId, answers) => onUserInput(thread.id, requestId, answers)} />)}
          <TurnChecklist items={allItems.filter((item) => item.threadId === thread.id && item.turnId === turn.id)} onReply={(item, value) => { if (item.annotationId && onReplyItem) onReplyItem(item, value); else onQueueReply?.(thread.id, item, value) }} onDismiss={(item) => onDismissItem?.(thread.id, item)} {...(onOpenItem ? { onOpen: onOpenItem } : {})} {...(onActItem ? { onAct: onActItem } : {})} />
        </section>
      })}
    </ConversationHistory>}
    <ConversationComposer key={thread.id} engine={engine} thread={thread} projectId={thread.projectId} draftKey={`thread:${thread.id}`} initial={{ model: thread.model, instanceId: thread.providerInstanceId, effort: thread.effort, access: thread.access, options: thread.options ?? (thread.effort ? [{ id: 'effort', value: thread.effort }] : []) }} queuedCount={queuedCount} workspace={engine.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? ''} branch={thread.branch ?? null} onSend={(input) => onStart(thread.id, input)} />
  </section>
}
