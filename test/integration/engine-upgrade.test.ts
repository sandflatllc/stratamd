import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { copyRuntimeDirectory } from '../../src/platform/runtime-copy'

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('folder replacement upgrades, archives newer work on rollback, pins the restored runtime and recovers a failed launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-upgrade-'))
  const bundle = join(root, 'bundle')
  let client: T3EngineClient
  let manager: LocalEngineManager
  let maintenance = false
  const start = async () => {
    client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null, reserveLocalSetup: () => { maintenance = true }, localSetupBusy: () => maintenance })
    await client.initialize(false)
    manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle,
      reserveChange: async () => { await client.prepareLocalSetup(); client.assertNoPendingSends(); await client.shutdown(); return async () => { maintenance = false; await client.resumeAfterMaintenance() } },
      connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined,
      authenticate: async address => { const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8')); return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok },
    })
    await manager.start(); expect(manager.view().state).toBe('running')
  }
  try {
    await copyRuntimeDirectory(process.env.STRATAMD_ENGINE_BUNDLE!, bundle)
    const original = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8'))
    // Same official server, distinct release manifests exercise transition mechanics without claiming a schema migration.
    delete original.integrity
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...original, version: original.version + '-upgrade-proof-1' }))
    await start()
    const identity = client!.view().identity
    const settings = await client!.readSettings()
    await client!.editSettings({ identity: identity!, base: settings, patch: { sidebarAutoSettleAfterDays: 15 } })
    await manager!.stop(); await client!.shutdown()
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...original, version: original.version + '-upgrade-proof-2' }))
    await start()
    expect(manager!.view().version).toContain('upgrade-proof-2')
    expect(client!.view().identity).toBe(identity)
    expect((await client!.readSettings()).sidebarAutoSettleAfterDays).toBe(15)
    const backup = (await manager!.recovery()).backups.find(row => row.kind === 'upgrade')!
    await client!.editSettings({ identity: identity!, base: await client!.readSettings(), patch: { sidebarAutoSettleAfterDays: 25 } })
    await manager!.restore(backup.id)
    expect(manager!.view().version).toContain('upgrade-proof-1')
    expect((await client!.readSettings()).sidebarAutoSettleAfterDays).toBe(15)
    expect((await manager!.recovery()).backups.some(row => row.kind === 'newer-work')).toBe(true)
    await manager!.stop(); await client!.shutdown(); await start()
    expect(manager!.view().version).toContain('upgrade-proof-1')
    await manager!.stop(); await client!.shutdown()
    await writeFile(join(bundle, 'failed-entry.mjs'), 'process.exit(7)\n')
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...original, version: original.version + '-upgrade-proof-3', entry: 'failed-entry.mjs' }))
    await start()
    expect(manager!.view().version).toContain('upgrade-proof-1')
    expect(manager!.view().problem).toContain('previous engine is running')
    expect((await client!.readSettings()).sidebarAutoSettleAfterDays).toBe(15)
    expect((await manager!.recovery()).backups.some(row => row.kind === 'failed-update')).toBe(true)
  } finally { await manager!?.stop(); await client!?.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 60000)

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('an interrupted transition archives changed data before recovering the matching backup', async () => {
  const { createEngineBackup } = await import('../../src/main/engine/backups')
  const root = await mkdtemp(join(tmpdir(), 'strata-interrupted-update-'))
  const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined, authenticate: async address => {
    const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8'))
    return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok
  } })
  try {
    await manager.start(); expect(manager.view().state).toBe('running')
    const record = JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8'))
    await manager.stop(); await client.shutdown()
    const runtime = { ...JSON.parse(await readFile(join(record.runtimeDirectory, 'runtime.json'), 'utf8')), directory: record.runtimeDirectory }
    const backup = await createEngineBackup(join(root, 'engine'), runtime, 'upgrade', async () => undefined)
    await writeFile(join(root, 'engine/t3/newer-work.txt'), 'Preserve interrupted work')
    await writeFile(join(root, 'engine/transition.json'), JSON.stringify({ backupId: backup.id, targetVersion: 'interrupted-target' }))
    await manager.start(); expect(manager.view().state).toBe('running')
    await expect(readFile(join(root, 'engine/t3/newer-work.txt'))).rejects.toThrow()
    const archive = (await manager.recovery()).backups.find(row => row.kind === 'failed-update')!
    expect(await readFile(join(root, 'engine/backups', archive.id, 't3/newer-work.txt'), 'utf8')).toBe('Preserve interrupted work')
    await expect(readFile(join(root, 'engine/transition.json'))).rejects.toThrow()
  } finally { await manager.stop(); await client.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 60000)
