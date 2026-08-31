import { describe, expect, it } from 'vitest'

import {
  acceptAgentReplacement,
  acceptUserReplacement,
  applyExternalChange,
  applyUserEdit,
  createDocumentState,
  discardOnClose,
  keepHunk,
  markReviewed,
  markSendBoundary,
  persistPendingHunkAnchors,
  prepareSave,
  recordMirrorWrite,
  resolveExternalConflict,
  revertHunk,
  restoreReviewFrame,
  reviewFrame,
  setExternalTag,
} from '../../src/core/state.js'

function externalBuffer(state: ReturnType<typeof createDocumentState>, incoming: string) {
  const result = applyExternalChange(state, 'buffer', incoming, { now: 1_000 })
  expect(result.status).toBe('applied')
  return result.state
}

describe('document state and external merges', () => {
  it('seeds open differences as external pending hunks', () => {
    const state = createDocumentState('current\n', 'reviewed\n')

    expect(state.shadow).toBe('current\n')
    expect(state.pendingHunks).toHaveLength(1)
    expect(state.pendingHunks[0]).toMatchObject({
      status: 'pending',
      author: { agentId: null, name: 'external' },
    })
  })

  it('applies non-conflicting incoming hunks around unsaved user edits', () => {
    const original = 'alpha\n\nbeta\n'
    let state = createDocumentState(original, original)
    state = applyUserEdit(state, { from: 7, to: 11, insert: 'BETA' })
    const result = applyExternalChange(state, 'buffer', 'ALPHA\n\nbeta\n', { now: 1_000 })

    expect(result.status).toBe('applied')
    expect(result.state.shadow).toBe('ALPHA\n\nBETA\n')
    expect(result.state.pendingHunks).toHaveLength(1)
    expect(result.state.conflicts).toHaveLength(0)
    expect(result.state.segments.map((segment) => segment.author)).toEqual(['user', 'external'])
  })

  it('widens conflict detection to top-level blocks and supports either choice', () => {
    const original = 'first line\nsecond line\n\nother\n'
    const locallyEdited = 'FIRST line\nsecond line\n\nother\n'
    const incoming = 'first line\nSECOND line\n\nother\n'
    const paragraphEnd = original.indexOf('\n\n') + 1
    let state = createDocumentState(original, original)
    state = applyUserEdit(state, { from: 0, to: 5, insert: 'FIRST' })
    const result = applyExternalChange(state, 'disk', incoming, {
      now: 1_000,
      blockRanges: [
        { from: 0, to: paragraphEnd },
        { from: paragraphEnd + 1, to: original.length },
      ],
    })

    expect(result.state.shadow).toBe(locallyEdited)
    expect(result.state.conflicts).toHaveLength(1)
    const conflictId = result.conflictIds[0]!
    expect(resolveExternalConflict(result.state, conflictId, 'mine').shadow).toBe(locallyEdited)

    const choseIncoming = resolveExternalConflict(result.state, conflictId, 'incoming')
    expect(choseIncoming.shadow).toBe('FIRST line\nSECOND line\n\nother\n')
    expect(choseIncoming.pendingHunks).toHaveLength(1)
  })

  it('a tag covers the whole burst, sliding its window, and expires unused', () => {
    const original = 'one\n'
    let tagged = setExternalTag(createDocumentState(original, original), 'agent-1', 'Ada', 1_000)
    const ignored = applyExternalChange(tagged, 'buffer', original, { now: 2_000 })
    expect(ignored.state.pendingTag?.name).toBe('Ada')

    tagged = applyExternalChange(tagged, 'buffer', 'two\n', { now: 2_000 }).state
    expect(tagged.pendingHunks[0]?.author).toEqual({ agentId: 'agent-1', name: 'Ada' })
    // The window slid on use: a later write past the tag's original expiry
    // still carries the name, and the merged hunk keeps it.
    tagged = applyExternalChange(tagged, 'buffer', 'two three\n', { now: 301_500 }).state
    expect(tagged.pendingHunks[0]?.author).toEqual({ agentId: 'agent-1', name: 'Ada' })
    expect(tagged.pendingTag?.expiresAt).toBe(601_500)

    // Idle past the window: the write is external and the tag clears.
    const idle = applyExternalChange(tagged, 'buffer', 'two three four\n', { now: 602_000 }).state
    expect(idle.pendingHunks[0]?.author).toEqual({ agentId: null, name: 'external' })
    expect(idle.pendingTag).toBeNull()

    // Another agent's tag replaces the running one from its next write.
    const handedOff = applyExternalChange(
      setExternalTag(tagged, 'agent-2', 'Grace', 302_000),
      'buffer',
      'two three four\n',
      { now: 302_500 },
    ).state
    expect(handedOff.pendingHunks[0]?.author).toEqual({ agentId: 'agent-2', name: 'Grace' })

    // A tag never used expires and attributes nothing.
    let unused = setExternalTag(createDocumentState(original, original), 'agent-1', 'Ada', 1_000)
    unused = applyExternalChange(unused, 'buffer', 'two\n', { now: 301_001 }).state
    expect(unused.pendingHunks[0]?.author).toEqual({ agentId: null, name: 'external' })
    expect(unused.pendingTag).toBeNull()
  })

  it('collapses consecutive writes to the same region into one pending hunk', () => {
    let state = externalBuffer(createDocumentState('one\n', 'one\n'), 'agent one\n')
    state = applyExternalChange(state, 'buffer', 'agent two\n', { now: 2_000 }).state

    expect(state.pendingHunks).toHaveLength(1)
    const saved = prepareSave(state, 'one\n')
    expect(saved.status).toBe('saved')
    if (saved.status === 'saved') expect(saved.state.ghost).toBe('one\n')
  })

  it('ignores mirror and Save watcher events by known content', () => {
    const original = 'one\n'
    let state = createDocumentState(original, original)
    state = applyUserEdit(state, { from: 0, to: 3, insert: 'ONE' })
    state = recordMirrorWrite(state)
    expect(applyExternalChange(state, 'buffer', state.shadow).status).toBe('ignored')

    const saved = prepareSave(state, original)
    expect(saved.status).toBe('saved')
    if (saved.status === 'saved') {
      expect(applyExternalChange(saved.state, 'disk', saved.content).status).toBe('ignored')
    }
  })

  it('restores pending attribution and mixed status from close-time text anchors', () => {
    const original = 'one\ntwo\n'
    let state = setExternalTag(createDocumentState(original, original), 'agent-1', 'Ada', 1_000)
    state = applyExternalChange(state, 'buffer', 'ONE\ntwo\n', { now: 2_000 }).state
    state = applyUserEdit(state, { from: 1, to: 1, insert: '!' })
    const persisted = persistPendingHunkAnchors(state)
    const originalId = state.pendingHunks[0]!.id

    const reopened = createDocumentState(original, state.ghost, {
      shadow: state.shadow,
      persistedPendingAnchors: persisted,
    })

    expect(reopened.pendingHunks).toHaveLength(1)
    expect(reopened.pendingHunks[0]).toMatchObject({
      id: originalId,
      status: 'mixed',
      author: { agentId: 'agent-1', name: 'Ada' },
    })
  })

  it('falls back to external when a persisted anchored hunk no longer matches', () => {
    const original = 'one\ntwo\n'
    const state = externalBuffer(createDocumentState(original, original), 'ONE\ntwo\n')
    const persisted = persistPendingHunkAnchors(state)

    const reopened = createDocumentState(original, original, {
      shadow: 'different\ntwo\n',
      persistedPendingAnchors: persisted,
    })

    expect(reopened.pendingHunks).toHaveLength(1)
    expect(reopened.pendingHunks[0]).toMatchObject({
      status: 'pending',
      author: { agentId: null, name: 'external' },
    })
  })

  it('persists zero-width pending deletion ranges', () => {
    const original = 'one\ntwo\n'
    const state = externalBuffer(createDocumentState(original, original), 'one\n')
    expect(state.pendingHunks[0]?.shadow.from).toBe(state.pendingHunks[0]?.shadow.to)
    const persisted = persistPendingHunkAnchors(state)

    const reopened = createDocumentState(original, original, {
      shadow: 'one\n',
      persistedPendingAnchors: persisted,
    })
    expect(reopened.pendingHunks[0]?.id).toBe(state.pendingHunks[0]?.id)
  })
})

