import { useState, type CSSProperties } from 'react'
import type { AgentIdentity, AnnotationView, AttachmentView, DocumentView, HunkView, RoundHunkView } from '../../shared/contracts'
import {
  absoluteTime,
  activeAnnotations,
  AGENT_COLORS,
  annotationCounts,
  attachedAgo,
  attachmentStateLabel,
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
  textColorFor,
  USER_ANNOTATION_COLOR
} from '../model'
import { InlineMarkdown } from '../inlineMarkdown'
import { AmbientDecor } from './AmbientDecor'
import { Resizer } from './Resizer'

interface RightRailProps {
  document: DocumentView
  changesHeight: number
  annotationsHeight: number
  onHeight(panel: 'changesHeight' | 'annotationsHeight', value: number, commit: boolean): void
  onMarkReviewed(): void
  onJumpHunk(hunk: HunkView): void
  onKeepHunk(id: string): void
  onRevertHunk(hunk: HunkView): void
  onAcceptAllSuggestions(agentId: string): void
  onRejectAllSuggestions(agentId: string): void
  onJumpAnnotation(annotation: AnnotationView): void
  onClearResolved(): void
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
  if (annotation.kind === 'question') return 'var(--controls-warning)'
  if (annotation.author === 'user') return USER_ANNOTATION_COLOR
  return AGENT_COLORS[annotation.author.color]
}

