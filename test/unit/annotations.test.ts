import { describe, expect, it } from 'vitest'
import {
  acceptAllSuggestions,
  acceptSuggestion,
  answerDecision,
  annotationDeliverySlice,
  annotationStepChanges,
  redoAnnotationStep,
  undoAnnotationStep,
  annotationsAfter,
  AnnotationAnchorError,
  clearResolvedAnnotations,
  createAnnotation,
  createAnnotationLog,
  eventsAfter,
  locateQuote,
  mapAnnotationsThroughEdit,
  nearestQuoteStart,
  relocateAnnotation,
  rejectSuggestion,
  rejectAllSuggestions,
  recordHunkVerdict,
  replyToAnnotation,
  reopenDecision,
  requoteAnnotation,
  resolveAnnotation,
  verdictQuote,
} from '../../src/core/annotations'

describe('annotation log', () => {
  it('creates quote, heading, and document decisions with validated choices', () => {
    const document = '# Plan\n\nChoose this path.\n'
    const quote = createAnnotation(createAnnotationLog(), document, {
      id: 'dq', kind: 'decision', author: 'agent', agent: 'ag_1', quote: 'Choose this path.', text: 'Which path?', options: ['Fast', 'Safe'], anchorKind: 'quote',
    })
    expect(quote.annotation).toMatchObject({ kind: 'decision', status: 'open', anchor: { kind: 'quote' }, decision: { options: ['Fast', 'Safe'], answers: [] } })
    const heading = createAnnotation(quote.log, document, {
      id: 'dh', kind: 'decision', author: 'user', quote: '# Plan', text: 'Ship it?', options: ['Yes', 'No'], anchorKind: 'heading',
    })
    expect(heading.annotation).toMatchObject({ anchor: { kind: 'heading' }, line: 1 })
    const whole = createAnnotation(heading.log, document, {
      id: 'dd', kind: 'decision', author: 'user', quote: '', text: 'Overall?', options: ['Approve', 'Revise'], anchorKind: 'document',
    })
    expect(whole.annotation).toMatchObject({ quote: '', line: 1, anchor: { kind: 'document', start: 0, end: 0 } })
    expect(() => createAnnotation(createAnnotationLog(), document, { id: 'few', kind: 'decision', author: 'user', quote: '', text: 'x', options: ['one'], anchorKind: 'document' })).toThrow('at least two')
    expect(() => createAnnotation(createAnnotationLog(), document, { id: 'dup', kind: 'decision', author: 'user', quote: '', text: 'x', options: ['same', 'same'], anchorKind: 'document' })).toThrow('distinct')
    expect(() => createAnnotation(createAnnotationLog(), document, { id: 'blank', kind: 'decision', author: 'user', quote: '', text: '  ', options: ['a', 'b'], anchorKind: 'document' })).toThrow('prompt')
    expect(() => createAnnotation(createAnnotationLog(), document, { id: 'bad-heading', kind: 'decision', author: 'user', quote: 'Plan', text: 'x', options: ['a', 'b'], anchorKind: 'heading' })).toThrow('complete ATX heading')
    expect(() => createAnnotation(createAnnotationLog(), '## Setup and installation\n', { id: 'partial-heading', kind: 'decision', author: 'user', quote: '## Setup', text: 'x', options: ['a', 'b'], anchorKind: 'heading' })).toThrow('complete heading line')
    expect(createAnnotation(createAnnotationLog(), '## Setup and installation\n', { id: 'full-heading', kind: 'decision', author: 'user', quote: '## Setup and installation', text: 'x', options: ['a', 'b'], anchorKind: 'heading' }).annotation.anchor.start).toBe(0)
  })

  it('records owner answers, preserves them across reopen, and delivers structured answer events', () => {
    const created = createAnnotation(createAnnotationLog(), 'Body', {
      id: 'd1', kind: 'decision', author: 'agent', agent: 'ag_1', quote: '', text: 'Which?', options: ['A', 'B'], anchorKind: 'document',
    })
    const answered = answerDecision(created.log, 'd1', { option: 'B', answeredAt: 100 })
    expect(answered.event).toMatchObject({ seq: 2, type: 'answered', author: 'user' })
    expect(answered.annotation).toMatchObject({ status: 'resolved', decision: { answers: [{ seq: 2, option: 'B', author: 'user', answeredAt: 100 }] } })
    const reopened = reopenDecision(answered.log, 'd1')
    expect(reopened.event).toMatchObject({ seq: 3, type: 'reopened' })
    expect(reopened.annotation.decision?.answers).toHaveLength(1)
    const other = answerDecision(reopened.log, 'd1', { option: null, other: 'A little of both', answeredAt: 200 })
    expect(other.annotation.decision?.answers).toHaveLength(2)
    expect(annotationDeliverySlice(other.log, 1, 'ag_2')).toMatchObject({
      answers: [
        { annotation: 'd1', seq: 2, option: 'B', parent: { text: 'Which?', options: ['A', 'B'], anchor: 'document' } },
        { annotation: 'd1', seq: 4, option: null, other: 'A little of both' },
      ],
      resolved: [{ id: 'd1', seq: 3, kind: 'decision', resolution: 'reopened' }],
    })
    expect(() => answerDecision(other.log, 'd1', { option: 'A', answeredAt: 300 })).toThrow('reopened')
    expect(() => resolveAnnotation(reopened.log, 'd1')).toThrow('Answer the decision')

    const wholeHistory = annotationDeliverySlice(answered.log, 0, 'ag_2')
    expect(wholeHistory.annotations).toMatchObject([
      { id: 'd1', seq: 1, decision: { answers: [{ seq: 2, option: 'B' }] } },
    ])
    expect(wholeHistory.answers).toEqual([])

    const withoutAnswer = annotationDeliverySlice(answered.log, 0, 'ag_2', new Set([2]))
    expect(withoutAnswer.annotations).toMatchObject([
      { id: 'd1', status: 'open', decision: { answers: [] } },
    ])
    expect(withoutAnswer.answers).toEqual([])
  })

  it('allows an orphaned decision to be answered', () => {
    const created = createAnnotation(createAnnotationLog(), 'Choose this.', {
      id: 'd1', kind: 'decision', author: 'agent', agent: 'ag_1', quote: 'Choose this.', text: 'Which?', options: ['A', 'B'], anchorKind: 'quote',
    })
    const orphaned = relocateAnnotation(created.log, 'd1', 'The quote is gone.').log
    expect(orphaned.annotations.d1?.status).toBe('orphaned')
    expect(answerDecision(orphaned, 'd1', { option: 'A', answeredAt: 100 }).annotation.status).toBe('resolved')
  })
  it('assigns one monotonic sequence to every create, reply, and resolve event', () => {
    const document = 'A useful sentence.\n\nAnother paragraph.'
    const created = createAnnotation(createAnnotationLog(), document, {
      id: 'a1',
      kind: 'question',
      author: 'user',
      quote: 'useful sentence',
      text: 'Can this be clearer?',
    })
    const replied = replyToAnnotation(created.log, 'a1', {
      id: 'r1',
      author: 'agent',
      agent: 'ag_1',
      text: 'Yes.',
    })
    const resolved = resolveAnnotation(replied.log, 'a1')

    expect(resolved.log.events.map((event) => [event.seq, event.type])).toEqual([
      [1, 'created'],
      [2, 'replied'],
      [3, 'resolved'],
    ])
    expect(resolved.annotation.replies[0]).toMatchObject({ id: 'r1', seq: 2 })
    expect(eventsAfter(resolved.log, 1).map((event) => event.seq)).toEqual([2, 3])
  })

  it('preserves structured table context through storage and delivery', () => {
    const document = '| Name | Verdict |\n| --- | --- |\n| Alpha | Unprotected |'
    const context = {
      kind: 'table-cell' as const,
      heading: 'Island review',
      columns: ['Name', 'Verdict'],
      column: { index: 1, label: 'Verdict' },
    }
    const created = createAnnotation(createAnnotationLog(), document, {
      id: 'a_table', kind: 'question', author: 'user', quote: '| Alpha | Unprotected |', text: 'What protects this?', context,
    })
    expect(created.annotation.context).toEqual(context)
    expect(annotationDeliverySlice(created.log, 0, 'ag_1').annotations[0]?.context).toEqual(context)
  })

  it('preserves structured screenshot-pin context through storage and delivery', () => {
    const quote = '| 2 | 80.0 | 30.0 | 68:123 | Tight spacing |'
    const context = {
      kind: 'screenshot-pin' as const,
      component: 'AnnotatedScreenshot' as const,
      componentLine: 12,
      image: './review.png',
      pin: 2,
    }
    const created = createAnnotation(createAnnotationLog(), quote, {
      id: 'a_pin', kind: 'question', author: 'user', quote, text: 'Is this too tight?', context,
    })
    expect(created.annotation.context).toEqual(context)
    expect(annotationDeliverySlice(created.log, 0, 'ag_1').annotations[0]?.context).toEqual(context)
  })

  it('requires an exact, unambiguous quote and uses up to 32 context characters', () => {
    const document = 'first repeated value then second repeated value'
    expect(() => locateQuote(document, 'repeated')).toThrowError(AnnotationAnchorError)

    const located = locateQuote(document, 'repeated', 'then second ')
    expect(located.start).toBe(document.lastIndexOf('repeated'))
    expect(located.prefix.length).toBeLessThanOrEqual(32)
    expect(located.suffix.length).toBeLessThanOrEqual(32)
  })

  it('orphans without guessing, emits that event once, and emits one reattach event later', () => {
    const created = createAnnotation(createAnnotationLog(), 'Keep this exact phrase.', {
      id: 'a1',
      kind: 'comment',
      author: 'agent',
      agent: 'ag_1',
      quote: 'exact phrase',
      text: 'Worth keeping.',
    })
    const orphaned = relocateAnnotation(created.log, 'a1', 'The words are gone.')
    const stillOrphaned = relocateAnnotation(orphaned.log, 'a1', 'Still gone.')
    const reattached = relocateAnnotation(stillOrphaned.log, 'a1', 'Now: exact phrase.')

    expect(stillOrphaned.log).toBe(orphaned.log)
    expect(reattached.annotation.status).toBe('open')
    expect(reattached.log.events.map((event) => event.type)).toEqual([
      'created',
      'orphaned',
      'reattached',
    ])
  })

  it('accepts a suggestion into shadow only and emits accepted for its agent author', () => {
    const disk = 'The old wording stays on disk.'
    const created = createAnnotation(createAnnotationLog(), disk, {
      id: 'a1',
      kind: 'suggestion',
      author: 'agent',
      agent: 'ag_author',
      quote: 'old wording',
      text: 'new wording',
    })
    const accepted = acceptSuggestion(created.log, disk, 'a1')

    expect(accepted.shadow).toBe('The new wording stays on disk.')
    expect(disk).toBe('The old wording stays on disk.')
    expect(accepted.userChange).toEqual({
      start: 4,
      end: 15,
      removed: 'old wording',
      added: 'new wording',
    })
    expect(accepted.event).toMatchObject({ type: 'accepted', annotationId: 'a1' })
    expect(accepted.annotation).toMatchObject({ status: 'resolved', resolution: 'accepted' })
  })

  it('does not accept an orphaned suggestion', () => {
    const created = createAnnotation(createAnnotationLog(), 'Old text.', {
      id: 'a1',
      kind: 'suggestion',
      author: 'agent',
      agent: 'ag_1',
      quote: 'Old',
      text: 'New',
    })
    const orphaned = relocateAnnotation(created.log, 'a1', 'Missing.')
    expect(() => acceptSuggestion(orphaned.log, 'Missing.', 'a1')).toThrow(
      'An orphaned suggestion cannot be accepted',
    )
  })

  it('maps an anchor through editor transactions while preserving its exact quote', () => {
    const created = createAnnotation(createAnnotationLog(), 'Before target after', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'target', text: 'note',
    })
    const shifted = mapAnnotationsThroughEdit(created.log, {
      start: 0, deleteCount: 0, insertText: 'New ',
    })
    expect(shifted.annotations.a1?.anchor).toMatchObject({ quote: 'target', start: 11, end: 17 })
    expect(created.log.annotations.a1?.anchor.start).toBe(7)
  })

  it('accepts an agent’s suggestions in document order and skips overlap', () => {
    const document = 'abcdef'
    const first = createAnnotation(createAnnotationLog(), document, {
      id: 'wide', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'bcd', text: 'B', start: 1,
    })
    const second = createAnnotation(first.log, document, {
      id: 'inside', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'cd', text: 'C', start: 2,
    })
    const third = createAnnotation(second.log, document, {
      id: 'later', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'ef', text: 'E', start: 4,
    })

    const result = acceptAllSuggestions(third.log, document, 'ag_1')
    expect(result.shadow).toBe('aBE')
    expect(result.accepted).toEqual(['wide', 'later'])
    expect(result.skipped).toEqual(['inside'])
    expect(result.changes).toHaveLength(2)
    expect(result.log.annotations.later?.anchor.start).toBe(2)
  })

  it('rejects every open suggestion for one agent in document order', () => {
    const document = 'one two three'
    const first = createAnnotation(createAnnotationLog(), document, {
      id: 'second', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'three', text: '3', start: 8,
    })
    const second = createAnnotation(first.log, document, {
      id: 'first', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'one', text: '1', start: 0,
    })
    const other = createAnnotation(second.log, document, {
      id: 'other', kind: 'suggestion', author: 'agent', agent: 'ag_2',
      quote: 'two', text: '2', start: 4,
    })

    const result = rejectAllSuggestions(other.log, 'ag_1')
    expect(result.rejected).toEqual(['first', 'second'])
    expect(result.log.annotations.first?.resolution).toBe('rejected')
    expect(result.log.annotations.second?.resolution).toBe('rejected')
    expect(result.log.annotations.other?.status).toBe('open')
  })

  it('clears resolved records and their events without resetting sequence numbers', () => {
    const created = createAnnotation(createAnnotationLog(), 'Keep this.', {
      id: 'a1', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'Keep', text: 'Drop',
    })
    const rejected = rejectSuggestion(created.log, 'a1')
    const cleared = clearResolvedAnnotations(rejected.log)

    expect(cleared.annotations).toEqual({})
    expect(cleared.events).toEqual([])
    expect(cleared.nextSeq).toBe(3)
    expect(annotationDeliverySlice(cleared, 0, 'ag_1')).toEqual({
      cursor: 2,
      annotations: [], answers: [],
      replies: [],
      resolved: [],
      edits: [],
      excluded: 0,
    })
  })

  it('delivers accept/reject events only to the suggestion author', () => {
    const created = createAnnotation(createAnnotationLog(), 'Old.', {
      id: 'a1', kind: 'suggestion', author: 'agent', agent: 'ag_author',
      quote: 'Old', text: 'New',
    })
    const accepted = acceptSuggestion(created.log, 'Old.', 'a1')
    expect(annotationDeliverySlice(accepted.log, 1, 'ag_author').resolved).toEqual([
      { id: 'a1', seq: 2, kind: 'suggestion', resolution: 'accepted' },
    ])
    expect(annotationDeliverySlice(accepted.log, 1, 'ag_other').resolved).toEqual([])
    expect(annotationDeliverySlice(created.log, 0, 'ag_other').annotations[0]).toHaveProperty('anchor', 'quote')
  })

  it('delivers a reply to an older annotation alone, without replaying its thread', () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'hello', text: 'first comment',
    })
    const answered = replyToAnnotation(created.log, 'a1', { id: 'r1', author: 'agent', agent: 'ag_1', text: 'agent answer' })
    const followed = replyToAnnotation(answered.log, 'a1', { id: 'r2', author: 'user', text: 'user follow-up' })

    const slice = annotationDeliverySlice(followed.log, 1, 'ag_1')
    expect(slice.annotations).toEqual([])
    expect(slice.replies).toEqual([
      {
        id: 'r2', seq: 3, annotation: 'a1', author: 'user', agent: null, text: 'user follow-up',
        parent: { kind: 'comment', quote: 'hello', line: 1, text: 'first comment' },
      },
    ])
    expect(slice.cursor).toBe(3)
  })

  it('never returns an agent’s own events to it but still advances its cursor past them', () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'hello', text: 'first comment',
    })
    const own = createAnnotation(created.log, 'hello world', {
      id: 'a2', kind: 'question', author: 'agent', agent: 'ag_1', quote: 'world', text: 'Which world?',
    })
    const replied = replyToAnnotation(own.log, 'a1', { id: 'r1', author: 'agent', agent: 'ag_1', text: 'agent answer' })
    const resolved = resolveAnnotation(replied.log, 'a2', 'agent', 'ag_1')

    const self = annotationDeliverySlice(resolved.log, 1, 'ag_1')
    expect(self).toEqual({ cursor: 4, annotations: [], replies: [], answers: [], resolved: [], edits: [], excluded: 0 })

    const peer = annotationDeliverySlice(resolved.log, 1, 'ag_2')
    expect(peer.annotations.map((annotation) => annotation.id)).toEqual(['a2'])
    expect(peer.replies.map((reply) => reply.id)).toEqual(['r1'])
    expect(peer.resolved).toEqual([{ id: 'a2', seq: 4, kind: 'question', resolution: 'resolved' }])
  })

  it('folds a reply into its annotation when both fall in the same delivery range', () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'hello', text: 'first comment',
    })
    const replied = replyToAnnotation(created.log, 'a1', { id: 'r1', author: 'user', text: 'and more' })
    const slice = annotationDeliverySlice(replied.log, 0, 'ag_1')
    expect(slice.annotations).toHaveLength(1)
    expect(slice.annotations[0]?.replies.map((reply) => reply.id)).toEqual(['r1'])
    expect(slice.replies).toEqual([])
  })

  it('rejects a suggestion without changing document text and reports later annotations', () => {
    const created = createAnnotation(createAnnotationLog(), 'Keep this.', {
      id: 'a1', kind: 'suggestion', author: 'agent', agent: 'ag_1',
      quote: 'Keep', text: 'Drop',
    })
    const rejected = rejectSuggestion(created.log, 'a1')
    expect(rejected.annotation).toMatchObject({ status: 'resolved', resolution: 'rejected' })
    expect(rejected.event.type).toBe('rejected')
    expect(annotationsAfter(rejected.log, 0)).toEqual([rejected.annotation])
  })

  it('enforces quote, block, identity, and UTF-8 text constraints', () => {
    expect(() => locateQuote('text', 'missing')).toThrow('does not occur')
    expect(() => createAnnotation(createAnnotationLog(), 'one\n\ntwo', {
      id: 'a1', kind: 'suggestion', author: 'agent', quote: 'one\n\ntwo', text: 'three',
    })).toThrow('one top-level block')
    expect(() => createAnnotation(createAnnotationLog(), 'text', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'text', text: 'x'.repeat(65_537),
    })).toThrow('64 KB')
    const created = createAnnotation(createAnnotationLog(), 'text', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'text', text: 'ok',
    })
    expect(() => createAnnotation(created.log, 'text', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'text', text: 'again',
    })).toThrow('already exists')
  })
})

