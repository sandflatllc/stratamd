import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

function threePagePdf(): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>']
  for (let page = 1; page <= 3; page++) {
    const text = `BT /F1 13 Tf 48 678 Td (INSPECTION REPORT - SEPTEMBER 2026) Tj 0 -36 Td /F1 24 Tf (Inspection page review ${page}) Tj 0 -44 Td /F1 14 Tf (The offer is clear. The next step needs to be easier to find.) Tj 0 -48 Td (Recommended changes) Tj 0 -34 Td (Keep the inspection button visible after the homeowner reads the offer.) Tj 0 -34 Td (Explain when the visit will be confirmed and what happens next.) Tj 0 -40 Td (${page} / 3) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 730] /Resources << /Font << /F1 9 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>')
  let pdf = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
async function attach(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
  await conversation.locator('.conversation-attachment-input').setInputFiles({ name, mimeType, buffer })
  await conversation.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('region', { name: 'Cockpit project preview', exact: true })).toBeVisible()
}
async function frame(page: Page) {
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' })
  await page.evaluate(async () => { await document.fonts.ready })
}

test('PDF pages really render, paginate and zoom with boundaries and cleanup', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false, projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  try {
    const page = await scenario.launchEmpty()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000) })
    await attach(page, 'inspection-report.pdf', 'application/pdf', threePagePdf())
    const canvas = page.locator('.document-paper canvas')
    await expect(canvas).toHaveAttribute('data-page', '1')
    await expect(page.getByLabel('PDF page')).toHaveText('1 of 3')
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    const first = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
    await frame(page); await page.screenshot({ path: testInfo.outputPath('files-pdf.png') })
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(canvas).toHaveAttribute('data-page', '2')
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(first)
    await page.getByRole('button', { name: 'Next page' }).click(); await expect(canvas).toHaveAttribute('data-page', '3')
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
    const width = await canvas.evaluate((element: HTMLCanvasElement) => element.width)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(canvas).toHaveAttribute('data-zoom', '125')
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(width)
    for (let n = 0; n < 3; n++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect(canvas).toHaveAttribute('data-zoom', '200'); await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled()
    for (let n = 0; n < 7; n++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
    await expect(canvas).toHaveAttribute('data-zoom', '25'); await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Close saved inspection-report.pdf' }).click(); await expect(canvas).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})

test('HTML preview and original source use the central document tab', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false, projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Inspection page</title>
</head>
<body>
  <main>
    <h1>Inspection page</h1>
    <p>Review the offer and the steps after booking.</p>
    <h2>Book an inspection</h2>
    <p>Choose a date. We will confirm the visit and explain what to expect.</p>
    <button>Request an inspection</button>
  </main>
</body>
</html>`
  try {
    const page = await scenario.launchEmpty()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000) })
    await attach(page, 'inspection-page.html', 'text/html', Buffer.from(html))
    await expect.poll(() => scenario.app!.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('https://document.invalid/'))
      return guest?.executeJavaScript('document.querySelector("h1")?.textContent')
    })).toBe('Inspection page')
    await frame(page)
    // Playwright's page screenshot omits sibling WebContentsViews. Capture only this
    // harness-owned X display/window for Linux evidence; never the owner's display.
    if (process.platform === 'linux') {
      const png = await scenario.app!.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        const display = screen.getDisplayMatching(window.getBounds())
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size })
        const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0]!
        const bounds = window.getContentBounds()
        return [...source.thumbnail.crop({ x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y, width: bounds.width, height: bounds.height }).toPNG()]
      })
      await writeFile(testInfo.outputPath('files-html.png'), Buffer.from(png))
    }

    await page.getByRole('button', { name: 'View source' }).click()
    await expect(page.getByLabel('HTML source')).toHaveText(html)
    await page.screenshot({ path: testInfo.outputPath('files-source.png') })
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByLabel('HTML source')).toHaveCount(0)
    const documentId = await scenario.app!.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith('https://document.invalid/'))!.getURL().split('/').pop()!)
    await page.getByRole('button', { name: 'Close saved inspection-page.html' }).click()
    await expect.poll(() => scenario.app!.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getURL().startsWith('https://document.invalid/')).length)).toBe(0)
    // Re-registering this session's handler would throw if the closed document
    // still retained its original handler and the bytes captured by that closure.
    expect(await scenario.app!.evaluate(({ session }, id) => {
      const guest = session.fromPartition(`document-${id}`)
      guest.protocol.handle('https', () => new Response('', { status: 410 }))
      guest.protocol.unhandle('https')
      return true
    }, documentId)).toBe(true)

  } finally { await scenario.dispose(); await engine.close() }
})

