import {
  applyTextEdit,
  assertRange,
  computeHunks,
  contentHash,
  mapNewRangeToOld,
  mapOldRangeToNew,
  mapRange,
  rangesTouch,
  type TextEdit,
  type TextHunk,
  type TextRange,
} from './diff.js'
import {
  createStoredTextAnchor,
  relocateStoredTextAnchor,
  type StoredTextAnchor,
} from './anchors.js'

export type SegmentAuthor = 'user' | 'external'
export type PendingStatus = 'pending' | 'mixed'
export type ExternalSource = 'disk' | 'buffer'
export type ConflictResolution = 'incoming' | 'mine'

export interface ExternalAttribution {
  agentId: string | null
  name: string
}

export interface ExternalTag extends ExternalAttribution {
  setAt: number
  expiresAt: number
}

export interface Snapshot {
  id: string
  content: string
}

export interface Segment {
  id: string
  author: SegmentAuthor
  beforeSnapshotId: string
  afterSnapshotId: string
  attribution: ExternalAttribution | null
}

export interface PendingHunk {
  id: string
  shadow: TextRange
  ghost: TextRange
  status: PendingStatus
  author: ExternalAttribution
}

/** Disk form used while a document is closed. */
export interface PendingHunkAnchor {
  id: string
  shadow: StoredTextAnchor
  ghost: StoredTextAnchor
  status: PendingStatus
  author: ExternalAttribution
}

export interface ExternalConflict {
  id: string
  source: ExternalSource
  shadow: TextRange
  removed: string
  incoming: string
  author: ExternalAttribution
}

export interface DocumentFrame {
  disk: string
  shadow: string
  ghost: string
  mirror: string
  pendingHunks: PendingHunk[]
  conflicts: ExternalConflict[]
  segments: Segment[]
  snapshots: Record<string, string>
  pendingTag: ExternalTag | null
  nextId: number
  forceNewUserSegment: boolean
}

export type DocumentState = DocumentFrame

/** The fields an application step (Keep, Revert, Accept, merge) owns. */
export interface ReviewFrame {
  shadow: string
  ghost: string
  pendingHunks: PendingHunk[]
  conflicts: ExternalConflict[]
}

export interface CreateDocumentStateOptions {
  shadow?: string
  mirror?: string
  persistedPending?: readonly PendingHunk[]
  persistedPendingAnchors?: readonly PendingHunkAnchor[]
}

export interface ExternalChangeOptions {
  now?: number
  /** Ranges in the old source that count as user-edited blocks. */
  userEditedRanges?: readonly TextRange[]
  /** Top-level block ranges in the old source. Used to widen conflict checks. */
  blockRanges?: readonly TextRange[]
}

export type ExternalChangeResult =
  | { status: 'ignored'; state: DocumentState; appliedHunkIds: []; conflictIds: [] }
  | {
      status: 'applied'
      state: DocumentState
      appliedHunkIds: string[]
      conflictIds: string[]
    }

export type RevertResult =
  | { status: 'reverted'; state: DocumentState }
  | { status: 'confirmation-required'; state: DocumentState; hunk: PendingHunk }

export type SaveResult =
  | { status: 'saved'; state: DocumentState; content: string }
  | { status: 'external-change'; state: DocumentState; observedDisk: string }

const EXTERNAL: ExternalAttribution = { agentId: null, name: 'external' }
export const EXTERNAL_TAG_TTL_MS = 5 * 60 * 1000

function cloneAttribution(author: ExternalAttribution): ExternalAttribution {
  return { ...author }
}

export function reviewFrame(state: ReviewFrame): ReviewFrame {
  return {
    shadow: state.shadow,
    ghost: state.ghost,
    pendingHunks: state.pendingHunks.map((hunk) => ({
      ...hunk,
      shadow: { ...hunk.shadow },
      ghost: { ...hunk.ghost },
      author: cloneAttribution(hunk.author),
    })),
    conflicts: state.conflicts.map((conflict) => ({
      ...conflict,
      shadow: { ...conflict.shadow },
      author: cloneAttribution(conflict.author),
    })),
  }
}

function allocateId(state: DocumentState, prefix: string): [DocumentState, string] {
  return [{ ...state, nextId: state.nextId + 1 }, `${prefix}-${state.nextId}`]
}

