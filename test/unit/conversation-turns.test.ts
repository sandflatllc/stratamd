import { describe, expect, it } from 'vitest'
import { conversationTurns } from '../../src/core/conversation-turns'
import { deriveTurnFold, deriveWorkEntries, groupWorkRows, turnRows } from '../../src/core/work-log'
import type { EngineActivityView, EngineMessageView } from '../../src/shared/contracts'

const stamp = (second: number) => new Date(Date.UTC(2026, 8, 6, 12, 0, second)).toISOString()
const message = (id: string, role: EngineMessageView['role'], second: number, turnId: string | null = null): EngineMessageView => ({ id, role, turnId, createdAt: stamp(second), text: id, streaming: false, attachmentCount: 0 })
const activity = (id: string, second: number, turnId: string | null): EngineActivityView => ({ id, turnId, createdAt: stamp(second), kind: 'tool.completed', tone: 'tool', summary: id, payload: { itemType: 'command_execution', detail: 'ls', status: 'completed' } })

describe('conversation turn ordering', () => {
  it('keeps real unassigned user messages beside their answers without changing saved IDs', () => {
    const messages = [message('u1', 'user', 0), message('a1', 'assistant', 2, 't1'), message('u2', 'user', 3), message('a2', 'assistant', 5, 't2')]
    const turns = conversationTurns(messages, [activity('work1', 1, 't1'), activity('work2', 4, 't2')], null)
    expect(turns.map(turn => [turn.turnId, turn.messages.map(row => row.id)])).toEqual([['t1', ['u1', 'a1']], ['t2', ['u2', 'a2']]])
    expect(messages.filter(row => row.role === 'user').map(row => row.turnId)).toEqual([null, null])
  })

  it('keeps mid-turn steering between progress and the answer, including when work is folded', () => {
    const messages = [message('request', 'user', 0), message('progress', 'assistant', 1, 't1'), message('steering', 'user', 3), message('answer', 'assistant', 5, 't1')]
    const [turn] = conversationTurns(messages, [activity('before', 2, 't1'), activity('after', 4, 't1')], null)
    const groups = groupWorkRows(deriveWorkEntries(turn!.activities), [{ id: 't1', finished: true }], turn!.messages.map(row => ({ ...row, turnId: 't1' })))
    const fold = deriveTurnFold({ id: 't1', messages: turn!.messages, groups, running: false, latestTurn: null })
    const rows = turnRows(turn!.messages, groups)
    expect(rows.map(row => row.id)).toEqual(['request', 'progress', 't1:work:before', 'steering', 't1:work:after', 'answer'])
    expect(rows.filter(row => !fold?.hiddenIds.includes(row.id)).map(row => row.id)).toEqual(['request', 'steering', 'answer'])
  })

  it('keeps a trailing request after a completed turn and joins it to its new response', () => {
    const messages = [message('u1', 'user', 0), message('a1', 'assistant', 1, 't1'), message('u2', 'user', 2)]
    const pending = conversationTurns(messages, [], null)
    expect(pending.map(turn => turn.messages.map(row => row.id))).toEqual([['u1', 'a1'], ['u2']])
    expect(pending[1]?.turnId).toBeNull()
    expect(conversationTurns([...messages, message('a2', 'assistant', 3, 't2')], [], 't2').map(turn => turn.messages.map(row => row.id))).toEqual([['u1', 'a1'], ['u2', 'a2']])
    expect(conversationTurns(messages, [], 't1').map(turn => turn.messages.map(row => row.id))).toEqual([['u1', 'a1', 'u2']])
  })

  it('preserves chronology when a provider turn resumes after another turn', () => {
    const messages = [message('a1', 'assistant', 1, 't1'), message('a2', 'assistant', 2, 't2'), message('a3', 'assistant', 3, 't1')]
    const turns = conversationTurns(messages, [], null)
    expect(turns.flatMap(turn => turn.messages.map(row => row.id))).toEqual(['a1', 'a2', 'a3'])
    expect(new Set(turns.map(turn => turn.id)).size).toBe(3)
  })

  it('orders activity-only turns and unassigned messages by time, preserving equal-time message order', () => {
    const messages = [message('u1', 'user', 2), message('a1', 'assistant', 2, 't1'), message('u2', 'user', 3), message('a2', 'assistant', 4)]
    const turns = conversationTurns(messages, [activity('earlier', 0, 't0')], null)
    expect(turns[0]?.activities.map(row => row.id)).toEqual(['earlier'])
    expect(turns.flatMap(turn => turn.messages.map(row => row.id))).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(conversationTurns([], [], null)).toEqual([])
  })

  it('keeps equal-time work with its turn before the next answer', () => {
    const turns = conversationTurns([message('a1', 'assistant', 0, 't1'), message('a2', 'assistant', 0, 't2')], [activity('work', 0, 't1')], null)
    expect(turns.map(turn => turn.turnId)).toEqual(['t1', 't2'])
    expect(turns[0]?.activities.map(row => row.id)).toEqual(['work'])
  })
})
