import { contentHash } from '../core/diff'
import { mdastText, parseMarkdown } from '../core/markdown/index'
import type { ParsedMarkdown } from '../core/markdown/types'
import type { HeadingReference, ReadingState, WalkthroughAction, WalkthroughMarker, WalkthroughState } from '../shared/contracts'
import { normalizeHeadingText, referenceKey, referencedHeadings, referencedWalkthroughHeadings, resolveHeadingReference } from '../shared/walkthrough'

interface AstNode {
  type?: string
  value?: string
  alt?: string | null
  depth?: number
  position?: { start?: { offset?: number }; end?: { offset?: number } }
  children?: readonly AstNode[]
}

export interface IndexedHeading {
  id: string
  level: number
  text: string
  sourceFrom: number
  headingTo: number
}

export function reconcileFoldedHeadings(references: readonly HeadingReference[], index: WalkthroughIndex): HeadingReference[] {
  const headings = referencedHeadings(index.headings).map(({ heading }) => heading)
  const resolved = references.flatMap((reference) => {
    const match = resolveHeadingReference(reference, headings)
    return match ? [match.reference] : []
  })
  return [...new Map(resolved.map((reference) => [referenceKey(reference), reference])).values()]
}

export interface WalkthroughSection extends IndexedHeading {
  level: 2 | 3
  sourceTo: number
  reference: HeadingReference
  hash: string
}

export interface WalkthroughIndex {
  markdown: string
  headings: readonly IndexedHeading[]
  sections: readonly WalkthroughSection[]
  nextId: number
}

export interface WalkthroughUpdate {
  index: WalkthroughIndex
  state: WalkthroughState
  changed: boolean
  durationMs: number
  hashedSections: number
  rebuilt: boolean
}

function collectHeadings(node: AstNode, output: Array<Omit<IndexedHeading, 'id'>>): void {
  if (node.type === 'heading' && typeof node.depth === 'number') {
    output.push({
      level: node.depth,
      text: normalizeHeadingText(mdastText(node as never)) || 'Untitled heading',
      sourceFrom: node.position?.start?.offset ?? 0,
      headingTo: node.position?.end?.offset ?? 0,
    })
  }
  for (const child of node.children ?? []) collectHeadings(child, output)
}

function sectionHash(markdown: string, from: number, to: number): string {
  return contentHash(markdown.slice(from, to))
}

function sectionReferences(headings: readonly IndexedHeading[]): Map<number, HeadingReference> {
  return new Map(referencedWalkthroughHeadings(headings).map(({ heading, reference }) => [heading.sourceFrom, reference]))
}

export function buildWalkthroughIndex(markdown: string, nextId = 1, parsed: ParsedMarkdown = parseMarkdown(markdown)): WalkthroughIndex {
  const raw: Array<Omit<IndexedHeading, 'id'>> = []
  collectHeadings(parsed.ast as AstNode, raw)
  raw.sort((left, right) => left.sourceFrom - right.sourceFrom)
  const headings = raw.map((heading) => ({ ...heading, id: `walkthrough:${nextId++}` }))
  const references = sectionReferences(headings)
  const sections: WalkthroughSection[] = []
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    if (heading.level !== 2 && heading.level !== 3) continue
    let sourceTo = markdown.length
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next]!.level <= heading.level) { sourceTo = headings[next]!.sourceFrom; break }
    }
    sections.push({
      ...heading,
      level: heading.level,
      sourceTo,
      reference: references.get(heading.sourceFrom)!,
      hash: sectionHash(markdown, heading.sourceFrom, sourceTo),
    })
  }
  return { markdown, headings, sections, nextId }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function resolveSection(reference: HeadingReference, index: WalkthroughIndex): WalkthroughSection | null {
  const base = index.sections.filter((section) => section.level === reference.level && section.reference.text === normalizeHeadingText(reference.text))
  if (base.length === 1) return base[0]!
  const exact = base.filter((section) =>
    section.reference.parentText === reference.parentText
    && section.reference.previousText === reference.previousText
    && section.reference.nextText === reference.nextText,
  )
  return exact.length === 1 ? exact[0]! : null
}

function canonicalReferences(references: readonly HeadingReference[], index: WalkthroughIndex): HeadingReference[] {
  const canonical = references.flatMap((reference) => {
    const section = resolveSection(reference, index)
    return section ? [section.reference] : []
  })
  return [...new Map(canonical.map((reference) => [referenceKey(reference), reference])).values()]
}

