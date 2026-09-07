import { expect, test, type Locator } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openAppMenu } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function expectFrame(panel: Locator) {
  const history = panel.locator('.conversation-messages')
  await expect(history).toBeVisible()
  await expect(panel.locator('.conversation-latest')).toBeVisible()
  await expect(panel.locator('.chat-composer-box')).toBeVisible()
  await expect(history).toHaveCSS('backdrop-filter', 'none')
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) await expect(history).toHaveCSS(`border-${corner}-radius`, '14px')
  await expect.poll(() => panel.evaluate(element => {
    const history = element.querySelector('.conversation-messages')!.getBoundingClientRect()
    const header = element.querySelector(':scope > header')!.getBoundingClientRect()
    const composer = element.querySelector('.chat-composer-box')!.getBoundingClientRect()
    const latest = element.querySelector('.conversation-latest')!.getBoundingClientRect()
    return Math.abs(history.top - header.bottom) < 1 && history.bottom < latest.top && latest.bottom <= composer.top + 1
  })).toBe(true)
}

test('opaque transcript meets the toolbar and clears the composer as it grows in both placements', async ({}, testInfo) => {
  const engine = await startEngine()
  engine.postAssistant('t1', '# Reading panel\n\n' + Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}. The last paragraph must remain readable above the composer.`).join('\n\n'))
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1900, 1000))
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    for (const placement of ['side', 'center']) {
      if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
      const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
      const history = panel.locator('.conversation-messages')
      await expect(history).toHaveCSS('background-color', 'rgb(21, 20, 26)')
      await expectFrame(panel)
      const before = (await history.boundingBox())!.height
      await panel.locator('.chat-composer textarea').fill(Array.from({ length: 9 }, (_, i) => `Draft line ${i + 1}`).join('\n'))
      await expect.poll(async () => (await history.boundingBox())!.height).toBeLessThan(before)
      await expectFrame(panel)
      await history.evaluate(el => { el.scrollTop = 0 })
      await panel.getByRole('button', { name: 'Newest', exact: true }).click()
      await expect.poll(() => history.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
      await expect(history.locator('[data-message-id]').getByText('Paragraph 35.', { exact: false })).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`transcript-${placement}.png`) })
      await panel.locator('.chat-composer textarea').fill('')
    }
  } finally { await scenario.dispose(); await engine.close() }
})

test('transcript theme controls preview independently and persist layout, shadow, and colors', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Theme', exact: true }).click()
    const theme = page.getByRole('dialog', { name: 'Theme' })
    await theme.getByRole('button', { name: 'New from this' }).click()
    await theme.getByRole('button', { name: 'Surfaces' }).click()
    const layout = theme.getByRole('combobox', { name: 'Transcript layout' })
    const shadow = theme.getByRole('combobox', { name: 'Transcript shadow', exact: true })
    const strength = theme.getByRole('slider', { name: 'Transcript shadow strength' })
    await expect(strength).toHaveCount(0)
    await expect(shadow).toHaveValue('none')
    await shadow.selectOption('drop-shadow')
    await expect(strength).toHaveValue('1')
    await expect(strength).toHaveAttribute('aria-valuetext', '100%')
    await expect(layout).toHaveValue('panel')
    await layout.selectOption('open')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-transcript-style', 'open')
    await expect(strength).toHaveCount(0)
    for (const [label, color] of [['Transcript background', '#203040'], ['Transcript border', '#607080'], ['Transcript shadow color', '#ff0000']]) {
      await theme.getByLabel(label!, { exact: true }).evaluate((element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }, color!)
    }
    await layout.selectOption('panel')
    const redShadow = /(?:color\(srgb 1 0 0 \/ 0\.65\)|rgba\(255, 0, 0, 0\.65\)) 0px 8px 24px 0px/
    await expect(theme.locator('.theme-sample-transcript')).toHaveCSS('box-shadow', redShadow)
    await strength.focus()
    await strength.press('Home')
    await expect(strength).toHaveAttribute('aria-valuetext', '0%')
    await expect(theme.locator('.theme-sample-transcript')).toHaveCSS('box-shadow', /(?:color\(srgb 0 0 0 \/ 0\)|rgba\(0, 0, 0, 0\)) 0px 0px 0px 0px/)
    await strength.press('End')
    await expect(strength).toHaveAttribute('aria-valuetext', '300%')
    const strongRedShadow = /(?:color\(srgb 1 0 0\)|rgb\(255, 0, 0\)) 0px 24px 72px 8px/
    await expect(theme.locator('.theme-sample-transcript')).toHaveCSS('box-shadow', strongRedShadow)
    const themePath = join(String(scenario.env.XDG_CONFIG_HOME), 'stratamd', 'themes', 'copy-of-strata-vivid.json')
    await expect.poll(async () => JSON.parse(await readFile(themePath, 'utf8')).surfaces).toMatchObject({ 'transcript-style': 'panel', transcript: '#203040', 'transcript-border': '#607080', 'transcript-shadow-style': 'drop-shadow', 'transcript-shadow': '#ff0000', 'transcript-shadow-strength': 3, panel: '#15141a' })
    await theme.getByRole('button', { name: 'Close theme panel' }).click()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const history = page.locator('.conversation-panel[data-placement="side"] .conversation-messages')
    await expect(history).toHaveCSS('background-color', 'rgb(32, 48, 64)')
    await expect(history).toHaveCSS('border-top-color', 'rgb(96, 112, 128)')
    await expect(history).toHaveCSS('box-shadow', strongRedShadow)
    await expect(page.locator('.chat-composer-box')).not.toHaveCSS('box-shadow', strongRedShadow)
    await expect(page.locator('.navigation-rail')).toHaveCSS('background-color', 'rgb(21, 20, 26)')
    await page.getByRole('button', { name: 'Open in center' }).click()
    await expect(page.locator('.conversation-panel[data-placement="center"] .conversation-messages')).toHaveCSS('box-shadow', strongRedShadow)
    await page.screenshot({ path: testInfo.outputPath('transcript-shadow-center.png') })
    await page.getByRole('button', { name: 'Move to side' }).click()
    await scenario.stop()
    const restored = await scenario.launch()
    await expect(restored.locator('.app-shell')).toHaveAttribute('data-transcript-style', 'panel')
    await expect(restored.locator('.app-shell')).toHaveAttribute('data-transcript-shadow', 'drop-shadow')
    await restored.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await restored.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await expect(restored.locator('.conversation-panel[data-placement="side"] .conversation-messages')).toHaveCSS('background-color', 'rgb(32, 48, 64)')
    const restoredHistory = restored.locator('.conversation-panel[data-placement="side"] .conversation-messages')
    await expect(restoredHistory).toHaveCSS('box-shadow', strongRedShadow)
    await restored.evaluate(() => window.strata.setThemeValue('surfaces.transcript-style', 'open'))
    await expect(restored.locator('.conversation-panel[data-placement="side"] .conversation-messages')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(restoredHistory).toHaveCSS('box-shadow', 'none')
    await restored.evaluate(() => window.strata.setThemeValue('surfaces.transcript-style', 'panel'))
    await expect(restoredHistory).toHaveCSS('box-shadow', strongRedShadow)
    await restored.evaluate(() => window.strata.setThemeValue('surfaces.transcript-shadow-style', 'none'))
    await expect(restoredHistory).toHaveCSS('box-shadow', 'none')
  } finally { await scenario.dispose(); await engine.close() }
})
