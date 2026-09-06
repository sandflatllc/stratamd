import { useState } from 'react'
import type { EngineThreadView, EngineView, PreviewTabView, ReviewTab, VisualCommentView } from '../../shared/contracts'
import { pageName } from '../../shared/preview'
import { AGENT_COLORS, textColorFor, threadAgentName } from '../model'
import { AmbientDecor } from './AmbientDecor'
import { RailTabs } from './RailTabs'
import { Resizer } from './Resizer'
import { VisualCommentCard, type VisualCardActions } from './VisualCommentCard'

/**
 * The right window with a preview centered (docs/plans/open/visual-review):
 * the same Changes and Items host as a document, with Items listing the
 * project's visual comments, and Attached listing the threads using the
 * project's browser with a badge while Strata serves their requests.
 */
interface PreviewRailProps {
  projectId: string
  engine: EngineView
  tabs: PreviewTabView[]
  serving: string[]
  visualComments: VisualCommentView[]
  visualActions: VisualCardActions
  upperReviewHeight: number
  onHeight(value: number, commit: boolean): void
  onOpenConversation(threadId: string): void
  onStop(threadId: string): void
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
}

export function PreviewRail({ projectId, engine, tabs, serving, visualComments, visualActions, upperReviewHeight, onHeight, onOpenConversation, onStop }: PreviewRailProps) {
  const [tab, setTab] = useState<ReviewTab>('annotations')
  const [filter, setFilter] = useState<'all' | 'visual' | 'resolved'>('all')
  const project = engine.projects.find((candidate) => candidate.id === projectId)
  const threadIds = [...new Set([...tabs.flatMap((candidate) => candidate.threadId ? [candidate.threadId] : []), ...serving])]
  const threads = threadIds.flatMap((id) => { const thread = project?.threads.find((candidate) => candidate.id === id); return thread ? [thread] : [] })
  const shown = filter === 'resolved' ? visualComments.filter((comment) => comment.status === 'done') : filter === 'visual' ? visualComments : visualComments.filter((comment) => comment.status !== 'done')
  const done = visualComments.filter((comment) => comment.status === 'done').length
  const statusLine = (thread: EngineThreadView) => {
    const own = tabs.filter((candidate) => candidate.threadId === thread.id)
    const busy = own.find((candidate) => candidate.working) ?? own.find((candidate) => candidate.paused)
    if (busy?.paused) return `paused in ${pageName(busy.url, busy.title)}`
    if (busy) return `${busy.activity ?? 'working'} in ${pageName(busy.url, busy.title)}`
    if (own.length) return `browsing ${pageName(own[0]!.url, own[0]!.title)}`
    return thread.status === 'running' ? 'working' : 'idle'
  }
  return (
    <aside className="right-rail preview-rail">
      <section className="island review-host" style={{ height: upperReviewHeight }} aria-label="Preview review">
        <AmbientDecor variant={tab === 'changes' ? 'changes' : 'annotations'} />
        <RailTabs<ReviewTab> label="Preview review" idPrefix="preview-review" selected={tab} onSelect={(next) => setTab(next)} tabs={[
          { id: 'changes', label: 'Changes', count: 0 },
          { id: 'annotations', label: 'Items', count: visualComments.filter((comment) => comment.status !== 'done').length },
        ]} />
        <section role="tabpanel" id="preview-review-panel-changes" aria-labelledby="preview-review-tab-changes" hidden={tab !== 'changes'}>
          <section className="rail-panel changes-panel" aria-labelledby="preview-changes-heading">
            <div className="panel-heading"><h2 id="preview-changes-heading">Changes</h2></div>
            <div className="panel-scroll"><div className="empty-state">Changes belong to a document. <small>Open one to review its edits.</small></div></div>
          </section>
        </section>
        <section role="tabpanel" id="preview-review-panel-annotations" aria-labelledby="preview-review-tab-annotations" hidden={tab !== 'annotations'}>
          <section className="rail-panel annotations-panel" aria-labelledby="preview-items-heading">
            <div className="panel-heading">
              <h2 id="preview-items-heading">Items</h2>
              <span className="panel-counts">{done} of {visualComments.length} done</span>
            </div>
            <div className="panel-scroll">
              <div className="annotation-filter" role="toolbar" aria-label="Filter items">
                {([['all', 'All'], ['visual', 'Visual'], ['resolved', 'Resolved']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
              </div>
              {shown.map((comment) => <VisualCommentCard key={comment.id} comment={comment} actions={visualActions} />)}
              {shown.length === 0 && <div className="empty-subtle">{visualComments.length === 0 ? 'Mark up the page to leave a visual comment.' : 'Nothing in this filter.'}</div>}
            </div>
          </section>
        </section>
      </section>
      <Resizer axis="horizontal" label="Resize review window" value={upperReviewHeight} min={180} max={954} onChange={(value) => onHeight(value, false)} onCommit={(value) => onHeight(value, true)} />
      <section className="island rail-panel agents-panel" aria-labelledby="preview-attached-heading">
        <AmbientDecor variant="agents" />
        <div className="panel-heading">
          <h2 id="preview-attached-heading">Attached</h2>
          <span className="panel-counts">{threads.length === 0 ? 'No threads' : `${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}`}</span>
        </div>
        {threads.map((thread, index) => {
          const color = AGENT_COLORS[(['grape', 'sky', 'mint', 'tangerine'] as const)[index % 4]!]
          const busy = serving.includes(thread.id)
          return (
            <div className="agent-row" key={thread.id} data-thread={thread.id}>
              <span className="agent-avatar" style={{ background: color, color: textColorFor(color) }}>{initials(threadAgentName(engine, thread.id))}</span>
              <span className="agent-detail">
                <strong>{thread.title}</strong>
                <span><i className={`state-dot state-${thread.status === 'running' ? 'running' : 'idle'}`} />{statusLine(thread)}</span>
              </span>
              <span className="agent-actions">
                {busy && <span className="agent-browser-badge" title="Strata is serving this thread's browser requests">browser</span>}
                <button type="button" className="agent-icon" title={`Open ${thread.title} as a tab`} aria-label={`Open ${thread.title} as a tab`} onClick={() => onOpenConversation(thread.id)}>↗</button>
                <button type="button" className="agent-icon" title={`Stop ${thread.title}`} aria-label={`Stop ${thread.title}`} onClick={() => onStop(thread.id)}>■</button>
              </span>
            </div>
          )
        })}
        {threads.length === 0 && <div className="empty-subtle">No thread is using this project's browser.</div>}
      </section>
    </aside>
  )
}