describe('pending hunk review', () => {
  it('marks an edited proposal mixed and Keep preserves the user edit', () => {
    let state = externalBuffer(createDocumentState('one\n', 'one\n'), 'agent\n')
    state = applyUserEdit(state, { from: 2, to: 2, insert: '!' })
    const hunk = state.pendingHunks[0]!

    expect(hunk.status).toBe('mixed')
    const kept = keepHunk(state, hunk.id)
    expect(kept.pendingHunks).toHaveLength(0)
    expect(kept.ghost).toBe('ag!ent\n')
    expect(kept.shadow).toBe('ag!ent\n')
  })

  it('requires confirmation before mixed Revert discards the user edit', () => {
    let state = externalBuffer(createDocumentState('one\n', 'one\n'), 'agent\n')
    state = applyUserEdit(state, { from: 2, to: 2, insert: '!' })
    const hunk = state.pendingHunks[0]!

    const blocked = revertHunk(state, hunk.id)
    expect(blocked.status).toBe('confirmation-required')
    expect(blocked.state.shadow).toBe('ag!ent\n')

    const reverted = revertHunk(state, hunk.id, true)
    expect(reverted.status).toBe('reverted')
    if (reverted.status === 'reverted') {
      expect(reverted.state.shadow).toBe('one\n')
      expect(reverted.state.pendingHunks).toHaveLength(0)
      expect(reverted.state.segments.at(-1)?.author).toBe('user')
    }
  })

  it('marks every remaining hunk reviewed in one reversible step', () => {
    const original = 'a\nb\nc\nd\n'
    const state = externalBuffer(createDocumentState(original, original), 'A\nb\nc\nD\n')
    expect(state.pendingHunks).toHaveLength(2)

    const reviewed = markReviewed(state)
    expect(reviewed.pendingHunks).toHaveLength(0)
    expect(reviewed.ghost).toBe(reviewed.shadow)

    const undone = restoreReviewFrame(reviewed, reviewFrame(state))
    expect(undone.pendingHunks).toHaveLength(2)
    expect(undone.ghost).toBe(original)
    expect(undone.shadow).toBe(state.shadow)
  })

  it('reverses Keep and Revert side effects from the frame before them', () => {
    const state = externalBuffer(createDocumentState('one\n', 'one\n'), 'agent\n')
    const hunkId = state.pendingHunks[0]!.id
    const before = reviewFrame(state)

    const keepUndone = restoreReviewFrame(keepHunk(state, hunkId), before)
    expect(keepUndone.ghost).toBe('one\n')
    expect(keepUndone.pendingHunks).toHaveLength(1)

    const reverted = revertHunk(state, hunkId)
    expect(reverted.status).toBe('reverted')
    if (reverted.status === 'reverted') {
      const revertUndone = restoreReviewFrame(reverted.state, before)
      expect(revertUndone.shadow).toBe('agent\n')
      expect(revertUndone.pendingHunks).toHaveLength(1)
      expect(revertUndone.pendingHunks[0]?.id).toBe(hunkId)
    }
  })

  it('accepts a replacement into shadow and ghost as one reversible user change', () => {
    const original = 'Use the old phrase here.\n'
    const base = createDocumentState(original, original)
    const accepted = acceptUserReplacement(base, {
      from: 8,
      to: 18,
      insert: 'new wording',
    })

    expect(accepted.shadow).toBe('Use the new wording here.\n')
    expect(accepted.ghost).toBe(accepted.shadow)
    expect(accepted.pendingHunks).toEqual([])
    expect(accepted.segments.at(-1)?.author).toBe('user')
    const undone = restoreReviewFrame(accepted, reviewFrame(base))
    expect(undone.shadow).toBe(original)
    expect(undone.ghost).toBe(original)
  })

  it('accepts a replacement on the Lead\'s authority as a tagged external segment with a pending hunk', () => {
    const original = 'Use the old phrase here.\n'
    const base = createDocumentState(original, original)
    const lead = { agentId: 'ag_lead', name: 'Lead' }
    const accepted = acceptAgentReplacement(base, { from: 8, to: 18, insert: 'new wording' }, lead)

    expect(accepted.shadow).toBe('Use the new wording here.\n')
    // The ghost does not move: the user reviews the change with Keep or Revert.
    expect(accepted.ghost).toBe(original)
    expect(accepted.pendingHunks).toHaveLength(1)
    expect(accepted.pendingHunks[0]).toMatchObject({
      status: 'pending',
      author: { agentId: 'ag_lead', name: 'Lead' },
    })
    expect(accepted.shadow.slice(accepted.pendingHunks[0]!.shadow.from, accepted.pendingHunks[0]!.shadow.to)).toBe('new wording')
    expect(accepted.segments.at(-1)).toMatchObject({
      author: 'external',
      attribution: { agentId: 'ag_lead', name: 'Lead' },
    })

    const reverted = revertHunk(accepted, accepted.pendingHunks[0]!.id)
    expect(reverted.status).toBe('reverted')
    if (reverted.status === 'reverted') expect(reverted.state.shadow).toBe(original)
  })
})

