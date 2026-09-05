import { ConversationMessage } from './ConversationMessage'
import { useConversationWorkspace } from './ConversationWorkspace'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { EngineActivityView, EngineThreadView, EngineView, ItemView } from '../../shared/contracts'
import { changedFilesLabel, formatDelta, summarizeChangedFiles, type ChangedFileInput, type ChangedFileView } from '../../core/changed-files'
import { deriveTurnFold, deriveWorkEntries, groupWorkRows, turnRows, type WorkEntry, type WorkGroupRow } from '../../core/work-log'
import { ConversationComposer } from './ConversationComposer'
import { ConversationHistory } from './ConversationHistory'
import { ConversationNavigator } from './ConversationNavigator'
import { isOwnerComment } from '../../core/conversation-delivery'
import { Resizer } from './Resizer'
import { MessageMarkdown } from '../messageMarkdown'

function activeThread(engine: EngineView): { thread: EngineThreadView; project: string; root: string | null } | null {
  for (const project of engine.projects) {
    const thread = project.threads.find((candidate) => candidate.id === engine.activeThreadId)
    if (thread) return { thread, project: project.title, root: project.workspaceRoot || null }
  }
  return null
}

function FileChip({ file, onOpen }: { file: ChangedFileView; onOpen?(path: string): void }) {
  const body = <><span className="conversation-file-kind" aria-hidden="true">{file.extension || '·'}</span><span className="conversation-file-name">{file.name}</span></>
  if (file.markdown && onOpen) return <button type="button" className="conversation-file-chip" title={file.path} onClick={() => onOpen(file.path)}>{body}</button>
  return <span className="conversation-file-chip" title={file.path}>{body}</span>
}

/** A turn's changed files, folded like T3's card: count and delta, top-level folders, three chips, and the full list on request (§6.9). */
function ChangedFilesCard({ files, root, onOpen }: { files: readonly ChangedFileInput[]; root: string | null; onOpen?(path: string): void }) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => summarizeChangedFiles(files, root), [files, root])
  if (summary.count === 0) return null
  return <section className="conversation-changed-files" aria-label="Changed files" data-expanded={expanded || undefined}>
    <header>
      <button type="button" className="conversation-files-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="conversation-work-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <strong>{changedFilesLabel(summary.count)}</strong>
        <span className="conversation-delta"><ins>+{formatDelta(summary.additions)}</ins><del>−{formatDelta(summary.deletions)}</del></span>
        <span className="conversation-files-show">{expanded ? 'Hide files' : 'Show files'}</span>
      </button>
    </header>
    {!expanded && <div className="conversation-files-folders">{summary.groups.map((group) => <span key={group.label}><code>{group.label}</code> {group.files.length} {group.files.length === 1 ? 'file' : 'files'}</span>)}</div>}
    {!expanded && <div className="conversation-files-preview">
      {summary.preview.map((file) => <FileChip key={file.path} file={file} {...(onOpen ? { onOpen } : {})} />)}
      {summary.count > summary.preview.length && <button type="button" className="conversation-files-more" onClick={() => setExpanded(true)}>Show all {summary.count} files</button>}
    </div>}
    {expanded && <div className="conversation-files-list">
      {summary.groups.map((group) => <div className="conversation-files-group" key={group.label}>
        <span className="conversation-files-group-label"><code>{group.label}</code> {group.files.length} {group.files.length === 1 ? 'file' : 'files'}</span>
        {group.files.map((file) => {
          const row = <><span className="conversation-file-kind" aria-hidden="true">{file.extension || '·'}</span><span className="conversation-file-name">{file.name}</span><small className="conversation-file-dir">{file.directory}</small><span className="conversation-delta"><ins>+{formatDelta(file.additions)}</ins><del>−{formatDelta(file.deletions)}</del></span></>
          return file.markdown && onOpen
            ? <button type="button" className="conversation-file-row" key={file.path} title={`Open ${file.path}`} onClick={() => onOpen(file.path)}>{row}</button>
            : <div className="conversation-file-row" key={file.path} title={file.path}>{row}</div>
        })}
      </div>)}
    </div>}
  </section>
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
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const rows = questions.length ? questions : [{ id: 'answer', question: activity.summary }]
  const questionId = (question: Record<string, unknown>, index: number) => typeof question.id === 'string' ? question.id : typeof question.header === 'string' ? question.header : `answer-${index}`
  return <section className="conversation-request" data-kind="user-input"><form onSubmit={event => { event.preventDefault(); onAnswer(requestId, answers) }}>
    {rows.map((question, index) => {
      const id = questionId(question, index)
      const options = Array.isArray(question.options) ? question.options.map(record) : []
      return <fieldset key={id}><legend>{String(question.question ?? question.prompt ?? activity.summary)}</legend>
        {options.map((option, index) => { const label = String(option.label ?? option.value ?? `Option ${index + 1}`); return <button type="button" aria-pressed={answers[id] === label} key={label} onClick={() => setAnswers(previous => ({ ...previous, [id]: label }))}>{label}</button> })}
        <input aria-label={`Answer ${id}`} placeholder="Other answer" value={answers[id] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [id]: event.target.value }))} />
      </fieldset>
    })}
    <button type="submit" disabled={rows.some((question, index) => !answers[questionId(question, index)]?.trim())}>Answer</button>
  </form></section>
}

