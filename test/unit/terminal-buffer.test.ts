import { expect, it } from 'vitest'
import { applyTerminalAttachStreamEvent as apply, EMPTY_TERMINAL_BUFFER_STATE as empty } from '../../src/renderer/terminal/buffer'
const target = { threadId: 'thread', terminalId: 'term-1' }
it('keeps UTF-8 intact while bounding history and replacing reconnect snapshots', () => {
  const state = apply(empty, { type: 'output', ...target, data: 'old🌵你好' }, 7)
  expect(state.buffer).toBe('你好')
  const restored = apply(state, { type: 'snapshot', snapshot: { ...target, cwd: '/tmp', worktreePath: null, history: '\u001b[32mready', status: 'running', label: 'bash', updatedAt: '2026-09-05T12:00:00Z' } })
  expect(restored.buffer).toBe('\u001b[32mready')
  expect(apply(restored, { type: 'cleared', ...target }).buffer).toBe('')
  expect(apply(restored, { type: 'exited', ...target, exitCode: 0, exitSignal: null }).status).toBe('exited')
  expect(apply(restored, { type: 'error', ...target, message: 'Socket closed' }).error).toBe('Socket closed')
})
