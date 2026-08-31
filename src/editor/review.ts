import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export type ReviewStatus = 'pending' | 'mixed'
export type ReviewKind = 'direct' | 'suggestion'

export interface ReviewRange {
  id: string
  from: number
  to: number
  kind: ReviewKind
  status: ReviewStatus
  author: string
  agent?: string | null
  deletedText?: string
  replacementText?: string
}

interface ReviewPluginState {
  ranges: readonly ReviewRange[]
  decorations: DecorationSet
}

export interface ReviewActions {
  onKeep?(id: string): void
  onRevert?(id: string): void
}

export interface LocalizedReviewChange {
  prefixLength: number
  suffixLength: number
  deletedText: string
  insertedText: string
}

export interface SourceTextRange {
  from: number
  to: number
}

/** Return the UTF-16 offset of a one-based source line. */
export function sourceOffsetForLine(source: string, line: number): number {
  if (line <= 1) return 0
  let currentLine = 1
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) continue
    currentLine += 1
    if (currentLine === line) return index + 1
  }
  return source.length
}

function sourceLineEnding(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

function nearestOccurrence(source: string, text: string, expected: number): number {
  if (!text) return -1
  let nearest = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let found = source.indexOf(text); found >= 0; found = source.indexOf(text, found + 1)) {
    const distance = Math.abs(found - expected)
    if (distance < nearestDistance) {
      nearest = found
      nearestDistance = distance
    }
  }
  return nearest
}

/**
 * Locate a direct-edit insertion near its hunk's source line. Hunk line
 * numbers, not text identity, disambiguate repeated lines in source view.
 */
export function locateSourceReviewInsertion(
  source: string,
  addedText: string,
  line: number,
  prefixLength = 0,
  visibleText = addedText,
): SourceTextRange | null {
  const lineEnding = sourceLineEnding(source)
  const sourceAdded = addedText.replaceAll('\n', lineEnding)
  const expected = sourceOffsetForLine(source, line)
  const occurrence = nearestOccurrence(source, sourceAdded, expected)
  if (occurrence < 0) return null
  const prefix = addedText.slice(0, prefixLength).replaceAll('\n', lineEnding)
  const visible = visibleText.replaceAll('\n', lineEnding)
  const from = occurrence + prefix.length
  return visible && source.slice(from, from + visible.length) === visible
    ? { from, to: from + visible.length }
    : null
}

/** Prefer a persisted source anchor; only fall back when the quote is unique. */
export function locateSourceAnnotationQuote(
  source: string,
  quote: string,
  from?: number | null,
  to?: number | null,
): SourceTextRange | null {
  if (
    typeof from === 'number'
    && typeof to === 'number'
    && from >= 0
    && to >= from
    && source.slice(from, to) === quote
  ) return { from, to }
  const first = source.indexOf(quote)
  if (first < 0 || source.indexOf(quote, first + 1) >= 0) return null
  return { from: first, to: first + quote.length }
}

export function isReviewControlActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar'
}

const reviewKey = new PluginKey<ReviewPluginState>('stratamd-review')
const reviewMeta = 'stratamd-review-ranges'

/**
 * Reduce a line-oriented diff hunk to the characters that actually changed.
 * Hunk producers intentionally retain full lines; the visual editor should
 * not make those unchanged line fragments look deleted and inserted again.
 * Lengths are UTF-16 offsets so they map directly to ProseMirror positions.
 */
