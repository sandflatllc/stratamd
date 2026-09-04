import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('workspace restores center and side placement, open tabs, and thread switching in place', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await scenario.launchEmpty()
    await expect(page.locator('.conversation-island')).toBeVisible()
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    await expect(page.locator('.conversation-island')).toContainText('Live engine thread')
    // A document remains open behind the conversation when the app quits.
    await page.evaluate((path) => window.strata.openDocument(path), scenario.file)
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
    await page.getByRole('button', { name: 'Conversations menu' }).click()
    await page.getByRole('menuitem', { name: /Live engine thread/ }).click()
    await expect(page.locator('.conversation-island')).toBeVisible()
    await page.getByRole('button', { name: 'Open Second engine thread', exact: true }).click()
    await expect(page.locator('.conversation-island')).toContainText('Second engine thread')
    await scenario.stop()
    page = await scenario.launchEmpty()
    await expect(page.locator('.conversation-island')).toContainText('Second engine thread')
    await page.getByRole('button', { name: /^Conversations/ }).click()
    await expect(page.getByRole('menuitem', { name: /Live engine thread/ }).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Move to side' }).click()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await scenario.stop()
    page = await scenario.launchEmpty()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toContainText('Second engine thread')
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    // t1 already has a center tab. Selecting it from Projects must still stay on the left.
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    // Thread selection navigates after the double-click delay; text also exists in the hidden tab.
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toContainText('Live engine thread')
    await expect(page.locator('.conversation-island')).toHaveCount(0)
    // Losing only the layout preference returns to the centered default even with a saved document.
    await page.evaluate(() => localStorage.removeItem('stratamd.workspace.v1'))
    await scenario.stop()
    page = await scenario.launchEmpty()
    await expect(page.locator('.conversation-island')).toContainText('Live engine thread')
    // A file explicitly named on launch takes focus, but that intent is consumed before a reload.
    await scenario.stop()
    page = await scenario.launch()
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
    await page.getByRole('button', { name: 'Open in center' }).click()
    await expect(page.locator('.conversation-island')).toBeVisible()
    await page.reload()
    await expect(page.locator('.conversation-island')).toContainText('Live engine thread')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