describe('nearest quote occurrence', () => {
  it('picks the occurrence closest to the stale offset', () => {
    const document = 'alpha target beta target gamma'
    expect(nearestQuoteStart(document, 'target', 8)).toBe(6)
    expect(nearestQuoteStart(document, 'target', 16)).toBe(18)
  })

  it('returns null when the quote no longer occurs', () => {
    expect(nearestQuoteStart('alpha beta', 'target', 0)).toBeNull()
  })
})

describe('requoting an annotation', () => {
  const document = 'First sentence here.\n\nSecond paragraph with more words.\n\nThird one.'
  const seeded = () => createAnnotation(createAnnotationLog(), document, {
    id: 'c1',
    kind: 'comment',
    author: 'agent',
    agent: 'ag_1',
    quote: 'sentence',
    text: 'Tighten this.',
  }).log

  it('moves the anchor and quote, updates the line, and emits one user event', () => {
    const start = document.indexOf('Second paragraph')
    const result = requoteAnnotation(seeded(), document, 'c1', { quote: 'Second paragraph', start })
    expect(result.annotation.quote).toBe('Second paragraph')
    expect(result.annotation.anchor).toMatchObject({ start, end: start + 'Second paragraph'.length, quote: 'Second paragraph' })
    expect(result.annotation.line).toBe(3)
    expect(result.annotation.text).toBe('Tighten this.')
    expect(result.annotation.author).toBe('agent')
    expect(result.event).toMatchObject({ type: 'requoted', author: 'user', annotationId: 'c1' })
    expect(result.log.nextSeq).toBe(3)
  })

  it('rejects a quote that is not at the supplied position', () => {
    expect(() => requoteAnnotation(seeded(), document, 'c1', { quote: 'Second paragraph', start: 0 })).toThrow(AnnotationAnchorError)
  })

  it('keeps a suggestion inside one top-level block', () => {
    const log = createAnnotation(createAnnotationLog(), document, {
      id: 's1',
      kind: 'suggestion',
      author: 'agent',
      agent: 'ag_1',
      quote: 'First sentence',
      text: 'Opening sentence',
    }).log
    const quote = 'here.\n\nSecond'
    expect(() => requoteAnnotation(log, document, 's1', { quote, start: document.indexOf(quote) })).toThrow(AnnotationAnchorError)
  })

  it('is a no-op when the range does not change', () => {
    const log = seeded()
    const result = requoteAnnotation(log, document, 'c1', { quote: 'sentence', start: document.indexOf('sentence') })
    expect(result.log).toBe(log)
  })

  it('refuses to move a resolved thread', () => {
    const log = resolveAnnotation(seeded(), 'c1').log
    expect(() => requoteAnnotation(log, document, 'c1', { quote: 'Third', start: document.indexOf('Third') })).toThrow(/resolved/)
  })

  it('delivers the annotation again with its new quote and a requoted line, including to its own author', () => {
    const created = seeded()
    const cursor = created.nextSeq - 1
    const moved = requoteAnnotation(created, document, 'c1', { quote: 'Third one', start: document.indexOf('Third one') }).log
    const slice = annotationDeliverySlice(moved, cursor, 'ag_1')
    expect(slice.annotations.map((annotation) => [annotation.id, annotation.seq, annotation.deliveredAt, annotation.quote])).toEqual([['c1', 1, 2, 'Third one']])
    expect(slice.resolved).toEqual([{ id: 'c1', seq: 2, kind: 'comment', resolution: 'requoted' }])
  })

  it('reattaches an orphaned annotation when the user requotes it', () => {
    const orphaned = relocateAnnotation(seeded(), 'c1', 'Nothing matches anymore.').log
    expect(orphaned.annotations.c1!.status).toBe('orphaned')
    const result = requoteAnnotation(orphaned, 'Nothing matches anymore.', 'c1', { quote: 'matches', start: 8 })
    expect(result.annotation.status).toBe('open')
    expect(result.event.type).toBe('requoted')
  })
})

