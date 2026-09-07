import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { parityCapture } from './captures'

test('usage changes windows and metrics, groups by hour, refreshes and opens Accounts', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    await page.getByRole('button', { name: 'StrataMD menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Usage', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Your usage' })
    await expect(dialog.locator('.usage-total')).toContainText('4 sessions')
    await expect(dialog.getByRole('img', { name: 'API estimate by provider over time' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Tokens', exact: true }).click()
    await expect(dialog.getByRole('img', { name: 'Tokens by provider over time' })).toBeVisible()
    await expect(dialog.getByRole('row')).toHaveCount(3)
    await parityCapture(page, 'usage-tokens')
    await dialog.getByRole('button', { name: 'API estimate', exact: true }).click()
    await expect(dialog.getByRole('img', { name: 'API estimate by provider over time' })).toBeVisible()
    await parityCapture(page, 'usage-cost')
    for (const name of ['7 days', '90 days', 'Past 24h']) {
      await dialog.getByRole('button', { name, exact: true }).click()
      await expect(dialog.locator('.usage-total')).toContainText(`4 sessions · ${name}`)
    }
    await dialog.getByRole('button', { name: 'Hour', exact: true }).click()
    await expect(dialog.getByRole('row')).toHaveCount(25)
    const request = engine.rpcRequests.filter(request => request.tag === 'server.getUsageSummary').at(-1)!
    expect(request.payload).toMatchObject({ resolution: 'hour', sinceTime: expect.any(String), untilTime: expect.any(String), timeZone: expect.any(String) })
    const count = engine.rpcRequests.filter(request => request.tag === 'server.getUsageSummary').length
    await dialog.getByRole('button', { name: 'Refresh usage' }).click()
    await expect.poll(() => engine.rpcRequests.filter(request => request.tag === 'server.getUsageSummary').length).toBe(count + 1)
    await dialog.getByRole('button', { name: 'Accounts', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const accounts = page.getByRole('dialog', { name: 'Accounts', exact: true })
    await expect(accounts).toBeVisible()
    await parityCapture(page, 'provider-overview')
    await accounts.getByRole('button', { name: 'Usage', exact: true }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})