function reservePersistedId(state: DocumentState, id: string): DocumentState {
  const numericSuffix = /-(\d+)$/.exec(id)?.[1]
  if (numericSuffix === undefined) return state
  return { ...state, nextId: Math.max(state.nextId, Number(numericSuffix) + 1) }
}

function putSnapshot(state: DocumentState, content: string): [DocumentState, string] {
  const id = contentHash(content)
  if (state.snapshots[id] === content) return [state, id]
  return [{ ...state, snapshots: { ...state.snapshots, [id]: content } }, id]
}

function recordSegment(
  state: DocumentState,
  before: string,
  after: string,
  author: SegmentAuthor,
  attribution: ExternalAttribution | null,
  force = false,
): DocumentState {
  if (before === after) return state
  let next = state
  let beforeSnapshotId: string
  let afterSnapshotId: string
  ;[next, beforeSnapshotId] = putSnapshot(next, before)
  ;[next, afterSnapshotId] = putSnapshot(next, after)

  const last = next.segments.at(-1)
  // Extending across differing attributions would mis-attribute one side and
  // hide it from that agent's deliveries, so attributed and anonymous user
  // segments never fold together.
  const mayExtend =
    !force &&
    !next.forceNewUserSegment &&
    author === 'user' &&
    last?.author === 'user' &&
    (last.attribution?.agentId ?? null) === (attribution?.agentId ?? null) &&
    last.afterSnapshotId === beforeSnapshotId

  if (mayExtend && last !== undefined) {
    const segments = next.segments.slice()
    segments[segments.length - 1] = { ...last, afterSnapshotId }
    return { ...next, segments, forceNewUserSegment: false }
  }

  let id: string
  ;[next, id] = allocateId(next, 'segment')
  return {
    ...next,
    segments: [
      ...next.segments,
      { id, author, beforeSnapshotId, afterSnapshotId, attribution },
    ],
    forceNewUserSegment: false,
  }
}

function pendingFromDiff(
  state: DocumentState,
  persisted: readonly PendingHunk[],
): DocumentState {
  let next = state
  const pendingHunks: PendingHunk[] = []
  const matchedIds = new Set<string>()
  for (const hunk of computeHunks(state.ghost, state.shadow)) {
    const match = persisted.find(
      (candidate) =>
        !matchedIds.has(candidate.id) &&
        state.ghost.slice(candidate.ghost.from, candidate.ghost.to) === hunk.removed &&
        state.shadow.slice(candidate.shadow.from, candidate.shadow.to) === hunk.added &&
        candidate.ghost.from === hunk.before.from &&
        candidate.shadow.from === hunk.after.from,
    )
    let id: string
    if (match === undefined) {
      ;[next, id] = allocateId(next, 'pending')
    } else {
      id = match.id
      matchedIds.add(match.id)
      next = reservePersistedId(next, id)
    }
    pendingHunks.push({
      id,
      ghost: { ...hunk.before },
      shadow: { ...hunk.after },
      status: match?.status ?? 'pending',
      author: match === undefined ? { ...EXTERNAL } : cloneAttribution(match.author),
    })
  }
  return { ...next, pendingHunks }
}

export function createDocumentState(
  disk: string,
  ghost: string,
  options: CreateDocumentStateOptions = {},
): DocumentState {
  const shadow = options.shadow ?? disk
  const mirror = options.mirror ?? shadow
  const initialSnapshot = contentHash(shadow)
  const state: DocumentState = {
    disk,
    shadow,
    ghost,
    mirror,
    pendingHunks: [],
    conflicts: [],
    segments: [],
    snapshots: { [initialSnapshot]: shadow },
    pendingTag: null,
    nextId: 1,
    forceNewUserSegment: false,
  }
  const persisted =
    options.persistedPendingAnchors === undefined
      ? (options.persistedPending ?? [])
      : relocatePendingHunkAnchors(ghost, shadow, options.persistedPendingAnchors)
  return pendingFromDiff(state, persisted)
}

export function recomputePendingHunks(state: DocumentState): DocumentState {
  return pendingFromDiff({ ...state, pendingHunks: [] }, state.pendingHunks)
}

export function persistPendingHunkAnchors(state: DocumentState): PendingHunkAnchor[] {
  return state.pendingHunks.map((hunk) => ({
    id: hunk.id,
    shadow: createStoredTextAnchor(state.shadow, hunk.shadow),
    ghost: createStoredTextAnchor(state.ghost, hunk.ghost),
    status: hunk.status,
    author: cloneAttribution(hunk.author),
  }))
}

