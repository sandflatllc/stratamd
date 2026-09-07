import { reviewCapture } from './captures'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('right sidebar collapses to its handle and only appears in document mode', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1900, 1000))
    const rail = page.locator('[data-pane="rightRail"]')
    const handle = page.getByRole('button', { name: 'Resize right rail' })
    await expect(rail).toBeVisible()
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    const width = (await rail.boundingBox())!.width
    const editor = page.locator('[data-pane="editor"]')
    const editorWidth = (await editor.boundingBox())!.width
    await handle.dblclick()
    await expect(rail).toHaveCount(0)
    await expect(handle).toBeVisible()
    await expect(handle).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(editorWidth)
    await reviewCapture(page, { path: testInfo.outputPath('collapsed-sidebar.png') })
    await handle.dblclick()
    await expect(rail).toBeVisible()
    expect((await rail.boundingBox())!.width).toBe(width)
    await handle.press('Enter')
    await expect(rail).toHaveCount(0)

    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Open in center' }).click()
    await expect(handle).toHaveCount(0)
    await expect(rail).toHaveCount(0)
    await reviewCapture(page, { path: testInfo.outputPath('conversation-without-sidebar.png') })
    await page.locator('.conversation-panel[data-placement="center"]').getByRole('button', { name: 'Move to side' }).click()
    await expect(handle).toHaveAttribute('aria-expanded', 'false')
    await expect(rail).toHaveCount(0)
    await handle.press('Space')
    await expect(rail).toBeVisible()
    expect((await rail.boundingBox())!.width).toBe(width)
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).settings.panelSizes.rightRailWidth).toBe(width)
    await page.getByRole('button', { name: 'Open in center' }).click()
    await expect(handle).toHaveCount(0)
    await expect(rail).toHaveCount(0)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
