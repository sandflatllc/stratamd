import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function open(page: Page) {
  await page.getByRole('tab', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
  await expect(page.locator('.conversation-panel')).toBeVisible()
  const center = page.getByRole('button', { name: 'Open in center', exact: true })
  if (await center.isVisible()) await center.click()
  await expect(page.locator('.conversation-panel[data-placement="center"]')).toBeVisible()
}
async function capture(page: Page, path: string) {
  await page.clock.setFixedTime(new Date('2026-09-03T12:02:00Z'))
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' })
  await page.evaluate(async () => { await document.fonts.ready; document.documentElement.dataset.typing = 'true' })
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
}
const pdf = async () => ({ name: 'inspection-report.pdf', mimeType: 'application/pdf', buffer: await readFile('test/fixtures/attachments/inspection-report.pdf') })

test('two attachment-only answers preserve associations and uploaded bytes across close, app restart, Hold and partial-upload retry', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', userInputQuestions: [{ id: 'report', question: 'Which report?' }, { id: 'export', question: 'Which export?' }] })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    let page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await open(page)
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Answer question' })
    const report = await pdf(), archive = { name: 'inspection-page.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body><h1>Inspection page</h1><p>Original answer bytes.</p></body></html>') }
    await dialog.getByLabel('Attach to answer report', { exact: true }).setInputFiles(report)
    await dialog.getByLabel('Attach to answer export', { exact: true }).setInputFiles(archive)
    await expect(dialog.getByLabel('Files for report', { exact: true })).toContainText(report.name)
    await expect(dialog.getByLabel('Files for export', { exact: true })).toContainText(archive.name)
    const previewFile = async (file: typeof report, phase: string) => {
      await expect(page.getByRole('dialog', { name: 'Answer question' })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Cockpit project preview', exact: true })).toBeVisible()
      if (file.mimeType === 'application/pdf') {
        const canvas = page.locator('.document-paper canvas')
        await expect(canvas).toHaveAttribute('data-page', '1')
        await expect(page.getByLabel('PDF page')).toHaveText('1 of 1')
        await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled()
        const width = await canvas.evaluate((node: HTMLCanvasElement) => node.width)
        await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
        await expect(canvas).toHaveAttribute('data-zoom', '125')
        expect(await canvas.evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(width)
      } else {
        await expect.poll(() => scenario.app!.evaluate(async ({ webContents }) => {
          const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('https://document.invalid/'))
          return guest?.executeJavaScript('document.querySelector("h1")?.textContent')
        })).toBe('Inspection page')
        await page.getByRole('button', { name: 'View source', exact: true }).click()
        await expect(page.getByLabel('HTML source')).toHaveText(file.buffer.toString('utf8'))
      }
      await capture(page, testInfo.outputPath(`question-${phase}-${file.mimeType === 'application/pdf' ? 'pdf' : 'html-source'}.png`))
      await page.getByRole('button', { name: `Close saved ${file.name}`, exact: true }).click()
      await open(page)
    }
    for (const [id, file] of [['report', report], ['export', archive]] as const) {
      await dialog.getByLabel(`Files for ${id}`, { exact: true }).getByRole('button', { name: file.name, exact: true }).click()
      await previewFile(file, 'staged')
      await page.getByRole('button', { name: 'Answer question', exact: true }).click()
      dialog = page.getByRole('dialog', { name: 'Answer question' })
      await expect(dialog.getByLabel('Files for report', { exact: true })).toContainText(report.name)
      await expect(dialog.getByLabel('Files for export', { exact: true })).toContainText(archive.name)
    }
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    expect(engine.uploadRequests).toEqual([])
    expect(engine.commands).toEqual([])
    await page.reload()
    await open(page)
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Answer question' })
    await expect(dialog.getByLabel('Files for report', { exact: true })).toContainText(report.name)
    await expect(dialog.getByLabel('Files for export', { exact: true })).toContainText(archive.name)
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    expect(engine.uploadRequests).toEqual([])
    engine.failNextUpload(1)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Could not send inspection-page.html')
    expect(engine.commands).toEqual([])
    expect(engine.uploadRequests).toHaveLength(1)
    await scenario.stop()
    page = await scenario.launch()
    await open(page)
    await page.getByRole('button', { name: 'Edit answer', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByRole('textbox', { name: 'Answer report', exact: true }).fill('An edit after the failed Send')
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.user-input.respond')).toHaveLength(1)
    const response = engine.commands[0] as { answers: Record<string, string>; attachmentsByQuestionId: Record<string, Array<{ id: string; name: string; mimeType: string; sizeBytes: number }>> }
    expect(response.answers).toEqual({ report: '', export: '' })
    expect(engine.uploadRequests).toHaveLength(2)
    for (const [id, file] of [['report', report], ['export', archive]] as const) {
      const attachment = response.attachmentsByQuestionId[id]![0]!
      expect(response.attachmentsByQuestionId[id]).toHaveLength(1)
      expect(attachment).toMatchObject({ name: file.name, mimeType: file.mimeType, sizeBytes: file.buffer.length })
      expect(engine.uploadBytesById.get(attachment.id)).toEqual(file.buffer)
      await expect(page.getByLabel(`Submitted files for ${id}`, { exact: true })).toContainText(file.name)
    }
    for (const [id, file] of [['report', report], ['export', archive]] as const) {
      await page.getByLabel(`Submitted files for ${id}`, { exact: true }).getByRole('button', { name: file.name, exact: true }).click()
      await previewFile(file, 'submitted')
    }
    expect(engine.commands.some(command => command.type === 'thread.turn.start')).toBe(false)
    await page.reload()
    await expect(page.getByLabel('Submitted files for report', { exact: true })).toContainText(report.name)
  } finally { await scenario.dispose(); await engine.close() }
})

test('question files use the corrected modal, keep failed staging private, and show submitted file history', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', projectsParity: true })
  engine.setMessage('# Inspection page review\n\nThe main offer is clear. I’ll review the inspection flow and the supporting copy.\n\n## Keep the next step visible\n\nUse a direct call to action and explain what happens after a homeowner requests an inspection.\n')
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000); BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1) })
    await open(page)
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByRole('button', { name: 'Version one', exact: true }).click()
    await dialog.getByLabel('Attach to answer release', { exact: true }).setInputFiles({ name: 'inspection-report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) })
    await expect(dialog.getByRole('alert')).toContainText('inspection-report.pdf is empty')
    await expect(dialog.getByRole('button', { name: 'Hold answer', exact: true })).toBeDisabled()
    await capture(page, testInfo.outputPath('questions-upload-error.png'))
    await dialog.getByLabel('Attach to answer release', { exact: true }).setInputFiles(await pdf())
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByLabel('Files for release', { exact: true })).toContainText('inspection-report.pdf')
    await capture(page, testInfo.outputPath('questions-asking.png'))
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(engine.uploadRequests).toEqual([])
    await capture(page, testInfo.outputPath('questions-held.png'))
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByLabel('Submitted files for release', { exact: true })).toContainText('inspection-report.pdf')
    await capture(page, testInfo.outputPath('questions-sent.png'))
  } finally { await scenario.dispose(); await engine.close() }
})

