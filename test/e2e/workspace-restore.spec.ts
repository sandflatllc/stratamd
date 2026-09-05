import { expect, test, type Page } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { selectNavigationTab, type Scenario } from './harness'

// One test per restore aspect, so a late step fails alone instead of taking
// a chain of five launches down with it (the chained form hit the 30 s test
// timeout in a serial run on 2026-09-04). Both tests build the same state
// through `restoreToSide`; the second continues from where the first stops.

/**
 * Opens a thread, then a document beside it, moves the conversation to the
 * center, opens a second thread, restarts, and moves the conversation to the
 * side. Returns the page of the restarted app with the side placement live.
 */
async function restoreToSide(scenario: Scenario): Promise<Page> {
  let page = await scenario.launchEmpty()
  await expect(page.locator('.conversation-island')).toBeVisible()
  await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
  await expect(page.locator('.conversation-island')).toContainText('Live engine thread')
  // A document remains open behind the conversation when the app quits.
  await page.evaluate((path: string) => window.strata.openDocument(path), scenario.file)
  await page.getByRole('button', { name: 'Docs menu', exact: true }).click()
  await page.getByRole('menu', { name: 'Open docs', exact: true }).getByRole('menuitem').click()
  await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
  await selectNavigationTab(page, 'Conversation')
  await page.getByRole('button', { name: 'Open in center' }).click()
  await expect(page.locator('.conversation-island')).toBeVisible()
  await page.getByRole('button', { name: 'Open Second engine thread', exact: true }).click()
  await expect(page.locator('.conversation-island')).toContainText('Second engine thread')
  await scenario.stop()
  page = await scenario.launchEmpty()
  await expect(page.locator('.conversation-island')).toContainText('Second engine thread')
  await expect(page.getByRole('button', { name: 'Open Live engine thread', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Move to side' }).click()
  await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
  return page
}

test('workspace restores center and side placement, open tabs, and thread switching in place', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await restoreToSide(scenario)
    await scenario.stop()
    const page = await scenario.launchEmpty()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toContainText('Second engine thread')
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
    await selectNavigationTab(page, 'Projects')
    // t1 already has a center tab. Selecting it from Projects must still stay on the left.
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    // Thread selection navigates after the double-click delay; text also exists in the hidden tab.
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toContainText('Live engine thread')
    await expect(page.locator('.conversation-island')).toHaveCount(0)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('losing the layout preference returns to the centered default, and a file named on launch takes focus once', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await restoreToSide(scenario)
    await selectNavigationTab(page, 'Projects')
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toContainText('Live engine thread')
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    // Losing only the layout preference returns to the centered default even with a saved document.
    await page.evaluate(() => localStorage.removeItem('stratamd.workspace.v1'))
    await scenario.stop()
    page = await scenario.launchEmpty()
    await expect(page.locator('.conversation-island')).toContainText('Live engine thread')
    // A file explicitly named on launch takes focus, but that intent is consumed before a reload.
    await scenario.stop()
    page = await scenario.launch()
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
    // The document also restores its selected navigation tab.
    await selectNavigationTab(page, 'Conversation')
    await page.getByRole('button', { name: 'Open in center' }).click()
    await expect(page.locator('.conversation-island')).toBeVisible()
    await page.reload()
    await expect(page.locator('.conversation-island')).toContainText('Live engine thread')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