describe('Save, Send, close, and undo boundaries', () => {
  it('saves the shadow while keeping a mixed proposal out of the ghost', () => {
    let state = externalBuffer(createDocumentState('one\n', 'one\n'), 'agent\n')
    state = applyUserEdit(state, { from: 2, to: 2, insert: '!' })
    const saved = prepareSave(state, 'one\n')

    expect(saved.status).toBe('saved')
    if (saved.status === 'saved') {
      expect(saved.content).toBe('ag!ent\n')
      expect(saved.state.disk).toBe('ag!ent\n')
      expect(saved.state.ghost).toBe('one\n')
      expect(saved.state.pendingHunks[0]?.status).toBe('mixed')
    }
  })

  it('advances saved user edits outside pending external regions', () => {
    const original = 'alpha\n\nbeta\n'
    let state = externalBuffer(createDocumentState(original, original), 'ALPHA\n\nbeta\n')
    state = applyUserEdit(state, { from: 7, to: 11, insert: 'BETA' })
    const saved = prepareSave(state, original)

    expect(saved.status).toBe('saved')
    if (saved.status === 'saved') {
      expect(saved.state.ghost).toBe('alpha\n\nBETA\n')
      expect(saved.state.shadow).toBe('ALPHA\n\nBETA\n')
      expect(saved.state.pendingHunks).toHaveLength(1)
    }
  })

  it('detects a disk write that raced the final Save check', () => {
    const original = 'one\n'
    const state = applyUserEdit(createDocumentState(original, original), {
      from: 0,
      to: 3,
      insert: 'ONE',
    })
    const result = prepareSave(state, 'external\n')

    expect(result).toMatchObject({ status: 'external-change', observedDisk: 'external\n' })
    expect(result.state.disk).toBe(original)
  })

  it('drops buffer-only pending hunks when close chooses Discard', () => {
    const state = externalBuffer(createDocumentState('disk\n', 'disk\n'), 'buffer\n')
    const discarded = discardOnClose(state)

    expect(discarded.shadow).toBe('disk\n')
    expect(discarded.mirror).toBe('disk\n')
    expect(discarded.pendingHunks).toHaveLength(0)
  })

  it('starts a new user segment after each Send boundary', () => {
    let state = createDocumentState('abc\n', 'abc\n')
    state = applyUserEdit(state, { from: 0, to: 1, insert: 'A' })
    state = applyUserEdit(state, { from: 1, to: 2, insert: 'B' })
    expect(state.segments).toHaveLength(1)

    state = markSendBoundary(state)
    state = applyUserEdit(state, { from: 2, to: 3, insert: 'C' })
    expect(state.segments).toHaveLength(2)
    expect(state.segments.every((segment) => segment.author === 'user')).toBe(true)
  })

  it('reverses an external merge as a user segment and clears its pending hunk', () => {
    const base = createDocumentState('one\n', 'one\n')
    const merged = externalBuffer(base, 'agent\n')
    const undone = restoreReviewFrame(merged, reviewFrame(base))

    expect(undone.shadow).toBe('one\n')
    expect(undone.pendingHunks).toHaveLength(0)
    expect(undone.segments.map((segment) => segment.author)).toEqual(['external', 'user'])
  })

  it('restoring a frame never rewinds disk, mirror, snapshots, or ids', () => {
    const base = createDocumentState('one\n', 'one\n')
    const merged = externalBuffer(base, 'agent\n')
    const undone = restoreReviewFrame(merged, reviewFrame(base))

    expect(undone.disk).toBe(merged.disk)
    expect(undone.mirror).toBe('agent\n')
    expect(undone.nextId).toBeGreaterThanOrEqual(merged.nextId)
    expect(Object.keys(undone.snapshots)).toEqual(expect.arrayContaining(Object.keys(merged.snapshots)))
    const redone = restoreReviewFrame(undone, reviewFrame(merged))
    expect(redone.shadow).toBe('agent\n')
    expect(redone.pendingHunks).toHaveLength(1)
    // The replay extends the reversal's user segment, so the two cancel for agents.
    expect(redone.segments.map((segment) => segment.author)).toEqual(['external', 'user'])
    expect(redone.segments.at(-1)?.beforeSnapshotId).toBe(redone.segments.at(-1)?.afterSnapshotId)
  })

  it('an Accept and its reversal cancel into one user segment', () => {
    const original = 'Use the old phrase here.\n'
    const base = createDocumentState(original, original)
    const accepted = acceptUserReplacement(base, { from: 8, to: 18, insert: 'new wording' })
    const undone = restoreReviewFrame(accepted, reviewFrame(base))
    expect(undone.segments).toHaveLength(1)
    expect(undone.segments[0]?.beforeSnapshotId).toBe(undone.segments[0]?.afterSnapshotId)
  })
})

