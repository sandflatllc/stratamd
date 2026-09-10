import { expect, test as base } from './test'
import { waitForManagedEngine, withManagedScenario } from './managed-test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const test = withManagedScenario(base)

test('This computer manages real pairing links and login choices in an isolated stock environment @managed', async ({ runningScenario: scenario }, testInfo) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const page = scenario.page!
  await page.getByRole('button', { name: 'StrataMD menu' }).click()
  await page.getByRole('menuitem', { name: 'This computer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connections', exact: true })
  await expect(dialog.getByRole('button', { name: 'Sign in to T3', exact: true })).toBeInViewport()
  await expect(dialog.getByTestId('local-engine-status')).toContainText('Local engine running')
  await expect(dialog.getByTestId('remote-connection-status')).toContainText('Remote access is off')
  for (const [width, height] of [[1440, 1000], [1024, 700]]) {
    await scenario.app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width: width!, height: height! })
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
    expect(await dialog.locator('.setup-dialog-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`this-computer-${width}.png`), animations: 'disabled' })
  }
  await expect(dialog.getByLabel('Remote access', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('Start at login', { exact: true }).check()
  const autostart = scenario.env.STRATAMD_TEST_LOGIN_FILE!
  await expect.poll(async () => readFile(autostart, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })).toContain('"enabled":true')
  await dialog.getByLabel('Start at login', { exact: true }).uncheck()
  await expect.poll(async () => JSON.parse(await readFile(autostart, 'utf8')).enabled).toBe(false)
  await dialog.getByText('Connect over a private network', { exact: true }).click()
  await dialog.getByLabel('Link name').fill('Disposable phone')
  await dialog.getByRole('button', { name: 'Create pairing link', exact: true }).click()
  await expect(dialog.getByLabel('New pairing link', { exact: true })).toHaveValue(/\/pair\?token=/)
  await dialog.getByRole('button', { name: 'Revoke link', exact: true }).click()
  await expect(dialog.getByLabel('New pairing link', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('This Strata session', { exact: false })).toBeVisible()
})

test('This computer writes the tray choice to settings @managed', async ({ runningScenario: scenario }) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const page = scenario.page!
  await page.getByRole('button', { name: 'StrataMD menu' }).click()
  await page.getByRole('menuitem', { name: 'This computer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connections', exact: true })
  await dialog.getByLabel('Keep running in the tray').uncheck()
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).settings.engine?.keepRunning).toBe(false)
  await expect.poll(async () => JSON.parse(await readFile(join(scenario.env.XDG_CONFIG_HOME!, 'stratamd/settings.json'), 'utf8')).engine.keepRunning).toBe(false)
})

test('a saved tray choice stops the owned engine on window close @managed', async ({ installedScenario: scenario }) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  await scenario.writeSettings({ engine: { mode: 'managed', keepRunning: false } })
  const page = await scenario.launch()
  await waitForManagedEngine(page)
  expect((await page.evaluate(() => window.strata.getState())).settings.engine?.keepRunning).toBe(false)
  const running = JSON.parse(await readFile(join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine/runtime.json'), 'utf8'))
  await scenario.captureEvidence()
  await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()).catch(error => {
    if (!/closed|destroyed/i.test(String(error))) throw error
  })
  await expect.poll(() => {
    try { process.kill(running.pid, 0); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  }).toBe(false)
})
