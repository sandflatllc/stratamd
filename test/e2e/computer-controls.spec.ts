import { reviewCapture } from './captures'
import { expect, test } from './test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario } from './harness'

test('This computer manages real pairing links, tray and login choices in an isolated stock environment @managed', async ({}, testInfo) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const scenario = await Scenario.create(testInfo, '# Connections stay separate\n')
  scenario.env.STRATAMD_ENGINE_MODE = 'managed'
  try {
    let page = await scenario.launch()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.managed?.state, { timeout: 20000 }).toBe('running')
    await page.getByRole('button', { name: 'StrataMD menu' }).click()
    await page.getByRole('menuitem', { name: 'This computer', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'This computer' })
    await expect(dialog.getByText('Signed out of T3', { exact: true })).toBeVisible()
    for (const [width, height] of [[1440, 1000], [1024, 700]]) {
      await scenario.app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width: width!, height: height! })
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await reviewCapture(page, { path: testInfo.outputPath(`this-computer-${width}.png`), animations: 'disabled' })
    }
    await expect(dialog.getByLabel('Remote access', { exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('Publish agent activity')).not.toBeChecked()
    await dialog.getByLabel('Start at login', { exact: true }).check()
    const autostart = scenario.env.STRATAMD_TEST_LOGIN_FILE!
    await expect.poll(async () => readFile(autostart, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })).toContain('"enabled":true')
    await dialog.getByLabel('Start at login', { exact: true }).uncheck()
    await expect.poll(async () => JSON.parse(await readFile(autostart, 'utf8')).enabled).toBe(false)
    await dialog.getByText('Advanced connections', { exact: true }).click()
    await dialog.getByLabel('Link name').fill('Disposable phone')
    await dialog.getByRole('button', { name: 'Create pairing link', exact: true }).click()
    await expect(dialog.getByLabel('New pairing link', { exact: true })).toHaveValue(/\/pair\?token=/)
    await dialog.getByRole('button', { name: 'Revoke link', exact: true }).click()
    await expect(dialog.getByLabel('New pairing link', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('This Strata session', { exact: false })).toBeVisible()
    await dialog.getByLabel('Keep running in the tray').uncheck()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).settings.engine?.keepRunning).toBe(false)
    await scenario.stop()
    page = await scenario.launch()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.managed?.state, { timeout: 20000 }).toBe('running')
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
  } finally { await scenario.stop(); await scenario.dispose() }
})