describe('annotation step inverses', () => {
  const document = 'Use the old wording here. Later note.\n'
  function logWithSuggestion() {
    return createAnnotation(createAnnotationLog(), document, {
      id: 's1', kind: 'suggestion', author: 'agent', agent: 'ag_1', quote: 'old wording', text: 'new wording',
    }).log
  }

  it('names only the records and events an Accept changed', () => {
    const before = logWithSuggestion()
    const after = acceptSuggestion(before, document, 's1').log
    const changes = annotationStepChanges(before, after)

    expect(Object.keys(changes.before)).toEqual(['s1'])
    expect(changes.before.s1?.status).toBe('open')
    expect(changes.after.s1?.status).toBe('resolved')
    expect(changes.events.map((event) => event.type)).toEqual(['accepted'])
  })

  it('undo reopens the suggestion and drops its event while a later comment and nextSeq stay', () => {
    const before = logWithSuggestion()
    const accepted = acceptSuggestion(before, document, 's1').log
    const changes = annotationStepChanges(before, accepted)
    const withComment = createAnnotation(accepted, document, {
      id: 'c1', kind: 'comment', author: 'user', quote: 'Later note', text: 'Keep this.',
    }).log

    const undone = undoAnnotationStep(withComment, changes)
    expect(undone.annotations.s1?.status).toBe('open')
    expect(undone.annotations.c1?.text).toBe('Keep this.')
    expect(undone.events.map((event) => event.type)).toEqual(['created', 'created'])
    expect(undone.nextSeq).toBe(withComment.nextSeq)

    const redone = redoAnnotationStep(undone, changes)
    expect(redone.annotations.s1?.status).toBe('resolved')
    expect(redone.annotations.c1?.text).toBe('Keep this.')
    expect(redone.events.map((event) => event.type)).toEqual(['created', 'accepted', 'created'])
    expect(redone.nextSeq).toBe(withComment.nextSeq)
  })

  it('undo of a requote puts the previous quote back and removes the requoted event', () => {
    const before = logWithSuggestion()
    const requoted = requoteAnnotation(before, document, 's1', { quote: 'wording', start: document.indexOf('wording') }).log
    const changes = annotationStepChanges(before, requoted)
    const undone = undoAnnotationStep(requoted, changes)

    expect(undone.annotations.s1?.quote).toBe('old wording')
    expect(undone.events.some((event) => event.type === 'requoted')).toBe(false)
  })
})

