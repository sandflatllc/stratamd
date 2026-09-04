import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { agentActs, agentEdits, attachThread, openThread } from './cockpit-agent'

// Agent activity (usability round 2 §5.4): when an agent's changes or
// suggestions arrive, a note names the agent and the count, and its Show
// button jumps to the first new item.

test('an agent edit raises a note with the author and count, and Show jumps to the change', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Activity\n\nTop sentence.\n\n${paragraphs.join('\n\n')}\n\nBottom sentence.\n`
  const engine = await startEngine({ titles: { t1: 'Agent A' } })
  const scenario = await seededScenario(testInfo, engine.origin, original, 'activity.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Agent A')
    await attachThread(page, 't1', 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    agentEdits(engine, 't1', scenario.file, 'Bottom sentence.', 'Bottom sentence.', 'Bottom sentence, rewritten.')

    const note = page.getByRole('status').filter({ hasText: /Agent A changed 1 passage/ })
    await expect(note).toBeVisible()
    await note.getByRole('button', { name: 'Show' }).click()
    const editor = page.getByRole('textbox', { name: /Document editor/i })
    const flashing = editor.locator('.strata-review-change.is-flashing')
    await expect(flashing).toHaveCount(1)
    await expect(flashing).toContainText('rewritten')
    await expect(flashing).toBeInViewport()

    // A suggestion counts too, in its own words.
    agentActs(engine, 't1', [{ verb: 'suggest', anchor: { document: scenario.file, quote: 'Top sentence.' }, replacement: 'Opening sentence.' }])
    await expect(page.getByRole('status').filter({ hasText: /Agent A suggested 1 change/ })).toBeVisible()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
