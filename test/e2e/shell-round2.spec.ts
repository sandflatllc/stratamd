import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { agentActs, annotationByText, attachThread, openThread } from './cockpit-agent'

// Shell details from usability round 2: Conversation focus (§5.11), the
// F1 shortcut sheet and F8 stepping (§5.12), toolbar menu keys and the tree
// (§5.13), and the tab menu's bulk close (§5.16).


test('an item focuses its reply and hands focus back on close; F8 steps through comments and questions', async ({}, testInfo) => {
  const engine = await startEngine({ titles: { t1: 'Agent A' } })
  const scenario = await seededScenario(testInfo, engine.origin, '# Threads\n\nFirst point to discuss.\n\nSecond point to question.\n\nThird point to suggest.\n', 'threads.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Agent A')
    await attachThread(page, 't1', 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    agentActs(engine, 't1', [
      { verb: 'question', anchor: { document: scenario.file, quote: 'Second point to question.' }, text: 'Is this right?' },
      { verb: 'comment', anchor: { document: scenario.file, quote: 'First point to discuss.' }, text: 'Tighten this.' },
      { verb: 'suggest', anchor: { document: scenario.file, quote: 'Third point to suggest.' }, replacement: 'Third point, suggested.' },
    ])
    await annotationByText(scenario, 'Third point, suggested.')

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    const row = page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'First point to discuss.' })
    await row.click()
    const thread = page.getByRole('region', { name: /comment thread/i })
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
    await expect(page.getByRole('region', { name: /comment thread/i })).toContainText('Tighten this.')
    await page.keyboard.press('F8')
    await expect(page.getByRole('region', { name: /question thread/i })).toContainText('Is this right?')
    await page.keyboard.press('F8')
    await expect(page.getByRole('region', { name: /comment thread/i })).toContainText('Tighten this.')
    await page.keyboard.press('Shift+F8')
    await expect(page.getByRole('region', { name: /question thread/i })).toContainText('Is this right?')
  } finally {
    await scenario.dispose()
    await engine.close()
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
    await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(3)

    await page.getByRole('tab', { name: /one\.md/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close other tabs' }).click()
    await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /one\.md/i })).toBeVisible()

    // A dirty tab survives Close all, and the note says so.
    await explorer.getByRole('button', { name: /^two\.md$/i }).click()
    await page.getByRole('textbox', { name: /document editor/i }).click()
    await page.keyboard.type('Edited ')
    await expect(page.getByRole('tab', { name: /two\.md/i }).locator('.tab-dirty-dot')).toBeVisible()
    await page.getByRole('tab', { name: /two\.md/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close all tabs' }).click()
    await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /two\.md/i })).toBeVisible()
    await expect(page.getByRole('status')).toContainText(/1 tab closed\. 1 with unsaved edits stayed open\./)
  } finally {
    await scenario.dispose()
  }
})
