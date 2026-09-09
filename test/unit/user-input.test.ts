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

it('retains old asynchronous requests beyond the activity cap and retires stale failures', async () => {
  const { retainQuestionActivities } = await import('../../src/core/user-input')
  const request = event('question', 'user-input.requested', 'pending', 'message')
  const activities = [request, ...Array.from({ length: 700 }, (_, index) => event(`event-${index}`, 'tool.completed', 'other'))]
  expect(pendingUserInputs(retainQuestionActivities(activities))).toEqual([request])
  const retired = { ...event('stale', 'provider.user-input.respond.failed', 'pending'), payload: { requestId: 'pending', detail: 'Unknown pending user-input request pending' } }
  expect(pendingUserInputs(retainQuestionActivities([...activities, retired]))).toEqual([])
  expect(retainQuestionActivities([...activities, retired])).toHaveLength(500)
})