describe('hunk verdicts', () => {
  it('delivers a verdict only to its target and advances every cursor past it', () => {
    let log = recordHunkVerdict(createAnnotationLog(), 'hunk-reverted', 'ag_author', 'the removed line')
    log = recordHunkVerdict(log, 'hunk-kept', 'ag_author', 'the kept line')

    const author = annotationDeliverySlice(log, 0, 'ag_author')
    expect(author.edits).toEqual([
      { seq: 1, verdict: 'reverted', quote: 'the removed line' },
      { seq: 2, verdict: 'kept', quote: 'the kept line' },
    ])
    expect(author.cursor).toBe(2)

    const other = annotationDeliverySlice(log, 0, 'ag_other')
    expect(other.edits).toEqual([])
    expect(other.cursor).toBe(2)
  })

  it('undoing the recording step retracts an undelivered verdict', () => {
    const before = createAnnotationLog()
    const after = recordHunkVerdict(before, 'hunk-kept', 'ag_author', 'kept text')
    const changes = annotationStepChanges(before, after)
    const undone = undoAnnotationStep(after, changes)
    expect(undone.events).toEqual([])
    expect(undone.nextSeq).toBe(after.nextSeq)
    const redone = redoAnnotationStep(undone, changes)
    expect(redone.events).toHaveLength(1)
  })

  it('an excluded creation with a selected later reply delivers the reply alone, keyed by id', () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'hello', text: 'first comment',
    })
    const replied = replyToAnnotation(created.log, 'a1', { id: 'r1', author: 'user', agent: null, text: 'follow-up' })

    const slice = annotationDeliverySlice(replied.log, 0, 'ag_1', new Set([created.event.seq]))
    expect(slice.annotations).toEqual([])
    expect(slice.replies).toEqual([
      {
        id: 'r1', seq: 2, annotation: 'a1', author: 'user', agent: null, text: 'follow-up',
        parent: { kind: 'comment', quote: 'hello', line: 1, text: 'first comment' },
      },
    ])
    expect(slice.excluded).toBe(1)
    expect(slice.cursor).toBe(2)
  })

  it('skips a settled creation without marking it excluded and delivers a later reply alone', () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'comment', author: 'user', quote: 'hello', text: 'quick comment',
    })
    const replied = replyToAnnotation(created.log, 'a1', {
      id: 'r1', author: 'user', agent: null, text: 'later reply',
    })

    const slice = annotationDeliverySlice(
      replied.log,
      0,
      'ag_1',
      new Set(),
      new Set([created.event.seq]),
    )
    expect(slice.annotations).toEqual([])
    expect(slice.replies).toEqual([
      {
        id: 'r1', seq: 2, annotation: 'a1', author: 'user', agent: null, text: 'later reply',
        parent: { kind: 'comment', quote: 'hello', line: 1, text: 'quick comment' },
      },
    ])
    expect(slice.excluded).toBe(0)
  })

  it("exclusions never count the recipient's own events as left out", () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'question', author: 'agent', agent: 'ag_1', quote: 'hello', text: 'own question',
    })
    const slice = annotationDeliverySlice(created.log, 0, 'ag_1', new Set([created.event.seq]))
    expect(slice.excluded).toBe(0)
  })

  it('verdict quotes take the first inserted line, the removed line for pure deletions, capped by code point', () => {
    expect(verdictQuote('old', 'new first line\nsecond')).toBe('new first line')
    expect(verdictQuote('removed only\nmore', '')).toBe('removed only')
    const long = '💡'.repeat(200)
    const quote = verdictQuote('', long)
    expect([...quote]).toHaveLength(120)
    expect(quote.endsWith('💡')).toBe(true)
  })
})

