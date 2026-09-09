import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function open(page: Page) {
  await page.getByRole('tab', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
  await page.getByRole('button', { name: 'Open in center', exact: true }).click()
  await page.getByRole('button', { name: 'Answer question', exact: true }).click()
  return page.getByRole('dialog', { name: 'Answer question' })
}

test('held answer count and Review match the corrected benchmark', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', projectsParity: true })
  engine.setMessage('# Inspection page review\n\nThe main offer is clear. I’ll review the inspection flow and the supporting copy.\n\n## Keep the next step visible\n\nUse a direct call to action and explain what happens after a homeowner requests an inspection.\n')
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await page.clock.setFixedTime(new Date('2026-09-03T12:02:00Z'))
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000); BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1) })
    const dialog = await open(page)
    await dialog.getByRole('button', { name: 'Version one', exact: true }).click()
    await dialog.getByLabel('Attach to answer release', { exact: true }).setInputFiles({ name: 'inspection-report.pdf', mimeType: 'application/pdf', buffer: await readFile('test/fixtures/attachments/inspection-report.pdf') })
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    const summary = page.getByLabel('Held answers for input-1', { exact: true })
    await expect(summary).toHaveText('1 answer · 1 fileReview')
    await expect(summary.locator('span')).toHaveCSS('border-top-width', '0px')
    await expect(page.getByText('1 answers queued', { exact: true })).toHaveCount(0)
    await expect(page.getByText('1 answer queued', { exact: true })).toHaveCount(0)
    expect(engine.uploadRequests).toEqual([])
    expect(engine.commands.filter(command => command.type !== 'thread.approval.respond')).toEqual([])
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' })
    await page.evaluate(async () => { document.documentElement.dataset.typing = 'true'; await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
    await expect(page.locator('.conversation-working-row')).toContainText('2m 0s')
    await page.screenshot({ path: testInfo.outputPath('questions-held.png'), animations: 'disabled', caret: 'hide' })
    await summary.getByRole('button', { name: 'Review', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Version one', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByLabel('Files for release', { exact: true })).toContainText('inspection-report.pdf')
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(summary).toHaveText('1 answer · 1 fileReview')
  } finally { await scenario.dispose(); await engine.close() }
})

test('Review keeps every question and removal preserves private answer files for reholding', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', userInputQuestions: [{ id: 'first', question: 'First question?' }, { id: 'second', question: 'Second question?' }] })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const dialog = await open(page)
    for (const id of ['first', 'second']) {
      await dialog.getByRole('textbox', { name: `Answer ${id}`, exact: true }).fill(`${id} answer`)
      await dialog.getByLabel(`Attach to answer ${id}`, { exact: true }).setInputFiles({ name: `${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`${id} file`) })
    }
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    const summary = page.getByLabel('Held answers for input-1', { exact: true })
    await expect(summary).toHaveText('2 answers · 2 filesReview')
    await summary.getByRole('button', { name: 'Review', exact: true }).click()
    for (const id of ['first', 'second']) {
      await expect(dialog.getByRole('textbox', { name: `Answer ${id}`, exact: true })).toHaveValue(`${id} answer`)
      await expect(dialog.getByLabel(`Files for ${id}`, { exact: true })).toContainText(`${id}.txt`)
    }
    await dialog.getByRole('button', { name: 'Remove held answer', exact: true }).click()
    await expect(summary).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
    expect(engine.commands).toEqual([])
    expect(engine.uploadRequests).toEqual([])
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    for (const id of ['first', 'second']) {
      await expect(dialog.getByRole('textbox', { name: `Answer ${id}`, exact: true })).toHaveValue(`${id} answer`)
      await expect(dialog.getByLabel(`Files for ${id}`, { exact: true })).toContainText(`${id}.txt`)
    }
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.user-input.respond')).toHaveLength(1)
    const response = engine.commands.find(command => command.type === 'thread.user-input.respond') as { answers: Record<string, string>; attachmentsByQuestionId: Record<string, Array<{ id: string }>> }
    expect(response.answers).toEqual({ first: 'first answer', second: 'second answer' })
    for (const id of ['first', 'second']) expect(engine.uploadBytesById.get(response.attachmentsByQuestionId[id]![0]!.id)).toEqual(Buffer.from(`${id} file`))
  } finally { await scenario.dispose(); await engine.close() }
})
