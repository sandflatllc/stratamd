import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { parityCapture } from './captures'

test('connection details keep pairing collapsed and support keyboard dismissal', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    await expect(page.getByRole('button', { name: 'Engine status' })).toContainText('Connected')
    await page.getByRole('button', { name: 'Engine status' }).click()
    const dialog = page.getByRole('dialog', { name: 'Engine', exact: true })
    await expect(dialog.getByLabel('Pairing link')).toBeHidden()
    await expect(dialog.getByRole('button', { name: 'Reconnect' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Open t3 connection settings' })).toBeVisible()
    await parityCapture(page, 'engine-details')
    await dialog.locator('.engine-pairing > summary').click()
    await expect(dialog.getByLabel('Pairing link')).toBeVisible()
    await parityCapture(page, 'engine-pair')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Engine status' })).toBeFocused()
    engine.setOnline(false)
    await expect(page.getByRole('button', { name: 'Engine status' })).toContainText('Disconnected')
    await page.getByRole('button', { name: 'Engine status' }).click()
    await expect(dialog.getByRole('button', { name: 'Reconnect' })).toHaveClass(/primary-button/)
    await parityCapture(page, 'engine-disconnected')
  } finally { await scenario.dispose(); await engine.close() }
})
