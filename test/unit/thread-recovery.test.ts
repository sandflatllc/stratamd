import { expect, it } from 'vitest'
import { reconcileThreadRecovery, type ThreadRecovery } from '../../src/shared/thread-recovery'
const pending: ThreadRecovery = { state: 'reconnecting', priorTurnId: 'old-turn' }
const thread = (status: string, activeTurnId: string | null, lastError: string | null = null) => ({ session: { status, activeTurnId, lastError }, latestTurn: null })
it('requires engine evidence before distinguishing original-turn resume, a new engine turn and an explicit continuation message', () => {
  expect(reconcileThreadRecovery(pending, thread('ready', null), true).state).toBe('waiting')
  expect(reconcileThreadRecovery(pending, thread('running', 'old-turn'), false).state).toBe('reconnecting')
  expect(reconcileThreadRecovery(pending, thread('running', 'old-turn'), true)).toMatchObject({ state: 'resumed', source: 'engine' })
  expect(reconcileThreadRecovery(pending, thread('running', 'new-turn'), true)).toMatchObject({ state: 'continued', source: 'engine' })
  expect(reconcileThreadRecovery({ ...pending, messageId: 'explicit' }, { ...thread('ready', null), messages: [{ id: 'explicit' }] }, true)).toMatchObject({ state: 'continued', source: 'message' })
})
it('reports failures and completed work without starting or inventing a continuation', () => {
  expect(reconcileThreadRecovery(pending, thread('error', null, 'Provider restart failed'), true)).toMatchObject({ state: 'failed', failure: 'Provider restart failed' })
  expect(reconcileThreadRecovery(pending, { ...thread('ready', null), latestTurn: { turnId: 'old-turn', state: 'completed' } }, true).state).toBe('completed')
})
