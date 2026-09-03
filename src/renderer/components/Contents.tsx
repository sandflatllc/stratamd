import { useState } from 'react'
import type { EditorHeading } from '../../editor/headings'
import type { WalkthroughAction, WalkthroughState } from '../../shared/contracts'
import { referenceKey } from '../../shared/walkthrough'
import { sectionPreview, stepLevel, stepNumber, walkthroughView, type WalkthroughView } from '../walkthrough'

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

function containsHeading(node: OutlineNode, id: string | null): boolean {
  if (id === null) return false
  if (node.heading.id === id) return true
  return node.children.some((child) => containsHeading(child, id))
}

interface OutlineContext {
  activeId: string | null
  walkthrough: WalkthroughView | null
  expanded: ReadonlySet<string>
  onToggleExpand(id: string): void
  onJump(id: string): void
  onAction(action: WalkthroughAction): void
}

function StateMark({ status }: { status: 'reviewed' | 'revisit' | undefined }) {
  // Shape and text carry the state; color only reinforces it.
  return (
    <span className="outline-state" data-state={status ?? 'none'}>
      <i aria-hidden="true">{status === 'reviewed' ? '✓' : status === 'revisit' ? '↻' : ''}</i>
      {status && <span className="sr-only">{status === 'reviewed' ? 'Reviewed' : 'Revisit'}</span>}
    </span>
  )
}

function OutlineRow({ node, number, depth, context, revealed = false }: { node: OutlineNode; number: string | null; depth: number; context: OutlineContext; revealed?: boolean }) {
  const { heading } = node
  const { walkthrough } = context
  const reference = walkthrough?.references.find((entry) => entry.heading.id === heading.id)?.reference
  const eligible = Boolean(walkthrough && reference && stepLevel(walkthrough.state.level, heading.level))
  const excluded = eligible && reference ? walkthrough!.state.excluded.some((candidate) => referenceKey(candidate) === referenceKey(reference)) : false
  const marker = reference ? walkthrough?.markerByKey.get(referenceKey(reference)) : undefined
  const active = context.activeId === heading.id
  const containsActive = containsHeading(node, context.activeId)
  const primary = depth === 0
  const hasChildren = node.children.length > 0
  const stepsInside = primary && walkthrough?.state.level === 'h2-h3' && node.children.some((child) => child.heading.level === 3)
  const expanded = context.expanded.has(heading.id)
  // An explicit expansion opens the whole subtree; the active path opens only as deep as it goes.
  const showChildren = hasChildren && (expanded || revealed || containsActive || stepsInside)
  const classes = ['outline-row', primary ? 'primary' : 'nested', active ? 'active' : '', excluded ? 'excluded' : '', marker ? marker.status : '']
  return (
    <li role="treeitem" aria-level={heading.level} aria-expanded={hasChildren ? showChildren : undefined} className={excluded ? 'walkthrough-excluded' : undefined}>
      <div className="outline-row-wrap">
        {eligible && reference && (
          <input
            type="checkbox"
            className="outline-include"
            aria-label={`Include ${heading.text} in walkthrough`}
            checked={!excluded}
            onChange={(event) => context.onAction({ type: 'set-included', heading: reference, included: event.currentTarget.checked })}
          />
        )}
        <button
          type="button"
          className={classes.filter(Boolean).join(' ')}
          aria-current={active ? 'location' : undefined}
          title={heading.text}
          onClick={() => {
            if (walkthrough && reference && eligible && !excluded) context.onAction({ type: 'set-current', heading: reference })
            context.onJump(heading.id)
          }}
        >
          <span className="outline-num" aria-hidden="true">{number ?? (primary ? '' : '·')}</span>
          <span className="outline-text">{heading.text}</span>
          <StateMark status={marker?.status} />
        </button>
        {hasChildren && (
          <button
            type="button"
            className="outline-disclosure"
            aria-label={`${showChildren ? 'Hide' : 'Show'} subsections of ${heading.text}`}
            aria-expanded={showChildren}
            onClick={() => context.onToggleExpand(heading.id)}
          >{showChildren ? '⌄' : '›'}</button>
        )}
      </div>
      {showChildren && (
        <ul role="group" className="outline-sub">
          {node.children.map((child) => <OutlineRow key={child.heading.id} node={child} number={null} depth={depth + 1} context={context} revealed={expanded || revealed} />)}
        </ul>
      )}
    </li>
  )
}

