import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

const TRANSPARENT = 'rgba(0, 0, 0, 0)'

test('conversations sit on the window background with an inline side header and no line under the header', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const editor = page.locator('main[data-pane="editor"]')
    const rail = page.locator('.navigation-rail')
    // Distinct colors catch a panel color leaking back in behind the conversation.
    await page.locator('.app-shell').evaluate((element) => {
      const shell = element as HTMLElement
      shell.style.setProperty('--surfaces-panel', '#243648')
      shell.style.setProperty('--surfaces-window', '#101820')
      shell.dataset.motion = 'true'
    })
    await expect(rail).not.toHaveCSS('background-color', TRANSPARENT)
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()

    const side = page.locator('.conversation-panel[data-placement="side"]')
    await expect(side).toBeVisible()
    await expect(rail).toHaveCSS('background-color', TRANSPARENT)
    await expect(rail).toHaveCSS('border-top-color', TRANSPARENT)
    await expect(rail).toHaveCSS('box-shadow', 'none')
    await expect(rail.locator('> .ambient-layer')).toBeHidden()
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
    await page.screenshot({ path: testInfo.outputPath('conversation-side-header.png') })

    await side.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    await expect(center).toBeVisible()
    await expect(editor).toHaveCSS('background-color', TRANSPARENT)
    await expect(editor).toHaveCSS('border-top-color', TRANSPARENT)
    await expect(editor).toHaveCSS('box-shadow', 'none')
    await expect(editor.locator('> .ambient-layer')).toBeHidden()
    await expect(center).toHaveCSS('background-color', TRANSPARENT)
    await expect(center.locator('.conversation-messages')).toHaveCSS('background-color', TRANSPARENT)
    await expect(center.locator('> header')).toHaveCSS('border-bottom-width', '0px')
    // Projects on the left keeps the panel color: only the conversation loses it.
    await expect(rail).not.toHaveCSS('background-color', TRANSPARENT)
    await page.screenshot({ path: testInfo.outputPath('conversation-background.png') })
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
