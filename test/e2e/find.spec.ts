import { expect, test } from '@playwright/test'
import { Scenario, primaryKey, sourceEditor } from './harness'

// Find (PRD §6.1): Ctrl/Cmd+F opens a bar in the editor pane in both views,
// matches ignore case, Enter/Shift+Enter and F3/Shift+F3 step with wrap-around,
// and Escape closes the bar and hands focus back to the editor.
const content = '# Find\n\nFirst target sentence.\n\nSecond Target sentence.\n\nThird TARGET sentence.\n'

test('the find bar counts, steps, and closes back to the visual editor', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, content, 'find.md')
  try {
    const page = await value.launch()
    const editor = page.getByRole('textbox', { name: /Document editor/i })
    await editor.click()
    await page.keyboard.press(primaryKey('f'))
    const field = page.getByRole('textbox', { name: 'Find in document' })
    await expect(field).toBeFocused()
    await page.keyboard.type('target')
    const count = page.locator('.find-bar .find-count')
    await expect(count).toHaveText('1 of 3')
    await expect(editor.locator('.strata-find-match')).toHaveCount(3)
    await expect(editor.locator('.strata-find-current')).toHaveText('target')
    await expect(editor.locator('.strata-find-current')).toBeInViewport()

    await page.keyboard.press('Enter')
    await expect(count).toHaveText('2 of 3')
    await expect(editor.locator('.strata-find-current')).toHaveText('Target')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(count).toHaveText('1 of 3')
    await page.keyboard.press('Shift+Enter')
    await expect(count).toHaveText('3 of 3')
    await page.keyboard.press('F3')
    await expect(count).toHaveText('1 of 3')

    await page.keyboard.type('s')
    await expect(count).toHaveText('No matches')
    await page.keyboard.press('Backspace')
    await expect(count).toHaveText('1 of 3')

    // Escape closes the bar, clears the marks, and puts the caret on the match.
    await page.keyboard.press('Escape')
    await expect(field).toBeHidden()
    await expect(editor.locator('.strata-find-match')).toHaveCount(0)
    await expect(editor).toBeFocused()
    await expect(page.locator('.annotation-composer, .selection-menu')).toHaveCount(0)
  } finally {
    await value.dispose()
  }
})

test('find works over the source text and follows the view toggle', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, content, 'find-source.md')
  try {
    const page = await value.launch()
    const source = await sourceEditor(page)
    await source.click()
    await page.keyboard.press(primaryKey('f'))
    const field = page.getByRole('textbox', { name: 'Find in document' })
    await expect(field).toBeFocused()
    await page.keyboard.type('TARGET')
    const count = page.locator('.find-bar .find-count')
    await expect(count).toHaveText('1 of 3')
    const layer = page.locator('.strata-source-find')
    await expect(layer.locator('.strata-find-match')).toHaveCount(3)
    await expect(layer.locator('.strata-find-current')).toHaveText('target')
    await page.keyboard.press('F3')
    await expect(layer.locator('.strata-find-current')).toHaveText('Target')
    await expect(count).toHaveText('2 of 3')
    await page.keyboard.press('Shift+F3')
    await expect(count).toHaveText('1 of 3')

    // The search survives switching views; the visual editor marks the same three.
    await page.keyboard.press(primaryKey('/'))
    const editor = page.getByRole('textbox', { name: /Document editor/i })
    await expect(editor).toBeVisible()
    await expect(editor.locator('.strata-find-match')).toHaveCount(3)
    await expect(count).toHaveText(/of 3$/)
    await page.keyboard.press(primaryKey('/'))
    await expect(source).toBeVisible()
    await expect(layer.locator('.strata-find-match')).toHaveCount(3)

    await field.focus()
    await page.keyboard.press('Escape')
    await expect(field).toBeHidden()
    await expect(layer).toBeHidden()
    await expect(source).toBeFocused()
  } finally {
    await value.dispose()
  }
})
