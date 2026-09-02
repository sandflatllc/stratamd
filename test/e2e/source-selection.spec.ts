import { expect, test } from '@playwright/test'
import { Scenario, primaryKey } from './harness'
import { selectTextInVisualEditor } from './harness'

// Source view (usability round 2 §5.8): the selection follows the view change
// in both directions, and typing in source view no longer reparses per key.

test('the selection carries into source view and back, and source typing lands in the visual view', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Map\n\nFirst sentence here.\n\nSecond **bold** sentence.\n', 'map.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    const source = page.getByRole('textbox', { name: /source editor/i })

    await selectTextInVisualEditor(page, 'bold')
    await page.keyboard.press(primaryKey('/'))
    await expect(source).toBeVisible()
    await expect(source).toBeFocused()
    expect(await source.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('bold')

    // Select in source, switch back: the visual selection is the same words.
    await source.evaluate((node: HTMLTextAreaElement) => {
      const start = node.value.indexOf('First sentence')
      node.setSelectionRange(start, start + 'First sentence'.length)
    })
    await page.keyboard.press(primaryKey('/'))
    await expect(editor).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('First sentence')

    // Typing in source view: the visual view catches up once typing pauses.
    await page.keyboard.press(primaryKey('/'))
    await source.evaluate((node: HTMLTextAreaElement) => { const end = node.value.indexOf('here.') + 'here.'.length; node.setSelectionRange(end, end) })
    await page.keyboard.type(' Added in source.', { delay: 15 })
    await page.keyboard.press(primaryKey('/'))
    await expect(editor.locator('p').first()).toHaveText('First sentence here. Added in source.')
    await scenario.waitForBuffer('# Map\n\nFirst sentence here. Added in source.\n\nSecond **bold** sentence.\n')
  } finally {
    await scenario.dispose()
  }
})
