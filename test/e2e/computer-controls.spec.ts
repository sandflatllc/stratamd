import { expect, test } from '@playwright/test'
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
    await page.getByRole('button', { name: 'Engine status' }).click()
    const dialog = page.getByRole('dialog', { name: 'This computer' })
    await expect(dialog.getByText('Signed out of T3', { exact: true })).toBeVisible()
    await expect(dialog.getByLabel('Remote access', { exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('Publish agent activity')).not.toBeChecked()
    await dialog.getByLabel('Start at login', { exact: true }).check()
    const autostart = join(scenario.env.XDG_CONFIG_HOME!, 'autostart/stratamd.desktop')
    await expect.poll(async () => readFile(autostart, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })).toContain('Exec=')
    await dialog.getByLabel('Start at login', { exact: true }).uncheck()
    await expect.poll(async () => readFile(autostart, 'utf8').then(() => true, () => false)).toBe(false)
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
  } finally { await scenario.stop(); await scenario.dispose() }
})
