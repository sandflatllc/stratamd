import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { seededScenario, startEngine } from './cockpit-engine-harness'

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
    await mkdir('docs/design/t3-parity/captures', { recursive: true })
    await page.screenshot({ animations: 'disabled', path: 'docs/design/t3-parity/captures/engine-details.png' })
    await dialog.locator('summary').click()
    await expect(dialog.getByLabel('Pairing link')).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'docs/design/t3-parity/captures/engine-pair.png' })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Engine status' })).toBeFocused()
    engine.setOnline(false)
    await expect(page.getByRole('button', { name: 'Engine status' })).toContainText('Disconnected')
    await page.getByRole('button', { name: 'Engine status' }).click()
    await expect(dialog.getByRole('button', { name: 'Reconnect' })).toHaveClass(/primary-button/)
    await page.screenshot({ animations: 'disabled', path: 'docs/design/t3-parity/captures/engine-disconnected.png' })
  } finally { await scenario.dispose(); await engine.close() }
})
