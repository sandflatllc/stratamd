import { describe, expect, it } from 'vitest'
import { attributeTurnWrite, firstDeliveryDocument } from '../../src/core/attribution'

describe('turn file attribution and first delivery', () => {
  it('sends nothing for an unchanged certain own write, its diff after a change, and full text without certainty', () => {
    const written = '# Plan\n\nAgent version.\n'
    expect(firstDeliveryDocument('t1', written, { threadId: 't1', content: written, certain: true })).toEqual({ kind: 'unchanged' })
    const changed = firstDeliveryDocument('t1', written.replace('Agent', 'Owner'), { threadId: 't1', content: written, certain: true })
    expect(changed).toMatchObject({ kind: 'diff', hunks: [{ removed: 'Agent version.\n', added: 'Owner version.\n' }] })
    expect(firstDeliveryDocument('t2', written, { threadId: 't1', content: written, certain: true })).toEqual({ kind: 'full', document: written })
    expect(firstDeliveryDocument('t1', written, { threadId: 't1', content: written, certain: false })).toEqual({ kind: 'full', document: written })
  })

  it('labels a shared-root write external when two threads run and makes both first deliveries full', () => {
    const attribution = attributeTurnWrite({ threadId: 't1', worktreePath: null, projectRoot: '/work', runningThreadIds: ['t1', 't2'], git: true })
    expect(attribution).toEqual({ kind: 'external' })
    for (const threadId of ['t1', 't2']) expect(firstDeliveryDocument(threadId, 'changed', null)).toEqual({ kind: 'full', document: 'changed' })
  })
})
