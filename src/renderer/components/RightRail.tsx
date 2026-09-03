import { useEffect, useState, type CSSProperties } from 'react'
import { useClock } from '../useClock'
import type { AgentIdentity, AnnotationView, AttachmentView, DocumentView, HunkView, ReviewTab, RoundHunkView } from '../../shared/contracts'
import {
  absoluteTime,
  filteredAnnotations,
  AGENT_COLORS,
  annotationCounts,
  attachedAgo,
  attachmentStatusLine,
  timeAgoShort,
  bulkRevertGroups,
  changeGroups,
  EXTERNAL_COLOR,
  hasResolvedAnnotations,
  hunkAction,
  hunkAuthor,
  hunkSnippet,
  hunkSourceTooltip,
  saveRoundAuthors,
  saveRoundLabel,
  saveStateSentence,
  pendingCount,
  textColorFor,
  USER_ANNOTATION_COLOR,
  type AnnotationFilter,
} from '../model'
import { InlineMarkdown } from '../inlineMarkdown'
import { AmbientDecor } from './AmbientDecor'
import { Resizer } from './Resizer'
import { RailTabs } from './RailTabs'
import type { EditorHeading } from '../../editor/headings'

interface RightRailProps {
  document: DocumentView
  selectedTab: ReviewTab
  upperReviewHeight: number
  onSelectTab(tab: ReviewTab): void
  onHeight(value: number, commit: boolean): void
  onMarkReviewed(): void
  onJumpHunk(hunk: HunkView): void
  onKeepHunk(id: string): void
  onRevertHunk(hunk: HunkView): void
  onAcceptAllSuggestions(agentId: string): void
  onRejectAllSuggestions(agentId: string): void
  /** Accept or reject one suggestion from its row when the editor cannot show it inline. */
  onAcceptSuggestion(id: string): void
  onRejectSuggestion(id: string): void
  /** Reverts every pending change by one author, after confirmation (PRD §6.9). */
  onRevertAll(group: { name: string; hunks: HunkView[] }): void
  /** Keeps every pending change by one author (§5.5). */
  onKeepAll?(group: { name: string; hunks: HunkView[] }): void
  /** Puts a one-line instruction for a new agent on the clipboard. */
  onCopyAgentPrompt(): void
  onJumpAnnotation(annotation: AnnotationView): void
  onClearResolved(): void
  headings: readonly EditorHeading[]
  onAddDecision(prompt: string, options: string[], anchor: 'document' | EditorHeading): void
  onNudge(agentId: string): void
  onSetLead(agentId: string | null): void
  onDisconnect(attachment: AttachmentView): void
  onSaveRound(index: number): Promise<{ hunks: RoundHunkView[] }>
}

function colorOf(author: AgentIdentity | 'user' | null): string {
  if (author === 'user') return USER_ANNOTATION_COLOR
  return author ? AGENT_COLORS[author.color] : EXTERNAL_COLOR
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
}

function annotationChipColor(annotation: AnnotationView): string {
  if (annotation.status === 'orphaned') return EXTERNAL_COLOR
  if (annotation.kind === 'question' || annotation.kind === 'decision') return 'var(--controls-warning)'
  if (annotation.author === 'user') return USER_ANNOTATION_COLOR
  return AGENT_COLORS[annotation.author.color]
}

function Avatar({ name, color }: { name: string; color: string }) {
  return <span className="change-avatar" style={{ background: color, color: textColorFor(color) }} aria-hidden="true">{initials(name)}</span>
}

