import { expect, it } from 'vitest'
import { applyTerminalAttachStreamEvent as apply, EMPTY_TERMINAL_BUFFER_STATE as empty, terminalBufferText as text } from '../../src/renderer/terminal/buffer'
const target = { threadId: 'thread', terminalId: 'term-1' }
it('keeps UTF-8 intact while bounding history and replacing reconnect snapshots', () => {
  const state = apply(empty, { type: 'output', ...target, data: 'old🌵你好' }, 7)
  expect(text(state)).toBe('你好')
  const restored = apply(state, { type: 'snapshot', snapshot: { ...target, cwd: '/tmp', worktreePath: null, history: '\u001b[32mready', status: 'running', label: 'bash', updatedAt: '2026-09-05T12:00:00Z' } })
  expect(text(restored)).toBe('\u001b[32mready')
  expect(text(apply(restored, { type: 'cleared', ...target }))).toBe('')
  expect(apply(restored, { type: 'exited', ...target, exitCode: 0, exitSignal: null }).status).toBe('exited')
  expect(apply(restored, { type: 'error', ...target, message: 'Socket closed' }).error).toBe('Socket closed')
})
it('drops whole leading chunks at capacity and trims only the oldest kept chunk', () => {
  let state = empty
  for (let index = 0; index < 6; index += 1) state = apply(state, { type: 'output', ...target, data: `chunk-${index}|` }, 20)
  expect(state.chunks.length).toBeLessThanOrEqual(3)
  expect(state.bytes).toBe(20)
  expect(text(state)).toBe('k-3|chunk-4|chunk-5|')
  const multibyte = apply(apply(empty, { type: 'output', ...target, data: 'ab' }, 6), { type: 'output', ...target, data: '🌵好' }, 6)
  expect(text(multibyte)).toBe('好')
  expect(multibyte.bytes).toBe(3)
})