export const closePendingHunks = persistPendingHunkAnchors

export function relocatePendingHunkAnchors(
  ghost: string,
  shadow: string,
  persisted: readonly PendingHunkAnchor[],
): PendingHunk[] {
  const relocated: PendingHunk[] = []
  for (const hunk of persisted) {
    const shadowRange = relocateStoredTextAnchor(hunk.shadow, shadow).range
    const ghostRange = relocateStoredTextAnchor(hunk.ghost, ghost).range
    if (shadowRange === null || ghostRange === null) continue
    relocated.push({
      id: hunk.id,
      shadow: shadowRange,
      ghost: ghostRange,
      status: hunk.status,
      author: cloneAttribution(hunk.author),
    })
  }
  return relocated
}

export function reopenPendingHunks(
  state: DocumentState,
  persisted: readonly PendingHunkAnchor[],
): DocumentState {
  const relocated = relocatePendingHunkAnchors(state.ghost, state.shadow, persisted)
  return pendingFromDiff({ ...state, pendingHunks: [] }, relocated)
}

function editTouchesRange(edit: TextEdit, range: TextRange): boolean {
  return rangesTouch(edit, range)
}

function mapPendingThroughEdit(
  pending: readonly PendingHunk[],
  edit: TextEdit,
  markMixed: boolean,
): PendingHunk[] {
  return pending.map((hunk) => ({
    ...hunk,
    shadow: mapRange(hunk.shadow, edit),
    status:
      markMixed && editTouchesRange(edit, hunk.shadow) ? 'mixed' : hunk.status,
  }))
}

function mapConflictsThroughEdit(
  conflicts: readonly ExternalConflict[],
  edit: TextEdit,
): ExternalConflict[] {
  return conflicts.map((conflict) => ({ ...conflict, shadow: mapRange(conflict.shadow, edit) }))
}

export function applyUserEdit(
  state: DocumentState,
  edit: TextEdit,
  attribution: ExternalAttribution | null = null,
): DocumentState {
  assertRange(edit, state.shadow.length)
  const before = state.shadow
  const shadow = applyTextEdit(before, edit)
  let next: DocumentState = {
    ...state,
    shadow,
    pendingHunks: mapPendingThroughEdit(state.pendingHunks, edit, true),
    conflicts: mapConflictsThroughEdit(state.conflicts, edit),
  }
  return recordSegment(next, before, shadow, 'user', attribution === null ? null : cloneAttribution(attribution))
}

/**
 * Accept a suggestion as one user transaction. The replacement is written to
 * shadow, the corresponding ghost range advances immediately, and remaining
 * pending hunks are recomputed while retaining matching attribution.
 */
export function acceptUserReplacement(
  state: DocumentState,
  edit: TextEdit,
  attribution: ExternalAttribution | null = null,
): DocumentState {
  assertRange(edit, state.shadow.length)
  const beforeShadow = state.shadow
  const ghostRange = mapNewRangeToOld(
    { from: edit.from, to: edit.to },
    computeHunks(state.ghost, beforeShadow),
  )
  let next = applyUserEdit(state, edit, attribution)
  const ghostEdit: TextEdit = { ...ghostRange, insert: edit.insert }
  const ghost = applyTextEdit(state.ghost, ghostEdit)
  const persisted = next.pendingHunks.map((hunk) => ({
    ...hunk,
    ghost: mapRange(hunk.ghost, ghostEdit),
  }))
  next = pendingFromDiff({ ...next, ghost, pendingHunks: [] }, persisted)
  return next
}

/**
 * Accept a suggestion on the Lead's authority (PRD §6.5). Unlike the user
 * path, the replacement lands as an `external` segment attributed to the
 * actor with a pending hunk the actor authored; the ghost does not move, so
 * the user still reviews the change with Keep or Revert.
 */
export function acceptAgentReplacement(
  state: DocumentState,
  edit: TextEdit,
  actor: ExternalAttribution,
): DocumentState {
  assertRange(edit, state.shadow.length)
  const before = state.shadow
  let next: DocumentState = {
    ...state,
    shadow: applyTextEdit(state.shadow, edit),
    conflicts: mapConflictsThroughEdit(state.conflicts, edit),
  }
  ;[next] = addPendingForEdit(next, before, edit, actor)
  next = recordSegment(next, before, next.shadow, 'external', cloneAttribution(actor), true)
  return { ...next, forceNewUserSegment: true }
}