function ChangeRow(props: Pick<RightRailProps, 'onJumpHunk' | 'onKeepHunk' | 'onRevertHunk'> & { hunk: HunkView; now: number }) {
  const { hunk, now } = props
  const meta = (
    <span className="change-meta" title={hunkSourceTooltip(hunk)}>
      <Avatar name={hunkAuthor(hunk)} color={colorOf(hunk.author)} />
      <strong style={{ color: colorOf(hunk.author) }}>{hunkAuthor(hunk)}</strong>
      <small>{hunkAction(hunk)}</small>
      <small className="change-time" title={absoluteTime(hunk.changedAt)}>{timeAgoShort(now - hunk.changedAt)}</small>
    </span>
  )
  const snippet = (
    <span className="change-snippet">
      {hunkSnippet(hunk).map((line, index) => (
        <span className={`snippet-${line.kind}`} key={index}><InlineMarkdown text={line.text} /></span>
      ))}
    </span>
  )
  if (hunk.inline) {
    return (
      <button type="button" className="change-row" onClick={() => props.onJumpHunk(hunk)}>
        {meta}
        {snippet}
      </button>
    )
  }
  // A hunk the editor cannot render inline keeps Keep and Revert on its row.
  return (
    <div className="change-row change-row-actions">
      <button type="button" className="change-row-jump" onClick={() => props.onJumpHunk(hunk)}>
        {meta}
        {snippet}
      </button>
      <div className="change-row-buttons">
        <button type="button" className="keep-button" onClick={() => props.onKeepHunk(hunk.id)}>Keep</button>
        <button type="button" className="revert-button" onClick={() => props.onRevertHunk(hunk)}>Revert</button>
      </div>
    </div>
  )
}

function SuggestionRow(props: Pick<RightRailProps, 'onJumpAnnotation' | 'onAcceptSuggestion' | 'onRejectSuggestion'> & { annotation: AnnotationView }) {
  const { annotation } = props
  const meta = (
    <span className="change-meta">
      <Avatar name={annotation.author === 'user' ? 'you' : annotation.author.name} color={colorOf(annotation.author)} />
      <strong style={{ color: colorOf(annotation.author) }}>{annotation.author === 'user' ? 'you' : annotation.author.name}</strong>
      <small>suggests</small>
    </span>
  )
  const snippet = (
    <span className="change-snippet">
      <span className="snippet-removed"><InlineMarkdown text={annotation.quote} /></span>
      <span className="snippet-added"><InlineMarkdown text={annotation.replacement ?? annotation.text} /></span>
    </span>
  )
  if (annotation.inline !== false) {
    return (
      <button type="button" className="change-row" onClick={() => props.onJumpAnnotation(annotation)}>
        {meta}
        {snippet}
      </button>
    )
  }
  // A suggestion the editor cannot show inline keeps Accept and Reject on its row, like a hunk.
  return (
    <div className="change-row change-row-actions">
      <button type="button" className="change-row-jump" onClick={() => props.onJumpAnnotation(annotation)}>
        {meta}
        {snippet}
      </button>
      <div className="change-row-buttons">
        <button type="button" className="keep-button" onClick={() => props.onAcceptSuggestion(annotation.id)}>Accept</button>
        <button type="button" className="revert-button" onClick={() => props.onRejectSuggestion(annotation.id)}>Reject</button>
      </div>
    </div>
  )
}

/**
 * Past save rounds, newest first, collapsed to summaries (PRD §6.7). Rows stay
 * collapsed by default because a round's diff legitimately overlaps the pending
 * groups above; hunks load on demand and render read-only.
 */
export const SAVE_HISTORY_PAGE = 10

function SaveHistory({ document, onSaveRound }: Pick<RightRailProps, 'document' | 'onSaveRound'>) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [rounds, setRounds] = useState<Record<string, RoundHunkView[]>>({})
  const [shown, setShown] = useState(SAVE_HISTORY_PAGE)
  if (document.saves.length === 0) return null
  const keyOf = (index: number) => `${index}:${document.saves[index]?.time ?? 0}`
  const toggle = (index: number) => {
    if (expandedIndex === index) {
      setExpandedIndex(null)
      return
    }
    setExpandedIndex(index)
    const key = keyOf(index)
    if (rounds[key] === undefined) {
      void onSaveRound(index).then((round) => setRounds((cache) => ({ ...cache, [key]: round.hunks })))
    }
  }
  const rows = document.saves.map((save, index) => ({ save, index })).reverse()
  const visible = rows.slice(0, shown)
  const older = rows.length - visible.length
  return (
    <div className="save-history">
      <h3 className="save-history-heading">Saves · {document.saves.length}</h3>
      {visible.map(({ save, index }) => {
        const expanded = expandedIndex === index
        const hunks = rounds[keyOf(index)]
        const authors = saveRoundAuthors(save.authors)
        return (
          <div className="save-round" key={keyOf(index)}>
            <button type="button" className="save-round-row" aria-expanded={expanded} onClick={() => toggle(index)}>
              <strong>{saveRoundLabel(index, document.saves.length, save.time)}</strong>
              {authors && <small>{authors}</small>}
              {expanded && hunks !== undefined && <small>{hunks.length} change{hunks.length === 1 ? '' : 's'}</small>}
            </button>
            {expanded && (
              <div className="save-round-hunks">
                {(hunks ?? []).map((hunk, hunkIndex) => (
                  <div className="change-row save-round-hunk" key={hunkIndex}>
                    <span className="change-snippet">
                      {hunkSnippet(hunk).map((line, lineIndex) => (
                        <span className={`snippet-${line.kind}`} key={lineIndex}><InlineMarkdown text={line.text} /></span>
                      ))}
                    </span>
                  </div>
                ))}
                {hunks === undefined && <div className="empty-subtle">Loading…</div>}
                {hunks?.length === 0 && <div className="empty-subtle">Nothing changed</div>}
              </div>
            )}
          </div>
        )
      })}
      {older > 0 && <button type="button" className="text-action show-older" onClick={() => setShown((count) => count + SAVE_HISTORY_PAGE)}>Show older · {older} more</button>}
    </div>
  )
}

function ChangeGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div className="change-group">
      <h3 className="change-group-heading">{label} · {count}</h3>
      {children}
    </div>
  )
}

function ChangesPanel(props: RightRailProps & { now: number }) {
  const groups = changeGroups(props.document)
  const agentSuggestions = groups.proposed.flatMap((annotation) =>
    annotation.author === 'user' ? [] : [annotation.author],
  )
  const bulkAgents = [...new Map(agentSuggestions.map((agent) => [agent.id, agent] as const)).values()]
    .filter((agent) => agentSuggestions.filter((author) => author.id === agent.id).length > 1)
  const revertGroups = bulkRevertGroups(props.document)
  const empty = groups.proposed.length === 0 && groups.unsaved.length === 0 && groups.saved.length === 0
  return (
    <section className="rail-panel changes-panel" aria-labelledby="changes-heading">
      <div className="panel-heading"><h2 id="changes-heading">Changes</h2>{props.document.pendingHunks.length > 0 && <button type="button" className="text-action positive" onClick={props.onMarkReviewed}>Mark reviewed</button>}</div>
      <div className="panel-scroll">
        {bulkAgents.map((agent) => {
          const count = agentSuggestions.filter((author) => author.id === agent.id).length
          return (
            <div className="suggestion-bulk-row" key={agent.id}>
              <span style={{ color: colorOf(agent) }}>{agent.name} · {count} suggestion{count === 1 ? '' : 's'}</span>
              <span>
                <button type="button" className="keep-button" onClick={() => props.onAcceptAllSuggestions(agent.id)}>Accept all</button>
                <button type="button" className="revert-button" onClick={() => props.onRejectAllSuggestions(agent.id)}>Reject all</button>
              </span>
            </div>
          )
        })}
        {revertGroups.map((group) => (
          <div className="suggestion-bulk-row" key={`revert:${group.key}`}>
            <span style={{ color: colorOf(group.author) }}>{group.name} · {group.hunks.length} changes</span>
            <span>
              {props.onKeepAll && <button type="button" className="keep-button" onClick={() => props.onKeepAll!({ name: group.name, hunks: group.hunks })}>Keep all</button>}
              <button type="button" className="revert-button" onClick={() => props.onRevertAll({ name: group.name, hunks: group.hunks })}>Revert all</button>
            </span>
          </div>
        ))}
        <ChangeGroup label="Proposed" count={groups.proposed.length}>
          {groups.proposed.map((annotation) => <SuggestionRow key={annotation.id} annotation={annotation} onJumpAnnotation={props.onJumpAnnotation} onAcceptSuggestion={props.onAcceptSuggestion} onRejectSuggestion={props.onRejectSuggestion} />)}
        </ChangeGroup>
        <ChangeGroup label="Unsaved" count={groups.unsaved.length}>
          {groups.unsaved.map((hunk) => <ChangeRow key={hunk.id} hunk={hunk} now={props.now} onJumpHunk={props.onJumpHunk} onKeepHunk={props.onKeepHunk} onRevertHunk={props.onRevertHunk} />)}
        </ChangeGroup>
        <ChangeGroup label="Saved" count={groups.saved.length}>
          {groups.saved.map((hunk) => <ChangeRow key={hunk.id} hunk={hunk} now={props.now} onJumpHunk={props.onJumpHunk} onKeepHunk={props.onKeepHunk} onRevertHunk={props.onRevertHunk} />)}
        </ChangeGroup>
        {empty && <div className="empty-state">All caught up. <small>Everything reviewed.</small></div>}
        <SaveHistory key={props.document.path} document={props.document} onSaveRound={props.onSaveRound} />
      </div>
    </section>
  )
}

