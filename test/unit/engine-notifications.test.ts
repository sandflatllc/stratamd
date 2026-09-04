import { describe, expect, it } from 'vitest'
import { decideAttention } from '../../src/main/engine/notifications'
import type { EngineThreadView } from '../../src/shared/contracts'

function thread(id: string, overrides: Partial<EngineThreadView> = {}): EngineThreadView {
  return {
    id, projectId: 'p1', title: `Thread ${id}`, model: 'gpt-5.6', providerInstanceId: 'codex', effort: null, access: 'full-access', status: 'running', updatedAt: '2026-09-03T12:00:00.000Z',
    unread: false, pendingApprovals: false, pendingUserInput: false, activeTurnId: 'turn-1', turnStartedAt: null, messages: [], activities: [], items: [], documents: [],
    pinnedAt: null, snoozedUntil: null, attention: 0, pendingWork: 0,
    ...overrides,
  }
}

describe('notifications (§5.2)', () => {
  it('a turn finishing, an item posting, or an approval arriving while the owner is elsewhere earns a badge', () => {
    const previous = [thread('t1'), thread('t2'), thread('t3')]
    const next = [thread('t1', { status: 'ready' }), thread('t2', { items: [{ id: 'i1', kind: 'question', status: 'open', review: 'unreviewed', text: 'Which?', quote: '', order: 0, threadId: 't2', turnId: null, messageId: 'm1', annotationId: null, hunkId: null, inferred: true }] }), thread('t3', { pendingApprovals: true })]
    const decision = decideAttention({ previous, next, activeThreadId: 't9', focused: true })
    expect(decision.badges).toEqual([
      { threadId: 't1', title: 'Thread t1', reason: 'turn-finished' },
      { threadId: 't2', title: 'Thread t2', reason: 'item-posted' },
      { threadId: 't3', title: 'Thread t3', reason: 'approval' },
    ])
    // The window is focused, so the badge is enough; no OS notification.
    expect(decision.notifications).toEqual([])
  })

  it('the thread in front of a focused owner never badges, but does once the window loses focus', () => {
    const previous = [thread('t1')]
    const next = [thread('t1', { status: 'ready' })]
    expect(decideAttention({ previous, next, activeThreadId: 't1', focused: true }).badges).toEqual([])
    const unfocused = decideAttention({ previous, next, activeThreadId: 't1', focused: false })
    expect(unfocused.badges).toHaveLength(1)
    expect(unfocused.notifications).toEqual([{ threadId: 't1', title: 'Thread t1', body: 'Turn finished' }])
  })

  it('nothing counts twice: a thread that stays finished, or keeps its approval, adds no badge', () => {
    const settled = [thread('t1', { status: 'ready', pendingApprovals: true })]
    expect(decideAttention({ previous: settled, next: settled, activeThreadId: null, focused: false }).badges).toEqual([])
    // A thread the client has not seen before cannot have "finished" while the owner watched.
    expect(decideAttention({ previous: [], next: [thread('t1', { status: 'ready' })], activeThreadId: null, focused: false }).badges).toEqual([])
  })
})
