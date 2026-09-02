import { expect, test } from '@playwright/test'
import { Scenario, lineEndKey } from './harness'

// Typing across the 180 ms mirror boundary (usability round 2 §5.3). The view
// push that echoes an earlier flush must not replace the editor's text while
// newer keystrokes are still waiting, or those keystrokes vanish.

test('keystrokes typed across several flush boundaries all survive and reach the buffer', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Type\n\nStart here.\n', 'typing.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await page.getByText('Start here.').click()
    await page.keyboard.press(lineEndKey)

    // About 1.5 s of typing at a human pace: eight or nine flushes land underneath it.
    const typed = ' The quick brown fox jumps over the lazy dog, twice, then rests.'
    await page.keyboard.type(typed, { delay: 25 })

    await expect(editor.locator('p').last()).toHaveText(`Start here.${typed}`)
    await scenario.waitForBuffer(`# Type\n\nStart here.${typed}\n`)
    // And the echo of that final flush leaves the editor alone.
    await page.waitForTimeout(600)
    await expect(editor.locator('p').last()).toHaveText(`Start here.${typed}`)
  } finally {
    await scenario.dispose()
  }
})
