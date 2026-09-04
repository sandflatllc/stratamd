import { describe, expect, it } from 'vitest'
import { deriveItems, itemProgress, turnItems } from '../../src/core/items'
import type { AnnotationView, AttachmentView, HunkView } from '../../src/shared/contracts'

const author = { id: 'thread-1', name: 'Reviewer', color: 'grape' as const }
const base: AnnotationView = {
  id: 'q', seq: 2, kind: 'question', status: 'open', author, quote: 'Later', text: 'Why?', line: 3, from: 20, to: 25,
  replies: [], replySeqs: [], review: 'unreviewed', source: { threadId: 'thread-1', turnId: 'turn-1', messageId: 'message-1' },
}

describe('items', () => {
  it('derives one decision-first checklist from annotations and hunks', () => {
    const decision: AnnotationView = { ...base, id: 'd', seq: 3, kind: 'decision', text: 'Choose', decision: { options: ['A', 'B'], answers: [] } }
    const suggestion: AnnotationView = { ...base, id: 's', seq: 4, kind: 'suggestion', text: 'Better', from: 4 }
    const edit: HunkView = { id: 'h', oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, removed: ['old'], added: ['new'], status: 'pending', author, source: 'buffer', inline: true, saved: false, changedAt: 1, itemSource: base.source! }
    const items = deriveItems({ annotations: [base, suggestion, decision], hunks: [edit] })
    expect(items.map((item) => item.kind)).toEqual(['decision', 'question', 'suggestion', 'edit'])
    expect(turnItems(items, 'thread-1', 'turn-1')).toHaveLength(4)
    expect(itemProgress(items)).toEqual({ done: 0, total: 4 })
  })

  it('keeps an inline reply Drafted until the source attachment acknowledges its sequence', () => {
    const replied: AnnotationView = { ...base, replies: [{ id: 'r', author: 'user', text: 'Because' }], replySeqs: [8] }
    const attachment = (cursor: number): AttachmentView => ({ agent: author, attachedAt: 1, state: 'waiting', queuedDeliveries: [], queuedSendCount: 0, lastCallAt: null, cursor })
    expect(deriveItems({ annotations: [replied], attachments: [attachment(7)] })[0]!.status).toBe('drafted')
    expect(deriveItems({ annotations: [replied], attachments: [attachment(8)] })[0]!.status).toBe('done')
  })

  it('projects Reviewed and Revisit without storing a second item record', () => {
    expect(Object.fromEntries(deriveItems({ annotations: [{ ...base, review: 'reviewed' }, { ...base, id: 'changed', review: 'revisit' }] }).map((item) => [item.id, item.review]))).toEqual({ q: 'reviewed', changed: 'revisit' })
  })
})
