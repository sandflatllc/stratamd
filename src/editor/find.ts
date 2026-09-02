import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

// Find (PRD §6.1): a case-insensitive substring search over the document with
// every match marked and the current one distinct. The same engine runs over
// the visual document's text blocks and over the raw source text, so the two
// views count and step through the same matches.

export interface FindMatch {
  from: number
  to: number
}

export interface FindResult {
  /** Total matches for the query; 0 for an empty query. */
  count: number
  /** One-based index of the current match; 0 when there is none. */
  current: number
}

export const NO_MATCHES: FindResult = { count: 0, current: 0 }

/** Every non-overlapping occurrence of `query` in `text`, ignoring case. */
export function findInText(text: string, query: string, offset = 0): FindMatch[] {
  if (!query) return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const matches: FindMatch[] = []
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    matches.push({ from: offset + index, to: offset + index + needle.length })
    index = haystack.indexOf(needle, index + needle.length)
  }
  return matches
}

/** Matches inside each text block of the document, in document order; a match never crosses blocks. */
export function findInDocument(doc: ProseMirrorNode, query: string): FindMatch[] {
  if (!query) return []
  const matches: FindMatch[] = []
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true
    // The leaf placeholder keeps string offsets equal to content offsets.
    const text = node.textBetween(0, node.content.size, undefined, '￼')
    matches.push(...findInText(text, query, position + 1))
    return false
  })
  return matches
}

/** The index of the first match at or after `position`, wrapping to the first match. */
export function firstMatchFrom(matches: readonly FindMatch[], position: number): number {
  if (matches.length === 0) return -1
  const index = matches.findIndex((match) => match.from >= position)
  return index < 0 ? 0 : index
}

/** Steps the current index with wrap-around; -1 stays -1 when there are no matches. */
export function stepMatch(count: number, current: number, direction: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

/** Copy for the find bar: "3 of 12", "No matches", or nothing for an empty query. */
export function findCountLabel(query: string, result: FindResult): string {
  if (!query) return ''
  if (result.count === 0) return 'No matches'
  return `${result.current} of ${result.count}`
}

export const FIND_MATCH_CLASS = 'strata-find-match'
export const FIND_CURRENT_CLASS = 'strata-find-current'

interface FindPluginState {
  query: string
  matches: FindMatch[]
  current: number
  decorations: DecorationSet
}

const findKey = new PluginKey<FindPluginState>('stratamd-find')
const findMeta = 'stratamd-find'

function findDecorations(doc: ProseMirrorNode, matches: readonly FindMatch[], current: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty
  return DecorationSet.create(doc, matches.map((match, index) => Decoration.inline(match.from, match.to, {
    class: index === current ? `${FIND_MATCH_CLASS} ${FIND_CURRENT_CLASS}` : FIND_MATCH_CLASS,
  })))
}

const EMPTY_FIND: FindPluginState = { query: '', matches: [], current: -1, decorations: DecorationSet.empty }

export function createFindPlugin(): Plugin<FindPluginState> {
  return new Plugin<FindPluginState>({
    key: findKey,
    state: {
      init: () => EMPTY_FIND,
      apply(transaction, value, _oldState, newState) {
        const requested = transaction.getMeta(findMeta) as { query: string; current: number } | undefined
        if (requested) {
          const matches = findInDocument(newState.doc, requested.query)
          const current = matches.length === 0 ? -1 : Math.max(0, Math.min(matches.length - 1, requested.current))
          return { query: requested.query, matches, current, decorations: findDecorations(newState.doc, matches, current) }
        }
        if (!value.query) return value
        if (!transaction.docChanged) return value
        // The text changed under an open search: re-run it and keep the current
        // match near where it was.
        const matches = findInDocument(newState.doc, value.query)
        const mappedFrom = value.current >= 0 ? transaction.mapping.map(value.matches[value.current]!.from) : 0
        const current = firstMatchFrom(matches, mappedFrom)
        return { query: value.query, matches, current, decorations: findDecorations(newState.doc, matches, current) }
      },
    },
    props: {
      decorations(state) {
        return findKey.getState(state)?.decorations ?? null
      },
    },
  })
}

export function setFind(transaction: Transaction, query: string, current: number): Transaction {
  return transaction.setMeta(findMeta, { query, current }).setMeta('addToHistory', false)
}

export function getFindState(state: EditorState): { query: string; matches: readonly FindMatch[]; current: number } {
  const value = findKey.getState(state) ?? EMPTY_FIND
  return { query: value.query, matches: value.matches, current: value.current }
}

export function findResultOf(matches: readonly FindMatch[], current: number): FindResult {
  return { count: matches.length, current: matches.length === 0 || current < 0 ? 0 : current + 1 }
}
