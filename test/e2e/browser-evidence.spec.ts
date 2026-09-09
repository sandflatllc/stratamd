import { expect, test } from './test'
import { readFile, copyFile } from 'node:fs/promises'
import { startEngine, seededScenario } from './cockpit-engine-harness'
import { startPreviewPage } from './preview-page'
import { openThread } from './cockpit-agent'
import type { BrowserEvidenceView } from '../../src/shared/browser-evidence'

// Real Chromium capture and WebM encoding; the engine transport records actual uploads.
test('browser evidence saves PNG bytes, records a browser session, uploads the completed WebM, and opens retained media', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launchEmpty()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect.poll(() => engine.hosts().length).toBe(1)
    await openThread(page, 'Live engine thread')
    const opened = await engine.automation('t1', 'open', { url: site.origin })
    expect(opened.ok).toBe(true)
    expect((await engine.automation('t1', 'evaluate', { expression: 'false' })).result).toBe(false)
    expect((await engine.automation('t1', 'evaluate', { expression: '0' })).result).toBe(0)
    expect((await engine.automation('t1', 'snapshot', {})).ok).toBe(true)
    const evidence = () => page.evaluate(async () => (await window.strata.getState()).preview.evidence ?? [])
    const screenshot = (await evidence())[0]!
    expect((await readFile(screenshot.path)).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]))
    const started = await engine.automation('t1', 'recordingStart', {})
    expect(started.ok, JSON.stringify(started)).toBe(true)
    expect((await engine.automation('t1', 'evaluate', { expression: "document.body.style.background = 'lightblue'" })).ok).toBe(true)
    const stopped = await engine.automation('t1', 'recordingStop', {}, { timeoutMs: 30_000 })
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true)
    const recording = stopped.result as BrowserEvidenceView
    expect(recording.uploadedAttachmentId).toBeTruthy()
    const bytes = await readFile(recording.path)
    await copyFile(recording.path, testInfo.outputPath('browser-session.webm'))
    await copyFile(screenshot.path, testInfo.outputPath('browser-screenshot.png'))
    expect(bytes.readUInt32BE(0)).toBe(0x1a45dfa3)
    expect(engine.uploadRequests).toContainEqual({ attachmentId: recording.uploadedAttachmentId, contentType: 'video/webm', byteLength: bytes.length })
    engine.postAssistant('t1', '# Browser review\n\nThe inspection page and completed browser recording are available below.')
    await openThread(page, 'Live engine thread')
    const card = page.getByRole('region', { name: 'Screenshot evidence' })
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('evidence-saved.png'), animations: 'disabled' })
    await card.getByRole('button', { name: 'Open screenshot' }).click()
    const preview = page.getByRole('region', { name: 'Cockpit project preview' })
    await expect(preview.getByRole('img', { name: screenshot.name })).toBeVisible()
    await expect(preview).toContainText('Saved screenshot')
    await expect(preview.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('evidence-preview.png'), animations: 'disabled' })
    await preview.getByRole('button', { name: 'Annotate', exact: true }).click()
    const annotation = page.getByRole('dialog', { name: 'Mark up the image' })
    await expect(annotation).toBeVisible()
    await annotation.getByRole('textbox', { name: 'Visual comment' }).fill('Keep the heading legible.')
    await page.keyboard.press('Escape')
    await expect(annotation).toBeHidden()
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).engine.projects.flatMap(project => project.visualComments ?? []).some(comment => comment.draft?.destination.threadId === 't1'))).toBe(true)
    await preview.getByRole('button', { name: `Close saved ${screenshot.name}` }).click()
    await openThread(page, 'Live engine thread')
    await page.getByRole('button', { name: 'View completed copy' }).click()
    const video = page.getByRole('region', { name: 'Cockpit project preview' }).locator('video')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  } finally { await scenario.stop(); await engine.close(); await site.close() }
})

test('a refused recording upload keeps the local copy and retries the known destination', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  let release!: () => void
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const handlers = engine.server.listeners('request')
  engine.server.removeAllListeners('request')
  let refuse = true
  engine.server.on('request', (request, response) => {
    if (request.url?.startsWith('/upload/') && refuse) {
      refuse = false; reached()
      void gate.then(() => { request.resume(); response.statusCode = 503; response.end('Temporarily unavailable') })
      return
    }
    for (const handler of handlers) handler.call(engine.server, request, response)
  })
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launchEmpty()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect.poll(() => engine.hosts().length).toBe(1)
    await openThread(page, 'Live engine thread')
    engine.postAssistant('t1', '# Browser review\n\nThe completed recording stays available while it copies to the agent environment.')
    expect((await engine.automation('t1', 'open', { url: site.origin })).ok).toBe(true)
    const started = await engine.automation('t1', 'recordingStart', {})
    expect(started.ok, JSON.stringify(started)).toBe(true)
    const stopped = engine.automation('t1', 'recordingStop', {}, { timeoutMs: 30_000 })
    await waiting
    const card = page.getByRole('region', { name: 'Recording evidence' })
    await expect(card).toHaveAttribute('data-evidence-state', 'transferring')
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('evidence-transfer.png'), animations: 'disabled' })
    release()
    expect((await stopped).error?._tag).toBe('PreviewAutomationRecordingTransferError')
    await expect(card).toHaveAttribute('data-evidence-state', 'failed')
    await expect(card).toContainText(engine.origin)
    await expect(card.getByRole('progressbar')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('evidence-failed.png'), animations: 'disabled' })
    const saved = await page.evaluate(async () => (await window.strata.getState()).preview.evidence![0]!)
    const original = await readFile(saved.path)
    await card.getByRole('button', { name: 'Retry copy' }).click()
    await expect(card).toHaveAttribute('data-evidence-state', 'saved')
    expect(await readFile(saved.path)).toEqual(original)
    expect(engine.uploadRequests).toHaveLength(1)
  } finally { release(); await scenario.stop(); await engine.close(); await site.close() }
})

test('owner takeover pauses recording and still permits saving the completed copy', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  scenario.env.STRATAMD_PREVIEW_PROBE = '1'
  try {
    const page = await scenario.launchEmpty()
    await expect.poll(() => engine.hosts().length).toBe(1)
    expect((await engine.automation('t1', 'open', { url: site.origin })).ok).toBe(true)
    expect((await engine.automation('t1', 'recordingStart', {})).ok).toBe(true)
    const tab = await page.evaluate(async () => (await window.strata.getState()).preview.tabs[0]!)
    expect(tab.recording).toBe('recording')
    await page.evaluate(id => (window as unknown as { strataPreviewProbe: { humanInput(id: string, point: { x: number; y: number }): Promise<void> } }).strataPreviewProbe.humanInput(id, { x: 40, y: 40 }), tab.id)
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).preview.tabs[0]?.recording)).toBe('paused')
    const stopped = await engine.automation('t1', 'recordingStop', {}, { timeoutMs: 30_000 })
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true)
    const record = stopped.result as BrowserEvidenceView
    expect(await page.evaluate(id => window.strata.previewEvidenceAction(id, 'open'), record.id)).toBe(`strata-visual://browser/${record.id}`)
  } finally { await scenario.dispose(); await engine.close(); await site.close() }
})
