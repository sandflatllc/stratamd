import type { WalkthroughAction } from '../../shared/contracts'
import { referenceKey } from '../../shared/walkthrough'
import { stepNumber, type WalkthroughView } from '../walkthrough'

/**
 * The center-bottom walkthrough bar: section progress, Previous and Next, and
 * the Reviewed / Revisit marks for the current step. It complements Contents
 * and never replaces it (docs/design/structured-reading, faithful shell).
 */
export function WalkthroughBar({ view, onJump, onAction }: {
  view: WalkthroughView
  onJump(id: string): void
  onAction(action: WalkthroughAction): void
}) {
  const current = view.current
  const total = view.included.length
  const marker = current ? view.markerByKey.get(referenceKey(current.reference)) : undefined
  const move = (offset: -1 | 1) => {
    const target = view.included[view.currentIndex + offset]
    if (!target) return
    onAction({ type: 'set-current', heading: target.reference })
    onJump(target.heading.id)
  }
  const progress = current ? ((view.currentIndex + 1) / total) * 100 : 0
  return (
    <div className="walkbar" role="group" aria-label="Walkthrough progress">
      <div className="walkbar-nav">
        <button type="button" aria-label="Previous section" disabled={view.currentIndex <= 0} onClick={() => move(-1)}>‹</button>
        <button type="button" aria-label="Next section" disabled={view.currentIndex < 0 || view.currentIndex >= total - 1} onClick={() => move(1)}>›</button>
      </div>
      <div className="walkbar-center">
        <div className="walkbar-title">
          <span>{current ? `${stepNumber(view.currentIndex)} / ${stepNumber(total - 1)}` : '— / —'}</span>
          <span className="walkbar-heading">{current ? current.heading.text : 'No sections included'}</span>
        </div>
        <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
      </div>
      <div className="state-actions">
        <button type="button" className="reviewed" disabled={!current} aria-pressed={marker?.status === 'reviewed'} onClick={() => current && onAction({ type: 'mark', heading: current.reference, status: 'reviewed' })}>Reviewed</button>
        <button type="button" className="revisit" disabled={!current} aria-pressed={marker?.status === 'revisit'} onClick={() => current && onAction({ type: 'mark', heading: current.reference, status: 'revisit' })}>Revisit</button>
      </div>
    </div>
  )
}
