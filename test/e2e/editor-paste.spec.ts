import { expect, test } from '@playwright/test'
import { Scenario, lineEndKey, primaryKey, sourceEditor } from './harness'

// Paste (usability round 2 §5.9): plain text that reads as markdown is
// inserted as markdown; plain prose is inserted as typed.

test('pasting markdown text creates structure while plain prose pastes as words', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Paste\n\nLead paragraph.\n', 'paste.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await page.getByText('Lead paragraph.').click()
    await page.keyboard.press(lineEndKey)
    await page.keyboard.press('Enter')

    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('## Pasted heading\n\n- alpha\n- beta\n\nWith **bold** words.'))
    await page.keyboard.press(primaryKey('v'))
    await expect(editor.locator('h2')).toHaveText('Pasted heading')
    await expect(editor.locator('li')).toHaveCount(2)
    await expect(editor.locator('strong')).toHaveText('bold')

    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('just plain words'))
    await page.keyboard.press(primaryKey('v'))
    await expect(editor.locator('p').last()).toContainText('just plain words')
    await expect(editor.locator('h2')).toHaveCount(1)

    const source = await sourceEditor(page)
    const markdown = await source.inputValue()
    expect(markdown).toContain('## Pasted heading')
    expect(markdown).toContain('- alpha\n- beta')
    expect(markdown).toContain('With **bold** words.just plain words')
  } finally {
    await scenario.dispose()
  }
})
