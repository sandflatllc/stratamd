import { expect, test } from './test'
import { Scenario } from './harness'
import { reviewCapture } from './captures'

const content = '# Document wrapper\n\n' + Array.from({ length: 30 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}. Reading, scrolling, and changing the measure keep the toolbar separate from the document.`).join('\n\n')

test('document wrapper clears the unchanged toolbar, rounds every corner, and follows the measure', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, content, 'document-wrapper.md')
  await scenario.writeSettings({ theme: 'strata-vivid', animatedBackground: false, panels: { documentMeasure: 700 } })
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1900, 1000))
    const panel = page.locator('.editor-scroll')
    const column = page.locator('.document-column')
    const toolbar = page.locator('.editor-island > .toolbar')
    await expect(panel).toHaveCSS('background-color', 'rgb(21, 20, 26)')
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) await expect(panel).toHaveCSS(`border-${corner}-radius`, '14px')
    await expect(toolbar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(toolbar).toHaveCSS('padding', '10px 14px')
    await expect(toolbar).toHaveCSS('border-bottom-width', '1px')
    const gap = () => panel.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.querySelector('.toolbar')!.getBoundingClientRect().bottom)
    await expect.poll(gap).toBe(12)
    await expect.poll(async () => (await column.boundingBox())!.width).toBe(700)
    const toolbarTop = (await toolbar.boundingBox())!.y
    const panelTop = (await panel.boundingBox())!.y
    await panel.evaluate(element => { element.scrollTop = 600 })
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(600)
    expect((await toolbar.boundingBox())!.y).toBe(toolbarTop)
    expect((await panel.boundingBox())!.y).toBe(panelTop)
    await expect.poll(gap).toBe(12)
    await reviewCapture(page, { path: testInfo.outputPath('document-wrapper-scrolled.png') })
    await panel.evaluate(element => { element.scrollTop = 0 })
    const grip = page.getByRole('button', { name: 'Resize document measure' })
    await grip.hover()
    const box = (await grip.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
    await expect(grip).toHaveAttribute('aria-valuenow', '780')
    await expect.poll(async () => (await column.boundingBox())!.width).toBe(780)
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).settings.panelSizes.documentMeasure).toBe(780)
    await reviewCapture(page, { path: testInfo.outputPath('document-wrapper.png') })
  } finally { await scenario.dispose() }
})

test('Open keeps document geometry and source view uses the same wrapper', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, content, 'document-layout.md')
  await scenario.writeSettings({ theme: 'strata-vivid', animatedBackground: false, panels: { documentMeasure: 700 } })
  try {
    const page = await scenario.launch()
    const panel = page.locator('.editor-scroll')
    await expect(panel).toHaveCSS('background-color', 'rgb(21, 20, 26)')
    await expect(page.getByRole('textbox', { name: 'Document editor' }).locator('h1')).toHaveText('Document wrapper')
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const before = await page.locator('.document-column').boundingBox()
    await page.evaluate(() => window.strata.createTheme('Wrapper test', 'strata-vivid'))
    await page.evaluate(() => window.strata.setThemeValue('surfaces.transcript-style', 'open'))
    await expect(panel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(panel).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    await expect(panel).toHaveCSS('box-shadow', 'none')
    expect(await page.locator('.document-column').boundingBox()).toEqual(before)
    await page.evaluate(() => window.strata.setThemeValue('surfaces.transcript-style', 'panel'))
    await page.locator('.source-toggle').click()
    await expect(page.getByRole('textbox', { name: 'Source editor' })).toBeVisible()
    await expect(panel).toHaveCSS('background-color', 'rgb(21, 20, 26)')
    await expect(panel).toHaveCSS('border-top-left-radius', '14px')
    await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.querySelector('.toolbar')!.getBoundingClientRect().bottom)).toBe(12)
    await reviewCapture(page, { path: testInfo.outputPath('document-source-wrapper.png') })
  } finally { await scenario.dispose() }
})
