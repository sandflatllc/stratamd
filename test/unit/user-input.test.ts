import { expect, it } from 'vitest'
import { pendingUserInputs } from '../../src/core/user-input'
import type { EngineActivityView } from '../../src/shared/contracts'
const event = (id: string, kind: string, requestId: string, mode?: 'message'): EngineActivityView => ({ id, kind, tone: 'info', summary: '', turnId: 'turn', createdAt: '', payload: { requestId, ...(mode ? { responseMode: mode } : {}) } })
it('keeps async and blocking requests across turn completion and failed response, resolving only the named request', () => {
  const async = event('async', 'user-input.requested', 'native-async', 'message')
  const blocking = event('blocking', 'user-input.requested', 'native-blocking')
  const history = [async, blocking, event('failure', 'provider.user-input.respond.failed', 'native-async'), event('turn', 'turn.completed', 'native-async')]
  expect(pendingUserInputs(history)).toEqual([async, blocking])
  expect(pendingUserInputs([...history, event('resolved', 'user-input.resolved', 'native-async', 'message')])).toEqual([blocking])
  expect(pendingUserInputs([async, async])).toEqual([async])
})
