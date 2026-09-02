import { expect, test } from '@playwright/test'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, primaryKey } from './harness'

// Explorer file operations (usability round 2 §5.10): New file, Rename,
// Move to trash, the recents list, and revealing the active document by
// opening its ancestor folders.

const exists = (path: string) => access(path).then(() => true, () => false)

test('New file, Ctrl+N, Rename, trash, and recents work from the explorer', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Files\n\nFirst document.\n', 'files.md')
  const folder = dirname(scenario.file)
  await writeFile(join(folder, 'other.md'), '# Other\n\nSecond document.\n')
  await scenario.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await scenario.launch()
    const explorer = page.getByRole('complementary', { name: /File explorer/i })

    // New file from the folder menu: named in a dialog, created empty, opened.
    await page.locator('.folder-row').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New file' }).click()
    const nameDialog = page.getByRole('dialog', { name: 'New file' })
    await expect(nameDialog).toBeVisible()
    await nameDialog.getByRole('textbox', { name: 'File name' }).fill('notes')
    await page.keyboard.press('Enter')
    await expect(nameDialog).toBeHidden()
    await expect(page.getByRole('tab', { name: /notes\.md/i })).toHaveAttribute('aria-selected', 'true')
    expect(await exists(join(folder, 'notes.md'))).toBe(true)
    await expect(explorer.getByRole('button', { name: /^notes\.md$/i })).toBeVisible()

    // Ctrl+N makes an untitled file beside the open document and opens it.
    await page.keyboard.press(primaryKey('n'))
    await expect(page.getByRole('tab', { name: /untitled\.md/i })).toHaveAttribute('aria-selected', 'true')
    expect(await exists(join(folder, 'untitled.md'))).toBe(true)
    await page.keyboard.press(primaryKey('n'))
    await expect(page.getByRole('tab', { name: /untitled-2\.md/i })).toHaveAttribute('aria-selected', 'true')

    // The recents list names what was opened, newest first.
    const recents = explorer.getByRole('region', { name: 'Recent documents' })
    await expect(recents.getByRole('button').first()).toHaveText('untitled-2.md')

    // Rename a document that is not open.
    await explorer.getByRole('button', { name: /^other\.md$/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const renameDialog = page.getByRole('dialog', { name: /Rename other\.md/i })
    await expect(renameDialog.getByRole('textbox', { name: 'File name' })).toHaveValue('other.md')
    await renameDialog.getByRole('textbox', { name: 'File name' }).fill('renamed.md')
    await page.keyboard.press('Enter')
    await expect(explorer.getByRole('button', { name: /^renamed\.md$/i })).toBeVisible()
    expect(await exists(join(folder, 'renamed.md'))).toBe(true)
    expect(await exists(join(folder, 'other.md'))).toBe(false)

    // Renaming an open document is refused in plain words.
    await explorer.getByRole('button', { name: /^files\.md$/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await page.getByRole('dialog', { name: /Rename files\.md/i }).getByRole('textbox', { name: 'File name' }).fill('moved.md')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toContainText(/Close the tab for files\.md before you rename it/)
    expect(await exists(scenario.file)).toBe(true)
    await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click()

    // Move to trash asks first. The system trash may be unavailable under a bare X server,
    // in which case the failure is reported rather than the file being deleted outright.
    await explorer.getByRole('button', { name: /^renamed\.md$/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to trash…' }).click()
    const trashDialog = page.getByRole('dialog', { name: /Move renamed\.md to the trash/i })
    await expect(trashDialog).toBeVisible()
    await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
    await expect(trashDialog).toBeHidden()
    await expect.poll(async () => {
      if (await page.getByRole('alert').count()) return 'refused'
      return (await exists(join(folder, 'renamed.md'))) ? 'present' : 'gone'
    }).not.toBe('present')
    if (!(await page.getByRole('alert').count())) {
      await expect(explorer.getByRole('button', { name: /^renamed\.md$/i })).toHaveCount(0)
    }
  } finally {
    await scenario.dispose()
  }
})

test('the active document is revealed by opening its ancestor folders', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Top\n\nTop document.\n', 'top.md')
  const folder = dirname(scenario.file)
  await mkdir(join(folder, 'sub', 'deeper'), { recursive: true })
  const deep = join(folder, 'sub', 'deeper', 'deep.md')
  await writeFile(deep, '# Deep\n\nNested document.\n')
  await scenario.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await scenario.launch()
    const explorer = page.getByRole('complementary', { name: /File explorer/i })
    // Subfolders start collapsed.
    await expect(explorer.getByRole('button', { name: /^deep\.md$/i })).toHaveCount(0)

    const opened = await scenario.cli(['open', deep])
    expect(opened.code, opened.stderr).toBe(0)
    await expect(page.getByRole('tab', { name: /deep\.md/i })).toHaveAttribute('aria-selected', 'true')
    const row = explorer.getByRole('button', { name: /^deep\.md$/i })
    await expect(row).toBeVisible()
    await expect(row.locator('..')).toHaveAttribute('aria-selected', 'true')
    await expect(explorer.getByRole('treeitem', { name: /deeper/ })).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await scenario.dispose()
  }
})