describe('quote failure detail', () => {
  const document = 'Intro line here.\n\nThe quick brown fox jumps over the lazy dog near the river bank today.\n\nAnother quick brown fox appears later in the text of this paragraph.\n'

  it('reports an ambiguous quote with word-boundary context usable as --preceded-by and --followed-by', async () => {
    const { describeQuoteFailure } = await import('../../src/core/annotations')
    let error: unknown
    try {
      locateQuote(document, 'quick brown fox')
    } catch (caught) {
      error = caught
    }
    const detail = describeQuoteFailure(document, 'quick brown fox', error as AnnotationAnchorError)
    expect(detail.reason).toBe('ambiguous')
    expect(detail.total).toBe(2)
    expect(detail.candidates).toEqual([
      { line: 3, before: 'The ', quote: 'quick brown fox', after: ' jumps over the lazy dog near the river ' },
      { line: 5, before: 'Another ', quote: 'quick brown fox', after: ' appears later in the text of this ' },
    ])
    expect(detail.hint).toContain('--preceded-by')
    for (const candidate of detail.candidates) {
      expect(locateQuote(document, candidate.quote, candidate.before, candidate.after).start).toBe(
        document.indexOf(candidate.before + candidate.quote) + candidate.before.length,
      )
    }
  })

  it('reports a whitespace-only mismatch with the exact buffer text', async () => {
    const { describeQuoteFailure } = await import('../../src/core/annotations')
    const quote = 'lazy dog  near\nthe river'
    let error: unknown
    try {
      locateQuote(document, quote)
    } catch (caught) {
      error = caught
    }
    const detail = describeQuoteFailure(document, quote, error as AnnotationAnchorError)
    expect(detail).toMatchObject({ reason: 'whitespace', total: 1, exact: 'lazy dog near the river' })
    expect(detail.candidates[0]).toMatchObject({ line: 3, quote: 'lazy dog near the river' })
    expect(locateQuote(document, detail.exact!).start).toBe(document.indexOf('lazy dog near'))
  })

  it('reports a missing quote with the closest lines and a multi-block suggestion with its block', async () => {
    const { describeQuoteFailure } = await import('../../src/core/annotations')
    let missing: unknown
    try {
      locateQuote(document, 'purple fox')
    } catch (caught) {
      missing = caught
    }
    const detail = describeQuoteFailure(document, 'purple fox', missing as AnnotationAnchorError, 'match')
    expect(detail.reason).toBe('missing')
    expect(detail.message).toBe('The match does not occur in the current buffer')
    expect(detail.candidates.map((candidate) => candidate.line)).toEqual([3, 5])
    expect(detail.candidates[0]?.quote).toContain('quick brown fox')

    let block: unknown
    try {
      createAnnotation(createAnnotationLog(), document, {
        id: 's1', kind: 'suggestion', author: 'agent', quote: 'today.\n\nAnother', text: 'x',
      })
    } catch (caught) {
      block = caught
    }
    const blockDetail = describeQuoteFailure(document, 'today.\n\nAnother', block as AnnotationAnchorError)
    expect(blockDetail).toMatchObject({ reason: 'multi_block', total: 1 })
    expect(blockDetail.candidates[0]).toMatchObject({ line: 3, quote: 'today.\n\nAnother' })
  })
})

