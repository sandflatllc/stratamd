import { expectActiveDocument } from './harness'
import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('dropdowns remain clickable above the workspace, scroll, and restore keyboard focus', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1100, height: 760 })
    for (let i = 0; i < 24; i++) {
      const path = join(dirname(scenario.file), `notes-${String(i).padStart(2, '0')}.md`)
      await writeFile(path, `# Notes ${i}\n`)
      await page.evaluate((file) => window.strata.openDocument(file), path)
    }
    const docs = page.getByRole('button', { name: 'Docs menu', exact: true })
    const menu = page.getByRole('menu', { name: 'Open docs', exact: true })
    await docs.click()
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('docs-open.png') })
    await menu.getByRole('menuitem', { name: 'notes-00.md', exact: true }).click()
    await expect(menu).toBeHidden()
    await expectActiveDocument(page, /notes-00.md/)
    await docs.click()
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: 'notes-23.md', exact: true })).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('docs-scrolled.png') })
    await page.keyboard.press('Escape')
    await expect(docs).toBeFocused()
    await page.keyboard.press('Enter')
    await menu.getByRole('button', { name: 'Pin notes-00.md', exact: true }).click()
    await expect(menu.getByRole('button', { name: 'Unpin notes-00.md', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await menu.getByRole('button', { name: 'Close notes-01.md', exact: true }).click()
    await expect(menu.getByRole('menuitem', { name: 'notes-01.md', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(page.getByRole('button', { name: 'Conversations menu' })).toBeVisible()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    await page.getByRole('region', { name: 'Conversation' }).getByRole('button', { name: 'Open in center' }).click()
    await page.getByRole('button', { name: 'Conversations menu' }).click()
    await expect(page.getByRole('menu', { name: 'Open conversations' }).getByRole('menuitem', { name: /Live engine thread/ })).toHaveAttribute('aria-current', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('.conversation-panel[data-placement="center"]')).toContainText('Read-side conversation from T3.')
    await docs.click()
    await menu.getByRole('button', { name: 'Close notes-00.md', exact: true }).click()
    await expect(menu.getByRole('menuitem', { name: 'notes-00.md', exact: true })).toHaveCount(0)
    await expect(page.locator('.conversation-panel[data-placement="center"]')).toBeVisible()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('stratamd.workspace.v1')!).conversationCentered)).toBe(true)
    const message = (await page.locator('.conversation-panel[data-placement="center"] .conversation-message').first().boundingBox())!
    await page.mouse.click(message.x + message.width / 2, message.y + message.height / 2)
    await expect(menu).toBeHidden()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