export function localizeReviewChange(deletedText: string, insertedText: string): LocalizedReviewChange {
  const maximumPrefix = Math.min(deletedText.length, insertedText.length)
  let prefixLength = 0
  while (prefixLength < maximumPrefix && deletedText[prefixLength] === insertedText[prefixLength]) {
    prefixLength += 1
  }

  const maximumSuffix = Math.min(
    deletedText.length - prefixLength,
    insertedText.length - prefixLength,
  )
  let suffixLength = 0
  while (
    suffixLength < maximumSuffix
    && deletedText[deletedText.length - suffixLength - 1] === insertedText[insertedText.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  return {
    prefixLength,
    suffixLength,
    deletedText: deletedText.slice(prefixLength, deletedText.length - suffixLength),
    insertedText: insertedText.slice(prefixLength, insertedText.length - suffixLength),
  }
}

export function reviewBadgeLabel(range: Pick<ReviewRange, 'author' | 'kind' | 'status'>): string {
  const author = range.author || 'external'
  if (range.kind === 'suggestion') return `${author} · suggestion`
  return range.status === 'mixed' ? `${author} · mixed` : author
}

function transactionTouchesRange(transaction: Transaction, range: ReviewRange): boolean {
  if (!transaction.docChanged) return false
  return transaction.mapping.maps.some((stepMap) => {
    let touched = false
    stepMap.forEach((oldStart, oldEnd) => {
      const pointRange = range.from === range.to
      const touches = pointRange
        ? oldStart <= range.from && oldEnd >= range.from
        : oldStart === oldEnd
          ? oldStart >= range.from && oldStart <= range.to
          : oldStart < range.to && oldEnd > range.from
      if (touches) {
        touched = true
      }
    })
    return touched
  })
}

function reviewDecorations(doc: ProseMirrorNode, ranges: readonly ReviewRange[], actions: ReviewActions): DecorationSet {
  const decorations: Decoration[] = []
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, doc.content.size))
    const to = Math.max(from, Math.min(range.to, doc.content.size))
    let visualFrom = from
    let visualTo = to
    let deletedText = range.deletedText ?? ''
    if (range.deletedText !== undefined && range.replacementText !== undefined) {
      const renderedReplacement = doc.textBetween(from, to, '\n', '\n')
      if (renderedReplacement === range.replacementText) {
        const localized = localizeReviewChange(range.deletedText, range.replacementText)
        visualFrom = Math.min(to, from + localized.prefixLength)
        visualTo = Math.max(visualFrom, to - localized.suffixLength)
        deletedText = localized.deletedText
      }
    }
    const baseClass = range.kind === 'suggestion' ? 'strata-suggestion' : 'strata-review-change'
    const external = !range.agent && (!range.author || range.author === 'external')
    if (visualTo > visualFrom) {
      decorations.push(Decoration.inline(visualFrom, visualTo, {
        class: `${baseClass} strata-review-${range.status}${external ? ' strata-review-external' : ''}`,
        'data-review-id': range.id,
        'data-review-author': range.author,
      }, { id: `review:${range.id}` }))
    }
    if (deletedText) {
      decorations.push(Decoration.widget(visualFrom, () => {
        const deletion = document.createElement('del')
        deletion.className = 'strata-review-deletion'
        deletion.dataset.reviewId = range.id
        deletion.textContent = deletedText
        deletion.contentEditable = 'false'
        return deletion
      }, { key: `review-delete:${range.id}`, side: -1 }))
    }
    decorations.push(Decoration.widget(visualTo, () => {
      const controls = document.createElement('span')
      controls.className = 'strata-review-controls'
      controls.dataset.reviewId = range.id
      controls.contentEditable = 'false'
      const badge = document.createElement('span')
      badge.className = `strata-review-author${external ? ' strata-review-author--external' : ''}`
      badge.textContent = reviewBadgeLabel(range)
      controls.append(badge)
      if (range.kind === 'direct') {
        for (const [label, callback] of [['Keep', actions.onKeep], ['Revert', actions.onRevert]] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = label
          button.setAttribute('aria-label', `${label} change ${range.id}`)
          if (callback) button.addEventListener('click', () => callback(range.id))
          controls.append(button)
        }
      }
      return controls
    }, { key: `review-author:${range.id}`, side: 1 }))
  }
  return DecorationSet.create(doc, decorations)
}

export function createReviewPlugin(initialRanges: readonly ReviewRange[] = [], actions: ReviewActions = {}): Plugin<ReviewPluginState> {
  return new Plugin<ReviewPluginState>({
    key: reviewKey,
    state: {
      init: (_config, state) => ({ ranges: initialRanges, decorations: reviewDecorations(state.doc, initialRanges, actions) }),
      apply(transaction, pluginState, _oldState, newState) {
        const replacement = transaction.getMeta(reviewMeta) as readonly ReviewRange[] | undefined
        const ranges = replacement ?? pluginState.ranges.map((range) => ({
          ...range,
          from: transaction.mapping.map(range.from, -1),
          to: transaction.mapping.map(range.to, 1),
          status: transactionTouchesRange(transaction, range) ? 'mixed' as const : range.status,
        }))
        return { ranges, decorations: reviewDecorations(newState.doc, ranges, actions) }
      },
    },
    props: {
      decorations(state) {
        return reviewKey.getState(state)?.decorations ?? null
      },
    },
  })
}

export function setReviewRanges(transaction: Transaction, ranges: readonly ReviewRange[]): Transaction {
  return transaction.setMeta(reviewMeta, ranges)
}

export function getReviewRanges(state: EditorState): readonly ReviewRange[] {
  return reviewKey.getState(state)?.ranges ?? []
}

export function reviewRangeById(state: EditorState, id: string): ReviewRange | undefined {
  return getReviewRanges(state).find((range) => range.id === id)
}
