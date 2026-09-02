import { expect, test } from '@playwright/test'
import { Scenario } from './harness'

// Agent activity (usability round 2 §5.4): when an agent's changes or
// suggestions arrive, a note names the agent and the count, and its Show
// button jumps to the first new item.

test('an agent edit raises a note with the author and count, and Show jumps to the change', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Activity\n\nTop sentence.\n\n${paragraphs.join('\n\n')}\n\nBottom sentence.\n`
  const scenario = await Scenario.create(testInfo, original, 'activity.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    const state = await scenario.state()
    expect(state.buffer).toBeTruthy()
    await scenario.tag('agent-a', 'Agent A')
    await scenario.atomicWrite(state.buffer!, original.replace('Bottom sentence.', 'Bottom sentence, rewritten.'))

    const note = page.getByRole('status').filter({ hasText: /Agent A changed 1 passage/ })
    await expect(note).toBeVisible()
    await note.getByRole('button', { name: 'Show' }).click()
    const editor = page.getByRole('textbox', { name: /Document editor/i })
    const flashing = editor.locator('.strata-review-change.is-flashing')
    await expect(flashing).toHaveCount(1)
    await expect(flashing).toContainText('rewritten')
    await expect(flashing).toBeInViewport()

    // A suggestion counts too, in its own words.
    const suggestion = await scenario.cli(['annotate', scenario.file, '--kind', 'suggestion', '--quote', 'Top sentence.', '--text', 'Opening sentence.', '--as', 'agent-a'])
    expect(suggestion.code, suggestion.stderr).toBe(0)
    await expect(page.getByRole('status').filter({ hasText: /Agent A suggested 1 change/ })).toBeVisible()
  } finally {
    await scenario.dispose()
  }
})
