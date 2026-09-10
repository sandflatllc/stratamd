import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { copyRuntimeDirectory } from '../../src/platform/runtime-copy'
import { createEngineBackup } from '../../src/main/engine/backups'
import { stageRuntime } from '../../src/main/engine/managed-runtime'

async function upgradeFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'strata-upgrade-'))
  const bundle = join(root, 'bundle')
  let client: T3EngineClient | undefined
  let manager: LocalEngineManager | undefined
  let maintenance = false
  const phase = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    console.info(`[engine-upgrade:${name}] ${label} started`)
    try {
      const result = await operation()
      console.info(`[engine-upgrade:${name}] ${label} completed in ${Date.now() - started}ms`)
      return result
    } catch (error) {
      console.info(`[engine-upgrade:${name}] ${label} failed after ${Date.now() - started}ms`)
      throw error
    }
  }
  const stop = () => phase('stop engine and client', async () => { await manager?.stop(); await client?.shutdown() })
  const cleanup = async () => { try { await stop() } finally { await rm(root, { recursive: true, force: true }) } }
  const start = () => phase('start engine', async () => {
    client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null, reserveLocalSetup: () => { maintenance = true }, localSetupBusy: () => maintenance })
    await client.initialize(false)
    manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle,
      reserveChange: async () => { await client!.prepareLocalSetup(); client!.assertNoPendingSends(); await client!.shutdown(); return async () => { maintenance = false; await client!.resumeAfterMaintenance() } },
      connect: (address, token, identity) => client!.pair(address, token, identity), reconnect: () => client!.reconnect(), changed: () => undefined,
      authenticate: async address => { const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8')); return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok },
    })
    await manager.start(); expect(manager.view().state).toBe('running')
  })
  try {
    await phase('copy official bundle', () => copyRuntimeDirectory(process.env.STRATAMD_ENGINE_BUNDLE!, bundle))
    const original = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8'))
    // Same official server, distinct release manifests exercise transition mechanics without claiming a schema migration.
    delete original.integrity
    const release = (version: number, entry = original.entry) => writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...original, version: `${original.version}-upgrade-proof-${version}`, entry }))
    const settings = (days: number) => phase(`save setting ${days}`, async () => {
      await client!.editSettings({ identity: client!.view().identity!, base: await client!.readSettings(), patch: { sidebarAutoSettleAfterDays: days } })
    })
    return { root, bundle, phase, start, stop, cleanup, release, settings, get client() { return client! }, get manager() { return manager! } }
  } catch (error) { await cleanup(); throw error }
}

type UpgradeFixture = Awaited<ReturnType<typeof upgradeFixture>>

// Installation is a suite fixture. Each case measures one transition from an
// existing installation; managed-engine.test.ts separately covers cold startup.
// Both preparation and cleanup are bounded, and test bodies retain one minute.
function preparedUpgrade(name: string, prepare: (fixture: UpgradeFixture) => Promise<void>, transition: (fixture: UpgradeFixture) => Promise<void>) {
  describe.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)(name, () => {
    let fixture: UpgradeFixture | undefined
    beforeAll(async () => {
      fixture = await upgradeFixture(name)
      await prepare(fixture)
    }, 60_000)
    afterAll(async () => { await fixture?.cleanup() }, 60_000)
    it('preserves the installed data across the transition', async () => { await transition(fixture!) }, 60_000)
  })
}

preparedUpgrade('folder replacement upgrades and preserves identity and settings', async fixture => {
  await fixture.release(1)
  await fixture.start()
  await fixture.settings(15)
}, async fixture => {
  const identity = fixture.client.view().identity
  await fixture.stop()
  await fixture.release(2)
  await fixture.start()
  expect(fixture.manager.view().version).toContain('upgrade-proof-2')
  expect(fixture.client.view().identity).toBe(identity)
  expect((await fixture.client.readSettings()).sidebarAutoSettleAfterDays).toBe(15)
  expect((await fixture.manager.recovery()).backups.some(row => row.kind === 'upgrade' && row.version.includes('upgrade-proof-1'))).toBe(true)
})

preparedUpgrade('rollback archives newer work and persists the restored runtime selection', async fixture => {
  await fixture.release(2)
  await fixture.start()
  await fixture.settings(15)
  await fixture.stop()
}, async fixture => {
  const currentVersion = fixture.manager.view().version!
  // Build a valid pre-upgrade backup without repeating the separately tested upgrade launches.
  await fixture.release(1)
  const previous = await fixture.phase('stage previous runtime', () => stageRuntime(fixture.bundle, join(fixture.root, 'engine')))
  await fixture.release(2)
  const backup = await fixture.phase('capture previous settings', () => createEngineBackup(join(fixture.root, 'engine'), previous, 'upgrade', async () => undefined, currentVersion))
  await fixture.start()
  await fixture.settings(25)
  await fixture.phase('restore previous backup', () => fixture.manager.restore(backup.id))
  expect(fixture.manager.view().version).toContain('upgrade-proof-1')
  expect((await fixture.client.readSettings()).sidebarAutoSettleAfterDays).toBe(15)
  expect((await fixture.manager.recovery()).backups.some(row => row.kind === 'newer-work')).toBe(true)
  expect(JSON.parse(await readFile(join(fixture.root, 'engine/selected-runtime.json'), 'utf8'))).toEqual({ version: previous.version, bundleVersion: currentVersion })
})

preparedUpgrade('a persisted runtime selection remains pinned across restart', async fixture => {
  await fixture.release(1)
  const previous = await fixture.phase('stage selected runtime', () => stageRuntime(fixture.bundle, join(fixture.root, 'engine')))
  await fixture.release(2)
  const bundled = JSON.parse(await readFile(join(fixture.bundle, 'runtime.json'), 'utf8'))
  // The rollback case proves this record is written; this case independently proves restart reads it.
  await writeFile(join(fixture.root, 'engine/selected-runtime.json'), JSON.stringify({ version: previous.version, bundleVersion: bundled.version }))
}, async fixture => {
  await fixture.start()
  expect(fixture.manager.view().version).toContain('upgrade-proof-1')
  await fixture.stop()
  await fixture.start()
  expect(fixture.manager.view().version).toContain('upgrade-proof-1')
})

preparedUpgrade('a failed update recovers the previous engine and settings and archives the failed work', async fixture => {
  await fixture.release(1)
  await fixture.start()
  await fixture.settings(15)
}, async fixture => {
  await writeFile(join(fixture.bundle, 'failed-entry.mjs'), 'process.exit(7)\n')
  await fixture.release(3, 'failed-entry.mjs')
  await fixture.phase('attempt failed update and recover', () => fixture.manager.update())
  expect(fixture.manager.view().version).toContain('upgrade-proof-1')
  expect(fixture.manager.view().problem).toContain('previous engine is running')
  expect((await fixture.client.readSettings()).sidebarAutoSettleAfterDays).toBe(15)
  expect((await fixture.manager.recovery()).backups.some(row => row.kind === 'failed-update')).toBe(true)
})

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('an interrupted transition archives changed data before recovering the matching backup', async () => {
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
