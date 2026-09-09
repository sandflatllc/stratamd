import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { openAppMenu } from './harness'
import type { Page } from './test'

const settings = { defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'high' }] }, defaultThreadEnvMode: 'local', newWorktreesStartFromOrigin: true, futureRoot: 'preserve' }
async function resize(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect.poll(() => dialog.evaluate(element => Math.abs(element.getBoundingClientRect().width - (element as HTMLElement).offsetWidth) < 1)).toBe(true)
  const bounds = await dialog.evaluate(element => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight }))
  const handle = page.getByRole('button', { name: 'Resize Settings', exact: true })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + (960 - bounds!.width) / 2, box.y + box.height / 2 + (760 - bounds!.height) / 2)
  await page.mouse.up()
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(960)
}
async function openSettings(page: Page) { await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await expect(page.getByRole('tab', { name: 'Computer', exact: true })).toBeVisible() }

test('computer and project defaults show inheritance, save grouped overrides, preserve concurrent fields and refuse conflicts', async ({}, testInfo) => {
  const engine = await startEngine({ settings, projectFile: '{"defaultThreadEnvMode":"worktree"}' }); engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    const before = (await page.evaluate(() => window.strata.getState())).engine.projects[0]!.threads
    await openSettings(page); await resize(page)
    await expect(page.getByLabel('Thinking')).toHaveValue('high')
    await page.screenshot({ path: testInfo.outputPath('defaults-computer.png') })
    await page.getByRole('tab', { name: 'Cockpit project', exact: true }).click(); await resize(page)
    await expect(page.locator('.defaults-row')).toContainText(['Inherited from computer', 'Uses the account and model default', 'Inherited from t3.json'])
    await page.screenshot({ path: testInfo.outputPath('defaults-project.png') })
    await page.getByRole('button', { name: 'Override model and thinking' }).click()
    await page.getByLabel('Project thinking').selectOption('low')
    await page.getByRole('button', { name: 'Override working copy' }).click()
    await page.getByLabel('Project working copy').selectOption('local')
    await page.screenshot({ path: testInfo.outputPath('defaults-override.png') })
    engine.setProjectDefaults({ title: 'Concurrent title', scripts: [{ id: 'keep', name: 'Keep script', command: 'echo keep', icon: 'play', runOnWorktreeCreate: false }], future: 'preserve' })
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    const changed = engine.commands.find(command => command.type === 'project.meta.update')!
    expect(changed).toMatchObject({ defaultModelSelection: { options: [{ id: 'effort', value: 'low' }] }, defaultThreadEnvMode: 'local' })
    expect(changed).not.toHaveProperty('scripts'); expect(changed).not.toHaveProperty('title'); expect(changed).not.toHaveProperty('future')
    await page.getByLabel('Project working copy').selectOption('worktree')
    engine.setProjectDefaults({ defaultThreadEnvMode: null })
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed in another client')
    await page.getByRole('alert').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('defaults-conflict.png') })
    await page.getByRole('button', { name: 'Reload and discard changes' }).click()
    await expect(page.getByRole('button', { name: 'Override working copy' })).toBeVisible()
    await page.getByRole('button', { name: 'Reset model and thinking' }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => window.strata.readEngineProjectDefaults('p1'))).toMatchObject({ defaultModelSelection: null, defaultThreadEnvMode: null, checkedIn: 'worktree' })
    const after = (await page.evaluate(() => window.strata.getState())).engine.projects[0]!.threads
    expect(after.map(thread => [thread.id, thread.model, thread.options])).toEqual(before.map(thread => [thread.id, thread.model, thread.options]))
  } finally { await scenario.dispose(); await engine.close() }
})

for (const mode of ['inherit', 'override', 'reset', 'malformed', 'explicit'] as const) test(`actual new thread applies ${mode} defaults without changing existing conversations`, async ({}, testInfo) => {
  const engine = await startEngine({ settings: mode === 'inherit' ? { ...settings, defaultModelSelection: { ...settings.defaultModelSelection, options: [{ id: 'effort', value: 'low' }] } } : settings, projectFile: mode === 'malformed' ? '{broken' : '{"defaultThreadEnvMode":"worktree"}', projectDefaults: mode === 'override' || mode === 'reset' ? { defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'low' }] }, defaultThreadEnvMode: 'local' } : {} }); engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    if (mode === 'inherit') await page.evaluate(async () => { const base = await window.strata.readEngineSettings(); await window.strata.editEngineSettings({ identity: base.identity ?? null, base, patch: { defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'high' }] } } }) })
    if (mode === 'reset') await page.evaluate(async () => { const base = await window.strata.readEngineProjectDefaults('p1'); await window.strata.editEngineProjectDefaults({ identity: base.identity, projectId: 'p1', base: { defaultModelSelection: base.defaultModelSelection ?? null, defaultThreadEnvMode: base.defaultThreadEnvMode ?? null }, patch: { defaultModelSelection: null, defaultThreadEnvMode: null } }) })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread in Cockpit project', exact: true }).click()
    await expect(page.getByLabel('Message conversation')).toBeVisible()
    if (mode === 'explicit') {
      await page.getByRole('button', { name: 'Workspace', exact: true }).click()
      await page.getByRole('button', { name: /^Current checkout/ }).click()
      await page.getByRole('button', { name: 'Choose model and account' }).click()
      await page.getByRole('region', { name: 'Models and accounts' }).getByRole('button', { name: 'Claude', exact: true }).click()
      await page.getByRole('button', { name: 'Use Claude Fable 5.1', exact: true }).click()
    }
    await page.getByLabel('Message conversation').fill('Use the effective project defaults.')
    await page.getByLabel('Message conversation').press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    const create = engine.commands.find(command => command.type === 'thread.create')!
    const turn = engine.commands.find(command => command.type === 'thread.turn.start')!
    expect(create).toMatchObject({ modelSelection: { instanceId: mode === 'explicit' ? 'claude-main' : 'codex', ...(mode !== 'explicit' ? { options: expect.arrayContaining([{ id: 'effort', value: mode === 'override' ? 'low' : 'high' }]) } : {}) } })
    if (mode === 'inherit' || mode === 'reset') expect(turn).toMatchObject({ bootstrap: { prepareWorktree: { baseBranch: 'master' } } })
    else expect(turn).not.toHaveProperty('bootstrap')
    expect(engine.commands.filter(command => command.type === 'thread.meta.update' && ['t1', 't2'].includes(String(command.threadId)))).toHaveLength(0)
  } finally { await scenario.dispose(); await engine.close() }
})
