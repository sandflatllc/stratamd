import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('terminal renders WASM, sends input, resizes and reattaches without closing the shell', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    await page.getByRole('button', { name: 'StrataMD menu', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Terminal/ }).click()
    const drawer = page.getByRole('region', { name: 'Terminal', exact: true })
    await expect(drawer.locator('.terminal-status')).toHaveText('running')
    await expect(drawer.locator('canvas')).toBeVisible()
    await expect(drawer.getByRole('alert')).toHaveCount(0)
    await page.keyboard.type('printf hello')
    await page.keyboard.press('Enter')
    await expect.poll(() => engine.rpcRequests.filter(request => request.tag === 'terminal.write').map(request => (request.payload as { data: string }).data).join('')).toContain('printf hello\r')
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1360, 960))
    await expect.poll(() => engine.rpcRequests.some(request => request.tag === 'terminal.resize')).toBe(true)
    await page.screenshot({ animations: 'disabled', path: 'docs/design/t3-parity/captures/terminal-open.png' })
    await page.keyboard.press('Control+Backquote')
    await expect(drawer).toHaveCount(0)
    expect(engine.rpcRequests.some(request => request.tag === 'terminal.close')).toBe(false)
    await page.keyboard.press('Control+Backquote')
    await expect(drawer.locator('.terminal-status')).toHaveText('running')
    expect(engine.rpcRequests.filter(request => request.tag === 'terminal.attach')).toHaveLength(2)
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click()
    await page.getByRole('button', { name: 'Engine status' }).click()
    await page.keyboard.press('Control+Backquote')
    await expect(drawer).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})