function eligibleSections(state: Pick<WalkthroughState, 'level' | 'excluded'>, index: WalkthroughIndex): WalkthroughSection[] {
  const excluded = new Set(state.excluded.map(referenceKey))
  return index.sections.filter((section) => (state.level === 'h2-h3' || section.level === 2) && !excluded.has(referenceKey(section.reference)))
}

export function reconcileWalkthroughState(state: WalkthroughState, index: WalkthroughIndex): WalkthroughState {
  const excluded = canonicalReferences(state.excluded, index)
  const markers: WalkthroughMarker[] = []
  for (const marker of state.markers) {
    const section = resolveSection(marker.heading, index)
    if (!section) continue
    const sourceChanged = marker.sourceHash !== section.hash
    markers.push({
      heading: section.reference,
      status: sourceChanged ? marker.reviewedHash === section.hash ? 'reviewed' : 'revisit' : marker.status,
      reviewedHash: marker.reviewedHash,
      sourceHash: section.hash,
    })
  }
  const partial = { active: state.active, level: state.level, excluded, markers }
  const current = state.current ? resolveSection(state.current, index) : null
  const eligible = eligibleSections({ level: state.level, excluded }, index)
  const selected = current && eligible.includes(current) ? current : eligible[0] ?? null
  return { ...partial, current: selected?.reference ?? null }
}

interface TextChange { oldFrom: number; oldTo: number; newTo: number }

