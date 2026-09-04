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


test('a root folder can be removed from the explorer while the open document stays available', { tag: '@clipboard' }, async ({}, testInfo) => {
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

    await expect(page.getByRole('heading', { name: 'Attached' })).toBeVisible()
    await expect(page.getByText('No threads attached. Start a thread from this document to send it.')).toBeVisible()
  } finally {
    await value.dispose()
  }
})
