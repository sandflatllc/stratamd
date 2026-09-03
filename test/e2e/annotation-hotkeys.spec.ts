import { expect, test } from '@playwright/test'
import { Scenario, lineStartKey, primaryKey, selectToLineEndKey, selectTextInVisualEditor } from './harness'

// The annotate pill's C/Q/S hotkeys listen on the window. Two reported
// regressions from that scope: Ctrl+C over a selection opened the comment
// composer instead of copying, and letters typed into the thread-panel reply
// were stolen to open a second composer whenever a selection pill was still up.
// Round 2 (§5.1, §5.2): the bare letters act only on a pointer selection or a
// focused pill, so a keyboard selection keeps typing-to-replace, and Ctrl+Enter
// inside the composer or a thread reply submits that form, not Send.
const document = '# Hotkeys\n\nReply to this thread sentence.\n\nSelect this other sentence.\n'

test('Ctrl+C over a selection copies instead of opening the composer', async ({}, testInfo) => {
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

test('letters typed into a thread reply stay there while a selection pill is up', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, document, 'hotkeys.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    const annotation = await scenario.cli([
      'annotate', scenario.file,
      '--kind', 'comment',
      '--quote', 'Reply to this thread sentence.',
      '--text', 'Please reword this.',
      '--as', 'agent-a',
    ])
    expect(annotation.code, annotation.stderr).toBe(0)
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    const row = page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'Reply to this thread sentence.' })
    await row.click()
    const thread = page.getByRole('region', { name: /comment thread/i })
    await expect(thread).toBeVisible()

    // A live selection pill in the editor must not claim the reply's letters.
    await selectTextInVisualEditor(page, 'Select this other sentence.')
    await expect(page.getByRole('menu', { name: /annotate selection/i })).toBeVisible()
    const reply = thread.getByRole('textbox', { name: 'Reply' })
    await reply.click()
    await page.keyboard.type('quick check success')

    await expect(reply).toHaveValue('quick check success')
    await expect(page.locator('.annotation-composer')).toHaveCount(0)

    // Ctrl+Enter sends the reply; it never opens Send underneath (§5.2).
    await page.keyboard.press(primaryKey('Enter'))
    await expect(thread.locator('.reply')).toContainText('quick check success')
    await expect(page.getByRole('dialog', { name: /Send changes/i })).toHaveCount(0)
  } finally {
    await scenario.dispose()
  }
})

test('a bare C on a pointer selection with focus in the editor opens the comment composer', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, document, 'hotkeys.md')
  try {
    const page = await scenario.launch()
    await selectTextInVisualEditor(page, 'Select this other sentence.')
    await expect(page.getByRole('menu', { name: /annotate selection/i })).toBeVisible()

    await page.keyboard.press('c')

    const composer = page.locator('.annotation-composer')
    await expect(composer).toBeVisible()
    await expect(composer.locator('.annotation-kind')).toHaveText('comment')
    await expect(composer.locator('textarea')).toBeFocused()

    // Ctrl+Enter inside the composer adds the note instead of opening Send (§5.2).
    await page.keyboard.type('Needs a citation.')
    await page.keyboard.press(primaryKey('Enter'))
    await expect(composer).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /Send changes/i })).toHaveCount(0)
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    await expect(page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'Select this other sentence.' })).toBeVisible()
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
