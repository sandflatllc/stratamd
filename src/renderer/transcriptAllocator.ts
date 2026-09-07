/**
 * One editor budget per transcript (docs/plans/open/transcript-scroll-stability-2026-09-07-plan.md §4.1).
 *
 * Every rich editor a transcript holds counts: displayed, retained offscreen,
 * staged candidates, and navigation targets. Mandatory pins come first and are
 * never evicted; the remaining slots go to visible rows, then rows ahead in the
 * travel direction, then recently visited rows that still hold an editor.
 * Rows that miss the cut keep their lightweight presentation. Only unpinned
 * offscreen editors are ever released.
 */
export const TRANSCRIPT_EDITOR_LIMIT = 11

export interface AllocationRow {
  id: string
  /** An active selection, an open discussion, or the current navigation target. */
  pinned: boolean
  /** Row box in the viewport's scroll coordinates. */
  top: number
  bottom: number
  /** Holds an editor now, published or staged. */
  editor: boolean
  /** Last time the row intersected the viewport, in ms; -Infinity when never. */
  lastVisible: number
}

export interface AllocationInput {
  rows: readonly AllocationRow[]
  viewportTop: number
  viewportHeight: number
  limit?: number
  /** Travel direction of the latest reader scroll: 1 down, -1 up, 0 unknown. */
  direction: -1 | 0 | 1
  /** Prefetch distance in the travel direction, in viewports. */
  prefetchViewports?: number
  /** Retention distance for rows already holding an editor, in viewports. */
  retainViewports?: number
}

export interface AllocationPlan {
  /** Rows that hold an editor after this pass, highest priority first. */
  keep: string[]
  /** Rows in `keep` without an editor, in preparation order. */
  prepare: string[]
  /** Offscreen, unpinned rows losing their editor. */
  release: string[]
  /** Mandatory pins alone exceeded the limit; no speculative work was admitted. */
  overflow: boolean
}

function distanceFromViewport(row: AllocationRow, viewportTop: number, viewportBottom: number): number {
  if (row.bottom <= viewportTop) return viewportTop - row.bottom
  if (row.top >= viewportBottom) return row.top - viewportBottom
  return 0
}

export function allocateTranscriptEditors(input: AllocationInput): AllocationPlan {
  const limit = input.limit ?? TRANSCRIPT_EDITOR_LIMIT
  const viewportBottom = input.viewportTop + input.viewportHeight
  const prefetch = (input.prefetchViewports ?? 1) * input.viewportHeight
  const retain = (input.retainViewports ?? 3) * input.viewportHeight
  const distance = (row: AllocationRow) => distanceFromViewport(row, input.viewportTop, viewportBottom)
  const visible = (row: AllocationRow) => row.bottom > input.viewportTop && row.top < viewportBottom
  const ahead = (row: AllocationRow) => input.direction === 0 || (input.direction > 0 ? row.top >= viewportBottom : row.bottom <= input.viewportTop)

  const keep: string[] = []
  const chosen = new Set<string>()
  const admit = (row: AllocationRow): boolean => {
    if (chosen.has(row.id)) return true
    if (keep.length >= limit) return false
    chosen.add(row.id)
    keep.push(row.id)
    return true
  }

  const pinned = input.rows.filter((row) => row.pinned)
  for (const row of pinned) { chosen.add(row.id); keep.push(row.id) }
  const overflow = keep.length > limit
  if (!overflow) {
    // Visible rows, those already holding an editor first so a full viewport
    // never churns, then nearest to the reading edge.
    const visibleRows = input.rows.filter((row) => !row.pinned && visible(row))
      .sort((left, right) => Number(right.editor) - Number(left.editor) || Math.abs(left.top - input.viewportTop) - Math.abs(right.top - input.viewportTop))
    for (const row of visibleRows) admit(row)
    // Rows ahead of the reader within one viewport, nearest first.
    const upcoming = input.rows.filter((row) => !row.pinned && !visible(row) && ahead(row) && distance(row) <= prefetch)
      .sort((left, right) => distance(left) - distance(right))
    for (const row of upcoming) admit(row)
    // Recently visited rows keep their editor while capacity allows.
    const retained = input.rows.filter((row) => !row.pinned && !visible(row) && row.editor && distance(row) <= retain)
      .sort((left, right) => right.lastVisible - left.lastVisible || distance(left) - distance(right))
    for (const row of retained) admit(row)
  }

  const byId = new Map(input.rows.map((row) => [row.id, row]))
  const prepare = keep.filter((id) => !byId.get(id)?.editor)
  const release = input.rows.filter((row) => row.editor && !row.pinned && !chosen.has(row.id) && !visible(row)).map((row) => row.id)
  return { keep, prepare, release, overflow }
}

/** The nearest unmeasured row for idle preparation when a slot is spare, or null. */
export function idleCandidate(input: AllocationInput & { unmeasured: ReadonlySet<string>; keepCount: number }): string | null {
  const limit = input.limit ?? TRANSCRIPT_EDITOR_LIMIT
  if (input.keepCount >= limit) return null
  const viewportBottom = input.viewportTop + input.viewportHeight
  const candidates = input.rows.filter((row) => !row.editor && !row.pinned && input.unmeasured.has(row.id))
    .sort((left, right) => distanceFromViewport(left, input.viewportTop, viewportBottom) - distanceFromViewport(right, input.viewportTop, viewportBottom))
  return candidates[0]?.id ?? null
}
