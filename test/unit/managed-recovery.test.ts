import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LocalEngineManager } from '../../src/main/engine/manager'

it('bounds failed startup recovery and cancels further work on stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-recovery-'))
  const states: string[] = []
  const manager = new LocalEngineManager({ directory: root, bundle: join(root, 'missing-bundle'), connect: async () => {}, authenticate: async () => false, reconnect: async () => {}, changed: view => states.push(view.state) })
  vi.useFakeTimers()
  try {
    await manager.start()
    for (const delay of [1000, 3000, 10000]) { await vi.advanceTimersByTimeAsync(delay); await manager.start() }
    expect(states.filter(state => state === 'starting')).toHaveLength(4)
    expect(manager.view().problem).toContain('missing-bundle')
    expect(vi.getTimerCount()).toBe(0)
    await manager.stop()
    expect(manager.view().state).toBe('stopped')
  } finally { vi.useRealTimers(); await manager.stop(); await rm(root, { recursive: true, force: true }) }
})
