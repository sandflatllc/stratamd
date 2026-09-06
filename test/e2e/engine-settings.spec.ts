import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { openAppMenu } from './harness'

const settings = {
  defaultThreadEnvMode: 'local', newWorktreesStartFromOrigin: true, addProjectBaseDirectory: '', sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: 3, enableProviderUpdateChecks: true,
  textGenerationModelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'low' }] },
  sourceControlWritingStyle: { mode: 'repo_conventions', customInstructions: '', followChangeRequestTemplates: true, future: 'preserved' }, sourceControlWriterModelSelection: null,
  backgroundActivity: { schemaVersion: 1, profile: 'balanced', baseProfile: 'balanced', overrides: { future: 17 } }, futureRoot: { untouched: true },
}

test('settings change defaults and writer options, preserve concurrent fields, and survive app restart', async ({}, testInfo) => {
  const engine = await startEngine({ settings }); engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await scenario.launch()
    const open = async () => { await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click() }
    await open()
    await page.getByLabel('New conversations', { exact: true }).selectOption('worktree')
    await page.getByRole('switch', { name: 'Start from origin', exact: true }).click()
    await page.getByLabel('Add project starts in', { exact: true }).fill('/home/owner/Projects')
    await page.getByRole('switch', { name: 'Auto-settle merged conversations', exact: true }).click()
    await page.getByRole('switch', { name: 'Auto-settle inactive conversations', exact: true }).click()
    await expect(page.getByLabel('Days of inactivity')).toHaveCount(0)
    await page.getByRole('switch', { name: 'Auto-settle inactive conversations', exact: true }).click()
    await page.getByLabel('Days of inactivity').fill('12')
    await page.getByLabel('Generated text model Reasoning').selectOption('high')
    await page.getByText('Advanced', { exact: true }).click()
    await page.getByRole('switch', { name: 'Provider update checks' }).click()
    await page.getByLabel('Writing style', { exact: true }).selectOption('custom')
    await page.getByLabel('Custom writing instructions').fill('Use short titles.')
    await page.getByRole('switch', { name: 'Follow change request templates' }).click()
    await page.getByRole('switch', { name: 'Separate source control writer model' }).click()
    await page.getByLabel('Source control writer model Reasoning').selectOption('low')
    await expect(page.getByRole('region', { name: 'Source control readiness' })).toContainText('Install and sign in with gh.')
    await page.screenshot({ path: testInfo.outputPath('settings.png'), animations: 'disabled' })
    engine.setSettings({ futureRoot: { untouched: 'changed elsewhere' } })
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    const read = await page.evaluate(() => window.strata.readEngineSettings())
    expect(read).toMatchObject({ defaultThreadEnvMode: 'worktree', newWorktreesStartFromOrigin: false, sidebarAutoSettleAfterDays: 12, enableProviderUpdateChecks: false, futureRoot: { untouched: 'changed elsewhere' }, sourceControlWritingStyle: { mode: 'custom', future: 'preserved' }, sourceControlWriterModelSelection: { options: [{ id: 'effort', value: 'low' }] } })
    await scenario.stop(); page = await scenario.launch(); await open()
    await expect(page.getByLabel('New conversations', { exact: true })).toHaveValue('worktree')
    await expect(page.getByLabel('Days of inactivity')).toHaveValue('12')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toContainText('New worktree')
  } finally { await scenario.dispose(); await engine.close() }
})

test('background tuning edits all eight controls and keeps unknown policy values', async ({}, testInfo) => {
  const engine = await startEngine({ settings })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByText('Advanced', { exact: true }).click()
    await page.getByLabel('Background activity profile').selectOption('battery-saver')
    await page.getByRole('button', { name: 'Tune background activity' }).click()
    await page.getByLabel('Shared policy').selectOption('performance')
    const intervals = ['Git fetch interval', 'Provider health interval', 'Active host power interval', 'Idle host power interval']
    for (let index = 0; index < intervals.length; index++) await page.getByLabel(intervals[index]!, { exact: true }).fill(String((index + 1) * 30))
    for (const label of ['Pause when locked', 'Pause when host is in low power mode', 'Pause when client is in low power mode', 'Pause on battery']) await page.getByLabel(label, { exact: true }).selectOption('on')
    await page.screenshot({ path: testInfo.outputPath('background.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Apply to settings' }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    expect((await page.evaluate(() => window.strata.readEngineSettings())).backgroundActivity).toMatchObject({ profile: 'custom', baseProfile: 'performance', overrides: { future: 17, automaticGitFetchInterval: 30000, providerHealthRefreshInterval: 60000, hostPowerMonitorActiveInterval: 90000, hostPowerMonitorIdleInterval: 120000, pauseWhenHostLocked: true, pauseWhenHostLowPower: true, pauseWhenClientLowPower: true, pauseWhenOnBattery: true } })
  } finally { await scenario.dispose(); await engine.close() }
})

test('a conflicting save retains edits, reload is explicit, and absent settings stay unsupported', async ({}, testInfo) => {
  const engine = await startEngine({ settings })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByLabel('Days of inactivity').fill('10')
    engine.setSettings({ sidebarAutoSettleAfterDays: 20 })
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed in another client')
    await expect(page.getByLabel('Days of inactivity')).toHaveValue('10')
    await page.getByRole('button', { name: 'Reload and discard changes' }).click()
    await expect(page.getByLabel('Days of inactivity')).toHaveValue('20')
    expect(engine.rpcRequests.filter(request => request.tag === 'server.updateSettings')).toHaveLength(0)
  } finally { await scenario.dispose(); await engine.close() }
})
