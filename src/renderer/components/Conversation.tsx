import { ConversationMessage } from './ConversationMessage'
import { useConversationWorkspace } from './ConversationWorkspace'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EngineActivityView, EngineThreadView, EngineView, ItemView, VisualCommentView } from '../../shared/contracts'
import type { DraftAttachment } from '../conversationDrafts'
import { changedFilesLabel, formatDelta, summarizeChangedFiles, type ChangedFileInput, type ChangedFileView } from '../../core/changed-files'
import { deriveTurnFold, deriveWorkEntries, groupWorkRows, turnRows, type WorkEntry, type WorkGroupRow } from '../../core/work-log'
import { deriveAgentRuns, deriveBackgroundTasks, type AgentRun } from '../../core/agent-activity'
import { AgentClusters, AgentsDialog } from './AgentClusters'
import { engineStorage } from '../engineStorage'
import { conversationTurns } from '../../core/conversation-turns'
import { ConversationComposer } from './ConversationComposer'
import { ConversationHistory } from './ConversationHistory'
import { ConversationNavigator } from './ConversationNavigator'
import { isOwnerComment } from '../../core/conversation-delivery'
import { Resizer } from './Resizer'
import { MessageMarkdown } from '../messageMarkdown'

const AGENTS_COLLAPSED_KEY = 'conversation-agents-collapsed'

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
  /** Copies an assistant message through the main process; the renderer's clipboard API is denied by the permission handler. */
  onCopyText?(text: string): void
  /** The project's visual comments (docs/plans/open/visual-review); held ones addressed to this thread ride its composer. */
  visualComments?: VisualCommentView[]
  onOpenVisual?(id: string): void
  /** Show me under an agent reply that references a page comment (phase 3). */
  onShowVisual?(id: string): void
  onMarkUpImage?(attachment: DraftAttachment): void
  consumedAttachmentIds?: readonly string[]
}

