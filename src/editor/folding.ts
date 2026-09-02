import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from 'prosemirror-view'
import type { HeadingReference } from '../shared/contracts'
import { referenceKey, referencedHeadings, resolveHeadingReference } from '../shared/walkthrough'
import type { AnnotationRange } from './annotations'
import { headingsForState, type EditorHeading } from './headings'
import type { ReviewRange } from './review'

const foldingKey = new PluginKey<number>('stratamd-folding')

interface FoldRange {
  heading: EditorHeading
  reference: HeadingReference
  from: number
  contentFrom: number
  to: number
}

export interface FoldingManagerOptions {
  folded?: readonly HeadingReference[]
  onFold?(heading: HeadingReference, folded: boolean): void
}

class HeadingNodeView implements NodeView {
  readonly dom: HTMLElement
  readonly contentDOM: HTMLElement
  private node: ProseMirrorNode
  private readonly manager: FoldingManager
  private readonly getPos: () => number | undefined
  private readonly button: HTMLButtonElement
  private readonly hiddenStatus: HTMLSpanElement

  constructor(node: ProseMirrorNode, manager: FoldingManager, getPos: () => number | undefined) {
    this.node = node
    this.manager = manager
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'strata-fold-heading'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'strata-fold-toggle'
    this.button.contentEditable = 'false'
    this.button.addEventListener('click', () => {
      const position = this.getPos()
      if (position !== undefined) this.manager.toggle(position)
    })
    this.contentDOM = document.createElement(`h${Number(node.attrs.level)}`)
    this.contentDOM.className = 'strata-fold-heading__content'
    this.hiddenStatus = document.createElement('span')
    this.hiddenStatus.className = 'strata-fold-hidden-status'
    this.hiddenStatus.contentEditable = 'false'
    this.dom.append(this.button, this.contentDOM, this.hiddenStatus)
    if (this.manager.isAttached()) this.refresh()
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || node.attrs.level !== this.node.attrs.level) return false
    if (node.eq(this.node)) return true
    this.node = node
    this.refresh()
    return true
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.button.contains(event.target)
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.target !== this.contentDOM && !this.contentDOM.contains(mutation.target)
  }

  destroy(): void { this.manager.unregister(this) }

  refresh(): void {
    const position = this.getPos()
    if (position === undefined) return
    const state = this.manager.headingState(position)
    this.button.dataset.icon = state.folded && !state.temporarilyOpen ? '›' : '⌄'
    this.button.setAttribute('aria-expanded', String(!state.folded || state.temporarilyOpen))
    this.button.setAttribute('aria-label', `${state.folded && !state.temporarilyOpen ? 'Expand' : 'Collapse'} section`)
    this.button.title = state.temporarilyOpen ? `${state.text} is temporarily open for a review target` : `${state.folded ? 'Expand' : 'Collapse'} ${state.text}`
    this.dom.classList.toggle('is-folded', state.folded && !state.temporarilyOpen)
    this.dom.classList.toggle('is-temporarily-open', state.temporarilyOpen)
    const parts = [
      state.annotations > 0 ? `${state.annotations} ${state.annotations === 1 ? 'annotation' : 'annotations'} hidden` : '',
      state.changes > 0 ? `${state.changes} ${state.changes === 1 ? 'change' : 'changes'} hidden` : '',
    ].filter(Boolean)
    this.hiddenStatus.textContent = state.folded && !state.temporarilyOpen ? parts.join(' · ') : state.temporarilyOpen ? 'Temporarily open' : ''
    this.hiddenStatus.hidden = this.hiddenStatus.textContent.length === 0
  }
}

export class FoldingManager {
  private view: EditorView | null = null
  private folded: HeadingReference[]
  private temporaryPosition: number | null = null
  private reviews: readonly ReviewRange[] = []
  private annotations: readonly AnnotationRange[] = []
  private readonly nodeViews = new Set<HeadingNodeView>()
  private foldedHeadingIds = new Set<string>()
  private rangeDocument: ProseMirrorNode | null = null
  private rangeCache: FoldRange[] = []
  private frame: number | null = null
  private readonly options: FoldingManagerOptions

  constructor(options: FoldingManagerOptions = {}) {
    this.options = options
    this.folded = [...(options.folded ?? [])]
  }

  attach(view: EditorView): void {
    this.view = view
    this.rangeDocument = null
    this.foldedHeadingIds = this.resolveFoldedIds(this.folded)
    for (const nodeView of this.nodeViews) nodeView.refresh()
    if (this.foldedHeadingIds.size > 0) this.schedule()
  }