function annotationPlace(annotation: AnnotationView): string {
  if (annotation.kind === 'decision') return annotation.anchor === 'document' ? 'Whole document' : annotation.anchor === 'heading' ? 'Heading' : 'Selected passage'
  const context = annotation.context?.kind
  if (context === 'table-row') return 'Table row'
  if (context === 'table-cell') return 'Table cell'
  if (context === 'screenshot-pin') return 'Screenshot pin'
  return annotation.status === 'resolved' ? 'Resolved' : ''
}

/** One populated Annotations row: kind and place, the text, the exact quote, and a decision's choices. */
function AnnotationCard({ annotation, onOpen }: { annotation: AnnotationView; onOpen(): void }) {
  const orphaned = annotation.status === 'orphaned'
  const place = annotationPlace(annotation)
  const answer = annotation.decision?.answers.at(-1)
  const body = annotation.kind === 'decision' ? annotation.text : annotation.kind === 'suggestion' ? (annotation.replacement ?? annotation.text) : annotation.text || annotation.quote
  const showQuote = annotation.quote.length > 0 && body !== annotation.quote
  return (
    <button type="button" className={`annotation-row kind-${annotation.kind} status-${annotation.status}`} onClick={onOpen}>
      <span className="annotation-meta">
        <span
          className={`annotation-chip chip-${orphaned ? 'orphaned' : annotation.kind}`}
          style={{ '--chip-color': annotationChipColor(annotation) } as CSSProperties}
          title={orphaned ? 'The text this was attached to was removed' : undefined}
        >{orphaned ? 'text removed' : annotation.kind}</span>
        {place && <span className="annotation-place">{place}</span>}
        {annotation.replies.length > 0 && <span className="reply-count">{annotation.replies.length} {annotation.replies.length === 1 ? 'reply' : 'replies'}</span>}
      </span>
      <span className="annotation-text"><InlineMarkdown text={body} /></span>
      {showQuote && <span className="quote-mini"><InlineMarkdown text={annotation.quote} /></span>}
      {annotation.decision && (
        <span className="decision-chips" aria-label="Choices">
          {annotation.decision.options.map((option) => <span key={option} className={answer?.option === option ? 'selected' : ''}>{option}</span>)}
          {answer?.other && <span className="selected">Other: {answer.other}</span>}
        </span>
      )}
    </button>
  )
}

