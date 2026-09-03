import type { EditorHeading } from '../editor/headings'
import type { WalkthroughMarker, WalkthroughState } from '../shared/contracts'
import { referenceKey, referencedWalkthroughHeadings, resolveHeadingReference, type ReferencedHeading } from '../shared/walkthrough'

/** The walkthrough as the renderer draws it: the step list, the current step, and each step's marker. */
export interface WalkthroughView {
  state: WalkthroughState
  /** Every H2 and H3 heading with its durable reference, whether or not it is a step. */
  references: Array<ReferencedHeading<EditorHeading>>
  /** The ordered steps: eligible for the current level and not excluded. */
  included: Array<ReferencedHeading<EditorHeading>>
  currentIndex: number
  current: ReferencedHeading<EditorHeading> | null
  markerByKey: Map<string, WalkthroughMarker>
}

/** A heading is a walkthrough step candidate when its level matches the chosen depth. */
export function stepLevel(level: WalkthroughState['level'], headingLevel: number): boolean {
  return headingLevel === 2 || (level === 'h2-h3' && headingLevel === 3)
}

export function walkthroughView(headings: readonly EditorHeading[], state: WalkthroughState): WalkthroughView | null {
  if (!state.active) return null
  const references = referencedWalkthroughHeadings(headings)
  const excluded = new Set(state.excluded.map(referenceKey))
  const included = references.filter(({ heading, reference }) => stepLevel(state.level, heading.level) && !excluded.has(referenceKey(reference)))
  const resolvedCurrent = state.current ? resolveHeadingReference(state.current, headings) : null
  const currentIndex = resolvedCurrent ? included.findIndex(({ heading }) => heading === resolvedCurrent.heading) : -1
  return {
    state,
    references,
    included,
    currentIndex,
    current: currentIndex >= 0 ? included[currentIndex]! : null,
    markerByKey: new Map(state.markers.map((marker) => [referenceKey(marker.heading), marker])),
  }
}

/** Two-digit step numbers read as a route: 01, 02, … 12. */
export function stepNumber(index: number): string {
  return String(index + 1).padStart(2, '0')
}

const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/u
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u

/** Strip inline Markdown down to readable words for a one-line preview. */
export function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/(\*|_)(.+?)\1/gu, '$2')
    .replace(/~~(.+?)~~/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * The first readable paragraph after a heading, for the walkthrough card. Tables,
 * fences, component wrappers, and list markers are skipped or reduced to words so
 * the preview reads as a sentence, never as syntax.
 */
export function sectionPreview(content: string, heading: Pick<EditorHeading, 'sourceFrom' | 'level'>, limit = 150): string {
  if (heading.sourceFrom === null || heading.sourceFrom < 0 || heading.sourceFrom > content.length) return ''
  const lines = content.slice(heading.sourceFrom).split(/\r?\n/u)
  let index = 1
  if (lines[1] !== undefined && SETEXT_UNDERLINE.test(lines[1])) index = 2
  let fence: string | null = null
  const paragraph: string[] = []
  for (; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    const fenceMatch = /^(`{3,}|~{3,})/u.exec(trimmed)
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) fence = null
      continue
    }
    if (fenceMatch) { fence = fenceMatch[1]!; continue }
    const headingMatch = HEADING_LINE.exec(line)
    if (headingMatch) {
      // A deeper heading (a phase inside a board, a claim inside a chain) is part of this section; a peer or shallower heading ends it.
      const level = (line.match(/#+/u)?.[0].length ?? 1)
      if (level <= heading.level || paragraph.length > 0) break
      continue
    }
    if (trimmed === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (trimmed.startsWith('|') || /^<\/?[A-Z]/u.test(trimmed) || trimmed === '---' || trimmed.startsWith('<!--')) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, '').replace(/^>\s?/u, ''))
  }
  const text = plainInline(paragraph.join(' '))
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]+$/u, '')}…`
}
