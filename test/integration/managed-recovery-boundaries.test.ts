import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { recoveryFixture } from '../fixtures/managed-recovery/runtime'
import { createEngineBackup } from '../../src/main/engine/backups'

it('stops repeated ready-then-crash cycles and retains the failure signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-crash-budget-'))
  const bundle = await recoveryFixture(root)
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle, connect: async () => {}, authenticate: async () => true, reconnect: async () => {}, changed: () => {} })
  try {
    await manager.start()
    for (let index = 0; index < 4; index++) {
      const record = JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8'))
      process.kill(record.pid, 'SIGKILL')
      if (index < 3) await expect.poll(async () => manager.view().state === 'running' && JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8')).pid !== record.pid, { timeout: 15000 }).toBe(true)
      else await expect.poll(() => manager.view().state).toBe('failed')
    }
    expect(manager.view().failure).toMatchObject({ signal: 'SIGKILL', attempt: 3 })
  } finally { await manager.stop(); await rm(root, { recursive: true, force: true }) }
}, 30000)

it('replenishes retry attempts only after sustained health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-healthy-budget-'))
  const bundle = await recoveryFixture(root)
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle, healthyIntervalMs: 20, connect: async () => {}, authenticate: async () => true, reconnect: async () => {}, changed: () => {} })
  try {
    await manager.start()
    for (let index = 0; index < 5; index++) {
      const record = JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8'))
      const readyAt = Date.now()
      await expect.poll(() => Date.now() - readyAt >= 40).toBe(true)
      process.kill(record.pid, 'SIGKILL')
      await expect.poll(async () => manager.view().state === 'running' && JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8')).pid !== record.pid, { timeout: 4000 }).toBe(true)
    }
    expect(manager.view().failure?.attempt).toBe(0)
  } finally { await manager.stop(); await rm(root, { recursive: true, force: true }) }
}, 20000)

it.each(['before-delete', 'after-delete', 'after-rename'])('recovers interrupted restore at %s with its data and Strata bindings', async boundary => {
  const root = await mkdtemp(join(tmpdir(), 'strata-restore-boundary-'))
  const bundle = await recoveryFixture(root), directory = join(root, 'engine')
  let restored = ''
  const manager = new LocalEngineManager({ directory, bundle, connect: async () => {}, authenticate: async () => true, reconnect: async () => {}, changed: () => {}, restoreState: async source => { restored = await readFile(join(source, 'bindings.txt'), 'utf8') } })
  try {
    await manager.start(); await manager.stop()
    const record = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
    const runtime = { ...JSON.parse(await readFile(join(record.runtimeDirectory, 'runtime.json'), 'utf8')), directory: record.runtimeDirectory }
    await writeFile(join(directory, 't3/valuable.txt'), 'original data')
    const backup = await createEngineBackup(directory, runtime, 'upgrade', async path => { await writeFile(join(path, 'bindings.txt'), 'original bindings') })
    await writeFile(join(directory, 'transition.json'), JSON.stringify({ backupId: backup.id, targetVersion: runtime.version }))
    if (boundary !== 'before-delete') await rm(join(directory, 't3'), { recursive: true })
    if (boundary === 'after-rename') { await mkdir(join(directory, 't3')); await writeFile(join(directory, 't3/valuable.txt'), 'original data') }
    await manager.start()
    expect(manager.view().state).toBe('running')
    expect(await readFile(join(directory, 't3/valuable.txt'), 'utf8')).toBe('original data')
    expect(restored).toBe('original bindings')
    expect((await manager.recovery()).backups.some(backup => backup.kind === 'failed-update')).toBe(true)
  } finally { await manager.stop(); await rm(root, { recursive: true, force: true }) }
})

it.each(['pairing', 'credential-saved'])('recovers parent death during %s with exactly one owned process', async phase => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { resolve } = await import('node:path')
  const { verifiedProcess } = await import('../../src/main/engine/managed-process')
  const root = await mkdtemp(join(tmpdir(), 'strata-parent-death-'))
  const bundle = await recoveryFixture(root)
  const parent = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--experimental-transform-types', '--experimental-loader', resolve('src/cli/typescript-loader.ts'), resolve('test/fixtures/managed-recovery/parent.mjs'), root, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let error = ''
  parent.stderr?.on('data', bytes => { error += bytes })
  let ready = false
  parent.on('message', () => { ready = true })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle, connect: async () => { await writeFile(join(root, 'credential-saved'), 'yes') }, authenticate: async () => readFile(join(root, 'credential-saved')).then(() => true, () => false), reconnect: async () => {}, changed: () => {} })
  try {
    await expect.poll(() => { if (parent.exitCode !== null) throw new Error(error); return ready }, { timeout: 5000 }).toBe(true)
    const original = JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8'))
    parent.kill('SIGKILL'); await once(parent, 'exit')
    await manager.start()
    expect(manager.view().state).toBe('running')
    const current = JSON.parse(await readFile(join(root, 'engine/runtime.json'), 'utf8'))
    expect(current.phase).toBe('ready')
    expect(await verifiedProcess(current)).toBe(true)
    expect(await verifiedProcess(original)).toBe(phase === 'credential-saved')
    expect(current.pid === original.pid).toBe(phase === 'credential-saved')
  } finally { if (parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await once(parent, 'exit') }; await manager.stop(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it('prunes only superseded automatic backups after a clean replacement session and retains all referenced runtimes', async () => {
  const { stageRuntime } = await import('../../src/main/engine/managed-runtime')
  const { retainEngineRecovery, listEngineBackups } = await import('../../src/main/engine/backups')
  const { stat } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'strata-retention-'))
  const bundle = await recoveryFixture(root), directory = join(root, 'engine')
  try {
    await mkdir(join(directory, 't3'), { recursive: true })
    const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8'))
    const runtimes = []
    for (const version of ['v1', 'v2', 'v3', 'unused']) {
      await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version }))
      runtimes.push(await stageRuntime(bundle, directory))
    }
    const old = await createEngineBackup(directory, runtimes[0]!, 'upgrade', async () => {}, 'v2')
    const latest = await createEngineBackup(directory, runtimes[1]!, 'upgrade', async () => {}, 'v3')
    const archive = await createEngineBackup(directory, runtimes[0]!, 'newer-work', async () => {})
    await writeFile(join(directory, 'selected-runtime.json'), JSON.stringify({ version: 'v2', bundleVersion: 'v3' }))
    await writeFile(join(directory, 'transition.json'), JSON.stringify({ backupId: old.id, targetVersion: 'v3' }))
    await retainEngineRecovery(directory, 'v2')
    expect((await listEngineBackups(directory)).map(b => b.id)).toContain(old.id)
    await rm(join(directory, 'transition.json'))
    await retainEngineRecovery(directory, 'v3')
    expect(new Set((await listEngineBackups(directory)).map(b => b.id))).toEqual(new Set([latest.id, archive.id]))
    for (const version of ['v1', 'v2', 'v3']) expect((await stat(join(directory, 'runtime', version))).isDirectory()).toBe(true)
    await expect(stat(join(directory, 'runtime/unused'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