/** Where the conversation will land: an arrow toward it and a three-column window with that column filled. */
function PlacementIcon({ target }: { target: 'side' | 'center' }) {
  return <svg viewBox="0 0 30 14" aria-hidden="true">
    {target === 'side' ? <path d="M9.5 7H1.5M4.5 4 1.5 7l3 3" /> : <path d="M1.5 7h8M6.5 4l3 3-3 3" />}
    <rect x="13.5" y="1.5" width="15" height="11" rx="2" />
    <path d="M18.5 1.5v11M23.5 1.5v11" />
    <rect className="conversation-placement-fill" x={target === 'side' ? 13.5 : 18.5} y="1.5" width="5" height="11" />
  </svg>
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

/** One call. Alone it opens its own output; as the live line of a running turn, `onToggle` opens the whole group instead. */
function WorkEntryRow({ entry, onToggle }: { entry: WorkEntry; onToggle?(): void }) {
  const [expanded, setExpanded] = useState(false)
  return <article className="conversation-work-entry" data-tone={entry.failed ? 'error' : entry.tone} data-icon={entry.icon} data-active={entry.active || undefined} data-work-entry-id={entry.id}>
    <button type="button" aria-expanded={onToggle ? false : expanded} onClick={onToggle ?? (() => setExpanded((value) => !value))}>
      <span className="conversation-work-icon" aria-hidden="true">{workIcons[entry.icon]}</span>
      <span className="conversation-work-copy"><strong>{entry.heading}</strong>{entry.preview && <small>{entry.preview}</small>}</span>
      <span className="conversation-work-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
    </button>
    {!onToggle && expanded && entry.expandedBody && <pre>{entry.expandedBody}</pre>}
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

export function Conversation({ visible = true, onDocumentContext, documentMeasure = 860, onDocumentMeasure, engine, placement = 'side', passage, onReconnect, onMove, onStart, onStop, onApproval, onUserInput, items = [], onReplyItem, onQueueReply, onDismissItem, onOpenItem, onActItem, onOpenDocument, onCopyText, visualComments = [], onOpenVisual, onShowVisual, onMarkUpImage, consumedAttachmentIds }: ConversationProps) {
  const selected = activeThread(engine)
  const [expandedWork, setExpandedWork] = useState<Record<string, boolean>>({})
  /** The owner's own turn disclosures. A navigation reveal is separate: it comes from the target and ends when the owner closes that turn. */
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({})
  const [dismissedReveal, setDismissedReveal] = useState<number | null>(null)
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(Date.now())
  /** The agent clusters fold behind their chevron (§6.9 Agents); the choice outlives the thread and the session. */
  const [agentsCollapsed, setAgentsCollapsed] = useState(() => engineStorage.getItem(AGENTS_COLLAPSED_KEY) === '1')
  const [agentsDialog, setAgentsDialog] = useState<{ focus?: string | undefined } | null>(null)
  const thread = selected?.thread

  const panelRef = useRef<HTMLElement>(null)
  const history = useRef<ConversationHistory>(null)
  const threadVisual = useMemo(() => thread ? visualComments.filter((comment) => (comment.draft?.destination.threadId ?? comment.revisions.at(-1)?.destination.threadId) === thread.id) : [], [thread?.id, visualComments])
  const heldVisual = useMemo(() => threadVisual.filter((comment) => comment.status === 'held' && comment.draft), [threadVisual])
  const visualById = useMemo(() => new Map(visualComments.map((comment) => [comment.id, comment])), [visualComments])
  const workspace = useConversationWorkspace(thread, onStart, panelRef, { comments: threadVisual, onOpen: (id) => onOpenVisual?.(id) })
  const [atBottom, setAtBottom] = useState(true)
  const latestId = workspace.latestResponse
  const jumpToResponse = atBottom && !!latestId
  useEffect(() => {
    const viewport = panelRef.current?.querySelector<HTMLElement>('.conversation-messages')
    if (!viewport) return
    let frame = 0
    const update = () => {
      setAtBottom(history.current?.isAtBottom() ?? true)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    const resize = new ResizeObserver(schedule)
    resize.observe(viewport)
    const column = viewport.querySelector('.conversation-column')
    if (column) resize.observe(column)
    viewport.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); viewport.removeEventListener('scroll', schedule) }
  }, [thread?.id, latestId, visible, engine.state])
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
  const turns = useMemo(() => conversationTurns(thread?.messages ?? [], thread?.activities ?? [], thread?.activeTurnId ?? null), [thread])
  const workGroups = useMemo(() => turns.flatMap((turn, index) => groupWorkRows(
    deriveWorkEntries(turn.activities).map(entry => ({ ...entry, turnId: turn.id })),
    // Before T3 names the new turn, only the newest group counts as running.
    [{ id: turn.id, running: Boolean(thread && (thread.status === 'running' || thread.status === 'starting') && (thread.activeTurnId !== null ? thread.activeTurnId === turn.turnId : index === turns.length - 1)), finished: thread?.activeTurnId !== turn.turnId }],
    turn.messages.map(message => ({ ...message, turnId: turn.id })),
  )), [turns, thread?.status, thread?.activeTurnId])
  /**
   * Agents belong to the newest turn: they appear on the first spawn and clear when the next message starts a turn.
   * T3 leaves many task rows without a turn id; after the turn settles they land in trailing turn-less groups, so the
   * newest turn with an id anchors the set and every later group's rows (its own late completions) join it.
   */
  const latestTurnActivities = useMemo(() => {
    const anchor = turns.findLastIndex((turn) => turn.turnId !== null)
    return anchor < 0 ? [] : turns.slice(anchor).flatMap((turn) => turn.activities)
  }, [turns])
  const agentRuns = useMemo(() => deriveAgentRuns(latestTurnActivities), [latestTurnActivities])
  const backgroundTasks = useMemo(() => deriveBackgroundTasks(latestTurnActivities), [latestTurnActivities])
  /** Runs whose spawn row exists in the transcript; workflow members arrive as progress rows only and have none. */
  const shownInTranscript = useMemo(() => {
    const entryIds = new Set(workGroups.flatMap((group) => group.entries.map((entry) => entry.id)))
    return new Set(agentRuns.filter((run) => run.activityIds.some((id) => entryIds.has(id))).map((run) => run.id))
  }, [workGroups, agentRuns])
  useEffect(() => {
    if (!agentRuns.some((run) => run.state === 'working' || run.state === 'waiting')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [agentRuns])
  const toggleAgents = () => setAgentsCollapsed((value) => { engineStorage.setItem(AGENTS_COLLAPSED_KEY, value ? '0' : '1'); return !value })
  /** Open the turn and the call group that hold the agent's spawn row, then bring that row into view. */
  const showAgentInTranscript = (run: AgentRun) => {
    const group = workGroups.find((candidate) => candidate.entries.some((entry) => run.activityIds.includes(entry.id)))
    const entry = group?.entries.find((candidate) => run.activityIds.includes(candidate.id))
    const turn = group ? turns.find((candidate) => candidate.id === group.turnId) : undefined
    if (!group || !entry || !turn) return
    setAgentsDialog(null)
    setExpandedTurns((value) => ({ ...value, [turn.turnId ?? turn.id]: true }))
    setExpandedWork((value) => ({ ...value, [group.id]: true }))
    requestAnimationFrame(() => {
      const row = panelRef.current?.querySelector<HTMLElement>(`[data-work-entry-id="${CSS.escape(entry.id)}"]`)
      row?.scrollIntoView({ block: 'center' })
      row?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    })
  }
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
  const revealedTurn = targetMessage ? turns.find(turn => turn.messages.some(message => message.id === targetMessage.id))?.id : null
  return <section ref={panelRef} className="conversation-panel" aria-label="Conversation" data-placement={placement} style={placement === 'center' ? { '--conversation-measure': `${documentMeasure}px` } as CSSProperties : undefined} onKeyDownCapture={workspace.onKeyDown}>
    <header>
      <div className="conversation-title">
        {onMove && <button type="button" className="conversation-placement" aria-label={placement === 'side' ? 'Open in center' : 'Move to side'} title={placement === 'side' ? 'Open in center' : 'Move to side'} onClick={onMove}><PlacementIcon target={placement === 'side' ? 'center' : 'side'} /></button>}
        <strong><span>{selected.project}</span><i aria-hidden="true">/</i>{thread.title}</strong>
        <AgentClusters runs={agentRuns} collapsed={agentsCollapsed} onToggle={toggleAgents} onOpen={(focus) => setAgentsDialog({ focus })} maxClusters={placement === 'side' ? 3 : 12} />
        {workspace.tools}
      </div>
    </header>
    {passage && <div className="conversation-passage">{passage}</div>}
    {agentsDialog && createPortal(<AgentsDialog runs={agentRuns} background={backgroundTasks} focus={agentsDialog.focus} now={now} onClose={() => setAgentsDialog(null)} onShow={showAgentInTranscript} canShow={(run) => shownInTranscript.has(run.id)} />, document.querySelector('.app-shell') ?? document.body)}
    <div className="conversation-reading-area">
    <ConversationHistory ref={history} active={visible} navigation={workspace.target?.serial} startMessage={workspace.target?.align === 'start' ? workspace.target.message : undefined} key={`history:${thread.id}`} className="conversation-messages">
      {placement === 'center' && onDocumentMeasure && <div className="conversation-measure" style={{ width: `min(${documentMeasure}px, 100%)` }}><Resizer axis="vertical" label="Resize conversation measure" value={documentMeasure} min={620} max={1600} onChange={(value) => onDocumentMeasure(value, false)} onCommit={(value) => onDocumentMeasure(value, true)} /></div>}
      <div className="conversation-column">
      {turns.map((turn) => {
        const groups = workGroups.filter((candidate) => candidate.turnId === turn.id)
        const timeline = turnRows(turn.messages, groups)
        const turnRunning = groups.some((group) => group.live) || (running && (thread.activeTurnId !== null && thread.activeTurnId === turn.turnId || (thread.activeTurnId === null && turn.id === turns.at(-1)?.id)))
        const fold = deriveTurnFold({ id: turn.turnId ?? turn.id, messages: turn.messages, groups, running: turnRunning, latestTurn: thread.latestTurn ?? null })
        const revealed = revealedTurn === turn.id
        const open = fold === null || revealed || (expandedTurns[turn.turnId ?? turn.id] ?? false)
        const toggleTurn = () => {
          setExpandedTurns((value) => ({ ...value, [turn.turnId ?? turn.id]: !open }))
          if (revealed && workspace.target) setDismissedReveal(workspace.target.serial)
        }
        const lastAssistant = turn.messages.findLast((message) => message.role === 'assistant')?.id
        const changedFiles = thread.documents?.filter((file) => file.turnId === turn.turnId) ?? []
        /** While the turn runs, T3's header sits where Worked for will: after the request, before the first work or answer. */
        const workingRow = turnRunning && !fold ? <div className="conversation-turn-fold" data-history-row><div className="conversation-working-row"><span className="working-pulse" aria-hidden="true" />Working for <time>{elapsed(thread.turnStartedAt, now)}</time></div></div> : null
        const headerIndex = timeline.findIndex((row) => row.kind === 'work' || row.message.role !== 'user')
        return <section className="conversation-turn" key={turn.id} data-running={turnRunning || undefined} data-folded={fold && !open ? '' : undefined}>
          {timeline.map((row, index) => {
            const foldRow = fold && row.id === fold.anchorId ? <div className="conversation-turn-fold" data-history-row data-interrupted={fold.interrupted || undefined}>
              <button type="button" className="conversation-turn-toggle" aria-expanded={open} onClick={toggleTurn}>
                <span>{fold.label}</span><span className="conversation-work-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>{fold.hasFailure && <b aria-label="Failed">!</b>}
              </button>
            </div> : index === headerIndex ? workingRow : null
            const hidden = fold?.hiddenIds.includes(row.id) ?? false
            if (hidden && !open) return <Fragment key={row.id}>{foldRow}</Fragment>
            if (row.kind === 'work') {
              const group = row.group
              const expanded = expandedWork[group.id] ?? !group.foldedByDefault
              if (group.live) {
                const current = group.entries.findLast((entry) => entry.active) ?? group.entries.at(-1)
                const toggle = () => setExpandedWork((value) => ({ ...value, [group.id]: !expanded }))
                return <Fragment key={row.id}>{foldRow}<div className="conversation-live-work" data-history-row>
                  {current && (expanded ? <WorkGroup group={group} expanded onToggle={toggle} /> : <WorkEntryRow entry={current} onToggle={toggle} />)}
                  {group.showThinking && <div className="conversation-thinking"><span className="conversation-thinking-dots" aria-hidden="true"><span /><span /><span /></span>Thinking</div>}
                </div></Fragment>
              }
              return <Fragment key={row.id}>{foldRow}<WorkGroup group={group} expanded={expanded} onToggle={() => setExpandedWork((value) => ({ ...value, [group.id]: !expanded }))} /></Fragment>
            }
            const message = row.message
            const prose = message.prose ?? message.text
            const blocks = message.blocks ?? []
            const longUserMessage = message.role === 'user' && shouldCollapseUserMessage(prose)
            const messageExpanded = expandedMessages[message.id] ?? false
            return <Fragment key={row.id}>{foldRow}<article className={`conversation-message ${message.role}`} data-history-row data-message-id={message.id} data-streaming={message.streaming || undefined} data-turn-trace={hidden || undefined}>
              <small>{message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}{message.role === 'user' && <span className="conversation-chip">{message.attachmentCount > 0 ? `${message.attachmentCount} attached` : 'Message'}</span>}{message.role === 'assistant' && <button type="button" className="conversation-copy" aria-label="Copy assistant message" onClick={() => onCopyText?.(prose)}>Copy</button>}</small>
              <div className={longUserMessage && !messageExpanded ? 'conversation-user-collapsed' : undefined} data-annotatable={message.role === 'assistant' && !message.streaming || undefined} data-block-ids={blocks.map((block) => block.id).join(' ')}>{message.role === 'assistant' && !message.streaming ? <ConversationMessage message={message} comments={(thread.comments ?? []).filter(comment => comment.anchor.message === message.id)} pinned={workspace.selection?.message === message.id || workspace.discussion?.anchor.message === message.id} target={workspace.target} root={selected.root} folds={workspace.folds(message.id)} onFold={(heading, folded) => workspace.foldHeading(message.id, heading, folded)} onSelection={range => workspace.select(message.id, range)} onOpen={workspace.open} /> : <MessageMarkdown text={prose} />}</div>
              {longUserMessage && <button type="button" className="conversation-message-toggle" aria-expanded={messageExpanded} onClick={() => setExpandedMessages((value) => ({ ...value, [message.id]: !messageExpanded }))}>{messageExpanded ? 'Show less' : 'Show more'}</button>}
              {message.role === 'assistant' && !message.streaming && (() => { const replies = message.visualReplies ?? []; return replies.length ? <div className="conversation-visual-replies">{replies.map((reply) => { const comment = visualById.get(reply.id); const latest = comment?.revisions.at(-1); return <span className="conversation-visual-reply-row" key={`${reply.id}:${reply.revision ?? ''}`}><button type="button" className="conversation-visual-reply" data-ready={reply.ready || undefined} onClick={() => onOpenVisual?.(reply.id)}><span>Visual comment</span>{comment ? ` · ${comment.title}` : ''}<em>{comment && comment.status === 'ready' ? 'ready for review' : reply.ready ? 'marked ready' : 'answered'}</em></button>{comment?.anchor.kind === 'page' && onShowVisual && <button type="button" className="conversation-visual-action" onClick={() => onShowVisual(reply.id)}>Show me</button>}{latest?.comparison && onOpenVisual && <button type="button" className="conversation-visual-action" onClick={() => onOpenVisual(reply.id)}>Then / now</button>}</span> })}</div> : null })()}
              {message.id === lastAssistant && changedFiles.length > 0 && <ChangedFilesCard files={changedFiles} root={selected.root} {...(onOpenDocument ? { onOpen: onOpenDocument } : {})} />}
            </article></Fragment>
          })}
          {headerIndex === -1 && workingRow}
          {approvals.filter(activity => turn.activities.some(candidate => candidate.id === activity.id)).map((activity) => { const payload = record(activity.payload); const requestId = String(payload.requestId ?? ''); return <section className="conversation-request" data-kind="approval" key={activity.id}><strong>{typeof payload.detail === 'string' ? payload.detail : activity.summary}</strong><div className="conversation-actions"><button type="button" onClick={() => onApproval(thread.id, requestId, 'accept')}>Approve</button><button type="button" onClick={() => onApproval(thread.id, requestId, 'decline')}>Decline</button></div></section> })}
          {userInputs.filter(activity => turn.activities.some(candidate => candidate.id === activity.id)).map((activity) => <UserInputCard key={activity.id} activity={activity} onAnswer={(requestId, answers) => onUserInput(thread.id, requestId, answers)} />)}
          <TurnChecklist items={allItems.filter((item) => item.threadId === thread.id && item.turnId === turn.turnId)} onReply={(item, value) => { if (item.annotationId && onReplyItem) onReplyItem(item, value); else onQueueReply?.(thread.id, item, value) }} onDismiss={(item) => onDismissItem?.(thread.id, item)} onOpen={item => { if (item.annotationId) onOpenItem?.(item); else workspace.open(item.id) }} {...(onActItem ? { onAct: onActItem } : {})} />
        </section>
      })}
      </div>
    </ConversationHistory>
    {visible && workspace.discussionView}
    {visible && <ConversationNavigator key={thread.id} thread={thread} onJump={workspace.navigate} />}
    {visible && <button type="button" className="conversation-latest" data-direction={jumpToResponse ? 'up' : 'down'} aria-label={jumpToResponse ? 'Latest response' : 'Newest'} title={jumpToResponse ? 'Read the latest response from its start' : 'Jump to the newest message'} onClick={() => { if (latestId && history.current?.isAtBottom()) workspace.jumpToLatest(); else history.current?.scrollToBottom() }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 7.5 6 3.5l4 4" /></svg></button>}
    </div>
    {visible && workspace.overlay}
    <ConversationComposer deliveryId={workspace.previewId} key={`composer:${thread.id}`} engine={engine} thread={thread} projectId={thread.projectId} draftKey={`thread:${thread.id}`} initial={{ model: thread.model, instanceId: thread.providerInstanceId, effort: thread.effort, access: thread.access, options: thread.options ?? (thread.effort ? [{ id: 'effort', value: thread.effort }] : []) }} context={<div className="conversation-context">{placement === 'side' && onDocumentContext && <button type="button" onClick={onDocumentContext}>Document context</button>}{workspace.tray}</div>} queuedCount={workspace.selectedCount} reservedAttachments={workspace.selectedCount > 0 || (thread.outcomes?.length ?? 0) > 0 ? 1 : 0} workspace={engine.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? ''} branch={thread.branch ?? null} running={running} onStop={() => onStop(thread.id)} onSend={async input => { await onStart(thread.id, { ...input, ...workspace.outgoing }); workspace.sent() }} visualComments={heldVisual} {...(onOpenVisual ? { onOpenVisual: (comment: VisualCommentView) => onOpenVisual(comment.id) } : {})} {...(onMarkUpImage ? { onMarkUpImage } : {})} {...(consumedAttachmentIds ? { consumedAttachmentIds } : {})} />
  </section>
}