describe('hunks born over unreviewed user work', () => {
  it('marks an external hunk mixed from birth when it replaces unsaved user text', () => {
    const original = '# Undo\n\nBase.\n'
    let state = createDocumentState(original, original)
    state = applyUserEdit(state, { from: 13, to: 13, insert: ' Owner' })
    state = recordMirrorWrite(state)

    const result = applyExternalChange(state, 'buffer', '# Undo\n\nBase. Owner Agent.\n')
    expect(result.status).toBe('applied')
    expect(result.state.pendingHunks).toHaveLength(1)
    const hunk = result.state.pendingHunks[0]!
    expect(hunk.status).toBe('mixed')

    const denied = revertHunk(result.state, hunk.id)
    expect(denied.status).toBe('confirmation-required')

    const confirmed = revertHunk(result.state, hunk.id, true)
    expect(confirmed.status).toBe('reverted')
    if (confirmed.status === 'reverted') expect(confirmed.state.shadow).toBe(original)
  })

  it('keeps a clean external hunk pending and reverts it without confirmation', () => {
    const original = '# Doc\n\nBase.\n'
    let state = createDocumentState(original, original)
    state = recordMirrorWrite(state)

    const result = applyExternalChange(state, 'buffer', '# Doc\n\nBase. Agent.\n')
    expect(result.status).toBe('applied')
    const hunk = result.state.pendingHunks[0]!
    expect(hunk.status).toBe('pending')

    const reverted = revertHunk(result.state, hunk.id)
    expect(reverted.status).toBe('reverted')
    if (reverted.status === 'reverted') expect(reverted.state.shadow).toBe(original)
  })
})