interface ConversationProps {
  visible?: boolean
  onDocumentContext?(): void
  documentMeasure?: number
  onDocumentMeasure?(value: number, commit: boolean): void
  engine: EngineView
  placement?: 'side' | 'center'
  passage?: ReactNode
  onReconnect(): void
  /** Moves the thread to the other placement; absent when no document could take the center's place. */
  onMove?(): void
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
  /** Opens a changed Markdown file in the center (§6.9); other changed files list without an action. */
  onOpenDocument?(path: string): void
}

const workIcons = { terminal: '›_', search: '⌕', wrench: '⌘', hammer: '◆', bot: '◇', tone: '•' } as const

function shouldCollapseUserMessage(text: string): boolean {
  return text.length > 420 || text.split('\n').length > 7
}

/** A stretch of calls between prose: one summary line, its rows on request. Inside an open turn there is no second Worked for row. */
function WorkGroup({ group, expanded, onToggle }: { group: WorkGroupRow; expanded: boolean; onToggle(): void }) {
  return <div className="conversation-work-group" data-history-row>
    <button type="button" className="conversation-work-toggle" aria-expanded={expanded} onClick={onToggle}>
      <span className="conversation-work-icon" aria-hidden="true">{workIcons[group.summaryIcon]}</span>
      <span>{group.summary}</span><span className="conversation-work-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>{group.hasFailure && <b aria-label="Failed">!</b>}
    </button>
    {expanded && <div className="conversation-work-list">{group.entries.map((entry) => <WorkEntryRow entry={entry} key={entry.id} />)}</div>}
  </div>
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
  const done = items.filter((item) => item.status === 'done').length
  if (items.length === 0) return null
  return <section className="turn-checklist" aria-label="Turn items">
    <header><strong>Items</strong><span>{done} of {items.length} done</span></header>
    {items.map((item) => <div className="turn-item" data-kind={item.kind} data-status={item.status} key={item.id}>
      <button type="button" className="turn-item-open" onClick={() => onOpen?.(item)}><span>{item.status === 'done' ? '✓' : item.status === 'drafted' ? '◌' : '○'}</span><strong>{item.kind}</strong><span>{item.text || item.quote}</span>{item.inferred && <em>inferred</em>}{item.status === 'drafted' && <em>Drafted{item.draftReply ? `: ${item.draftReply}` : ''}</em>}</button>
      <div className="turn-item-actions">
        {item.kind === 'suggestion' && item.annotationId && <><button type="button" aria-label="Conversation item: Accept" onClick={() => onAct?.(item, 'accept')}>Accept</button><button type="button" aria-label="Conversation item: Reject" onClick={() => onAct?.(item, 'reject')}>Reject</button></>}
        {item.kind === 'edit' && item.hunkId && <><button type="button" aria-label="Conversation item: Keep" onClick={() => onAct?.(item, 'keep')}>Keep</button><button type="button" aria-label="Conversation item: Revert" onClick={() => onAct?.(item, 'revert')}>Revert</button></>}
        <button type="button" onClick={() => onOpen?.(item)}>Reply</button>
        {item.inferred && <button type="button" onClick={() => onDismiss?.(item)}>Dismiss</button>}
      </div>
    </div>)}
  </section>
}