function WalkthroughCard({ view, content, onJump, onAction }: {
  view: WalkthroughView
  content: string
  onJump(id: string): void
  onAction(action: WalkthroughAction): void
}) {
  const current = view.current
  const total = view.included.length
  const move = (offset: -1 | 1) => {
    const target = view.included[view.currentIndex + offset]
    if (!target) return
    onAction({ type: 'set-current', heading: target.reference })
    onJump(target.heading.id)
  }
  const preview = current ? sectionPreview(content, current.heading) : ''
  const progress = current ? ((view.currentIndex + 1) / total) * 100 : 0
  return (
    <section className="walk-card" aria-label="Walkthrough controls">
      <div className="walk-kicker">
        <span>Walkthrough</span>
        <b>{current ? `Section ${view.currentIndex + 1} of ${total}` : 'No sections included'}</b>
      </div>
      <h3 className="walk-title">{current ? current.heading.text : 'Include a section to continue'}</h3>
      <p className="walk-preview">{current ? (preview || 'This section opens with a table, diagram, or list.') : 'Every step is excluded. Turn one back on in the list below.'}</p>
      <div className="progress-track" role="progressbar" aria-label="Walkthrough progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={current ? view.currentIndex + 1 : 0}>
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="walk-actions">
        <button type="button" disabled={view.currentIndex <= 0} onClick={() => move(-1)}><span aria-hidden="true">‹ </span>Previous</button>
        <button type="button" disabled={view.currentIndex < 0 || view.currentIndex >= total - 1} onClick={() => move(1)}>Next<span aria-hidden="true"> ›</span></button>
        <div className="walk-depth" role="radiogroup" aria-label="Walkthrough section levels">
          <button type="button" role="radio" aria-checked={view.state.level === 'h2'} onClick={() => onAction({ type: 'set-level', level: 'h2' })}>H2</button>
          <button type="button" role="radio" aria-checked={view.state.level === 'h2-h3'} onClick={() => onAction({ type: 'set-level', level: 'h2-h3' })}>H2 + H3</button>
        </div>
        <button type="button" className="leave" aria-label="Leave walkthrough" onClick={() => onAction({ type: 'leave' })}>Leave</button>
      </div>
    </section>
  )
}

export function Contents({ headings, activeId, walkthrough, content, onJump, onWalkthrough }: {
  headings: readonly EditorHeading[]
  activeId: string | null
  walkthrough: WalkthroughState
  /** The live Markdown, for the walkthrough card's section preview. */
  content: string
  onJump(id: string): void
  onWalkthrough(action: WalkthroughAction): void
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const title = headings.find((heading) => heading.level === 1)
  const outline = headingOutline(headings.filter((heading) => heading !== title))
  const view = walkthroughView(headings, walkthrough)
  const context: OutlineContext = {
    activeId,
    walkthrough: view,
    expanded,
    onToggleExpand: (id) => setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    }),
    onJump,
    onAction: onWalkthrough,
  }
  return (
    <nav className="contents" aria-label="Document contents">
      <div className="panel-heading">
        <h2>Contents</h2>
        {!walkthrough.active && headings.length > 0 && <button type="button" className="text-action positive" onClick={() => onWalkthrough({ type: 'start' })}>Start walkthrough</button>}
      </div>
      {view && <WalkthroughCard view={view} content={content} onJump={onJump} onAction={onWalkthrough} />}
      {headings.length === 0 ? <div className="contents-empty">This document has no headings.</div> : (
        <div className="contents-scroll">
          {title && (
            <button type="button" className={`contents-title ${activeId === title.id ? 'active' : ''}`} aria-current={activeId === title.id ? 'location' : undefined} onClick={() => onJump(title.id)}>
              <span>Document title</span>
              <strong>{title.text}</strong>
            </button>
          )}
          <div className="outline-label"><span>Sections</span><span className="outline-count">{outline.length}</span></div>
          <ul className="contents-tree" role="tree" aria-label="Headings">
            {outline.map((node, index) => <OutlineRow key={node.heading.id} node={node} number={stepNumber(index)} depth={0} context={context} />)}
          </ul>
        </div>
      )}
    </nav>
  )
}