export function recordMirrorWrite(state: DocumentState, content = state.shadow): DocumentState {
  return { ...state, mirror: content }
}

export function setExternalTag(
  state: DocumentState,
  agentId: string,
  name: string,
  now: number,
): DocumentState {
  return {
    ...state,
    pendingTag: { agentId, name, setAt: now, expiresAt: now + EXTERNAL_TAG_TTL_MS },
  }
}

function authorForExternal(state: DocumentState, now: number): ExternalAttribution {
  if (state.pendingTag !== null && state.pendingTag.expiresAt >= now) {
    return { agentId: state.pendingTag.agentId, name: state.pendingTag.name }
  }
  return { ...EXTERNAL }
}

function conflictArea(hunk: TextHunk, blocks: readonly TextRange[] | undefined): TextRange {
  if (blocks === undefined) return hunk.before
  const touched = blocks.filter((block) => rangesTouch(block, hunk.before))
  if (touched.length === 0) return hunk.before
  return {
    from: Math.min(...touched.map((block) => block.from)),
    to: Math.max(...touched.map((block) => block.to)),
  }
}

function mapThroughEdits(range: TextRange, edits: readonly TextEdit[]): TextRange {
  return edits.reduce((mapped, edit) => mapRange(mapped, edit), range)
}

function addPendingForEdit(
  state: DocumentState,
  beforeShadow: string,
  edit: TextEdit,
  author: ExternalAttribution,
): [DocumentState, string] {
  const ghostToBeforeShadow = computeHunks(state.ghost, beforeShadow)
  const ghostRange = mapNewRangeToOld({ from: edit.from, to: edit.to }, ghostToBeforeShadow)
  const mappedExisting = mapPendingThroughEdit(state.pendingHunks, edit, false)
  let next = { ...state, pendingHunks: mappedExisting }
  let id: string
  ;[next, id] = allocateId(next, 'pending')
  // A hunk that replaced unreviewed user text carries that text from birth:
  // reverting it to the ghost would discard the user's work, so it needs the
  // mixed confirmation even though no later edit touched it.
  const bornMixed =
    state.ghost.slice(ghostRange.from, ghostRange.to) !== beforeShadow.slice(edit.from, edit.to)
  const added: PendingHunk = {
    id,
    ghost: ghostRange,
    shadow: { from: edit.from, to: edit.from + edit.insert.length },
    status: bornMixed ? 'mixed' : 'pending',
    author: cloneAttribution(author),
  }
  const overlapping = next.pendingHunks.filter((hunk) => rangesTouch(hunk.shadow, added.shadow))
  if (overlapping.length === 0) {
    return [{ ...next, pendingHunks: [...next.pendingHunks, added] }, id]
  }

  const merged: PendingHunk = {
    ...added,
    shadow: {
      from: Math.min(added.shadow.from, ...overlapping.map((hunk) => hunk.shadow.from)),
      to: Math.max(added.shadow.to, ...overlapping.map((hunk) => hunk.shadow.to)),
    },
    ghost: {
      from: Math.min(added.ghost.from, ...overlapping.map((hunk) => hunk.ghost.from)),
      to: Math.max(added.ghost.to, ...overlapping.map((hunk) => hunk.ghost.to)),
    },
    status: added.status === 'mixed' || overlapping.some((hunk) => hunk.status === 'mixed') ? 'mixed' : 'pending',
  }
  const overlappingIds = new Set(overlapping.map((hunk) => hunk.id))
  return [
    {
      ...next,
      pendingHunks: [
        ...next.pendingHunks.filter((hunk) => !overlappingIds.has(hunk.id)),
        merged,
      ],
    },
    id,
  ]
}

