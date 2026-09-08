import { expect, test } from './test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openAppMenu, primaryKey, Scenario } from './harness'

test('theme panel resizes, zooms independently, and remembers both across restart', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Theme panel\n')
  try {
    const page = await scenario.launch()
    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Theme', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Theme', exact: true })
    const grip = panel.getByRole('button', { name: 'Resize theme panel', exact: true })
    await expect(panel).toBeVisible()
    await grip.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowUp')
    await expect(panel).toHaveCSS('width', '350px')
    await expect(panel).toHaveCSS('height', '550px')

    // Use real pointer capture, including a release outside the resize button.
    // Raw coordinates do not wait for the panel's pop-in transform to settle.
    await grip.hover()
    const box = (await grip.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 - 40, { steps: 3 })
    await page.mouse.up()
    await expect(panel).toHaveCSS('width', '320px')
    await expect(panel).toHaveCSS('height', '510px')

    await panel.locator('.theme-panel-name').hover()
    await page.keyboard.press(primaryKey('Equal'))
    await expect(panel.locator('.theme-panel-name')).toHaveCSS('font-size', '16.5px')
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect(panel.locator('.theme-panel-name')).toHaveCSS('font-size', '18px')
    await expect(panel).toHaveCSS('width', '320px')
    await expect(page.locator('[data-pane="editor"]')).toHaveCSS('--zoom', '1')
    await expect(page.locator('[data-pane="explorer"]')).toHaveCSS('--zoom', '1')

    const settingsPath = join(String(scenario.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
    await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')).zoom.themePanel).toBe(1.2)
    await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')).panels.themePanel).toMatchObject({ width: 320, height: 510 })
    await scenario.stop()
    const restarted = await scenario.launch()
    await openAppMenu(restarted)
    await restarted.getByRole('menuitem', { name: 'Theme', exact: true }).click()
    const restored = restarted.getByRole('dialog', { name: 'Theme', exact: true })
    await expect(restored).toHaveCSS('width', '320px')
    await expect(restored).toHaveCSS('height', '510px')
    await expect(restored.locator('.theme-panel-name')).toHaveCSS('font-size', '18px')
    await openAppMenu(restarted)
    await restarted.getByRole('menuitem', { name: 'Reset zoom' }).click()
    await expect(restored.locator('.theme-panel-name')).toHaveCSS('font-size', '15px')
  } finally {
    await scenario.dispose()
  }
})

// Hold panel persistence while a different setting publishes older panel sizes.
test('a pending panel resize survives an unrelated view push before its save completes', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Pending panel save\n')
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const original = handlers.get('strata:update-settings')!
      const gate = { waiting: 0, release: () => {} }
      const ready = new Promise<void>(resolve => { gate.release = resolve })
      Object.assign(globalThis, { __panelWriteGate: gate })
      handlers.set('strata:update-settings', async (...args) => {
        if ((args[1] as { panelSizes?: unknown }).panelSizes) { gate.waiting++; await ready }
        return original(...args)
      })
    })
    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Theme', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Theme', exact: true })
    const grip = panel.getByRole('button', { name: 'Resize theme panel', exact: true })
    await grip.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(panel).toHaveCSS('width', '350px')
    await expect.poll(() => scenario.app!.evaluate(() => (globalThis as unknown as { __panelWriteGate: { waiting: number } }).__panelWriteGate.waiting)).toBe(1)
    const motion = await page.evaluate(async () => {
      const next = !(await window.strata.getState()).settings.animatedBackground
      await window.strata.updateSettings({ animatedBackground: next })
      return String(next)
    })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', motion)
    await expect(panel).toHaveCSS('width', '350px')
    await scenario.app!.evaluate(() => (globalThis as unknown as { __panelWriteGate: { release(): void } }).__panelWriteGate.release())
    const settings = join(String(scenario.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
    await expect.poll(async () => JSON.parse(await readFile(settings, 'utf8')).panels.themePanel.width).toBe(350)
    await grip.focus()
    await page.keyboard.press('ArrowUp')
    await expect(panel).toHaveCSS('width', '350px')
    await expect(panel).toHaveCSS('height', '550px')
  } finally {
    await scenario.app?.evaluate(() => (globalThis as unknown as { __panelWriteGate?: { release(): void } }).__panelWriteGate?.release()).catch(() => undefined)
    await scenario.dispose()
  }
})
