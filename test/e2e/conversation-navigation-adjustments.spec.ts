import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { selectNavigationTab, primaryKey } from './harness'

test('closing the last document restores the active conversation, and settling it opens its project picker', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await selectNavigationTab(page, 'Projects')
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await page.getByRole('textbox', { name: 'Document editor' }).focus()
    await page.keyboard.press(primaryKey('w'))
    await expect(page.locator('.conversation-panel[data-placement="center"]')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).tabs.length)).toBe(0)
    await page.getByRole('button', { name: 'Settle Second engine thread', exact: true }).click()
    await expect(page.locator('.conversation-panel[data-placement="center"]')).toContainText('Live engine thread')
    await page.getByRole('button', { name: 'Settle Live engine thread', exact: true }).click()
    await expect(page.getByRole('region', { name: 'New conversation' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Conversation project' })).toHaveText('Cockpit project')
    await page.screenshot({ path: testInfo.outputPath('settled-project-picker.png') })
  } finally { await scenario.dispose(); await engine.close() }
})

test('closing the last document without an active conversation opens a new thread', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('textbox', { name: 'Document editor' }).focus()
    await page.keyboard.press(primaryKey('w'))
    await expect(page.getByRole('region', { name: 'New conversation' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Open a markdown file' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('last-document-new-thread.png') })
  } finally { await scenario.dispose(); await engine.close() }
})
