import { expect, test } from '@playwright/test'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, primaryKey, selectTextInVisualEditor, setSource } from './harness'

// Shell keyboard and drafts (PRD §6.9): tab shortcuts and middle-click,
// error toasts that stay, drafts that survive Escape, Escape closing one
// surface at a time, and the explorer's Remove folder.

test('tabs cycle from the keyboard, close with the primary modifier and W, and close on middle click', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Keys\n\nFirst document.\n', 'keys.md')
  const folder = dirname(value.file)
  await writeFile(join(folder, 'other.md'), '# Other\n\nSecond document.\n')
  await value.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await value.launch()
    const explorer = page.getByRole('complementary', { name: /File explorer/i })
    await explorer.getByRole('button', { name: /^other\.md$/i }).click()
    const keysTab = page.getByRole('tab', { name: /keys\.md/i })
    const otherTab = page.getByRole('tab', { name: /other\.md/i })
    await expect(otherTab).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Control+Tab')
    await expect(keysTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+Shift+Tab')
    await expect(otherTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press(primaryKey('PageUp'))
    await expect(keysTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press(primaryKey('PageDown'))
    await expect(otherTab).toHaveAttribute('aria-selected', 'true')

    // Middle click closes a clean tab outright.
    await otherTab.click({ button: 'middle' })
    await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1)
    await expect(keysTab).toHaveAttribute('aria-selected', 'true')

    // A dirty tab asks first; Escape keeps it open.
    await explorer.getByRole('button', { name: /^other\.md$/i }).click()
    await expect(otherTab).toHaveAttribute('aria-selected', 'true')
    await setSource(page, '# Other\n\nSecond document, edited.\n')
    await expect(otherTab.locator('.tab-dirty-dot')).toBeVisible()
    await page.keyboard.press(primaryKey('w'))
    const dialog = page.getByRole('dialog', { name: /Close other\.md/i })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(2)

    // A clean tab closes at once.
    await page.keyboard.press('Control+Tab')
    await expect(keysTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press(primaryKey('w'))
    await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(1)
    await expect(otherTab).toHaveAttribute('aria-selected', 'true')
  } finally {
    await value.dispose()
  }
})

test('an error toast uses the danger color, outlives a success, and clears from its button or Escape', { tag: '@clipboard' }, async ({}, testInfo) => {
  const original = '# Toast\n\nOriginal.\n'
  const value = await Scenario.create(testInfo, original, 'toast.md')
  const folder = dirname(value.file)
  await value.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await value.launch()
    await setSource(page, '# Toast\n\nEdited.\n')
    await value.waitForBuffer('# Toast\n\nEdited.\n')
    await chmod(folder, 0o500)
    await page.keyboard.press(primaryKey('s'))
    const alert = page.getByRole('alert')
    await expect(alert).toContainText(/EACCES|permission denied/i)
    const danger = await alert.evaluate((element) => {
      const hex = getComputedStyle(element).getPropertyValue('--controls-danger').trim()
      const probe = document.createElement('i')
      probe.style.color = hex
      document.body.append(probe)
      const rgb = getComputedStyle(probe).color
      probe.remove()
      return { rgb, background: getComputedStyle(element).backgroundColor }
    })
    expect(danger.background).toBe(danger.rgb)

    // Longer than a success toast lives; a success does not paint over it.
    await page.waitForTimeout(3_200)
    await expect(alert).toBeVisible()
    await page.locator('.folder-row').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy full path' }).click()
    await page.waitForTimeout(300)
    await expect(alert).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)

    await alert.getByRole('button', { name: 'Dismiss' }).click()
    await expect(alert).toBeHidden()

    await page.keyboard.press(primaryKey('s'))
    await expect(alert).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(alert).toBeHidden()
  } finally {
    await chmod(folder, 0o700).catch(() => undefined)
    await value.dispose()
  }
})