test('malicious HTML has no app privileges, storage or popup access', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false, projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  const html = `<!doctype html><html><head><title>Inspection page</title><style>body{font:18px Georgia;padding:40px;color:#172a2a}button{padding:12px}</style></head><body><h1>Inspection page</h1><p>Review the offer and the steps after booking.</p><h2>Book an inspection</h2><p>Choose a date. We will confirm the visit and explain what to expect.</p><button>Request an inspection</button><script>document.body.dataset.script='ran';document.body.dataset.bridge=typeof window.strata;document.body.dataset.node=typeof require;try{localStorage.setItem('leak','1');document.body.dataset.storage='allowed'}catch{document.body.dataset.storage='blocked'};try{document.cookie='leak=1';document.body.dataset.cookie=document.cookie}catch{document.body.dataset.cookie='blocked'};window.open('https://example.com')</script></body></html>`
  try {
    const page = await scenario.launchEmpty()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000) })
    await attach(page, 'inspection-page.html', 'text/html', Buffer.from(html))
    await expect.poll(() => scenario.app!.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('https://document.invalid/'))
      return guest?.executeJavaScript('JSON.stringify(document.body.dataset)')
    })).toBe(JSON.stringify({ script: 'ran', bridge: 'undefined', node: 'undefined', storage: 'blocked', cookie: 'blocked' }))
    expect(await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    await page.getByRole('button', { name: 'View source' }).click()
    await expect(page.getByLabel('HTML source')).toHaveText(html)

    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByLabel('HTML source')).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})

test('corrupt PDF and missing staged bytes show a recoverable document error', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false, projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  try {
    const page = await scenario.launchEmpty()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000) })
    await attach(page, 'inspection-report.pdf', 'application/pdf', Buffer.from('%PDF-1.4\ncorrupt'))
    await expect(page.locator('.document-error')).toContainText('The PDF may be damaged')
    await frame(page); await page.screenshot({ path: testInfo.outputPath('files-file-error.png') })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Locate file', exact: true }).click()
    await (await chooser).setFiles({ name: 'replacement.pdf', mimeType: 'application/pdf', buffer: threePagePdf() })
    await expect(page.locator('.document-paper canvas')).toHaveAttribute('data-page', '1')
    await expect(page.getByLabel('PDF page')).toHaveText('1 of 3')
    await expect(page.getByText('Previewing a replacement. The original attachment has not changed.')).toBeVisible()
    await frame(page); await page.screenshot({ path: testInfo.outputPath('files-replacement.png') })
    await page.getByRole('button', { name: 'Close saved inspection-report.pdf' }).click()
    const failure = await page.evaluate(async () => { try { await window.strata.readDocument({ kind: 'staged', id: 'a_00000000-0000-4000-8000-000000000000', name: 'missing.pdf' }, (await window.strata.getState()).engine.identity ?? null); return '' } catch (error) { return String(error) } })
    expect(failure).toContain('missing.pdf is unavailable')
    await attach(page, 'password-protected.pdf', 'application/pdf', await readFile('test/fixtures/attachments/password-protected.pdf'))
    await expect(page.locator('.document-error')).toContainText('needs a password')
  } finally { await scenario.dispose(); await engine.close() }
})
