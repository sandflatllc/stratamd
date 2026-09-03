import { expect, test } from '@playwright/test'
import { primaryKey, Scenario } from './harness'

// The right-click menu (usability round 2 §5.15) carries Cut, Copy, Paste,
// and Select all beside the annotate buttons.

test('right-click offers Copy, Cut, Paste, and Select all on the word under the pointer', { tag: '@clipboard' }, async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Menu\n\nAlpha beta gamma.\n', 'menu.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    // The body paragraph; its text changes as the test pastes and cuts, so no text filter.
    const paragraph = editor.locator('p').last()
    await expect(paragraph).toHaveText('Alpha beta gamma.')
    await page.waitForTimeout(1_000)
    // Right-click on the first word itself: its glyph box, not the paragraph's centre.
    const rightClickWord = async () => {
      const point = await paragraph.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const node = walker.nextNode() as Text
        const range = document.createRange()
        range.setStart(node, 1)
        range.setEnd(node, 2)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })
      // Let the previous menu close and the caret settle, as the other
      // right-click specs do, then wait as long as they wait.
      await expect(menu).toBeHidden()
      await page.waitForTimeout(300)
      await page.mouse.click(point.x, point.y, { button: 'right' })
      await expect(menu).toBeVisible({ timeout: 10_000 })
    }
    const menu = page.getByRole('menu', { name: /annotate selection/i })

    await rightClickWord()
    await expect(menu.getByRole('group', { name: 'Edit' })).toBeVisible()

    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    await menu.getByRole('menuitem', { name: 'Copy' }).click()
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('Alpha')

    // Select all takes the whole document.
    await rightClickWord()
    await menu.getByRole('menuitem', { name: 'Select all' }).click()
    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    await page.keyboard.press(primaryKey('c'))
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain('Alpha beta gamma.')
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain('Menu')

    // Close the selection menu before starting the next context-menu action.
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await paragraph.click({ position: { x: 2, y: 8 } })

    // Paste replaces the word under the pointer with the clipboard text.
    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('delta'))
    await rightClickWord()
    await menu.getByRole('menuitem', { name: 'Paste' }).click()
    await expect(paragraph).toHaveText('delta beta gamma.')
    // The native paste's DOM change is still being read back by the editor for a moment.
    await page.waitForTimeout(300)

    // Cut removes the word.
    await rightClickWord()
    await menu.getByRole('menuitem', { name: 'Cut' }).click()
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('delta')
    await expect(paragraph).toHaveText(/^\s*beta gamma\.$/)
  } finally {
    await scenario.dispose()
  }
})
