import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { LocalEngineManager } from '../../src/main/engine/manager'
import { T3EngineClient } from '../../src/main/engine/client'
for (const enabled of [false, true]) it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)(`managed shutdown continuation marker and startup honor preference ${enabled}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-managed-continuation-'))
  const record = join(root, 'provider-wire.jsonl')
  const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null, scanAsks: async () => [] })
  const manager = new LocalEngineManager({ directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(), changed: () => undefined,
    authenticate: async address => { const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8')); return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok },
  })
  try {
    const provider = process.platform === 'win32' ? join(root, 'restart-codex.cmd') : resolve('test/fixtures/restart-codex.cjs')
    if (process.platform === 'win32') await writeFile(provider, `@echo off\r\n"${join(process.env.STRATAMD_ENGINE_BUNDLE!, 'node/node.exe')}" "${resolve('test/fixtures/restart-codex.cjs')}" %*\r\n`)
    await mkdir(join(root, 'project')); await mkdir(join(root, 'provider-home'))
    await mkdir(join(root, 'engine/t3/userdata'), { recursive: true })
    await writeFile(join(root, 'engine/t3/userdata/settings.json'), JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: { binaryPath: provider, homePath: join(root, 'provider-home') }, environment: [{ name: 'STRATA_RESTART_RECORD', value: record, sensitive: false }] } } }))
    await manager.start(); expect(manager.view().state).toBe('running')
    let settings = await client.readSettings()
    expect(settings.continueThreadsAfterServerUpdate).toBe(false)
    await client.editSettings({ identity: client.view().identity!, base: settings, patch: { continueThreadsAfterServerUpdate: enabled } })
    settings = await client.readSettings()
    await client.editProvider({ identity: client.view().identity!, instanceId: 'codex', base: settings.providerInstances.codex!, patch: { config: { binaryPath: provider, homePath: join(root, 'provider-home') }, environment: [{ name: 'STRATA_RESTART_RECORD', value: record, sensitive: false }] } })
    const projectId = await client.createProject({ title: 'Synthetic restart', workspaceRoot: join(root, 'project') })
    await expect.poll(() => client.view().projects.some(project => project.id === projectId)).toBe(true)
    const threadId = await client.createThread({ projectId, title: 'Synthetic running turn', instanceId: 'codex', model: 'gpt-5.6', effort: null, access: 'full-access' })
    await client.openThread(threadId)
    await client.startTurn(threadId, { instanceId: 'codex', model: 'gpt-5.6', effort: null, access: 'full-access', text: 'Synthetic work only.', attachments: [] })
    const thread = () => client.view().projects.flatMap(project => project.threads).find(thread => thread.id === threadId)!
    await expect.poll(() => thread().status, { timeout: 15000 }).toBe('running')
    const turnId = thread().activeTurnId
    await manager.stop(); await client.shutdown()
    const db = new DatabaseSync(join(root, 'engine/t3/userdata/state.sqlite'), { readOnly: true })
    const row = db.prepare('SELECT runtime_payload_json FROM provider_session_runtime WHERE thread_id=?').get(threadId)!
    const payload = JSON.parse(String(row.runtime_payload_json)); db.close()
    expect(payload.continueAfterServerUpdate ?? null).toBe(enabled ? turnId : null)
    await manager.start(); expect(manager.view().state).toBe('running')
    expect((await client.readSettings()).continueThreadsAfterServerUpdate).toBe(enabled)
    await expect.poll(() => thread().status, { timeout: 15000 }).toBe(enabled ? 'running' : 'error')
    const calls = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect((await calls()).filter(call => call.method === 'turn/start')).toHaveLength(enabled ? 2 : 1)
    await client.reconnect(); await client.reconnect()
    expect((await calls()).filter(call => call.method === 'turn/start')).toHaveLength(enabled ? 2 : 1)
    if (enabled) expect(thread().activeTurnId).not.toBe(turnId)
  } finally { await manager.stop(); await client.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 60000)