describe('anchorless edits', () => {
  it('locates an empty match by context, treats empty context as a document boundary, and appends', async () => {
    const { locateEdit } = await import('../../src/core/annotations')
    const document = 'alpha\n\nbeta\n'
    expect(locateEdit(document, { match: '', precededBy: 'alpha\n' })).toMatchObject({ start: 6, end: 6, quote: '' })
    expect(locateEdit(document, { match: '', followedBy: 'beta' })).toMatchObject({ start: 7, end: 7 })
    expect(locateEdit(document, { match: '', precededBy: '' })).toMatchObject({ start: 0, end: 0 })
    expect(locateEdit(document, { match: '', followedBy: '' })).toMatchObject({ start: document.length })
    expect(locateEdit('', { match: '', precededBy: '' })).toMatchObject({ start: 0, end: 0 })
    expect(locateEdit(document, { match: '', append: true })).toMatchObject({ start: document.length, end: document.length })
    expect(locateEdit('', { match: '', append: true })).toMatchObject({ start: 0 })
    expect(() => locateEdit(document, { match: '' })).toThrow('--append')
    expect(() => locateEdit(document, { match: 'x', append: true })).toThrow('--append takes no --match')
    expect(() => locateEdit('a a a', { match: '', precededBy: 'a' })).toThrow('more than once')
  })

  it('pins a non-empty quote to the document start with an empty precededBy', () => {
    const document = 'same\nsame\n'
    expect(locateQuote(document, 'same', '').start).toBe(0)
    expect(locateQuote(document, 'same\n', undefined, '').start).toBe(5)
    expect(() => locateQuote(document, 'same')).toThrow('ambiguous')
    expect(() => createAnnotation(createAnnotationLog(), document, {
      id: 'a1', kind: 'comment', author: 'agent', quote: '', text: 'x', precededBy: '',
    })).toThrow('cannot be empty')
  })
})

