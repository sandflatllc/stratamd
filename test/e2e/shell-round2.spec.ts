import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario } from './harness'

// Shell details from usability round 2: the thread panel's focus (§5.11), the
// F1 shortcut sheet and F8 stepping (§5.12), toolbar menu keys and the tree
// (§5.13), and the tab menu's bulk close (§5.16).

test('the thread panel focuses its reply and hands focus back on close; F8 steps through comments and questions', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Threads\n\nFirst point to discuss.\n\nSecond point to question.\n\nThird point to suggest.\n', 'threads.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    for (const [kind, quote, text] of [
      ['question', 'Second point to question.', 'Is this right?'],
      ['comment', 'First point to discuss.', 'Tighten this.'],
      ['suggestion', 'Third point to suggest.', 'Third point, suggested.'],
    ] as const) {
      const result = await scenario.cli(['annotate', scenario.file, '--kind', kind, '--quote', quote, '--text', text, '--as', 'agent-a'])
      expect(result.code, result.stderr).toBe(0)
    }

    const row = page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'First point to discuss.' })
    await row.click()
    const thread = page.getByRole('dialog', { name: /comment thread/i })
    await expect(thread).toBeVisible()
    await expect(thread.getByRole('textbox', { name: 'Reply' })).toBeFocused()
    // The jump selects the annotated span, which raises the annotate pill above the thread;
    // Escape closes one surface at a time, so the pill goes first when it is up.
    const pill = page.getByRole('menu', { name: /annotate selection/i })
    if (await pill.isVisible()) {
      await page.keyboard.press('Escape')
      await expect(pill).toBeHidden()
    }
    await page.keyboard.press('Escape')
    await expect(thread).toBeHidden()
    await expect(row).toBeFocused()

    // F8 walks comments and questions in document order, skipping the suggestion; Shift+F8 goes back.
    await page.keyboard.press('F8')
    await expect(page.getByRole('dialog', { name: /comment thread/i })).toContainText('Tighten this.')
    await page.keyboard.press('F8')
    await expect(page.getByRole('dialog', { name: /question thread/i })).toContainText('Is this right?')
    await page.keyboard.press('F8')
    await expect(page.getByRole('dialog', { name: /comment thread/i })).toContainText('Tighten this.')
    await page.keyboard.press('Shift+F8')
    await expect(page.getByRole('dialog', { name: /question thread/i })).toContainText('Is this right?')
  } finally {
    await scenario.dispose()
  }
})

test('F1 lists the shortcuts, toolbar menus take arrow keys, and source view explains the disabled tools', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Keys\n\nA sentence.\n', 'keys.md')
  try {
    const page = await scenario.launch()
    await page.keyboard.press('F1')
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('Add or edit a link')
    await expect(sheet).toContainText('F8')
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()

    // The heading menu: ArrowDown on the summary opens it and focuses the first item.
    const heading = page.getByRole('toolbar', { name: 'Formatting' }).getByLabel('Heading level', { exact: true })
    await heading.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Paragraph' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Heading 1' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('menuitem', { name: 'Heading 6' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(heading).toBeFocused()

    // Source view: the tools are off and the toolbar says why.
    await page.getByRole('button', { name: /source/i }).click()
    await expect(page.getByRole('note')).toContainText(/Formatting tools work in the visual view/)
    await expect(page.getByRole('toolbar', { name: 'Formatting' }).getByLabel('Bold', { exact: true })).toHaveAttribute('title', /visual view/)

    // The explorer is a tree.
    await expect(page.getByRole('tree', { name: 'Documents' })).toBeVisible()
  } finally {
    await scenario.dispose()
  }
})

test('the tab menu closes other, saved, or all tabs and keeps the ones with unsaved edits', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# One\n\nFirst.\n', 'one.md')
  const folder = dirname(scenario.file)
  await writeFile(join(folder, 'two.md'), '# Two\n\nSecond.\n')
  await writeFile(join(folder, 'three.md'), '# Three\n\nThird.\n')
  await scenario.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await scenario.launch()
    const explorer = page.getByRole('complementary', { name: /File explorer/i })
    await explorer.getByRole('button', { name: /^two\.md$/i }).click()
    await explorer.getByRole('button', { name: /^three\.md$/i }).click()
    await expect(page.getByRole('tab')).toHaveCount(3)

    await page.getByRole('tab', { name: /one\.md/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close other tabs' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /one\.md/i })).toBeVisible()

    // A dirty tab survives Close all, and the note says so.
    await explorer.getByRole('button', { name: /^two\.md$/i }).click()
    await page.getByRole('textbox', { name: /document editor/i }).click()
    await page.keyboard.type('Edited ')
    await expect(page.getByRole('tab', { name: /two\.md/i }).locator('.tab-dirty-dot')).toBeVisible()
    await page.getByRole('tab', { name: /two\.md/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close all tabs' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /two\.md/i })).toBeVisible()
    await expect(page.getByRole('status')).toContainText(/1 tab closed\. 1 with unsaved edits stayed open\./)
  } finally {
    await scenario.dispose()
  }
})
