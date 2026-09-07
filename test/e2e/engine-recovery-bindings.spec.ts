import { expect, test } from './test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario } from './harness'
import { copyRuntimeDirectory } from '../../src/platform/runtime-copy'
import { GhostStore } from '../../src/main/storage'
import { threadCreateCommand } from '../../src/main/engine/t3-contract'

test('engine rollback restores an existing document conversation link and Lead without starting an agent turn @managed', async ({}, testInfo) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const scenario = await Scenario.create(testInfo, '# Linked document\n')
  const bundle = join(scenario.root, 'bundle')
  await copyRuntimeDirectory(process.env.STRATAMD_ENGINE_BUNDLE!, bundle)
  const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8')); delete manifest.integrity
  scenario.env.STRATAMD_ENGINE_MODE = 'managed'; scenario.env.STRATAMD_ENGINE_BUNDLE = bundle
  try {
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version: manifest.version + '-bindings-old' }))
    let page = await scenario.launch()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.state, { timeout: 20000 }).toBe('running')
    const state = await page.evaluate(() => window.strata.getState())
    const projectId = await page.evaluate(root => window.strata.createEngineProject({ title: 'Recovery fixture', workspaceRoot: root }), scenario.root)
    const data = join(scenario.env.XDG_DATA_HOME!, 'stratamd')
    const credential = JSON.parse(await readFile(join(data, 'engine-credential.json'), 'utf8'))
    const command = threadCreateCommand.parse({ type: 'thread.create', commandId: 'fixture-create', threadId: 'fixture-linked-thread', projectId, title: 'Linked conversation', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [] }, runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null, createdAt: new Date().toISOString() })
    expect((await fetch(credential.server + '/api/orchestration/dispatch', { method: 'POST', headers: { authorization: `Bearer ${credential.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(command) })).ok).toBe(true)
    await scenario.stop()
    const store = new GhostStore({ dataDirectory: data }); await store.initialize()
    const meta = await store.loadMeta(scenario.file)
    await store.saveMeta({ ...meta, engineIdentity: state.engine.identity!, leadAgentId: 'fixture-linked-thread', attachments: { 'fixture-linked-thread': { id: 'fixture-linked-thread', name: 'Linked conversation', attachedAt: Date.now(), baselineBlob: meta.ghostBlob, segmentIndex: 0, cursor: 0, deliveries: [] } } })
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version: manifest.version + '-bindings-new' }))
    page = await scenario.launch()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.version, { timeout: 20000 }).toContain('bindings-new')
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).activeDocument?.leadAgentId).toBe('fixture-linked-thread')
    await page.evaluate(path => window.strata.detachThread(path, 'fixture-linked-thread'), scenario.file)
    expect((await page.evaluate(() => window.strata.getState())).activeDocument?.attachments).toEqual([])
    const backups = await page.evaluate(() => window.strata.engineRecovery!({ action: 'status' }))
    const backup = backups.backups.find(row => row.kind === 'upgrade')!
    await page.evaluate(backupId => window.strata.engineRecovery!({ action: 'restore', backupId, acknowledgeNewerWork: true }), backup.id)
    const restored = await page.evaluate(() => window.strata.getState())
    expect(restored.activeDocument?.leadAgentId).toBe('fixture-linked-thread')
    expect(restored.activeDocument?.attachments[0]?.agent.id).toBe('fixture-linked-thread')
    expect(restored.engine.projects.flatMap(project => project.threads).find(thread => thread.id === 'fixture-linked-thread')?.messages).toEqual([])
    expect(await readFile(scenario.file, 'utf8')).toBe('# Linked document\n')
  } finally { await scenario.stop(); await scenario.dispose() }
})
