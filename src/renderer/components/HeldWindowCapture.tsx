import type { VisualCommentView } from '../../shared/contracts'
export function HeldWindowCapture({ comment, busy, onReview, onRemove }: { comment: VisualCommentView; busy: boolean; onReview(): void; onRemove(): void }) {
  if (comment.anchor.kind !== 'image') return null
  const label = comment.anchor.windowCapture?.selection === 'system-source' ? 'System capture' : 'Window capture'
  return <div className="held-window-capture">
    <div className="conversation-attachment-preview" data-kind="capture">
      {comment.thumbnail && <img src={comment.thumbnail} alt="" />}
      <div><strong>{comment.anchor.name}</strong><small>{label} · comment held</small></div>
      <button type="button" disabled={busy} aria-label={`Remove held capture: ${comment.anchor.name}`} onClick={onRemove}>×</button>
    </div>
    <div className="held-window-capture-summary"><span>1 {label.toLowerCase()} · 1 visual comment</span><button type="button" className="text-action" onClick={onReview}>Review</button></div>
  </div>
}
