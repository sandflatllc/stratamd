import { reviewCapture } from './captures'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('center conversation shares the saved document measure and fits the side pane', async ({}, testInfo) => {
  const engine = await startEngine()
  engine.postAssistant('t1', '# Long answer\n\n' + Array.from({ length: 45 }, (_, i) => `Paragraph ${i + 1}. The width control must remain available while reading the conversation.`).join('\n\n'))
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1900, 1000))
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    const handle = center.getByRole('button', { name: 'Resize conversation measure' })
    const history = center.locator('.conversation-messages')
    await history.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(500)
    await expect(handle).toBeInViewport()
    await history.evaluate((element) => { element.scrollTop = element.scrollHeight / 2 })
    await expect(handle).toBeInViewport()
    const before = Number(await handle.getAttribute('aria-valuenow'))
    const column = center.locator('.conversation-column')
    const initialWidth = (await column.boundingBox())!.width
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    const measure = before - 120
    await expect(handle).toHaveAttribute('aria-valuenow', String(measure))
    await expect.poll(async () => (await column.boundingBox())!.width).toBeLessThan(initialWidth)
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).settings.panelSizes.documentMeasure).toBe(measure)
    const composer = center.locator('.chat-composer-box')
    await expect.poll(async () => Math.abs((await composer.boundingBox())!.width - (await column.boundingBox())!.width * 2 / 3)).toBeLessThan(1)
    await expect.poll(async () => {
      const box = (await composer.boundingBox())!
      const transcript = (await column.boundingBox())!
      return Math.abs(box.x + box.width / 2 - transcript.x - transcript.width / 2)
    }).toBeLessThan(1)
    await reviewCapture(page, { path: testInfo.outputPath('conversation-width.png') })
    await center.getByRole('button', { name: 'Move to side' }).click()
    await expect(page.getByRole('button', { name: 'Resize document measure' })).toHaveAttribute('aria-valuenow', String(measure))
    const side = page.locator('.conversation-panel[data-placement="side"]')
    await expect(side.getByRole('button', { name: 'Resize conversation measure' })).toHaveCount(0)
    expect(await side.locator('.conversation-column').evaluate((element) => element.getBoundingClientRect().width <= element.parentElement!.clientWidth)).toBe(true)
    await scenario.stop()
    const restored = await scenario.launch()
    await expect(restored.getByRole('button', { name: 'Resize document measure' })).toHaveAttribute('aria-valuenow', String(measure))
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
