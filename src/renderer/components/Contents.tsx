import type { EditorHeading } from '../../editor/headings'
import type { WalkthroughAction, WalkthroughState } from '../../shared/contracts'
import { referenceKey, referencedWalkthroughHeadings, resolveHeadingReference } from '../../shared/walkthrough'

export interface OutlineNode {
  heading: EditorHeading
  children: OutlineNode[]
}

export function headingOutline(headings: readonly EditorHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const heading of headings) {
    const node: OutlineNode = { heading, children: [] }
    while (stack.length > 0 && stack.at(-1)!.heading.level >= heading.level) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

interface WalkthroughView {
  state: WalkthroughState
  references: ReturnType<typeof referencedWalkthroughHeadings<EditorHeading>>
  included: ReturnType<typeof referencedWalkthroughHeadings<EditorHeading>>
  currentIndex: number
  markerByKey: Map<string, WalkthroughState['markers'][number]>
}

function OutlineItems({ nodes, activeId, walkthrough, onJump, onAction }: {
  nodes: readonly OutlineNode[]
  activeId: string | null
  walkthrough: WalkthroughView | null
  onJump(id: string): void
  onAction(action: WalkthroughAction): void
}) {
  const references = new Map(walkthrough?.references.map((entry) => [entry.heading.id, entry.reference]))
  return (
    <ul role="group">
      {nodes.map(({ heading, children }) => {
        const reference = references.get(heading.id)
        const excluded = reference ? walkthrough?.state.excluded.some((candidate) => referenceKey(candidate) === referenceKey(reference)) : false
        const marker = reference ? walkthrough?.markerByKey.get(referenceKey(reference)) : undefined
        return (
          <li role="treeitem" aria-level={heading.level} key={heading.id} className={excluded ? 'walkthrough-excluded' : undefined}>
            <span className="contents-row-wrap">
              {walkthrough && reference && (
                <input
                  type="checkbox"
                  aria-label={`Include ${heading.text} in walkthrough`}
                  checked={!excluded}
                  onChange={(event) => onAction({ type: 'set-included', heading: reference, included: event.currentTarget.checked })}
                />
              )}
              <button
                type="button"
                className={`contents-row ${activeId === heading.id ? 'active' : ''}`}
                aria-current={activeId === heading.id ? 'location' : undefined}
                onClick={() => {
                  if (walkthrough && reference && !excluded) onAction({ type: 'set-current', heading: reference })
                  onJump(heading.id)
                }}
              >
                <span className="contents-level">H{heading.level}</span>
                <span className="contents-text">{heading.text}</span>
                {marker && <span className={`walkthrough-marker ${marker.status}`}>{marker.status === 'reviewed' ? 'Reviewed' : 'Revisit'}</span>}
              </button>
            </span>
            {children.length > 0 && <OutlineItems nodes={children} activeId={activeId} walkthrough={walkthrough} onJump={onJump} onAction={onAction} />}
          </li>
        )
      })}
    </ul>
  )
}

function WalkthroughControls({ view, onJump, onAction }: {
  view: WalkthroughView
  onJump(id: string): void
  onAction(action: WalkthroughAction): void
}) {
  const current = view.currentIndex >= 0 ? view.included[view.currentIndex] : undefined
  const marker = current ? view.markerByKey.get(referenceKey(current.reference)) : undefined
  const move = (offset: -1 | 1) => {
    const target = view.included[view.currentIndex + offset]
    if (!target) return
    onAction({ type: 'set-current', heading: target.reference })
    onJump(target.heading.id)
  }
  return (
    <section className="walkthrough-controls" aria-label="Walkthrough controls">
      <div className="walkthrough-status">
        <strong>{current ? `Section ${view.currentIndex + 1} of ${view.included.length}` : 'No sections included'}</strong>
        <button type="button" className="text-action" onClick={() => onAction({ type: 'leave' })}>Leave walkthrough</button>
      </div>
      <div className="walkthrough-level" role="radiogroup" aria-label="Walkthrough section levels">
        <button type="button" role="radio" aria-checked={view.state.level === 'h2'} onClick={() => onAction({ type: 'set-level', level: 'h2' })}>H2</button>
        <button type="button" role="radio" aria-checked={view.state.level === 'h2-h3'} onClick={() => onAction({ type: 'set-level', level: 'h2-h3' })}>H2 + H3</button>
      </div>
      <div className="walkthrough-navigation">
        <button type="button" disabled={view.currentIndex <= 0} onClick={() => move(-1)}>Previous</button>
        <button type="button" disabled={view.currentIndex < 0 || view.currentIndex >= view.included.length - 1} onClick={() => move(1)}>Next</button>
      </div>
      <div className="walkthrough-marks">
        <button type="button" className="reviewed" disabled={!current} aria-pressed={marker?.status === 'reviewed'} onClick={() => current && onAction({ type: 'mark', heading: current.reference, status: 'reviewed' })}>Reviewed</button>
        <button type="button" className="revisit" disabled={!current} aria-pressed={marker?.status === 'revisit'} onClick={() => current && onAction({ type: 'mark', heading: current.reference, status: 'revisit' })}>Revisit</button>
      </div>
    </section>
  )
}

export function Contents({ headings, activeId, walkthrough, onJump, onWalkthrough }: {
  headings: readonly EditorHeading[]
  activeId: string | null
  walkthrough: WalkthroughState
  onJump(id: string): void
  onWalkthrough(action: WalkthroughAction): void
}) {
  const title = headings.find((heading) => heading.level === 1)
  const outline = headingOutline(headings.filter((heading) => heading !== title))
  const references = referencedWalkthroughHeadings(headings)
  const excluded = new Set(walkthrough.excluded.map(referenceKey))
  const included = references.filter(({ heading, reference }) =>
    (walkthrough.level === 'h2-h3' || heading.level === 2) && !excluded.has(referenceKey(reference)),
  )
  const resolvedCurrent = walkthrough.current ? resolveHeadingReference(walkthrough.current, headings) : null
  const currentIndex = resolvedCurrent ? included.findIndex(({ heading }) => heading === resolvedCurrent.heading) : -1
  const walkthroughView: WalkthroughView | null = walkthrough.active ? {
    state: walkthrough,
    references,
    included,
    currentIndex,
    markerByKey: new Map(walkthrough.markers.map((marker) => [referenceKey(marker.heading), marker])),
  } : null
  return (
    <nav className="contents" aria-label="Document contents">
      <div className="panel-heading">
        <h2>Contents</h2>
        {!walkthrough.active && <button type="button" className="text-action positive" onClick={() => onWalkthrough({ type: 'start' })}>Start walkthrough</button>}
      </div>
      {walkthroughView && <WalkthroughControls view={walkthroughView} onJump={onJump} onAction={onWalkthrough} />}
      {headings.length === 0 ? <div className="contents-empty">This document has no headings.</div> : (
        <>
          {title && (
            <button type="button" className={`contents-title ${activeId === title.id ? 'active' : ''}`} aria-current={activeId === title.id ? 'location' : undefined} onClick={() => onJump(title.id)}>
              <span>Document title</span>
              <strong>{title.text}</strong>
            </button>
          )}
          <div className="contents-tree" role="tree" aria-label="Headings">
            <OutlineItems nodes={outline} activeId={activeId} walkthrough={walkthroughView} onJump={onJump} onAction={onWalkthrough} />
          </div>
        </>
      )}
    </nav>
  )
}