describe('attribution through review actions', () => {
  const claude = { agentId: 'ag_x', name: 'Claude' }

  function agentHunkState() {
    let state = setExternalTag(createDocumentState('one\n', 'one\n'), claude.agentId, claude.name, 500)
    state = externalBuffer(state, 'agent\n')
    expect(state.pendingHunks[0]).toMatchObject({ author: claude })
    return state
  }

  it('Revert records a user segment attributed to the hunk author', () => {
    const state = agentHunkState()
    const reverted = revertHunk(state, state.pendingHunks[0]!.id)
    expect(reverted.status).toBe('reverted')
    if (reverted.status === 'reverted') {
      expect(reverted.state.segments.at(-1)).toMatchObject({ author: 'user', attribution: claude })
    }
  })

  it("Accept carries the suggestion author onto the user segment; the user's own accept stays anonymous", () => {
    const original = 'Use the old phrase here.\n'
    const attributed = acceptUserReplacement(createDocumentState(original, original), { from: 8, to: 18, insert: 'new wording' }, claude)
    expect(attributed.segments.at(-1)).toMatchObject({ author: 'user', attribution: claude })

    const anonymous = acceptUserReplacement(createDocumentState(original, original), { from: 8, to: 18, insert: 'new wording' })
    expect(anonymous.segments.at(-1)).toMatchObject({ author: 'user', attribution: null })
  })

  it('typing and an attributed step never fold into one segment', () => {
    const state = agentHunkState()
    const reverted = revertHunk(state, state.pendingHunks[0]!.id)
    expect(reverted.status).toBe('reverted')
    if (reverted.status !== 'reverted') return
    const afterRevert = reverted.state.segments.length
    const typed = applyUserEdit(reverted.state, { from: 0, to: 0, insert: 'x' })
    expect(typed.segments).toHaveLength(afterRevert + 1)
    expect(typed.segments.at(-1)).toMatchObject({ author: 'user', attribution: null })

    const original = 'Use the old phrase here.\n'
    let plain = applyUserEdit(createDocumentState(original, original), { from: 0, to: 0, insert: 'x' })
    const count = plain.segments.length
    plain = acceptUserReplacement(plain, { from: 9, to: 19, insert: 'new wording' }, claude)
    expect(plain.segments).toHaveLength(count + 1)
    expect(plain.segments.at(-1)).toMatchObject({ author: 'user', attribution: claude })
  })

  it('undo of an attributed Revert extends its own segment and cancels', () => {
    const state = agentHunkState()
    const before = reviewFrame(state)
    const reverted = revertHunk(state, state.pendingHunks[0]!.id)
    expect(reverted.status).toBe('reverted')
    if (reverted.status !== 'reverted') return
    const count = reverted.state.segments.length
    const undone = restoreReviewFrame(reverted.state, before)
    expect(undone.segments).toHaveLength(count)
    const last = undone.segments.at(-1)!
    expect(last.beforeSnapshotId).toBe(last.afterSnapshotId)
    expect(last.attribution).toMatchObject(claude)
  })
})