test('composer and reply drafts survive Escape, and Escape closes one surface at a time', async ({}, testInfo) => {
  const original = '# Drafts\n\nReply to this sentence.\n\nSelect this other sentence.\n'
  const value = await Scenario.create(testInfo, original, 'drafts.md')
  try {
    const page = await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    const edited = `${original}\nOwner edit.\n`
    await setSource(page, edited)
    await value.waitForBuffer(edited)

    await page.keyboard.press(primaryKey('Enter'))
    const composer = page.getByRole('dialog', { name: /Send changes/i })
    await expect(composer).toBeVisible()
    const note = composer.getByRole('textbox', { name: /Note for recipients/i })
    await note.fill('Half-written note')
    const item = composer.locator('.send-item[data-author="user"] input[type="checkbox"]').first()
    await expect(item).toBeChecked()
    await item.uncheck()
    await page.keyboard.press('Escape')
    await expect(composer).toBeHidden()

    await page.keyboard.press(primaryKey('Enter'))
    await expect(composer).toBeVisible()
    await expect(composer.getByRole('textbox', { name: /Note for recipients/i })).toHaveValue('Half-written note')
    await expect(composer.locator('.send-item[data-author="user"] input[type="checkbox"]').first()).not.toBeChecked()
    // A stray click outside closes it; the draft still comes back.
    await page.mouse.click(4, 4)
    await expect(composer).toBeHidden()
    await page.keyboard.press(primaryKey('Enter'))
    await expect(composer.getByRole('textbox', { name: /Note for recipients/i })).toHaveValue('Half-written note')
    await page.keyboard.press('Escape')

    const annotation = await value.cli([
      'annotate', value.file,
      '--kind', 'comment',
      '--quote', 'Reply to this sentence.',
      '--text', 'Please reword this.',
      '--as', 'agent-a',
    ])
    expect(annotation.code, annotation.stderr).toBe(0)
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    const row = page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'Reply to this sentence.' })
    await row.click()
    const thread = page.getByRole('region', { name: /comment thread/i })
    await expect(thread).toBeVisible()
    const reply = thread.getByRole('textbox', { name: 'Reply' })
    await reply.click()
    await page.keyboard.type('Unsent reply')

    // The annotate menu is above the thread: the first Escape closes only it.
    await selectTextInVisualEditor(page, 'Select this other sentence.')
    const menu = page.getByRole('menu', { name: /annotate selection/i })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(thread).toBeVisible()
    await expect(thread.getByRole('textbox', { name: 'Reply' })).toHaveValue('Unsent reply')

    await page.keyboard.press('Escape')
    await expect(thread).toBeHidden()
    await row.click()
    await expect(thread).toBeVisible()
    await expect(thread.getByRole('textbox', { name: 'Reply' })).toHaveValue('Unsent reply')
  } finally {
    await value.dispose()
  }
})

test('a root folder can be removed from the explorer, and the empty agents panel offers the attach prompt', { tag: '@clipboard' }, async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Remove\n\nKeep me remembered.\n', 'remove.md')
  const folder = dirname(value.file)
  await value.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await value.launch()
    await expect(page.locator('.explorer-note')).toContainText(/^Up to date · 1 file/)
    await expect(page.locator('.explorer-note')).not.toContainText(/ghost/i)

    // File rows keep the one-item menu.
    await page.getByRole('button', { name: /^remove\.md$/i }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy full path' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Remove folder' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.locator('.folder-row').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove folder' }).click()
    await expect(page.locator('.folder-row')).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText(/Folder removed/)
    const settingsPath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
    await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')).explorerFolders ?? []).toEqual([])
    // The open document is untouched.
    await expect(page.getByRole('tab', { name: /remove\.md/i })).toHaveAttribute('aria-selected', 'true')

    await value.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    await page.getByRole('button', { name: 'Copy the prompt for your agent' }).click()
    await expect.poll(() => value.app!.evaluate(({ clipboard }) => clipboard.readText())).toContain('stratamd attach --name')
    await expect(page.getByRole('status')).toContainText(/Prompt copied/)
  } finally {
    await value.dispose()
  }
})
