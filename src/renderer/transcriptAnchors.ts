import { renderedOffsetForSource, sourceOffsetWithin } from '../editor/selection'

/**
 * Reading anchors for the transcript (docs/plans/open/transcript-scroll-stability-2026-09-07-plan.md §3.2).
 *
 * A passage anchor names a message, the exact source offset of the text at
 * the reading edge, and where that text sat in the viewport. It is captured
 * from either rendering, the source-mapped lightweight Markdown or the rich
 * editor, and resolved in whichever rendering the row has afterwards. Rows
 * whose top edge is in view need no passage: their top is exact.
 */
export interface ReadingAnchor {
  message: string
  /** The exact source offset, or null when the anchor is the row's top edge. */
  offset: number | null
  /** Distance from the viewport's top edge to the anchored text or row top, in CSS px. */
  viewportOffset: number
}

interface TextHit {
  node: Text
  offset: number
}

function caretAt(left: number, top: number): TextHit | null {
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(left, top)
    if (position && position.offsetNode.nodeType === Node.TEXT_NODE) return { node: position.offsetNode as Text, offset: position.offset }
    return null
  }
  const range = document.caretRangeFromPoint(left, top)
  if (range && range.startContainer.nodeType === Node.TEXT_NODE) return { node: range.startContainer as Text, offset: range.startOffset }
  return null
}

/** The source offset shown at a client point inside a source-mapped lightweight rendering, or null over atomic or unmapped content. */
export function lightweightSourceOffsetAtPoint(container: HTMLElement, source: string, left: number, top: number): { offset: number; top: number } | null {
  const hit = caretAt(left, top)
  if (!hit || !container.contains(hit.node) || hit.node.parentElement?.closest('[data-atomic]')) return null
  const run = hit.node.parentElement?.closest<HTMLElement>('[data-source-from]')
  if (!run || !container.contains(run)) return null
  const from = Number(run.dataset.sourceFrom)
  const to = Number(run.dataset.sourceTo)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const within = run.dataset.sourceVerbatim === 'true'
    ? Math.min(hit.offset, to - from)
    : sourceOffsetWithin(source.slice(from, to), hit.node.data, hit.offset)
  if (within === null) return null
  const range = document.createRange()
  range.setStart(hit.node, hit.offset)
  range.collapse(true)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  if (Math.abs(rect.top - top) > rect.height + 2) return null
  return { offset: from + within, top: rect.top }
}

/** The client rect of the text that shows a source offset in a lightweight rendering, or null. */
export function lightweightRectForSourceOffset(container: HTMLElement, source: string, offset: number): DOMRect | null {
  let best: { run: HTMLElement; from: number; to: number } | null = null
  for (const run of container.querySelectorAll<HTMLElement>('[data-source-from]')) {
    const from = Number(run.dataset.sourceFrom)
    const to = Number(run.dataset.sourceTo)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    if (offset >= from && offset < to) { best = { run, from, to }; break }
    if (offset >= to && (!best || to > best.to)) best = { run, from, to }
  }
  if (!best) return null
  const text = Array.from(best.run.childNodes).find((child): child is Text => child.nodeType === Node.TEXT_NODE)
  if (!text) return best.run.getBoundingClientRect()
  const within = Math.max(0, Math.min(offset, best.to) - best.from)
  const index = best.run.dataset.sourceVerbatim === 'true' ? within : renderedOffsetForSource(source.slice(best.from, best.to), text.data, within)
  const range = document.createRange()
  range.setStart(text, Math.max(0, Math.min(index ?? text.data.length, text.data.length)))
  range.collapse(true)
  return range.getClientRects()[0] ?? range.getBoundingClientRect()
}

/**
 * Sample points from the reading edge downward across the row's width and
 * return the first text hit. `probe` answers null over atomic content.
 */
export function firstTextPoint<T>(row: DOMRect, edge: number, probe: (left: number, top: number) => T | null, depth = 160): T | null {
  const lefts = [row.left + Math.min(24, row.width / 4), row.left + row.width / 2, row.right - Math.min(24, row.width / 4)]
  const bottom = Math.min(row.bottom - 1, edge + depth)
  for (let top = edge + 1; top <= bottom; top += 6) {
    for (const left of lefts) {
      const found = probe(left, top)
      if (found !== null) return found
    }
  }
  return null
}