export function Conversation({ visible = true, onDocumentContext, documentMeasure = 860, onDocumentMeasure, engine, placement = 'side', passage, onReconnect, onMove, onStart, onStop, onApproval, onUserInput, items = [], onReplyItem, onQueueReply, onDismissItem, onOpenItem, onActItem, onOpenDocument }: ConversationProps) {
  const selected = activeThread(engine)
  const [expandedWork, setExpandedWork] = useState<Record<string, boolean>>({})
  /** The owner's own turn disclosures. A navigation reveal is separate: it comes from the target and ends when the owner closes that turn. */
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({})
  const [dismissedReveal, setDismissedReveal] = useState<number | null>(null)
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(Date.now())
  const thread = selected?.thread

  const panelRef = useRef<HTMLElement>(null)
  const history = useRef<ConversationHistory>(null)
  const workspace = useConversationWorkspace(thread, onStart, () => history.current?.scrollToBottom(), panelRef)
  useEffect(() => {
    if (thread?.status !== 'running' && thread?.status !== 'starting') return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [thread?.status])

  // An in-session interrupt leaves its turn open so the reader keeps their place;
  // the next turn folds it, and so does a reload, since this is component state.
  const previousTurn = useRef(thread?.latestTurn ?? null)
  useLayoutEffect(() => {
    const previous = previousTurn.current
    const latest = thread?.latestTurn ?? null
    previousTurn.current = latest
    if (!latest || !previous) return
    if (latest.id === previous.id) {
      if (previous.state === 'running' && latest.state === 'interrupted') setExpandedTurns((value) => ({ ...value, [latest.id]: true }))
      return
    }
    setExpandedTurns((value) => { if (!(previous.id in value)) return value; const { [previous.id]: _closed, ...rest } = value; return rest })
  }, [thread?.latestTurn])

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
    // Before T3 names the new turn, only the newest turn counts as running; older turns keep their folds.
    turns.map((turn, index) => ({ id: turn.id, running: Boolean(thread && (thread.status === 'running' || thread.status === 'starting') && (thread.activeTurnId === turn.id || (thread.activeTurnId === null && index === turns.length - 1))), finished: thread?.activeTurnId !== turn.id })),
    thread?.messages ?? [],
  ), [workEntries, turns, thread?.status, thread?.activeTurnId, thread?.messages])
  const allItems = useMemo(() => thread ? [...items, ...(thread.items ?? []).filter(item => !isOwnerComment(item))] : [...items], [items, thread])
  /** Replies queued in the main process for this thread's message items; they ride the next Send. */
  const queuedCount = thread ? (thread.items ?? []).filter((item) => item.draftReply !== undefined).length : 0

  if (engine.state === 'disconnected' || engine.state === 'connecting') return <div className="engine-empty" data-testid="conversation-disconnected">{engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.<button type="button" onClick={onReconnect}>Reconnect</button></div>
  if (!thread && passage) return <section className="conversation-panel" aria-label="Conversation" data-placement={placement}>
    <header><strong>Comment discussion</strong></header>
    <div className="conversation-passage">{passage}</div>
  </section>
  if (!thread || !selected) return <div className="engine-empty">No conversation open.<small>Choose a thread under Projects.</small></div>
  const running = thread.status === 'running' || thread.status === 'starting'
  // Find and comment markers reach into folded turns: the target's turn stays open for that navigation, apart from the owner's own disclosures.
  const targetMessage = workspace.target && dismissedReveal !== workspace.target.serial ? thread.messages.find((message) => message.id === workspace.target?.message) : undefined
  const revealedTurn = targetMessage ? targetMessage.turnId ?? 'thread' : null
  return <section ref={panelRef} className="conversation-panel" aria-label="Conversation" data-placement={placement} style={placement === 'center' ? { '--conversation-measure': `${documentMeasure}px` } as CSSProperties : undefined} onKeyDownCapture={workspace.onKeyDown}>
    <header>
      <div className="conversation-title"><strong><span>{selected.project}</span><i aria-hidden="true">/</i>{thread.title}</strong>{running && <button type="button" className="stop-button" onClick={() => onStop(thread.id)}>Stop</button>}{onMove && <button type="button" onClick={onMove}>{placement === 'side' ? 'Open in center' : 'Move to side'}</button>}</div>
      {workspace.toolbar}
    </header>
    {passage && <div className="conversation-passage">{passage}</div>}
    <div className="conversation-reading-area">
    <ConversationHistory ref={history} active={visible} navigation={workspace.target?.serial} startMessage={workspace.target?.align === 'start' ? workspace.target.message : undefined} key={`history:${thread.id}`} className="conversation-messages">
      {placement === 'center' && onDocumentMeasure && <div className="conversation-measure" style={{ width: `min(${documentMeasure}px, 100%)` }}><Resizer axis="vertical" label="Resize conversation measure" value={documentMeasure} min={620} max={1600} onChange={(value) => onDocumentMeasure(value, false)} onCommit={(value) => onDocumentMeasure(value, true)} /></div>}
      <div className="conversation-column">
      {turns.map((turn) => {
        const groups = workGroups.filter((candidate) => candidate.turnId === turn.id)
        const timeline = turnRows(turn.messages, groups)
        const turnRunning = groups.some((group) => group.live) || (running && (thread.activeTurnId === turn.id || (thread.activeTurnId === null && turn.id === turns.at(-1)?.id)))
        const fold = deriveTurnFold({ id: turn.id, messages: turn.messages, groups, running: turnRunning, latestTurn: thread.latestTurn ?? null })
        const revealed = revealedTurn === turn.id
        const open = fold === null || revealed || (expandedTurns[turn.id] ?? false)
        const toggleTurn = () => {
          setExpandedTurns((value) => ({ ...value, [turn.id]: !open }))
          if (revealed && workspace.target) setDismissedReveal(workspace.target.serial)
        }
        const lastAssistant = turn.messages.findLast((message) => message.role === 'assistant')?.id
        const changedFiles = thread.documents?.filter((file) => file.turnId === turn.id) ?? []
        return <section className="conversation-turn" key={turn.id} data-running={turnRunning || undefined} data-folded={fold && !open ? '' : undefined}>
          {timeline.map((row) => {
            const foldRow = fold && row.id === fold.anchorId ? <div className="conversation-turn-fold" data-history-row data-interrupted={fold.interrupted || undefined}>
              <button type="button" className="conversation-turn-toggle" aria-expanded={open} onClick={toggleTurn}>
                <span>{fold.label}</span><span className="conversation-work-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>{fold.hasFailure && <b aria-label="Failed">!</b>}
              </button>
            </div> : null
            const hidden = fold?.hiddenIds.includes(row.id) ?? false
            if (hidden && !open) return <Fragment key={row.id}>{foldRow}</Fragment>
            if (row.kind === 'work') {
              const group = row.group
              const expanded = expandedWork[group.id] ?? !group.foldedByDefault
              if (group.live) return <Fragment key={row.id}>{foldRow}<div className="conversation-live-work" data-history-row><div className="conversation-working-row"><span className="working-pulse" aria-hidden="true" />Working <time>{elapsed(thread.turnStartedAt, now)}</time></div>{group.entries.map((entry) => <WorkEntryRow entry={entry} key={entry.id} />)}{group.showThinking && <div className="conversation-thinking"><span aria-hidden="true" />Thinking</div>}</div></Fragment>
              return <Fragment key={row.id}>{foldRow}<WorkGroup group={group} expanded={expanded} onToggle={() => setExpandedWork((value) => ({ ...value, [group.id]: !expanded }))} /></Fragment>
            }
            const message = row.message
            const prose = message.prose ?? message.text
            const blocks = message.blocks ?? []
            const longUserMessage = message.role === 'user' && shouldCollapseUserMessage(prose)
            const messageExpanded = expandedMessages[message.id] ?? false
            return <Fragment key={row.id}>{foldRow}<article className={`conversation-message ${message.role}`} data-history-row data-message-id={message.id} data-streaming={message.streaming || undefined} data-turn-trace={hidden || undefined}>
              <small>{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}{message.role === 'user' && <span className="conversation-chip">{message.attachmentCount > 0 ? `${message.attachmentCount} attached` : 'Message'}</span>}{message.role === 'assistant' && <button type="button" className="conversation-copy" aria-label="Copy assistant message" onClick={() => void navigator.clipboard.writeText(prose)}>Copy</button>}</small>
              <div className={longUserMessage && !messageExpanded ? 'conversation-user-collapsed' : undefined} data-annotatable={message.role === 'assistant' && !message.streaming || undefined} data-block-ids={blocks.map((block) => block.id).join(' ')}>{message.role === 'assistant' && !message.streaming ? <ConversationMessage message={message} comments={(thread.comments ?? []).filter(comment => comment.anchor.message === message.id)} pinned={workspace.selection?.message === message.id || workspace.discussion?.anchor.message === message.id} target={workspace.target} root={selected.root} folds={workspace.folds(message.id)} onFold={(heading, folded) => workspace.foldHeading(message.id, heading, folded)} onSelection={range => workspace.select(message.id, range)} onOpen={workspace.open} /> : <MessageMarkdown text={prose} />}</div>
              {longUserMessage && <button type="button" className="conversation-message-toggle" aria-expanded={messageExpanded} onClick={() => setExpandedMessages((value) => ({ ...value, [message.id]: !messageExpanded }))}>{messageExpanded ? 'Show less' : 'Show more'}</button>}
              {message.id === lastAssistant && changedFiles.length > 0 && <ChangedFilesCard files={changedFiles} root={selected.root} {...(onOpenDocument ? { onOpen: onOpenDocument } : {})} />}
            </article></Fragment>
          })}
          {approvals.filter((activity) => (activity.turnId ?? 'thread') === turn.id).map((activity) => { const payload = record(activity.payload); const requestId = String(payload.requestId ?? ''); return <section className="conversation-request" data-kind="approval" key={activity.id}><strong>{typeof payload.detail === 'string' ? payload.detail : activity.summary}</strong><div className="conversation-actions"><button type="button" onClick={() => onApproval(thread.id, requestId, 'accept')}>Approve</button><button type="button" onClick={() => onApproval(thread.id, requestId, 'decline')}>Decline</button></div></section> })}
          {userInputs.filter((activity) => (activity.turnId ?? 'thread') === turn.id).map((activity) => <UserInputCard key={activity.id} activity={activity} onAnswer={(requestId, answers) => onUserInput(thread.id, requestId, answers)} />)}
          <TurnChecklist items={allItems.filter((item) => item.threadId === thread.id && item.turnId === turn.id)} onReply={(item, value) => { if (item.annotationId && onReplyItem) onReplyItem(item, value); else onQueueReply?.(thread.id, item, value) }} onDismiss={(item) => onDismissItem?.(thread.id, item)} onOpen={item => { if (item.annotationId) onOpenItem?.(item); else workspace.open(item.id) }} {...(onActItem ? { onAct: onActItem } : {})} />
        </section>
      })}
      </div>
    </ConversationHistory>
    {visible && workspace.discussionView}
    {visible && <ConversationNavigator key={thread.id} thread={thread} onJump={workspace.navigate} />}
    </div>
    {visible && workspace.overlay}
    <ConversationComposer deliveryId={workspace.previewId} key={`composer:${thread.id}`} engine={engine} thread={thread} projectId={thread.projectId} draftKey={`thread:${thread.id}`} initial={{ model: thread.model, instanceId: thread.providerInstanceId, effort: thread.effort, access: thread.access, options: thread.options ?? (thread.effort ? [{ id: 'effort', value: thread.effort }] : []) }} context={<div className="conversation-context">{placement === 'side' && onDocumentContext && <button type="button" onClick={onDocumentContext}>Document context</button>}{workspace.tray}</div>} queuedCount={workspace.selectedCount} workspace={engine.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? ''} branch={thread.branch ?? null} onSend={async input => { await onStart(thread.id, { ...input, ...workspace.outgoing }); workspace.sent() }} />
  </section>
}
