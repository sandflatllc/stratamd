import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { parityCapture } from './captures'
import { openAppMenu } from './harness'

test('provider configuration preserves fields, model preferences persist, and the add-provider steps write an instance', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    const openAccounts = async () => { await openAppMenu(page); await page.getByRole('menuitem', { name: 'Accounts' }).click() }
    await openAccounts()
    const capture = (step: string) => parityCapture(page, `provider-${step}`)
    await capture('overview')
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await expect(page.getByRole('switch', { name: 'Enabled' })).toBeChecked()
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Codex renamed')
    await capture('config')
    await page.getByText('Advanced configuration', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Binary path', exact: true }).fill('/opt/bin/codex')
    await capture('advanced')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('dialog', { name: 'Accounts', exact: true })).toBeVisible()
    const settingsWrite = engine.rpcRequests.find(request => request.tag === 'server.updateSettings')!
    expect(settingsWrite.payload).toMatchObject({ patch: { providerInstances: { codex: { driver: 'codex', displayName: 'Codex renamed', config: { homePath: '/home/owner/.codex-work', binaryPath: '/opt/bin/codex', preserved: 'keep' } } } } })
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await page.getByRole('button', { name: 'Favorite GPT-5.6' }).click()
    await expect(page.getByRole('button', { name: 'Favorite GPT-5.6' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Hide GPT-5.6' }).click()
    await expect(page.getByRole('button', { name: 'Show GPT-5.6' })).toBeVisible()
    await capture('models')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Add provider', exact: true }).click()
    await capture('pick')
    await page.getByRole('button', { name: /^Codex Configure/ }).click()
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Personal')
    await page.getByText('Instance identifier', { exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Instance ID' })).toHaveValue('codex_personal')
    await capture('identity')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('textbox', { name: 'Account home path', exact: true }).fill('/home/owner/.codex-personal')
    await capture('new-config')
    await page.getByRole('button', { name: 'Add provider', exact: true }).click()
    await expect.poll(() => engine.rpcRequests.filter(request => request.tag === 'server.updateSettings').length).toBe(2)
    expect(engine.rpcRequests.filter(request => request.tag === 'server.updateSettings').at(-1)!.payload).toMatchObject({ patch: { providerInstances: { codex: { displayName: 'Codex renamed' }, codex_personal: { driver: 'codex', displayName: 'Personal', config: { homePath: '/home/owner/.codex-personal' } } } } })
    await page.reload()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.models?.find(model => model.instanceId === 'codex')?.favorite).toBe(true)
    expect((await page.evaluate(() => window.strata.getState())).engine.models?.find(model => model.instanceId === 'codex')?.hidden).toBe(true)
  } finally { await scenario.dispose(); await engine.close() }
})
