import { expect, test, type Page } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

// Agents (§6.9, decided 2026-09-06): subagents of the newest turn show as
// clusters in the conversation header, six arcs to a bot, and open the Agents
// dialog. docs/design/subagent-activity holds the approved mockup.

async function openLiveThread(page: Page) {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
  return page.locator('.conversation-panel')
}

test('seven agents draw two clusters, the chevron folds them to one summary bot, and the fold survives a reload', async ({}, testInfo) => {
  const engine = await startEngine({ agentTasks: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const panel = await openLiveThread(page)
    const agents = panel.getByRole('group', { name: 'Agents in this turn' })
    await expect(agents.getByRole('button', { name: /^Agents 1 to 6: 3 working, 1 failed, 2 done$/ })).toBeVisible()
    await expect(agents.getByRole('button', { name: /^Agents 7 to 7: 1 working$/ })).toBeVisible()
    // The nested agent is a shorter arc in the first cluster; the arcs carry the agent's title for hover.
    await expect(agents.locator('.conversation-agent-arc[data-depth="2"]')).toHaveCount(1)
    await expect(agents.locator('.conversation-agent-arc[data-state="failed"]')).toHaveCount(1)

    await agents.getByRole('button', { name: 'Hide agent clusters' }).click()
    await expect(agents.getByRole('button', { name: /^7 agents: 4 working, 1 failed, 2 done$/ })).toBeVisible()
    await expect(agents.getByRole('button', { name: /^Agents 1 to 6/ })).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('button', { name: 'Docs menu', exact: true })).toBeVisible()
    const again = (await openLiveThread(page)).getByRole('group', { name: 'Agents in this turn' })
    await expect(again.getByRole('button', { name: /^7 agents:/ })).toBeVisible()
    await again.getByRole('button', { name: 'Show agent clusters' }).click()
    await expect(again.getByRole('button', { name: /^Agents 7 to 7/ })).toBeVisible()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('a cluster opens the Agents dialog with the tree, filters, background commands, and Show in transcript', async ({}, testInfo) => {
  const engine = await startEngine({ agentTasks: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const panel = await openLiveThread(page)
    await panel.getByRole('button', { name: /^Agents 1 to 6/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Agents' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('7 agents in this turn')).toBeVisible()
    await expect(dialog.getByText('4 working', { exact: true })).toBeVisible()
    await expect(dialog.getByText('2 levels deep')).toBeVisible()
    const rows = dialog.locator('.conversation-agent')
    await expect(rows).toHaveCount(7)
    // Families stay together: the inferred child sits right under its parent, one level in and marked as inferred.
    await expect(rows.nth(1)).toContainText('Analyze e2e harness flakiness')
    await expect(rows.nth(1)).toContainText('Check reduced-motion coverage')
    await expect(rows.nth(2)).toHaveAttribute('data-depth', '2')
    await expect(rows.nth(2)).toContainText('L2?')
    await expect(rows.nth(0)).toContainText('Of 126 files, 31 assert nothing a type check would not catch.')
    await expect(rows.nth(0)).toContainText('269k tokens · 40 tool uses')
    await expect(dialog.getByRole('heading', { name: 'Background commands' })).toBeVisible()
    await expect(dialog.getByText('Run the experiment at six workers')).toBeVisible()

    await dialog.getByRole('button', { name: 'Failed', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('session limit reached')
    await dialog.getByRole('button', { name: 'All', exact: true }).click()
    await expect(rows).toHaveCount(7)

    // Show in transcript closes the dialog and brings the spawn row into view inside its call group.
    await rows.nth(4).getByRole('button', { name: 'Show in transcript' }).click()
    await expect(dialog).toHaveCount(0)
    const spawnRow = panel.locator('[data-work-entry-id="task-ag5-start"]')
    await expect(spawnRow).toBeVisible()
    await expect(spawnRow).toBeInViewport()

    // Escape closes and returns focus to the cluster that opened it.
    const cluster = panel.getByRole('button', { name: /^Agents 1 to 6/ })
    await cluster.click()
    await expect(page.getByRole('dialog', { name: 'Agents' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Agents' })).toHaveCount(0)
    await expect(cluster).toBeFocused()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
