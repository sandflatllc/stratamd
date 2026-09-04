import { expect, test } from '@playwright/test'
import { Scenario, lineStartKey, primaryKey, selectToLineEndKey, selectTextInVisualEditor } from './harness'

// The annotate pill's C/Q/S hotkeys listen on the window. Two reported
// regressions from that scope: Ctrl+C over a selection opened the comment
// composer instead of copying, and letters typed into the thread-panel reply
// were stolen to open a second composer whenever a selection pill was still up.
// Round 2 (§5.1, §5.2): the bare letters act only on a pointer selection or a
// focused pill, so a keyboard selection keeps typing-to-replace. A thread
// reply keeps Ctrl+Enter, while the cockpit popover uses Enter for quick send.
const document = '# Hotkeys\n\nReply to this thread sentence.\n\nSelect this other sentence.\n'

test('Ctrl+C over a selection copies instead of opening the composer', { tag: '@clipboard' }, async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, document, 'hotkeys.md')
  try {
    const page = await scenario.launch()
    await selectTextInVisualEditor(page, 'Select this other sentence.')
    await expect(page.getByRole('menu', { name: /annotate selection/i })).toBeVisible()

    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    await page.keyboard.press(primaryKey('c'))

    await expect(page.locator('.annotation-composer')).toHaveCount(0)
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('Select this other sentence.')
  } finally {
    await scenario.dispose()
  }
})



test('typing over a keyboard selection replaces the text instead of opening the pill composer', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, document, 'hotkeys.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await page.getByText('Select this other sentence.').click()
    await page.keyboard.press(lineStartKey)
    await page.keyboard.press(selectToLineEndKey)
    // The pill still shows for a keyboard selection; its letters just do not fire.
    await expect(page.getByRole('menu', { name: /annotate selection/i })).toBeVisible()

    await page.keyboard.press('s')

    await expect(page.locator('.annotation-composer')).toHaveCount(0)
    await expect(editor).not.toContainText('Select this other sentence.')
    await expect(editor.locator('p').last()).toHaveText('s')
  } finally {
    await scenario.dispose()
  }
})