function ChangeRow(props: Pick<RightRailProps, 'onJumpHunk' | 'onKeepHunk' | 'onRevertHunk'> & { hunk: HunkView }) {
  const { hunk } = props
  const meta = (
    <span className="change-meta" title={hunkSourceTooltip(hunk)}>
      <i style={{ background: colorOf(hunk.author) }} />
      <strong style={{ color: colorOf(hunk.author) }}>{hunkAuthor(hunk)}</strong>
      <small>{hunkAction(hunk)}</small>
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

function SuggestionRow(props: Pick<RightRailProps, 'onJumpAnnotation'> & { annotation: AnnotationView }) {
  const { annotation } = props
  return (
    <button type="button" className="change-row" onClick={() => props.onJumpAnnotation(annotation)}>
      <span className="change-meta">
        <i style={{ background: colorOf(annotation.author) }} />
        <strong style={{ color: colorOf(annotation.author) }}>{annotation.author === 'user' ? 'you' : annotation.author.name}</strong>
        <small>suggests</small>
      </span>
      <span className="change-snippet">
        <span className="snippet-removed"><InlineMarkdown text={annotation.quote} /></span>
        <span className="snippet-added"><InlineMarkdown text={annotation.replacement ?? annotation.text} /></span>
      </span>
    </button>
  )
}

/**
 * Past save rounds, newest first, collapsed to summaries (PRD §6.7). Rows stay
 * collapsed by default because a round's diff legitimately overlaps the pending
 * groups above; hunks load on demand and render read-only.
 */
function SaveHistory({ document, onSaveRound }: Pick<RightRailProps, 'document' | 'onSaveRound'>) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [rounds, setRounds] = useState<Record<string, RoundHunkView[]>>({})
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
  return (
    <div className="save-history">
      <h3 className="save-history-heading">Saves · {document.saves.length}</h3>
      {rows.map(({ save, index }) => {
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

function ChangesPanel(props: RightRailProps) {
  const groups = changeGroups(props.document)
  const agentSuggestions = groups.proposed.flatMap((annotation) =>
    annotation.author === 'user' ? [] : [annotation.author],
  )
  const bulkAgents = [...new Map(agentSuggestions.map((agent) => [agent.id, agent] as const)).values()]
    .filter((agent) => agentSuggestions.filter((author) => author.id === agent.id).length > 1)
  const empty = groups.proposed.length === 0 && groups.unsaved.length === 0 && groups.saved.length === 0
  return (
    <section className="island rail-panel changes-panel" style={{ height: props.changesHeight }} aria-labelledby="changes-heading">
      <AmbientDecor variant="changes" />
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
        <ChangeGroup label="Proposed" count={groups.proposed.length}>
          {groups.proposed.map((annotation) => <SuggestionRow key={annotation.id} annotation={annotation} onJumpAnnotation={props.onJumpAnnotation} />)}
        </ChangeGroup>
        <ChangeGroup label="Unsaved" count={groups.unsaved.length}>
          {groups.unsaved.map((hunk) => <ChangeRow key={hunk.id} hunk={hunk} onJumpHunk={props.onJumpHunk} onKeepHunk={props.onKeepHunk} onRevertHunk={props.onRevertHunk} />)}
        </ChangeGroup>
        <ChangeGroup label="Saved" count={groups.saved.length}>
          {groups.saved.map((hunk) => <ChangeRow key={hunk.id} hunk={hunk} onJumpHunk={props.onJumpHunk} onKeepHunk={props.onKeepHunk} onRevertHunk={props.onRevertHunk} />)}
        </ChangeGroup>
        {empty && <div className="empty-state">All caught up. <small>Everything reviewed.</small></div>}
        <SaveHistory key={props.document.path} document={props.document} onSaveRound={props.onSaveRound} />
      </div>
    </section>
  )
}

function AnnotationsPanel(props: RightRailProps) {
  const annotations = activeAnnotations(props.document)
  const counts = annotationCounts(props.document)
  return (
    <section className="island rail-panel annotations-panel" style={{ height: props.annotationsHeight }} aria-labelledby="annotations-heading">
      <AmbientDecor variant="annotations" />
      <div className="panel-heading">
        <h2 id="annotations-heading">Annotations</h2>
        <span className="panel-counts">{counts.open} open{counts.removedText > 0 ? ` · ${counts.removedText} on removed text` : ''}</span>
      </div>
      <div className="panel-scroll">
        {annotations.map((annotation) => (
          <button type="button" className="annotation-row" key={annotation.id} onClick={() => props.onJumpAnnotation(annotation)}>
            <span
              className={`annotation-chip chip-${annotation.status === 'orphaned' ? 'orphaned' : annotation.kind}`}
              style={{ '--chip-color': annotationChipColor(annotation) } as CSSProperties}
              title={annotation.status === 'orphaned' ? 'The text this was attached to was removed' : undefined}
            >{annotation.status === 'orphaned' ? 'text removed' : annotation.kind}</span>
            <span><InlineMarkdown text={annotation.quote} /></span>
          </button>
        ))}
        {annotations.length === 0 && <div className="empty-subtle">Select text to comment</div>}
        {hasResolvedAnnotations(props.document) && <button type="button" className="clear-resolved" onClick={props.onClearResolved}>Clear resolved</button>}
      </div>
    </section>
  )
}

function AttachmentsPanel({ document, onNudge, onSetLead, onDisconnect }: Pick<RightRailProps, 'document' | 'onNudge' | 'onSetLead' | 'onDisconnect'>) {
  return (
    <section className="island rail-panel agents-panel" aria-labelledby="agents-heading">
      <AmbientDecor variant="agents" />
      <div className="panel-heading">
        <h2 id="agents-heading" title="What you send is never dropped. An agent's notes to other agents don't keep it attached.">Attached agents</h2>
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
              <strong>{attachment.agent.name} <small title={absoluteTime(attachment.attachedAt)}>{attachedAgo(attachment.attachedAt)}</small></strong>
              <span><i className={`state-dot state-${attachment.state}`} style={attachment.state === 'waiting' ? { background: color } : undefined} />{attachmentStateLabel(attachment.state)}</span>
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
              <button type="button" className="nudge" onClick={() => onNudge(attachment.agent.id)}>nudge</button>
            </span>
          </div>
        )
      })}
      {document.attachments.length === 0 && <div className="empty-subtle">No agents attached.<br />Send becomes Copy for agent.</div>}
    </section>
  )
}

export function RightRail(props: RightRailProps) {
  return (
    <aside className="right-rail">
      <ChangesPanel {...props} />
      <Resizer axis="horizontal" label="Resize changes panel" value={props.changesHeight} min={120} max={520} onChange={(value) => props.onHeight('changesHeight', value, false)} onCommit={(value) => props.onHeight('changesHeight', value, true)} />
      <AnnotationsPanel {...props} />
      <Resizer axis="horizontal" label="Resize annotations panel" value={props.annotationsHeight} min={90} max={420} onChange={(value) => props.onHeight('annotationsHeight', value, false)} onCommit={(value) => props.onHeight('annotationsHeight', value, true)} />
      <AttachmentsPanel document={props.document} onNudge={props.onNudge} onSetLead={props.onSetLead} onDisconnect={props.onDisconnect} />
      <div className="save-state-footer">{saveStateSentence(props.document.dirty, props.document.lastSavedAt)}</div>
    </aside>
  )
}