describe('names and reply context in deliveries', () => {
  it('keeps the attachment name and label on the record and delivers them', async () => {
    const { toDeliveredAnnotation, withAttachmentNames } = await import('../../src/core/annotations')
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'comment', author: 'agent', agent: 'ag_1', name: 'GPT', label: 'Tone', quote: 'hello', text: 'hi',
    })
    expect(toDeliveredAnnotation(created.annotation)).toMatchObject({ name: 'GPT', label: 'Tone' })
    expect(toDeliveredAnnotation(created.annotation)).toHaveProperty('anchor', 'quote')

    const unnamed = createAnnotation(created.log, 'hello world', {
      id: 'a2', kind: 'comment', author: 'agent', agent: 'ag_2', quote: 'world', text: 'w',
    })
    const named = withAttachmentNames(
      [toDeliveredAnnotation(created.annotation), toDeliveredAnnotation(unnamed.annotation)],
      (agent) => (agent === 'ag_2' ? 'Claude' : undefined),
    )
    expect(named.map((annotation) => annotation.name)).toEqual(['GPT', 'Claude'])
    const user = createAnnotation(createAnnotationLog(), 'hello', { id: 'u', kind: 'comment', author: 'user', name: 'nope', quote: 'hello', text: '' })
    expect(user.annotation).not.toHaveProperty('name')
  })

  it('delivers a lone reply with its parent thread and the replier name', () => {
    const created = createAnnotation(createAnnotationLog(), 'hello world', {
      id: 'a1', kind: 'question', author: 'user', quote: 'hello', text: 'Why hello?',
    })
    const replied = replyToAnnotation(created.log, 'a1', { id: 'r1', author: 'agent', agent: 'ag_2', name: 'GPT', text: 'Because.' })
    const slice = annotationDeliverySlice(replied.log, 1, 'ag_9')
    expect(slice.replies).toEqual([{
      id: 'r1', seq: 2, annotation: 'a1', author: 'agent', agent: 'ag_2', name: 'GPT', text: 'Because.',
      parent: { kind: 'question', quote: 'hello', line: 1, text: 'Why hello?' },
    }])
  })
})
