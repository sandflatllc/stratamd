import { assertRange, mapPosition, type TextEdit, type TextRange } from './diff.js'

export const ANCHOR_CONTEXT_LENGTH = 32

export type AnchorStatus = 'attached' | 'orphaned'

export interface StoredTextAnchor extends TextRange {
  quote: string
  prefix: string
  suffix: string
}

export interface TextAnchor extends StoredTextAnchor {
  status: AnchorStatus
}

export interface StoredAnchorRelocation {
  range: TextRange | null
  candidates: number
}

export interface AnchorRelocation {
  anchor: TextAnchor
  event: 'none' | 'orphaned' | 'reattached'
  candidates: number
}

export interface CreateAnchorOptions {
  contextLength?: number
}

export function createTextAnchor(
  text: string,
  range: TextRange,
  options: CreateAnchorOptions = {},
): TextAnchor {
  if (range.from === range.to) throw new Error('An annotation quote cannot be empty')
  return { ...createStoredTextAnchor(text, range, options), status: 'attached' }
}

/** Pending deletions use this form because their shadow range is zero-width. */
export function createStoredTextAnchor(
  text: string,
  range: TextRange,
  options: CreateAnchorOptions = {},
): StoredTextAnchor {
  assertRange(range, text.length)
  const contextLength = options.contextLength ?? ANCHOR_CONTEXT_LENGTH
  if (!Number.isInteger(contextLength) || contextLength < 0) {
    throw new RangeError('Anchor context length must be a non-negative integer')
  }

  return {
    ...range,
    quote: text.slice(range.from, range.to),
    prefix: text.slice(Math.max(0, range.from - contextLength), range.from),
    suffix: text.slice(range.to, range.to + contextLength),
  }
}

export const createAnchor = createTextAnchor

/** Maps the live range while retaining the immutable quote and load context. */
export function mapAnchorThroughEdit(anchor: TextAnchor, edit: TextEdit): TextAnchor {
  const mapped = {
    from: mapPosition(anchor.from, edit, 1),
    to: mapPosition(anchor.to, edit, -1),
  }
  return { ...anchor, ...mapped }
}

function exactOccurrences(text: string, quote: string): number[] {
  const occurrences: number[] = []
  let from = 0
  while (from <= text.length - quote.length) {
    const match = text.indexOf(quote, from)
    if (match === -1) break
    occurrences.push(match)
    from = match + 1
  }
  return occurrences
}

function contextMatches(text: string, position: number, anchor: StoredTextAnchor): boolean {
  const before = text.slice(Math.max(0, position - anchor.prefix.length), position)
  const afterStart = position + anchor.quote.length
  const after = text.slice(afterStart, afterStart + anchor.suffix.length)
  return before === anchor.prefix && after === anchor.suffix
}

export function relocateStoredTextAnchor(
  anchor: StoredTextAnchor,
  text: string,
): StoredAnchorRelocation {
  const exact =
    anchor.quote.length === 0
      ? Array.from({ length: text.length + 1 }, (_, position) => position).filter((position) =>
          contextMatches(text, position, anchor),
        )
      : exactOccurrences(text, anchor.quote)
  let position: number | undefined

  if (exact.length === 1) {
    position = exact[0]
  } else if (exact.length > 1 && anchor.quote.length > 0) {
    const contextual = exact.filter((candidate) => contextMatches(text, candidate, anchor))
    if (contextual.length === 1) position = contextual[0]
  }

  return {
    range: position === undefined ? null : { from: position, to: position + anchor.quote.length },
    candidates: exact.length,
  }
}

/**
 * Re-locates only on an exact quote. Context disambiguates duplicate quotes;
 * it never permits a fuzzy attachment to changed text.
 */
export function relocateAnchor(anchor: TextAnchor, text: string): AnchorRelocation {
  const relocated = relocateStoredTextAnchor(anchor, text)

  if (relocated.range === null) {
    return {
      anchor: { ...anchor, status: 'orphaned' },
      event: anchor.status === 'orphaned' ? 'none' : 'orphaned',
      candidates: relocated.candidates,
    }
  }

  return {
    anchor: {
      ...anchor,
      ...relocated.range,
      status: 'attached',
    },
    event: anchor.status === 'orphaned' ? 'reattached' : 'none',
    candidates: relocated.candidates,
  }
}

export function canAcceptSuggestion(anchor: TextAnchor): boolean {
  return anchor.status === 'attached'
}

export function isRangeWithinSingleBlock(
  range: TextRange,
  blocks: readonly TextRange[],
): boolean {
  return blocks.some((block) => block.from <= range.from && range.to <= block.to)
}
