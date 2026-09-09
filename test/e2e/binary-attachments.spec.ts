import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function freeze(page: Page) {
  await page.clock.setFixedTime(new Date('2026-09-03T12:02:00Z'))
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' })
  await page.evaluate(async () => { await document.fonts.ready; document.documentElement.dataset.typing = 'true' })
}

async function open(page: Page) {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
  const conversation = page.getByRole('region', { name: 'Conversation' })
  await conversation.getByRole('button', { name: /^(Open in center|Move to side)$/ }).waitFor()
  if (await conversation.getByRole('button', { name: 'Open in center' }).isVisible()) await conversation.getByRole('button', { name: 'Open in center' }).click()
  await expect(conversation.getByRole('button', { name: 'Move to side' })).toBeVisible()
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  return conversation
}

test('PDF and ZIP retain original bytes after draft reload and failed upload retry', async ({}, testInfo) => {
  const engine = await startEngine({ projectsParity: true })
  engine.setMessage('# Inspection page review\n\nThe main offer is clear. I’ll review the inspection flow and the supporting copy.\n\n## Keep the next step visible\n\nUse a direct call to action and explain what happens after a homeowner requests an inspection.\n')
  engine.complete('2026-09-03T12:02:00Z')
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000); BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1) })
    await freeze(page)
    let conversation = await open(page)
    const files = await Promise.all(['inspection-report.pdf', 'inspection-export.zip'].map(async name => ({ name, mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/zip', buffer: await readFile(`test/fixtures/attachments/${name}`) })))
    await conversation.getByRole('textbox', { name: 'Message conversation' }).fill('Use the report and export to check the inspection flow.')
    await conversation.locator('.conversation-attachment-input').setInputFiles(files)
    await expect(conversation.locator('[data-kind="binary"]')).toHaveCount(2)
    await expect(conversation.locator('[data-kind="binary"]').first()).toContainText('PDF')
    await page.reload()
    await freeze(page)
    conversation = await open(page)
    await expect(conversation.locator('[data-kind="binary"]')).toHaveCount(2)
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Use the report and export to check the inspection flow.')
    if (await conversation.getByRole('button', { name: 'Approve', exact: true }).isVisible()) await conversation.getByRole('button', { name: 'Approve', exact: true }).click()
    await conversation.locator('.conversation-messages').evaluate(el => { el.scrollTop = 0 })
    await page.mouse.move(1300, 980)
    await page.screenshot({ path: testInfo.outputPath('files-attached.png') })
    const stop = conversation.getByRole('button', { name: 'Stop', exact: true })
    if (await stop.isVisible()) { await stop.click(); await expect(page.getByText('Stop requested.', { exact: true })).toBeVisible(); await expect(page.getByText('Stop requested.', { exact: true })).toBeHidden() }
    engine.failNextUpload(1)
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(conversation.getByRole('alert')).toContainText('inspection-export.zip could not be sent. Your message and files are still held.')
    await expect(conversation.locator('[data-kind="binary"]')).toHaveCount(2)
    await expect(conversation.locator('.conversation-messages').getByRole('alert')).toContainText('inspection-export.zip could not be sent')
    await expect(conversation.getByRole('alert')).toHaveCount(1)
    await expect(conversation.locator('form').getByRole('alert')).toHaveCount(0)
    await conversation.getByRole('button', { name: 'Retry send', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('files-upload-error.png') })
    await conversation.getByRole('textbox', { name: 'Message conversation' }).fill('This edit must not replace the frozen delivery.')
    await conversation.getByRole('button', { name: 'Retry send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find(command => command.type === 'thread.turn.start')!.message as { text: string; attachments: Array<{ id: string; name: string; type: string; mimeType: string; sizeBytes: number }> }
    expect(turn.text).toBe('Use the report and export to check the inspection flow.')
    expect(turn.attachments).toHaveLength(2)
    for (const [index, attachment] of turn.attachments.entries()) {
      expect(attachment).toMatchObject({ type: 'file', name: files[index]!.name, mimeType: files[index]!.mimeType, sizeBytes: files[index]!.buffer.length })
      expect(engine.uploadBytesById.get(attachment.id)).toEqual(files[index]!.buffer)
    }
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(0)
    await expect(conversation.locator('.conversation-send-failure')).toHaveCount(0)
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('This edit must not replace the frozen delivery.')
  } finally { await scenario.dispose(); await engine.close() }
})

test('a missing binary draft names the file and discard removes its saved draft', async ({}, testInfo) => {
  const engine = await startEngine()
  engine.complete('2026-09-03T12:02:00Z')
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000); BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1) })
    await freeze(page)
    const conversation = await open(page)
    await conversation.locator('.conversation-attachment-input').setInputFiles({ name: 'inspection-report.pdf', mimeType: 'application/pdf', buffer: await readFile('test/fixtures/attachments/inspection-report.pdf') })
    await expect(conversation.locator('[data-kind="binary"]')).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => { try { return JSON.parse(value)?.attachments?.some((file: { kind: string }) => file.kind === 'binary') } catch { return false } }))).toBe(true)
    await page.evaluate(async () => {
      const draft = Object.values(localStorage).map(value => { try { return JSON.parse(value) } catch { return null } }).find(value => value?.attachments?.some((file: { kind: string }) => file.kind === 'binary'))
      if (!draft) throw new Error('Binary draft was not persisted')
      await window.strata.discardConversationAttachment(draft.attachments[0].id)
    })
    const stop = conversation.getByRole('button', { name: 'Stop', exact: true })
    if (await stop.isVisible()) { await stop.click(); await expect(page.getByText('Stop requested.', { exact: true })).toBeVisible(); await expect(page.getByText('Stop requested.', { exact: true })).toBeHidden() }
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(conversation.getByRole('alert')).toContainText('Attachment inspection-report.pdf is no longer staged. Attach it again.')
    await conversation.getByRole('alert').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('files-file-error.png') })
    expect(engine.uploadRequests).toHaveLength(0)
    await conversation.getByRole('button', { name: 'Discard message…', exact: true }).click()
    await page.getByRole('dialog', { name: 'Discard this message draft?' }).getByRole('button', { name: 'Discard message', exact: true }).click()
    await expect(conversation.locator('[data-kind="binary"]')).toHaveCount(0)
    await page.reload()
    await open(page)
    await expect(page.locator('[data-kind="binary"]')).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})