  isAttached(): boolean { return this.view !== null }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.view = null
    this.nodeViews.clear()
  }

  plugin(): Plugin<number> {
    return new Plugin({
      key: foldingKey,
      state: {
        init: () => 0,
        apply: (transaction, revision) => transaction.getMeta(foldingKey) === true ? revision + 1 : revision,
      },
      props: { decorations: (state) => this.decorations(state) },
    })
  }

  createHeading(node: ProseMirrorNode, _view: EditorView, getPos: () => number | undefined): NodeView {
    const nodeView = new HeadingNodeView(node, this, getPos)
    this.nodeViews.add(nodeView)
    return nodeView
  }

  unregister(nodeView: HeadingNodeView): void { this.nodeViews.delete(nodeView) }

  setFolded(references: readonly HeadingReference[]): void {
    if (references.length === this.folded.length && references.every((reference, index) => referenceKey(reference) === referenceKey(this.folded[index]!))) return
    this.folded = [...references]
    this.foldedHeadingIds = this.resolveFoldedIds(references)
    this.schedule()
  }

  hasFolds(): boolean { return this.foldedHeadingIds.size > 0 || this.folded.length > 0 }

  setReviewRanges(reviews: readonly ReviewRange[], annotations: readonly AnnotationRange[]): void {
    if (this.reviews === reviews && this.annotations === annotations) return
    this.reviews = reviews
    this.annotations = annotations
    if (this.foldedHeadingIds.size === 0) return
    this.schedule()
  }

  toggle(position: number): void {
    const range = this.ranges().find((candidate) => candidate.from === position)
    if (!range) return
    const key = referenceKey(range.reference)
    const folded = !this.isFoldedRange(range)
    this.folded = folded
      ? [...this.folded.filter((reference) => referenceKey(reference) !== key), range.reference]
      : this.folded.filter((reference) => referenceKey(reference) !== key)
    if (folded) this.foldedHeadingIds.add(range.heading.id)
    else this.foldedHeadingIds.delete(range.heading.id)
    this.temporaryPosition = null
    this.options.onFold?.(range.reference, folded)
    this.schedule()
  }

  revealPosition(position: number): void {
    this.temporaryPosition = this.ranges().some((range) => this.isFoldedRange(range) && position > range.contentFrom && position < range.to)
      ? position
      : null
    this.schedule()
  }

  restoreWhenSelectionLeaves(position: number): void {
    if (this.temporaryPosition === null) return
    const stillInside = this.ranges().some((range) => this.isFoldedRange(range)
      && this.temporaryPosition! > range.contentFrom && this.temporaryPosition! < range.to
      && position > range.contentFrom && position < range.to)
    if (!stillInside) {
      this.temporaryPosition = null
      this.schedule()
    }
  }

  headingState(position: number): { folded: boolean; temporarilyOpen: boolean; text: string; annotations: number; changes: number } {
    const range = this.ranges().find((candidate) => candidate.from === position)
    if (!range) return { folded: false, temporarilyOpen: false, text: 'section', annotations: 0, changes: 0 }
    const folded = this.isFoldedRange(range)
    const temporarilyOpen = folded && this.temporaryPosition !== null && this.temporaryPosition > range.contentFrom && this.temporaryPosition < range.to
    const annotations = new Set(this.annotations.filter((item) => item.status !== 'resolved' && item.from > range.contentFrom && item.from < range.to).map((item) => item.id)).size
    const changes = new Set(this.reviews.filter((item) => item.status === 'pending' || item.status === 'mixed').filter((item) => item.from > range.contentFrom && item.from < range.to).map((item) => item.id)).size
    return { folded, temporarilyOpen, text: range.heading.text, annotations, changes }
  }

  schedule(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      const view = this.view
      if (!view) return
      view.dispatch(view.state.tr.setMeta(foldingKey, true).setMeta('addToHistory', false))
      for (const nodeView of this.nodeViews) nodeView.refresh()
    })
  }

  documentChanged(selectionHead: number): void {
    this.rangeDocument = null
    if (this.foldedHeadingIds.size === 0) return
    for (const range of this.ranges()) {
      if (!this.foldedHeadingIds.has(range.heading.id)) continue
      if (this.folded.some((reference) => referenceKey(reference) === referenceKey(range.reference))) continue
      this.folded.push(range.reference)
      this.options.onFold?.(range.reference, true)
    }
    if (this.ranges().some((range) => this.isFoldedRange(range) && selectionHead > range.contentFrom && selectionHead < range.to)) {
      this.temporaryPosition = selectionHead
    }
    this.schedule()
  }

  private isFolded(reference: HeadingReference): boolean {
    return this.folded.some((candidate) => referenceKey(candidate) === referenceKey(reference))
  }

  private isFoldedRange(range: FoldRange): boolean {
    return this.foldedHeadingIds.has(range.heading.id) || this.isFolded(range.reference)
  }

  private resolveFoldedIds(references: readonly HeadingReference[]): Set<string> {
    if (!this.view) return new Set()
    const headings = [...headingsForState(this.view.state)]
    const ids = new Set<string>()
    for (const reference of references) {
      const resolved = resolveHeadingReference(reference, headings)
      if (resolved) ids.add(resolved.heading.id)
    }
    return ids
  }

  private ranges(): FoldRange[] {
    if (!this.view) return []
    if (this.rangeDocument === this.view.state.doc) return this.rangeCache
    const headings = [...headingsForState(this.view.state)]
    const references = referencedHeadings(headings)
    this.rangeCache = references.map(({ heading, reference }, index) => {
      let to = this.view!.state.doc.content.size
      for (let next = index + 1; next < references.length; next += 1) {
        if (references[next]!.heading.level <= heading.level) {
          to = references[next]!.heading.position
          break
        }
      }
      const headingNode = this.view!.state.doc.nodeAt(heading.position)
      return { heading, reference, from: heading.position, contentFrom: heading.position + (headingNode?.nodeSize ?? 0), to }
    })
    this.rangeDocument = this.view.state.doc
    return this.rangeCache
  }

  private decorations(state: EditorState): DecorationSet {
    if (this.foldedHeadingIds.size === 0 && this.folded.length === 0) return DecorationSet.empty
    const ranges = this.ranges().filter((range) => this.isFoldedRange(range)
      && !(this.temporaryPosition !== null && this.temporaryPosition > range.contentFrom && this.temporaryPosition < range.to))
    if (ranges.length === 0) return DecorationSet.empty
    const decorations: Decoration[] = []
    state.doc.forEach((node, offset) => {
      if (ranges.some((range) => offset >= range.contentFrom && offset < range.to)) {
        decorations.push(Decoration.node(offset, offset + node.nodeSize, { class: 'strata-fold-hidden', 'aria-hidden': 'true' }))
      }
    })
    return DecorationSet.create(state.doc, decorations)
  }
}
