import { useEffect, type ReactNode } from 'react'
import { claimEscape, isEscapeClaimed } from '../escape'
import type { VisualCommentView } from '../../shared/contracts'
import { threadTime } from '../model'
import { useClock } from '../useClock'

export interface VisualCardActions {
  onOpen?(comment: VisualCommentView): void
  onAccept?(comment: VisualCommentView): void
  onReopen?(comment: VisualCommentView): void
  onRetry?(comment: VisualCommentView): void
  onDiscard?(comment: VisualCommentView): void
  onShowMe?(comment: VisualCommentView): void
  onCompare?(comment: VisualCommentView): void
}

/** The text a card shows: the draft while held, otherwise the latest revision. */
export function visualCardText(comment: VisualCommentView): string {
  return comment.draft?.text || comment.revisions.at(-1)?.text || ''
}

/** The latest agent reply on the latest revision, if any. */
export function latestVisualReply(comment: VisualCommentView): { from: string; text: string; file?: string } | null {
  const revision = comment.revisions.at(-1)
  const reply = revision?.replies.at(-1)
  return reply ? { from: revision!.destination.threadTitle, text: reply.text, ...(reply.file ? { file: reply.file } : {}) } : null
}

/**
 * One visual comment as Items, the composer, and the conversation show it:
 * kind and status, the page and size, the marked thumbnail, the text, the
 * summary, the latest agent reply, and the actions the status allows.
 * Every word is plain; no file, selector, or property appears here.
 */
export function VisualCommentCard({ comment, actions = {}, compact = false, children }: { comment: VisualCommentView; actions?: VisualCardActions; compact?: boolean; children?: ReactNode }) {
  const now = useClock()
  const reply = latestVisualReply(comment)
  const latest = comment.revisions.at(-1)
  const text = visualCardText(comment)
  const acceptedAt = latest?.accepted ? threadTime(latest.replies.at(-1)?.at ?? latest.sentAt, now) : ''
  return (
    <article className="visual-card-row" data-status={comment.status} data-compact={compact || undefined} aria-label={`Visual comment · ${comment.statusLabel}`}>
      <header>
        <span className="visual-kind">Visual · comment</span>
        <span className="visual-status" data-status={comment.status}>{comment.statusLabel}</span>
      </header>
      <div className="visual-where">{comment.place}</div>
      <div className="visual-body">
        {comment.thumbnail && <button type="button" className="visual-thumb" aria-label="Open the marked image" onClick={() => actions.onOpen?.(comment)}><img src={comment.thumbnail} alt="" /></button>}
        <div className="visual-text">{text || <em>No note yet</em>}</div>
      </div>
      {comment.summary && <div className="visual-meta">{comment.summary}</div>}
      {latest?.state === 'failed' && <p className="visual-error" role="alert">Send failed{latest.error ? `: ${latest.error}` : ''}</p>}
      {reply && !compact && <div className="visual-reply"><small>{reply.from}</small>{reply.text}</div>}
      {latest?.comparison && !compact && <figure className="visual-compare" aria-label="Then and now">
        <div><img src={latest.comparison.thenUrl} alt="" /><figcaption>then</figcaption></div>
        <div>{latest.comparison.nowUrl ? <img src={latest.comparison.nowUrl} alt="" /> : <span className="visual-compare-missing">views differ</span>}<figcaption>now</figcaption></div>
        {latest.comparison.note && <p className="visual-compare-note">{latest.comparison.note}</p>}
      </figure>}
      {children}
      {!compact && <div className="visual-actions">
        {comment.status === 'held' && actions.onOpen && <button type="button" onClick={() => actions.onOpen!(comment)}>Open</button>}
        {comment.status === 'held' && actions.onDiscard && <button type="button" className="visual-action-quiet" onClick={() => actions.onDiscard!(comment)}>Discard</button>}
        {comment.status === 'failed' && actions.onRetry && <button type="button" onClick={() => actions.onRetry!(comment)}>Retry</button>}
        {comment.status === 'ready' && actions.onAccept && <button type="button" className="visual-action-positive" onClick={() => actions.onAccept!(comment)}>Looks right</button>}
        {comment.status === 'ready' && actions.onReopen && <button type="button" className="visual-action-danger" onClick={() => actions.onReopen!(comment)}>Still wrong</button>}
        {(comment.status === 'ready' || comment.status === 'sent' || comment.status === 'done') && actions.onShowMe && <button type="button" onClick={() => actions.onShowMe!(comment)}>Show me</button>}
        {(comment.status === 'ready' || comment.status === 'done') && actions.onCompare && latest?.comparison && <button type="button" onClick={() => actions.onCompare!(comment)}>Then / now</button>}
        {comment.status === 'done' && <span className="visual-accepted">Accepted{acceptedAt ? ` ${acceptedAt}` : ''}</span>}
      </div>}
    </article>
  )
}

/** The full card with its revision history, opened from the conversation's items menu or a reply chip. */
export function VisualCommentPanel({ comment, actions, notice, onOpenPage, onClose }: { comment: VisualCommentView; actions: VisualCardActions; notice?: string | null; onOpenPage?: (() => void) | undefined; onClose(): void }) {
  const now = useClock()
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isEscapeClaimed(event)) return
      claimEscape(event)
      onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <section className="visual-panel" role="dialog" aria-label="Visual comment">
      <header><strong>Visual comment</strong><button type="button" className="popover-close" aria-label="Close visual comment" onClick={onClose}>×</button></header>
      {notice && <p className="visual-notice" role="status">{notice}{onOpenPage && <> <button type="button" className="visual-notice-action" onClick={onOpenPage}>Open the page</button></>}</p>}
      <VisualCommentCard comment={comment} actions={actions} />
      {comment.revisions.length > 0 && <ol className="visual-history" aria-label="Sends">
        {[...comment.revisions].reverse().map((revision) => <li key={revision.number}>
          <strong>Send {revision.number}</strong> <small>{revision.state === 'sending' ? 'sending' : revision.state === 'failed' ? 'failed' : `sent ${threadTime(revision.sentAt, now)}`} · to {revision.destination.threadTitle}</small>
          {revision.text && <p>{revision.text}</p>}
          {revision.replies.map((reply, index) => <p className="visual-history-reply" key={index}><small>{revision.destination.threadTitle}{reply.ready ? ' · ready for review' : ''}</small>{reply.text}</p>)}
        </li>)}
      </ol>}
    </section>
  )
}
