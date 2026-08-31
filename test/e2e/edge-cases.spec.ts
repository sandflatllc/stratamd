import { expect, test } from '@playwright/test'
import { chmod, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, documentStartKey, primaryKey, save, send, setSource } from './harness'

test('Save permission failure keeps disk and shadow unchanged and shows the error', async ({}, testInfo) => {
  const original = '# Permission\n\nSaved on disk.\n'
  // Avoid making the permission assertion depend on the editor's independent
  // trailing-newline reconciliation; this case isolates Save failure state.
  const edited = '# Permission\n\nUnsaved shadow is retained.'
  const value = await Scenario.create(testInfo, original, 'permission.md')

  try {
    const page = await value.launch()
    await setSource(page, edited)
    await value.waitForBuffer(edited)
    const before = await page.evaluate(async () => (await window.strata.getState()).activeDocument)

    await chmod(dirname(value.file), 0o500)
    await page.keyboard.press(primaryKey('s'))
    await expect(page.getByRole('status')).toContainText(/EACCES|permission denied/i)

    expect(await readFile(value.file, 'utf8')).toBe(original)
    const after = await page.evaluate(async () => (await window.strata.getState()).activeDocument)
    expect(after).toEqual(before)
  } finally {
    await chmod(dirname(value.file), 0o700).catch(() => undefined)
    await value.dispose()
  }
})

test('deleted while open keeps the tab and attachment, then Save recreates the exact shadow', async ({}, testInfo) => {
  const original = '# Deleted document\n\nSaved on disk.\n'
  const shadow = '# Deleted document\n\nUnsaved shadow survives deletion.\n'
  const value = await Scenario.create(testInfo, original, 'deleted.md')

  try {
    const page = await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')

    const source = page.getByRole('textbox', { name: /source editor/i })
    await page.keyboard.press(primaryKey('/'))
    await expect(source).toBeVisible()
    await source.fill(shadow)
    await value.waitForBuffer(shadow)

    await rm(value.file)
    const banner = page.getByRole('status').filter({ hasText: /was deleted/i })
    await expect(banner).toContainText(/tab stays open; Save will recreate it/i, { timeout: 10_000 })
    await expect(page.getByRole('tab', { name: /deleted\.md/i })).toBeVisible()
    await expect(page.locator('.agents-panel .agent-row')).toContainText('Agent A')

    await save(page)
    expect(await readFile(value.file, 'utf8')).toBe(shadow)
    await expect(banner).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /deleted\.md/i })).toBeVisible()
    await expect(page.locator('.agents-panel .agent-row')).toContainText('Agent A')
  } finally {
    await value.dispose()
  }
})

test('invalid UTF-8 opens source-only and read-only without creating document metadata', async ({}, testInfo) => {
  const invalid = Buffer.from([0x23, 0x20, 0x66, 0x6f, 0x80, 0x6f, 0x0a])
  const value = await Scenario.create(testInfo, invalid, 'invalid.md')

  try {
    const page = await value.launch()
    const source = page.getByRole('textbox', { name: /source editor/i })

    await expect(source).toBeVisible()
    await expect(source).toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: /source/i })).toBeDisabled()
    await expect(page.getByRole('button', { name: /^Saved?$/i })).toBeDisabled()
    await expect(page.getByRole('status')).toContainText(
      'Invalid UTF-8. Opened read-only in source view.',
    )
    await expect(page.getByRole('textbox', { name: /document editor/i })).toBeHidden()

    const documentEntries = await readdir(join(String(value.env.XDG_DATA_HOME), 'stratamd', 'docs'))
    expect(documentEntries).toEqual([])
  } finally {
    await value.dispose()
  }
})

test('a missing ghost stays struck through in the explorer until Forget', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Missing\n\nKeep the ghost.\n', 'missing.md')
  await value.writeSettings({ explorerFolders: [dirname(value.file)] })

  try {
    const page = await value.launch()
    await page.getByRole('button', { name: /Close tab/i }).click()
    await rm(value.file)
    await page.getByRole('button', { name: /Refresh/i }).click()

    const missing = page.locator('.file-row.missing').filter({ hasText: 'missing.md' })
    await expect(missing).toBeVisible()
    await expect(missing.locator('button').first().locator('span').first()).toHaveCSS('text-decoration-line', 'line-through')
    await expect(page.getByText(/1 missing/i)).toBeVisible()

    await missing.getByRole('button', { name: /forget/i }).click()
    await expect(missing).toHaveCount(0)
  } finally {
    await value.dispose()
  }
})

test('a document over 2 MB opens in the full visual editor while review and Send still work', async ({}, testInfo) => {
  test.slow()
  const filler = 'x'.repeat(2 * 1024 * 1024)
  const original = `# Oversized\n\nOriginal proposal.\n\n${filler}\n`
  const proposed = original.replace('Original proposal.', 'Agent proposal.')
  const withOwnerEdit = proposed.replace('# Oversized', '# Oversized updated')
  const value = await Scenario.create(testInfo, original, 'oversized.md')

  try {
    const startedAt = Date.now()
    const page = await value.launch()
    const visual = page.getByRole('textbox', { name: /document editor/i })
    await expect(visual).toBeVisible({ timeout: 30_000 })
    const readyMs = Date.now() - startedAt
    testInfo.annotations.push({ type: 'large-document-ready-ms', description: String(readyMs) })
    await testInfo.attach('large-document-readiness.json', {
      body: Buffer.from(`${JSON.stringify({ bytes: Buffer.byteLength(original), readyMs })}\n`),
      contentType: 'application/json',
    })
    await expect(page.getByRole('button', { name: /source/i })).toBeEnabled()
    await expect(page.getByRole('status').filter({ hasText: /size ceiling|source view only/i })).toHaveCount(0)

    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    await value.tag('agent-a', 'Agent A')
    const state = await value.state()
    expect(state.buffer).toBeTruthy()
    await value.atomicWrite(state.buffer!, proposed)
    await expect(page.getByRole('button', { name: /^Keep change /i }).first()).toBeVisible({ timeout: 10_000 })

    await visual.focus()
    await page.keyboard.press(documentStartKey)
    await page.keyboard.press('End')
    await page.keyboard.insertText(' updated')
    await value.waitForBuffer(withOwnerEdit)
    await expect(page.getByRole('button', { name: /^Send(?:\b|$)/i })).toBeEnabled()

    await send(page, { note: 'Review the oversized document.' })
    const delivery = await value.attach('agent-a', 'Agent A')
    expect(delivery.event).toBe('send')
    expect(delivery.notes).toEqual(['Review the oversized document.'])
    expect(delivery.text).toContain('Oversized updated')
    expect(await readFile(value.file, 'utf8')).toBe(original)
  } finally {
    await value.dispose()
  }
})
