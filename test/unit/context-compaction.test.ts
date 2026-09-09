import { describe, expect, it } from 'vitest'
import { contextCompactionResult } from '../../src/shared/context-compaction'
import { selectedProviderCommands, supportsManualCompaction } from '../../src/shared/provider-commands'
import type { EngineActivityView } from '../../src/shared/contracts'

const request = { messageId: 'compact-1', previousActivityIds: ['old'] }
const activity = (kind: string, payload: unknown, id = 'new'): EngineActivityView => ({ id, kind, payload, summary: 'Context compaction failed', tone: 'info', turnId: null, createdAt: '2026-09-03T12:00:00Z' })
describe('manual compaction contracts', () => {
  it('uses the selected instance and exact workspace snapshot, including an empty workspace catalog', () => {
    const catalog = [
      { instanceId: 'unsupported', slashCommands: [], skills: [] },
      { instanceId: 'selected', slashCommands: [{ name: 'compact' }], skills: [], workspaceSnapshots: [{ cwd: '/work/a', checkedAt: '', slashCommands: [], skills: [] }, { cwd: '/work/b', checkedAt: '', slashCommands: [{ name: 'compact' }], skills: [] }] },
    ]
    expect(supportsManualCompaction(selectedProviderCommands(catalog, 'unsupported', '/work/b'))).toBe(false)
    expect(supportsManualCompaction(selectedProviderCommands(catalog, 'selected', '/work/a'))).toBe(false)
    expect(supportsManualCompaction(selectedProviderCommands(catalog, 'selected', '/work/b'))).toBe(true)
    expect(supportsManualCompaction(selectedProviderCommands(catalog, 'selected', '/work/other'))).toBe(true)
    expect(supportsManualCompaction(selectedProviderCommands(catalog, null, '/work/b'))).toBe(false)
  })
  it('waits for this request result and reports only supplied finite token counts', () => {
    expect(contextCompactionResult(request, [activity('context-compaction', { state: 'compacted' }, 'old'), activity('context-compaction', { state: 'compacted', requestId: 'other' })])).toEqual({ state: 'working' })
    expect(contextCompactionResult(request, [activity('context-compaction', { state: 'compacted', requestId: 'compact-1', beforeTokens: 176000, afterTokens: 48000 })])).toEqual({ state: 'done', beforeTokens: 176000, afterTokens: 48000 })
    expect(contextCompactionResult(request, [activity('context-compaction', { state: 'compacted', beforeTokens: -1, afterTokens: '200' })])).toEqual({ state: 'done' })
    expect(contextCompactionResult(request, [activity('provider.turn.start.failed', { requestId: 'compact-1', detail: 'Sign in again.' })])).toEqual({ state: 'failed', error: 'Sign in again.' })
    expect(contextCompactionResult({ ...request, error: 'Reconnect.' }, [])).toEqual({ state: 'failed', error: 'Reconnect.' })
  })
})
