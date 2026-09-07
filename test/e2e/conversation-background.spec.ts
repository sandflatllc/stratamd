import { reviewCapture } from './captures'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('conversations keep the panel background, with an inline side header and no line under the header', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const editor = page.locator('main[data-pane="editor"]')
    const rail = page.locator('.navigation-rail')
    // Distinct colors catch a window-colored child covering the panel background.
    await page.locator('.app-shell').evaluate((element) => {
      const shell = element as HTMLElement
      shell.style.setProperty('--surfaces-panel', '#243648')
      shell.style.setProperty('--surfaces-window', '#101820')
      shell.dataset.motion = 'true'
    })
    const documentBackground = await editor.evaluate((element) => getComputedStyle(element).backgroundColor)
    const documentAmbient = await editor.locator('.ambient-layer').evaluate((element) => element.outerHTML)
    const railBackground = await rail.evaluate((element) => getComputedStyle(element).backgroundColor)
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()

    const side = page.locator('.conversation-panel[data-placement="side"]')
    await expect(side).toBeVisible()
    await expect(rail).toHaveCSS('background-color', railBackground)
    await expect(rail.locator('> .ambient-layer')).toBeVisible()
    await expect(side.locator('> header')).toHaveCSS('border-bottom-width', '0px')
    // One row: names, then Find, then the placement button at the right edge.
    const title = (await side.locator('.conversation-title > strong').boundingBox())!
    const find = (await side.locator('.conversation-find').boundingBox())!
    const move = (await side.getByRole('button', { name: 'Open in center' }).boundingBox())!
    const row = (await side.locator('.conversation-title').boundingBox())!
    expect(title.x + title.width).toBeLessThanOrEqual(find.x)
    expect(find.x + find.width).toBeLessThanOrEqual(move.x)
    expect(Math.abs(move.x + move.width - (row.x + row.width))).toBeLessThan(1)
    for (const box of [title, find, move]) expect(Math.abs(box.y + box.height / 2 - (row.y + row.height / 2))).toBeLessThan(4)
    await reviewCapture(page, { path: testInfo.outputPath('conversation-side-header.png') })

    await side.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    await expect(center).toBeVisible()
    await expect(editor).toHaveCSS('background-color', documentBackground)
    // The transcript has its own opaque frame; the ambient layer stays outside it.
    await expect(center).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(center.locator('.conversation-messages')).toHaveCSS('background-color', 'rgb(21, 20, 26)')
    expect(await editor.locator('.ambient-layer').evaluate((element) => element.outerHTML)).toBe(documentAmbient)
    await expect(editor.locator('.ambient-layer')).toBeVisible()
    await expect(center.locator('> header')).toHaveCSS('border-bottom-width', '0px')
    await reviewCapture(page, { path: testInfo.outputPath('conversation-background.png') })

    // The theme's Open choice restores the original transparent reading area.
    await page.evaluate(async () => {
      await window.strata.createTheme('Open conversation', 'strata-vivid')
      await window.strata.setThemeValue('surfaces.transcript-style', 'open')
    })
    await expect(center.locator('.conversation-messages')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    await page.locator('.app-shell').evaluate((element) => { (element as HTMLElement).dataset.motion = 'false' })
    await expect(editor.locator('.ambient-layer')).toBeHidden()
    await expect(editor).toHaveCSS('background-color', documentBackground)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
