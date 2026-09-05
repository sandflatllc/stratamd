import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('center conversation shows the same panel background and ambient layer as the document', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const editor = page.locator('main[data-pane="editor"]')
    // Distinct colors catch a window-colored child covering the panel background.
    await page.locator('.app-shell').evaluate((element) => {
      const shell = element as HTMLElement
      shell.style.setProperty('--surfaces-panel', '#243648')
      shell.style.setProperty('--surfaces-window', '#101820')
      shell.dataset.motion = 'true'
    })
    const documentBackground = await editor.evaluate((element) => getComputedStyle(element).backgroundColor)
    const documentAmbient = await editor.locator('.ambient-layer').evaluate((element) => element.outerHTML)
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('region', { name: 'Conversation' }).getByRole('button', { name: 'Open in center' }).click()

    await expect(editor).toHaveCSS('background-color', documentBackground)
    // Transparent children let both the panel color and its ambient decoration show through.
    await expect(editor.locator('.conversation-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(editor.locator('.conversation-messages')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect(await editor.locator('.ambient-layer').evaluate((element) => element.outerHTML)).toBe(documentAmbient)
    await expect(editor.locator('.ambient-layer')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('conversation-background.png') })

    await page.locator('.app-shell').evaluate((element) => { (element as HTMLElement).dataset.motion = 'false' })
    await expect(editor.locator('.ambient-layer')).toBeHidden()
    await expect(editor).toHaveCSS('background-color', documentBackground)
    await expect(editor.locator('.conversation-panel')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