function AnnotationsPanel(props: RightRailProps & { pinChanges: boolean; onPinChanges(): void }) {
  const [filter, setFilter] = useState<AnnotationFilter>('all')
  const [creating, setCreating] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [choices, setChoices] = useState(['', ''])
  const [anchor, setAnchor] = useState('document')
  useEffect(() => { setFilter('all'); setCreating(false) }, [props.document.path])
  const annotations = filteredAnnotations(props.document, filter)
  const counts = annotationCounts(props.document)
  const filters: Array<[AnnotationFilter, string]> = [
    ['all', 'All'], ['decisions', 'Decisions'], ['questions', 'Questions'],
    ['comments', 'Comments'], ['suggestions', 'Suggestions'], ['resolved', 'Resolved'],
  ]
  const addDecision = () => {
    const clean = choices.map((choice) => choice.trim()).filter(Boolean)
    if (!prompt.trim() || clean.length < 2 || new Set(clean).size !== clean.length) return
    const heading = props.headings.find((candidate) => candidate.id === anchor)
    props.onAddDecision(prompt.trim(), clean, heading ?? 'document')
    setPrompt('')
    setChoices(['', ''])
    setAnchor('document')
    setCreating(false)
    setFilter('decisions')
  }
  return (
    <section className="rail-panel annotations-panel" aria-labelledby="annotations-heading">
      <div className="panel-heading">
        <h2 id="annotations-heading">Annotations</h2>
        <span className="panel-counts">{counts.open} open{counts.removedText > 0 ? ` · ${counts.removedText} on removed text` : ''}</span>
        <button type="button" className={`text-action pin-toggle ${props.pinChanges ? 'positive' : ''}`} aria-pressed={props.pinChanges} onClick={props.onPinChanges}>Pin changes</button>
      </div>
      <div className="panel-scroll">
        <div className="annotation-filter" role="toolbar" aria-label="Filter annotations">
          {filters.map(([value, label]) => <button type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <button type="button" className="text-action new-decision" aria-expanded={creating} onClick={() => setCreating((value) => !value)}>New decision</button>
        {creating && (
          <form className="rail-decision-form" onSubmit={(event) => { event.preventDefault(); addDecision() }}>
            <label><span>Anchor</span><select aria-label="Decision anchor" value={anchor} onChange={(event) => setAnchor(event.target.value)}>
              <option value="document">Whole document</option>
              {props.headings.filter((heading) => heading.atx).map((heading) => <option value={heading.id} key={heading.id}>{'#'.repeat(heading.level)} {heading.text}</option>)}
            </select></label>
            {props.headings.some((heading) => !heading.atx) && <small>Only # headings can carry a decision.</small>}
            <label><span>Decision</span><textarea aria-label="Decision prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
            {choices.map((choice, index) => <label key={index}><span>Choice {index + 1}</span><input aria-label={`Decision choice ${index + 1}`} value={choice} onChange={(event) => setChoices((current) => current.map((value, item) => item === index ? event.target.value : value))} /></label>)}
            <small>Other is always available.</small>
            <div><button type="button" className="text-action" onClick={() => setChoices((current) => [...current, ''])}>Add choice</button><button type="submit" className="keep-button">Add decision</button></div>
          </form>
        )}
        {annotations.map((annotation) => <AnnotationCard key={annotation.id} annotation={annotation} onOpen={() => props.onJumpAnnotation(annotation)} />)}
        {annotations.length === 0 && <div className="empty-subtle">{filter === 'all' ? 'Select text to comment' : 'Nothing in this filter.'}</div>}
        {hasResolvedAnnotations(props.document) && <button type="button" className="clear-resolved" onClick={props.onClearResolved}>Clear resolved</button>}
      </div>
    </section>
  )
}

function AttachmentsPanel({ document, now, onNudge, onSetLead, onDisconnect, onCopyAgentPrompt }: Pick<RightRailProps, 'document' | 'onNudge' | 'onSetLead' | 'onDisconnect' | 'onCopyAgentPrompt'> & { now: number }) {
  return (
    <section className="island rail-panel agents-panel" aria-labelledby="agents-heading">
      <AmbientDecor variant="agents" />
      <div className="panel-heading">
        <h2 id="agents-heading" title="What you send is never dropped. An agent's notes to other agents don't keep it attached.">Agents</h2>
        <span className="panel-counts">{document.attachments.length === 0 ? 'None attached' : `${document.attachments.length} attached`}</span>
      </div>
      {document.attachments.map((attachment) => {
        const leads = attachment.agent.id === document.leadAgentId
        const color = AGENT_COLORS[attachment.agent.color]
        return (
          <div
            className={`agent-row${leads ? ' agent-row-lead' : ''}`}
            style={leads ? ({ '--lead-color': color } as CSSProperties) : undefined}
            key={attachment.agent.id}
          >
            <span className="agent-avatar" style={{ background: color, color: textColorFor(color) }}>{initials(attachment.agent.name)}</span>
            <span className="agent-detail">
              <strong>{attachment.agent.name} <small title={absoluteTime(attachment.attachedAt)}>{attachedAgo(attachment.attachedAt, now)}</small></strong>
              <span><i className={`state-dot state-${attachment.state}`} style={attachment.state === 'waiting' ? { background: color } : undefined} />{attachmentStatusLine(attachment, now)}</span>
            </span>
            <span className="agent-actions">
              <button
                type="button"
                className={`agent-icon crown${leads ? ' holds-lead' : ''}`}
                title={leads ? `${attachment.agent.name} is the Lead — click to take it back` : `Make ${attachment.agent.name} the Lead`}
                aria-label={leads ? `Remove the Lead from ${attachment.agent.name}` : `Make ${attachment.agent.name} the Lead`}
                onClick={() => onSetLead(leads ? null : attachment.agent.id)}
              >♛</button>
              <button
                type="button"
                className="agent-icon disconnect"
                title={`Disconnect ${attachment.agent.name}`}
                aria-label={`Disconnect ${attachment.agent.name}`}
                onClick={() => onDisconnect(attachment)}
              >⏻</button>
              <button type="button" className="nudge" title={`Copies a short reminder that asks ${attachment.agent.name} to check in with this document. Paste it to the agent.`} onClick={() => onNudge(attachment.agent.id)}>nudge</button>
            </span>
          </div>
        )
      })}
      {document.attachments.length === 0 && (
        <div className="empty-subtle">
          No agents attached.<br />Send becomes Copy for agent.
          <button type="button" className="text-action positive agent-prompt" onClick={onCopyAgentPrompt}>Copy the prompt for your agent</button>
        </div>
      )}
    </section>
  )
}

export function RightRail(props: RightRailProps) {
  // Relative copy ("saved just now", "attached a minute ago") moves on with the clock.
  const now = useClock()
  const [pinChanges, setPinChanges] = useState(false)
  useEffect(() => setPinChanges(false), [props.document.path])
  const groups = changeGroups(props.document)
  const pinned = [
    ...groups.proposed.map((annotation) => ({ id: annotation.id, text: annotation.replacement ?? annotation.text, label: annotation.author === 'user' ? 'you suggest' : `${annotation.author.name} suggests` })),
    ...[...groups.unsaved, ...groups.saved].map((hunk) => ({ id: hunk.id, text: hunkSnippet(hunk)[0]?.text ?? 'Change', label: `${hunkAuthor(hunk)} ${hunkAction(hunk)}` })),
  ]
  return (
    <aside className="right-rail">
      <section className="island review-host" style={{ height: props.upperReviewHeight }} aria-label="Document review">
        <AmbientDecor variant={props.selectedTab === 'changes' ? 'changes' : 'annotations'} />
        <RailTabs label="Document review" idPrefix="review" selected={props.selectedTab} onSelect={props.onSelectTab} tabs={[
          { id: 'changes', label: 'Changes', count: pendingCount(props.document) },
          { id: 'annotations', label: 'Annotations', count: annotationCounts(props.document).open + annotationCounts(props.document).removedText },
        ]} />
        <section role="tabpanel" id="review-panel-changes" aria-labelledby="review-tab-changes" hidden={props.selectedTab !== 'changes'}>
          <ChangesPanel {...props} now={now} />
        </section>
        <section role="tabpanel" id="review-panel-annotations" aria-labelledby="review-tab-annotations" hidden={props.selectedTab !== 'annotations'}>
          {pinChanges && (
            <div className="pinned-changes" aria-label="Pinned changes">
              <div className="pinned-head">Pinned changes <span>{pinned.length} pending</span></div>
              {pinned.map((item) => <button type="button" key={item.id} onClick={() => props.onSelectTab('changes')}><strong>{item.label}</strong><span>{item.text}</span></button>)}
              {pinned.length === 0 && <span>Nothing waiting for review.</span>}
            </div>
          )}
          <AnnotationsPanel {...props} pinChanges={pinChanges} onPinChanges={() => setPinChanges((value) => !value)} />
        </section>
      </section>
      <Resizer axis="horizontal" label="Resize review window" value={props.upperReviewHeight} min={180} max={954} onChange={(value) => props.onHeight(value, false)} onCommit={(value) => props.onHeight(value, true)} />
      <AttachmentsPanel document={props.document} now={now} onNudge={props.onNudge} onSetLead={props.onSetLead} onDisconnect={props.onDisconnect} onCopyAgentPrompt={props.onCopyAgentPrompt} />
      <div className="save-state-footer">{saveStateSentence(props.document.dirty, props.document.lastSavedAt, now)}</div>
    </aside>
  )
}