test('question screenshot markup returns to the same private answer before Hold and Send', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message' })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await open(page)
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByLabel('Attach to answer release', { exact: true }).setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: await readFile('test/fixtures/structured-reading/review-screenshot.png') })
    await dialog.getByRole('button', { name: 'Mark up screen.png', exact: true }).click()
    const markup = page.getByRole('dialog', { name: 'Mark up the image' })
    await expect(markup).toBeVisible()
    await markup.getByRole('button', { name: /^Arrow/ }).click()
    const surface = await markup.locator('.visual-surface').boundingBox()
    if (!surface) throw new Error('Screenshot surface is missing')
    await page.mouse.move(surface.x + 40, surface.y + 40)
    await page.mouse.down()
    await page.mouse.move(surface.x + 140, surface.y + 100, { steps: 5 })
    await page.mouse.up()
    await expect(markup.locator('.visual-stroke[data-tool=arrow]')).toHaveCount(1)
    await markup.locator('textarea').fill('Use the marked screenshot')
    await markup.getByRole('button', { name: 'Hold', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Files for release', { exact: true })).toContainText('screen-marked.png')
    expect(engine.commands).toEqual([])
    expect(engine.uploadRequests).toEqual([])
    await expect(dialog.getByRole('textbox', { name: 'Answer release' })).toHaveValue('Use the marked screenshot')
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.user-input.respond')).toHaveLength(1)
    const response = engine.commands.find(command => command.type === 'thread.user-input.respond') as { attachmentsByQuestionId: { release: Array<{ id: string; type: string; name: string }> } }
    expect(response.attachmentsByQuestionId.release).toEqual([expect.objectContaining({ type: 'image', name: 'screen-marked.png' })])
    expect(engine.uploadBytesById.get(response.attachmentsByQuestionId.release[0]!.id)?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  } finally { await scenario.dispose(); await engine.close() }
})


test('answer file limits and choice-only questions refuse files before any upload', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', userInputQuestions: [{ id: 'choice', question: 'Choose one', allowCustomAnswer: false, options: [{ label: 'One' }] }, { id: 'files', question: 'Supporting files' }] })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await open(page)
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await expect(dialog.getByLabel('Attach to answer choice', { exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'One', exact: true }).click()
    const files = Array.from({ length: 9 }, (_, index) => ({ name: `answer-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Answer ${index}`) }))
    await dialog.getByLabel('Attach to answer files', { exact: true }).setInputFiles(files)
    await expect(dialog.getByRole('alert')).toContainText('8')
    await expect(dialog.getByRole('button', { name: 'Hold answer', exact: true })).toBeDisabled()
    expect(engine.uploadRequests).toEqual([])
    expect(engine.commands).toEqual([])
  } finally { await scenario.dispose(); await engine.close() }
})


test('unheld answer files survive a complete app restart without sending', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message' })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await scenario.launch()
    await open(page)
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByLabel('Attach to answer release', { exact: true }).setInputFiles(await pdf())
    await expect(dialog.getByLabel('Files for release', { exact: true })).toContainText('inspection-report.pdf')
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await scenario.stop()
    page = await scenario.launch()
    await open(page)
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Answer question' })
    await expect(dialog.getByLabel('Files for release', { exact: true })).toContainText('inspection-report.pdf')
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    expect(engine.commands).toEqual([])
    expect(engine.uploadRequests).toEqual([])
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByLabel('Submitted files for release', { exact: true })).toContainText('inspection-report.pdf')
    expect(engine.uploadRequests).toHaveLength(1)
  } finally { await scenario.dispose(); await engine.close() }
})
