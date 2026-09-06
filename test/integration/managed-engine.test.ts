import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { T3EngineClient } from '../../src/main/engine/client'

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('starts the unmodified bundled server, pairs automatically, and stops only its owned child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-managed-'))
  const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined, authenticate: async address => {
    const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8'))
    return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok
  } })
  try {
    await manager.start()
    expect(manager.view().problem).toBeNull()
    expect(manager.view().state).toBe('running')
    expect(client.view().state).toBe('connected')
    const identity = client.view().identity
    const old = JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8'))
    process.kill(old.pid, 'SIGKILL')
    await expect.poll(async () => JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8')).pid, { timeout: 15000 }).not.toBe(old.pid)
    await manager.restart()
    expect(manager.view().problem).toBeNull()
    expect(client.view().identity).toBe(identity)
    expect(client.view().projects).toEqual([])
  } finally { await manager.stop(); await client.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 60_000)