function textChange(before: string, after: string): TextChange | null {
  if (before === after) return null
  let oldFrom = 0
  const shortest = Math.min(before.length, after.length)
  while (oldFrom < shortest && before.charCodeAt(oldFrom) === after.charCodeAt(oldFrom)) oldFrom += 1
  let suffix = 0
  while (suffix < shortest - oldFrom && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix += 1
  return { oldFrom, oldTo: before.length - suffix, newTo: after.length - suffix }
}

function expandedLine(text: string, from: number, to: number): string {
  let start = from
  while (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') start -= 1
  let end = to
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1
  return text.slice(start, end)
}

function mayChangeHeadingStructure(index: WalkthroughIndex, markdown: string, change: TextChange): boolean {
  const oldChanged = index.markdown.slice(change.oldFrom, change.oldTo)
  const newChanged = markdown.slice(change.oldFrom, change.newTo)
  if (/\r|\n/u.test(oldChanged) || /\r|\n/u.test(newChanged)) return true
  if (index.headings.some((heading) => change.oldFrom <= heading.headingTo && change.oldTo >= heading.sourceFrom)) return true
  const possibleHeading = /^(?: {0,3}(?:>[ \t]*)*)?(?:#{1,6}(?:[ \t]+|$)|(?:=+|-+)[ \t]*$)/mu
  return possibleHeading.test(expandedLine(index.markdown, change.oldFrom, change.oldTo))
    || possibleHeading.test(expandedLine(markdown, change.oldFrom, change.newTo))
}

function mapOpenReferences(previous: WalkthroughIndex, next: WalkthroughIndex, change: TextChange): Map<string, HeadingReference> {
  const delta = change.newTo - change.oldTo
  const mapped = new Map<string, HeadingReference>()
  for (const section of previous.sections) {
    if (section.headingTo < change.oldFrom || section.sourceFrom > change.oldTo) {
      const target = section.sourceFrom >= change.oldTo ? section.sourceFrom + delta : section.sourceFrom
      const match = next.sections.find((candidate) => candidate.sourceFrom === target && candidate.level === section.level && candidate.text === section.text)
      if (match) mapped.set(referenceKey(section.reference), match.reference)
    }
  }
  const oldTouched = previous.sections.filter((section) => section.sourceFrom <= change.oldTo && section.headingTo >= change.oldFrom)
  const newTouched = next.sections.filter((section) => section.sourceFrom <= change.newTo && section.headingTo >= change.oldFrom)
  if (oldTouched.length === 1 && newTouched.length === 1 && oldTouched[0]!.level === newTouched[0]!.level) {
    mapped.set(referenceKey(oldTouched[0]!.reference), newTouched[0]!.reference)
  }
  return mapped
}

function rewriteReferences(state: WalkthroughState, mapping: ReadonlyMap<string, HeadingReference>): WalkthroughState {
  const replace = (reference: HeadingReference): HeadingReference => mapping.get(referenceKey(reference)) ?? reference
  return {
    ...state,
    current: state.current ? replace(state.current) : null,
    excluded: state.excluded.map(replace),
    markers: state.markers.map((marker) => ({ ...marker, heading: replace(marker.heading) })),
  }
}

export function updateWalkthroughIndex(previous: WalkthroughIndex, markdown: string, state: WalkthroughState): WalkthroughUpdate {
  const started = performance.now()
  const change = textChange(previous.markdown, markdown)
  if (!change) return { index: previous, state, changed: false, durationMs: performance.now() - started, hashedSections: 0, rebuilt: false }
  if (mayChangeHeadingStructure(previous, markdown, change)) {
    const next = buildWalkthroughIndex(markdown, previous.nextId)
    const rewritten = rewriteReferences(state, mapOpenReferences(previous, next, change))
    const reconciled = reconcileWalkthroughState(rewritten, next)
    return { index: next, state: reconciled, changed: !sameJson(state, reconciled), durationMs: performance.now() - started, hashedSections: next.sections.length, rebuilt: true }
  }

  const delta = change.newTo - change.oldTo
  const affected = new Set<string>()
  const shiftStart = (offset: number) => offset >= change.oldTo ? offset + delta : offset
  const shiftEnd = (offset: number) => offset >= change.oldFrom ? offset + delta : offset
  const headings = previous.headings.map((heading) => ({ ...heading, sourceFrom: shiftStart(heading.sourceFrom), headingTo: shiftStart(heading.headingTo) }))
  let hashedSections = 0
  const sections = previous.sections.map((section) => {
    const touches = change.oldFrom < section.sourceTo && change.oldTo >= section.sourceFrom
      || change.oldFrom === change.oldTo && change.oldFrom >= section.sourceFrom && change.oldFrom < section.sourceTo
      || change.oldFrom === change.oldTo && change.oldFrom === section.sourceTo && section.sourceTo === previous.markdown.length
    const shifted = { ...section, sourceFrom: shiftStart(section.sourceFrom), headingTo: shiftStart(section.headingTo), sourceTo: shiftEnd(section.sourceTo) }
    if (!touches) return shifted
    affected.add(referenceKey(section.reference))
    hashedSections += 1
    return { ...shifted, hash: sectionHash(markdown, shifted.sourceFrom, shifted.sourceTo) }
  })
  const index: WalkthroughIndex = { markdown, headings, sections, nextId: previous.nextId }
  const markers = state.markers.map((marker) => {
    if (!affected.has(referenceKey(marker.heading))) return marker
    const section = resolveSection(marker.heading, index)
    if (!section) return marker
    return {
      ...marker,
      status: marker.reviewedHash === section.hash ? 'reviewed' as const : 'revisit' as const,
      sourceHash: section.hash,
    }
  })
  const nextState = markers.some((marker, index) => marker !== state.markers[index]) ? { ...state, markers } : state
  return { index, state: nextState, changed: nextState !== state, durationMs: performance.now() - started, hashedSections, rebuilt: false }
}

export function applyWalkthroughAction(state: WalkthroughState, action: WalkthroughAction, index: WalkthroughIndex): WalkthroughState {
  let next = reconcileWalkthroughState(state, index)
  if (action.type === 'start') next = { ...next, active: true }
  else if (action.type === 'leave') next = { ...next, active: false }
  else if (action.type === 'set-level') next = { ...next, level: action.level }
  else {
    const section = resolveSection(action.heading, index)
    if (!section) return next
    if (action.type === 'set-current') next = { ...next, current: section.reference }
    else if (action.type === 'set-included') {
      const without = next.excluded.filter((reference) => referenceKey(reference) !== referenceKey(section.reference))
      next = { ...next, excluded: action.included ? without : [...without, section.reference] }
    } else {
      const without = next.markers.filter((marker) => referenceKey(marker.heading) !== referenceKey(section.reference))
      const previous = next.markers.find((marker) => referenceKey(marker.heading) === referenceKey(section.reference))
      next = {
        ...next,
        markers: [...without, {
          heading: section.reference,
          status: action.status,
          reviewedHash: action.status === 'reviewed' ? section.hash : previous?.reviewedHash ?? null,
          sourceHash: section.hash,
        }],
      }
    }
  }
  return reconcileWalkthroughState(next, index)
}

export function withWalkthrough(reading: ReadingState, walkthrough: WalkthroughState): ReadingState {
  return { ...reading, walkthrough }
}
