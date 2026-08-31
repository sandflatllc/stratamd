import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'

export type AnnotationKind = 'comment' | 'question' | 'suggestion'
export type AnnotationStatus = 'open' | 'resolved' | 'orphaned'

export interface AnnotationQuoteAnchor {
  quote: string
  prefix?: string
  suffix?: string
}

export interface AnnotationRange extends AnnotationQuoteAnchor {
  id: string
  kind: AnnotationKind
  status: AnnotationStatus
  from: number
  to: number
  author: string
  agent?: string | null
  color?: string | null
  text?: string
}

export interface AnnotationAdjustment {
  id: string
  from: number
  to: number
}

interface AnnotationPluginState {
  ranges: readonly AnnotationRange[]
  /** The annotation whose grab handles are showing, if any. */
  active: string | null
  /** A handle drag in progress; the range it previews replaces the stored one until release. */
  adjusting: AnnotationAdjustment | null
  decorations: DecorationSet
}

export interface AnnotationActions {
  onOpen?(id: string): void
  onAccept?(id: string): void
  onReject?(id: string): void
  /** Called when a handle drag ends on a non-empty range, with editor positions. */
  onAdjust?(id: string, from: number, to: number): void
}

const annotationKey = new PluginKey<AnnotationPluginState>('stratamd-annotations')
const annotationMeta = 'stratamd-annotation-ranges'
const activeMeta = 'stratamd-annotation-active'
const adjustMeta = 'stratamd-annotation-adjust'

export const ANNOTATION_HANDLE_CLASS = 'strata-annotation-handle'

function handleWidget(range: AnnotationRange, end: 'start' | 'end'): HTMLElement {
  const handle = document.createElement('span')
  handle.className = `${ANNOTATION_HANDLE_CLASS} ${ANNOTATION_HANDLE_CLASS}--${end} ${ANNOTATION_HANDLE_CLASS}--${range.kind}`
  handle.contentEditable = 'false'
  handle.dataset.annotationHandle = end
  handle.dataset.annotationId = range.id
  handle.setAttribute('role', 'slider')
  handle.setAttribute('aria-label', `Drag to move the ${end} of ${range.kind} ${range.id}`)
  const color = safeColor(range.color)
  if (color) handle.style.setProperty('--strata-annotation-color', color)
  const grip = document.createElement('span')
  grip.className = `${ANNOTATION_HANDLE_CLASS}__grip`
  handle.append(grip)
  return handle
}

export function suggestionBadgeLabel(author: string): string {
  return `${author || 'external'} · suggestion`
}

export interface SuggestionPresentation {
  deletedText: string
  replacementText: string
  badgeLabel: string
  actions: readonly ['Accept', 'Reject']
}

export function suggestionPresentation(
  range: Pick<AnnotationRange, 'quote' | 'text' | 'author'>,
): SuggestionPresentation {
  return {
    deletedText: range.quote,
    replacementText: range.text ?? '',
    badgeLabel: suggestionBadgeLabel(range.author),
    actions: ['Accept', 'Reject'],
  }
}