export function applyExternalChange(
  state: DocumentState,
  source: ExternalSource,
  incoming: string,
  options: ExternalChangeOptions = {},
): ExternalChangeResult {
  const known = source === 'disk' ? state.disk : state.mirror
  if (incoming === known) {
    return { status: 'ignored', state, appliedHunkIds: [], conflictIds: [] }
  }

  const now = options.now ?? Date.now()
  const author = authorForExternal(state, now)
  const incomingHunks = computeHunks(known, incoming)
  const localHunks = computeHunks(known, state.shadow)
  const userEditedRanges = options.userEditedRanges ?? localHunks.map((hunk) => hunk.before)
  // A tag covers the whole burst: using it slides its window forward instead of
  // consuming it, so every write of a multi-write edit keeps the agent's name.
  // An expired or absent tag clears; an unused one still times out (PRD §6.2).
  const tagUsed = state.pendingTag !== null && state.pendingTag.expiresAt >= now
  let next: DocumentState = {
    ...state,
    disk: source === 'disk' ? incoming : state.disk,
    mirror: source === 'buffer' ? incoming : state.mirror,
    pendingTag: tagUsed && state.pendingTag !== null
      ? { ...state.pendingTag, expiresAt: now + EXTERNAL_TAG_TTL_MS }
      : null,
  }
  const beforeMergeShadow = next.shadow
  const editsApplied: TextEdit[] = []
  const appliedHunkIds: string[] = []
  const conflictIds: string[] = []

  for (const incomingHunk of incomingHunks) {
    const area = conflictArea(incomingHunk, options.blockRanges)
    const conflicts = userEditedRanges.some((range) => rangesTouch(area, range))
    const localRange = mapOldRangeToNew(incomingHunk.before, localHunks)
    const shadowRange = mapThroughEdits(localRange, editsApplied)

    if (conflicts) {
      let id: string
      ;[next, id] = allocateId(next, 'conflict')
      next = {
        ...next,
        conflicts: [
          ...next.conflicts,
          {
            id,
            source,
            shadow: shadowRange,
            removed: known.slice(incomingHunk.before.from, incomingHunk.before.to),
            incoming: incomingHunk.added,
            author: cloneAttribution(author),
          },
        ],
      }
      conflictIds.push(id)
      continue
    }

    const edit: TextEdit = { ...shadowRange, insert: incomingHunk.added }
    const shadowBeforeEdit = next.shadow
    next = {
      ...next,
      shadow: applyTextEdit(next.shadow, edit),
      conflicts: mapConflictsThroughEdit(next.conflicts, edit),
    }
    let id: string
    ;[next, id] = addPendingForEdit(next, shadowBeforeEdit, edit, author)
    appliedHunkIds.push(id)
    editsApplied.push(edit)
  }

  next = recordSegment(next, beforeMergeShadow, next.shadow, 'external', author, true)
  next = { ...next, forceNewUserSegment: true }
  return { status: 'applied', state: next, appliedHunkIds, conflictIds }
}

export function resolveExternalConflict(
  state: DocumentState,
  conflictId: string,
  resolution: ConflictResolution,
): DocumentState {
  const conflict = state.conflicts.find((candidate) => candidate.id === conflictId)
  if (conflict === undefined) throw new Error(`Unknown external conflict: ${conflictId}`)
  const remaining = state.conflicts.filter((candidate) => candidate.id !== conflictId)
  if (resolution === 'mine') return { ...state, conflicts: remaining }

  const edit: TextEdit = { ...conflict.shadow, insert: conflict.incoming }
  const before = state.shadow
  let next: DocumentState = {
    ...state,
    shadow: applyTextEdit(state.shadow, edit),
    pendingHunks: state.pendingHunks,
    conflicts: mapConflictsThroughEdit(remaining, edit),
  }
  let ignoredId: string
  ;[next, ignoredId] = addPendingForEdit(next, before, edit, conflict.author)
  next = recordSegment(next, before, next.shadow, 'external', conflict.author, true)
  return { ...next, forceNewUserSegment: true }
}

function requirePending(state: DocumentState, hunkId: string): PendingHunk {
  const hunk = state.pendingHunks.find((candidate) => candidate.id === hunkId)
  if (hunk === undefined) throw new Error(`Unknown pending hunk: ${hunkId}`)
  return hunk
}

function keepHunkInternal(state: DocumentState, hunkId: string): DocumentState {
  const hunk = requirePending(state, hunkId)
  const replacement = state.shadow.slice(hunk.shadow.from, hunk.shadow.to)
  const edit: TextEdit = { ...hunk.ghost, insert: replacement }
  return {
    ...state,
    ghost: applyTextEdit(state.ghost, edit),
    pendingHunks: state.pendingHunks
      .filter((candidate) => candidate.id !== hunkId)
      .map((candidate) => ({ ...candidate, ghost: mapRange(candidate.ghost, edit) })),
  }
}

export function keepHunk(state: DocumentState, hunkId: string): DocumentState {
  return keepHunkInternal(state, hunkId)
}