function safeColor(color: string | null | undefined): string | undefined {
  return color && /^(?:#[0-9a-f]{3,8}|[a-z]+)$/iu.test(color) ? color : undefined
}

function annotationDecorations(
  doc: ProseMirrorNode,
  stored: readonly AnnotationRange[],
  actions: AnnotationActions,
  active: string | null = null,
  adjusting: AnnotationAdjustment | null = null,
): DecorationSet {
  const decorations: Decoration[] = []
  const ranges = adjusting
    ? stored.map((range) => range.id === adjusting.id ? { ...range, from: adjusting.from, to: adjusting.to } : range)
    : stored
  const visible = ranges.filter((range) => range.status === 'open' && range.to > range.from)
  for (const range of visible) {
    const from = Math.max(0, Math.min(range.from, doc.content.size))
    const to = Math.max(from, Math.min(range.to, doc.content.size))
    const depth = visible.filter((other) => other.id !== range.id && other.from <= from && other.to >= to).length
    const isActive = range.id === active
    const attrs: Record<string, string> = {
      class: `strata-annotation strata-annotation-${range.kind} strata-annotation-depth-${Math.min(depth, 5)}${range.kind === 'suggestion' ? ' strata-suggestion-deletion' : ''}${isActive ? ' is-active' : ''}${adjusting?.id === range.id ? ' is-adjusting' : ''}`,
      'data-annotation-id': range.id,
      'data-annotation-author': range.author,
    }
    const color = safeColor(range.color)
    const styles: string[] = []
    if (color) styles.push(`--strata-annotation-color: ${color}`)
    if (range.kind === 'suggestion') {
      styles.push(
        'text-decoration: line-through',
        'background: color-mix(in srgb, var(--changes-removed) 14%, transparent)',
        'color: var(--changes-removed-tint)',
        'border-bottom: 0',
      )
    }
    if (styles.length > 0) attrs.style = styles.join('; ')
    decorations.push(Decoration.inline(from, to, attrs, { id: `annotation:${range.id}` }))
    if (isActive) {
      decorations.push(Decoration.widget(from, () => handleWidget(range, 'start'), { key: `annotation-handle:${range.id}:start`, side: -1, ignoreSelection: true }))
      decorations.push(Decoration.widget(to, () => handleWidget(range, 'end'), { key: `annotation-handle:${range.id}:end`, side: 1, ignoreSelection: true }))
    }
    if (range.kind === 'suggestion') {
      const presentation = suggestionPresentation(range)
      decorations.push(Decoration.widget(to, () => {
        const controls = document.createElement('span')
        controls.className = 'strata-suggestion-controls'
        controls.dataset.annotationId = range.id
        controls.contentEditable = 'false'

        if (presentation.replacementText) {
          const replacement = document.createElement('span')
          replacement.className = 'strata-suggestion-replacement'
          replacement.textContent = presentation.replacementText
          replacement.style.cssText = 'background:color-mix(in srgb,var(--strata-annotation-color,var(--controls-primary)) 22%,transparent);color:color-mix(in srgb,var(--strata-annotation-color,var(--controls-primary)) 58%,var(--interface-primary));border-radius:6px;padding:1px 5px;font-weight:700'
          controls.append(replacement)
        }

        const badge = document.createElement('span')
        badge.className = 'strata-review-author strata-suggestion-author'
        badge.textContent = presentation.badgeLabel
        controls.append(badge)

        for (const [label, callback] of [['Accept', actions.onAccept], ['Reject', actions.onReject]] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = label
          button.setAttribute('aria-label', `${label} suggestion ${range.id}`)
          if (callback) button.addEventListener('click', () => callback(range.id))
          controls.append(button)
        }
        return controls
      }, { key: `annotation-controls:${range.id}`, side: 1 }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export function createAnnotationPlugin(initialRanges: readonly AnnotationRange[] = [], actions: AnnotationActions = {}): Plugin<AnnotationPluginState> {
  return new Plugin<AnnotationPluginState>({
    key: annotationKey,
    state: {
      init: (_config, state) => ({
        ranges: initialRanges,
        active: null,
        adjusting: null,
        decorations: annotationDecorations(state.doc, initialRanges, actions),
      }),
      apply(transaction, value, _oldState, newState) {
        const replacement = transaction.getMeta(annotationMeta) as readonly AnnotationRange[] | undefined
        const ranges = replacement ?? value.ranges.map((range) => ({
          ...range,
          from: transaction.mapping.map(range.from, -1),
          to: transaction.mapping.map(range.to, 1),
        }))
        const activeChange = transaction.getMeta(activeMeta) as { id: string | null } | undefined
        const active = activeChange ? activeChange.id : value.active
        const adjustChange = transaction.getMeta(adjustMeta) as { adjusting: AnnotationAdjustment | null } | undefined
        let adjusting = adjustChange ? adjustChange.adjusting : value.adjusting
        if (adjusting && !adjustChange && transaction.docChanged) {
          adjusting = {
            ...adjusting,
            from: transaction.mapping.map(adjusting.from, -1),
            to: transaction.mapping.map(adjusting.to, 1),
          }
        }
        if (active !== null && !ranges.some((range) => range.id === active && range.status === 'open')) adjusting = null
        return {
          ranges,
          active,
          adjusting,
          decorations: annotationDecorations(newState.doc, ranges, actions, active, adjusting),
        }
      },
    },
    props: {
      decorations(state) {
        return annotationKey.getState(state)?.decorations ?? null
      },
      handleDOMEvents: {
        pointerdown(view, event) {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${ANNOTATION_HANDLE_CLASS}`) : null
          const id = target?.dataset.annotationId
          const end = target?.dataset.annotationHandle
          if (!target || !id || (end !== 'start' && end !== 'end') || event.button !== 0) return false
          const range = getAnnotationRanges(view.state).find((candidate) => candidate.id === id)
          if (!range || range.status !== 'open') return false
          event.preventDefault()
          beginHandleDrag(view, range, end, event, actions)
          return true
        },
      },
      handleClick(_view, _pos, event) {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-annotation-id]') : null
        if (!target?.dataset.annotationId) return false
        actions.onOpen?.(target.dataset.annotationId)
        return true
      },
    },
  })
}

export function setAnnotationRanges(transaction: Transaction, ranges: readonly AnnotationRange[]): Transaction {
  return transaction.setMeta(annotationMeta, ranges)
}

export function getAnnotationRanges(state: EditorState): readonly AnnotationRange[] {
  return annotationKey.getState(state)?.ranges ?? []
}

/** Shows grab handles on one open annotation, or hides them with null. */
export function setActiveAnnotation(transaction: Transaction, id: string | null): Transaction {
  return transaction.setMeta(activeMeta, { id }).setMeta('addToHistory', false)
}

export function getActiveAnnotation(state: EditorState): string | null {
  return annotationKey.getState(state)?.active ?? null
}

export function getAnnotationAdjustment(state: EditorState): AnnotationAdjustment | null {
  return annotationKey.getState(state)?.adjusting ?? null
}

/** Moves one end of a range to a new editor position, keeping the range non-empty and ordered. */
export function adjustedRange(range: { from: number; to: number }, end: 'start' | 'end', position: number): { from: number; to: number } {
  if (end === 'start') return position < range.to ? { from: position, to: range.to } : { from: range.to - 1, to: range.to }
  return position > range.from ? { from: range.from, to: position } : { from: range.from, to: range.from + 1 }
}

function beginHandleDrag(
  view: EditorView,
  range: AnnotationRange,
  end: 'start' | 'end',
  start: PointerEvent,
  actions: AnnotationActions,
): void {
  const owner = view.dom.ownerDocument
  const pointerId = start.pointerId
  let current = { from: range.from, to: range.to }
  let moved = false

  const preview = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return
    const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!hit) return
    const $pos = view.state.doc.resolve(hit.pos)
    if (!$pos.parent.isTextblock) return
    const next = adjustedRange(range, end, hit.pos)
    if (next.from === current.from && next.to === current.to) return
    current = next
    moved = true
    view.dispatch(view.state.tr.setMeta(adjustMeta, { adjusting: { id: range.id, ...current } }).setMeta('addToHistory', false))
  }

  const finish = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return
    owner.removeEventListener('pointermove', preview)
    owner.removeEventListener('pointerup', finish)
    owner.removeEventListener('pointercancel', cancel)
    view.dom.classList.remove('is-adjusting-annotation')
    const settled = moved && current.to > current.from
    const ranges = getAnnotationRanges(view.state).map((candidate) =>
      settled && candidate.id === range.id ? { ...candidate, from: current.from, to: current.to } : candidate,
    )
    // Keep the previewed range in place until the stored anchor arrives, so nothing snaps back.
    view.dispatch(setAnnotationRanges(view.state.tr, ranges).setMeta(adjustMeta, { adjusting: null }).setMeta('addToHistory', false))
    if (settled) actions.onAdjust?.(range.id, current.from, current.to)
  }

  const cancel = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return
    moved = false
    finish(event)
  }

  // Collapse any text selection so the native highlight does not compete with the drag preview.
  const anchor = end === 'start' ? range.from : range.to
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(anchor))).setMeta('addToHistory', false))
  view.dom.classList.add('is-adjusting-annotation')
  owner.addEventListener('pointermove', preview)
  owner.addEventListener('pointerup', finish)
  owner.addEventListener('pointercancel', cancel)
}

interface TextIndex {
  text: string
  positions: number[]
}

function documentTextIndex(doc: ProseMirrorNode): TextIndex {
  let text = ''
  const positions: number[] = []
  let sawTopLevel = false
  doc.descendants((node, pos, parent) => {
    if (node.isBlock && parent === doc && sawTopLevel) {
      text += '\n'
      positions.push(pos)
    }
    if (node.isBlock && parent === doc) sawTopLevel = true
    if (node.isText) {
      const value = node.text ?? ''
      text += value
      for (let index = 0; index < value.length; index += 1) positions.push(pos + index)
    } else if (node.type.name === 'soft_break' || node.type.name === 'hard_break') {
      text += '\n'
      positions.push(pos)
    }
  })
  return { text, positions }
}

function allIndexes(haystack: string, needle: string): number[] {
  if (!needle) return []
  const indexes: number[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    indexes.push(index)
    from = index + 1
  }
  return indexes
}

export interface LocatedAnnotation {
  from: number
  to: number
}

/** Exact anchoring only. Context may disambiguate duplicate exact quotes. */
export function locateAnnotationAnchor(
  doc: ProseMirrorNode,
  anchor: AnnotationQuoteAnchor,
  kind: AnnotationKind = 'comment',
): LocatedAnnotation | null {
  const index = documentTextIndex(doc)
  let matches = allIndexes(index.text, anchor.quote)
  if (matches.length > 1 && anchor.prefix) {
    matches = matches.filter((start) => index.text.slice(Math.max(0, start - anchor.prefix!.length), start) === anchor.prefix)
  }
  if (matches.length > 1 && anchor.suffix) {
    matches = matches.filter((start) => index.text.slice(start + anchor.quote.length, start + anchor.quote.length + anchor.suffix!.length) === anchor.suffix)
  }
  if (matches.length !== 1) return null
  const start = matches[0]!
  const last = start + anchor.quote.length - 1
  const from = index.positions[start]
  const lastPosition = index.positions[last]
  if (from === undefined || lastPosition === undefined) return null
  const to = lastPosition + 1
  if (kind === 'suggestion') {
    const $from = doc.resolve(from)
    const $to = doc.resolve(Math.max(0, Math.min(to - 1, doc.content.size)))
    const fromTop = $from.depth > 0 ? $from.before(1) : from
    const toTop = $to.depth > 0 ? $to.before(1) : to
    if (fromTop !== toTop) return null
  }
  return { from, to }
}

export function anchorContext(text: string, from: number, to: number): AnnotationQuoteAnchor {
  return {
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - 32), from),
    suffix: text.slice(to, Math.min(text.length, to + 32)),
  }
}