export function revertHunk(
  state: DocumentState,
  hunkId: string,
  confirmMixed = false,
): RevertResult {
  const hunk = requirePending(state, hunkId)
  if (hunk.status === 'mixed' && !confirmMixed) {
    return { status: 'confirmation-required', state, hunk }
  }
  const replacement = state.ghost.slice(hunk.ghost.from, hunk.ghost.to)
  const edit: TextEdit = { ...hunk.shadow, insert: replacement }
  const before = state.shadow
  let next: DocumentState = {
    ...state,
    shadow: applyTextEdit(state.shadow, edit),
    pendingHunks: mapPendingThroughEdit(state.pendingHunks, edit, false).filter(
      (candidate) => candidate.id !== hunkId,
    ),
    conflicts: mapConflictsThroughEdit(state.conflicts, edit),
  }
  next = recordSegment(next, before, next.shadow, 'user', cloneAttribution(hunk.author))
  return { status: 'reverted', state: next }
}

export function markReviewed(state: DocumentState): DocumentState {
  let next = state
  for (const hunk of [...state.pendingHunks].sort((left, right) => right.ghost.from - left.ghost.from)) {
    next = keepHunkInternal(next, hunk.id)
  }
  return next
}

function ghostAfterSave(state: DocumentState): {
  ghost: string
  pendingHunks: PendingHunk[]
} {
  const pending = [...state.pendingHunks].sort(
    (left, right) => left.shadow.from - right.shadow.from || left.shadow.to - right.shadow.to,
  )
  let ghost = ''
  let cursor = 0
  const updated: PendingHunk[] = []
  for (const hunk of pending) {
    if (hunk.shadow.from < cursor) {
      throw new Error('Overlapping pending hunks cannot be saved independently')
    }
    ghost += state.shadow.slice(cursor, hunk.shadow.from)
    const ghostText = state.ghost.slice(hunk.ghost.from, hunk.ghost.to)
    const from = ghost.length
    ghost += ghostText
    updated.push({ ...hunk, ghost: { from, to: ghost.length } })
    cursor = hunk.shadow.to
  }
  ghost += state.shadow.slice(cursor)
  return { ghost, pendingHunks: updated }
}

/** Re-checks disk immediately before producing the atomic Save content. */
export function prepareSave(state: DocumentState, observedDisk: string): SaveResult {
  if (observedDisk !== state.disk) {
    return { status: 'external-change', state, observedDisk }
  }
  const saved = ghostAfterSave(state)
  const next: DocumentState = {
    ...state,
    disk: state.shadow,
    ghost: saved.ghost,
    pendingHunks: saved.pendingHunks,
  }
  return { status: 'saved', state: next, content: state.shadow }
}

export function markSendBoundary(state: DocumentState): DocumentState {
  const [withSnapshot] = putSnapshot(state, state.shadow)
  return { ...withSnapshot, forceNewUserSegment: true }
}

export function discardOnClose(state: DocumentState): DocumentState {
  const discarded = {
    ...state,
    shadow: state.disk,
    mirror: state.disk,
    conflicts: [],
  }
  return recomputePendingHunks(discarded)
}

/**
 * Reverse or replay an application step. The ghost, pending hunks, and
 * conflicts come back verbatim; the shadow difference is recorded as a user
 * segment so it reaches agents as a user hunk. When the previous segment is
 * the step's own user segment (Accept, Revert) the reversal extends it and the
 * two cancel in the next delivery. disk, mirror, segments, snapshots, and ids
 * are never rewound.
 */
export function restoreReviewFrame(state: DocumentState, target: ReviewFrame): DocumentState {
  const shadowBefore = state.shadow
  const frame = reviewFrame(target)
  const next: DocumentState = {
    ...state,
    shadow: frame.shadow,
    ghost: frame.ghost,
    pendingHunks: frame.pendingHunks,
    conflicts: frame.conflicts,
  }
  // The reversal carries the attribution of the segment it extends, so an
  // attributed Accept or Revert still cancels in place under the merge rule.
  const last = state.segments.at(-1)
  const attribution =
    !state.forceNewUserSegment &&
    last?.author === 'user' &&
    last.afterSnapshotId === contentHash(shadowBefore)
      ? last.attribution
      : null
  return recordSegment(next, shadowBefore, frame.shadow, 'user', attribution)
}
