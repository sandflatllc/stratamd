import { reviewCapture } from './captures'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { pngBytes } from './png'

const paragraphs = Array.from({ length: 30 }, (_, i) => `Sentinel ${i}. Repeated &amp; &#169; text.\n\n**Bold words** with \\*escaped\\* punctuation and a [link](https://example.test).\n\n| Name | Value |\n| --- | --- |\n| Repeated | ${i} |\n\n\`\`\`ts\nconst repeated = ${i}\n\`\`\``).join('\n\n')

async function open(page: Page, placement: 'side' | 'center') {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
  if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
  return page.locator(`.conversation-panel[data-placement="${placement}"]`)
}

async function evidence(page: Page, info: TestInfo) {
  await writeFile(info.outputPath('transcript-diagnostics.json'), JSON.stringify(await page.evaluate(() => window.strataTranscript!.snapshot()), null, 2))
}

for (const placement of ['side', 'center'] as const) {
  test(`cold publication preserves an interior source passage after scrolling in ${placement}`, async ({}, info) => {
    const engine = await startEngine()
    const scenario = await seededScenario(info, engine.origin)
    scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
    scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
    scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
    const id = engine.postAssistant('t1', paragraphs)
    try {
      const page = await scenario.launch()
      await page.evaluate(() => window.strataTranscript!.hold('publish'))
      const panel = await open(page, placement)
      const row = panel.locator(`[data-message-id="${id}"]`)
      const viewport = panel.locator('.conversation-messages')
      await expect.poll(() => page.evaluate(id => window.strataTranscript!.snapshot().events.some(e => e.kind === 'ready' && e.detail?.id === id), id)).toBe(true)
      const sentinel = row.locator('.conversation-lightweight p').filter({ hasText: /^Sentinel 12\./ })
      // A held scrollbar gesture gives deterministic control over the publication boundary.
      await viewport.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse' })
      await sentinel.evaluate(el => {
        const v = el.closest('.conversation-messages')!
        const inset = Number.parseFloat(getComputedStyle(v).paddingTop)
        v.scrollTop += el.getBoundingClientRect().top - v.getBoundingClientRect().top - inset
      })
      const before = await sentinel.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el)
        return { top: range.getClientRects()[0]!.top, height: el.closest('[data-message-id]')!.getBoundingClientRect().height }
      })
      await page.evaluate(() => { window.strataTranscript!.reset(); window.strataTranscript!.release('publish') })
      await viewport.dispatchEvent('wheel', { deltaY: -200 })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await row.evaluate(el => el.getBoundingClientRect().height)).toBe(before.height)
      expect(await page.evaluate(() => window.strataTranscript!.snapshot().counters.publications)).toBe(0)
      expect(await page.evaluate(() => window.strataTranscript!.snapshot().counters.scrollWrites)).toBe(0)
      await viewport.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse' })
      await expect(row.locator('[data-transcript-display]')).toHaveAttribute('data-transcript-display', 'rich')
      const after = await row.locator('.strata-prosemirror p').filter({ hasText: /^Sentinel 12\./ }).evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects()[0]!.top
      })
      expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2)
      await writeFile(info.outputPath('passage-position.json'), JSON.stringify({ before, after, displacement: after - before.top }, null, 2))
      const snapshot = await page.evaluate(() => window.strataTranscript!.snapshot())
      expect(snapshot.events.filter(e => e.kind === 'anchor-lost')).toEqual([])
      expect(snapshot.events.filter(e => e.kind === 'scroll-write' && e.detail?.scrolling)).toEqual([])
      expect(snapshot.counters.peakLive).toBeLessThan(12)
      await evidence(page, info)
      await reviewCapture(page, { path: info.outputPath('published-passage.png') })
    } finally { await scenario.dispose(); await engine.close() }
  })

  for (const resource of ['image-metadata', 'image-decode', 'mermaid'] as const) test(`navigation waits for ${resource} in ${placement}`, async ({}, info) => {
    const engine = await startEngine()
    const scenario = await seededScenario(info, engine.origin)
    scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
    scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
    scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
    engine.setWorkspaceRoot(scenario.root)
    await writeFile(join(scenario.root, 'screenshot.png'), pngBytes(1000, 1600))
    const id = engine.postAssistant('t1', '# Resource answer\n\n![Screenshot](screenshot.png)\n\n```mermaid\ngraph LR\nA --> B\n```\n\n' + paragraphs + '\n\nDestination deep inside the answer.\n')
    try {
      const page = await scenario.launch()
      await page.evaluate(kind => window.strataTranscript!.hold(kind), resource)
      const panel = await open(page, placement)
      // Synthetic conversation resolution must work with no ordinary document session.
      if (placement === 'center') await page.evaluate(async () => { const active = (await window.strata.getState()).activeDocument; if (active) await window.strata.closeDocument(active.path) })
      const row = panel.locator(`[data-message-id="${id}"]`)
      await expect.poll(() => page.evaluate(kind => window.strataTranscript!.waiting(kind), resource)).toBeGreaterThan(0)
      expect(await row.locator('.strata-prosemirror').count()).toBe(0)
      await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('Destination deep')
      await panel.getByRole('button', { name: 'Next', exact: true }).click()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await row.locator('.strata-prosemirror').count()).toBe(0)
      await page.evaluate(kind => window.strataTranscript!.release(kind), resource)
      await expect(row.locator('.strata-prosemirror')).toBeVisible()
      const destination = row.locator('.strata-prosemirror p').filter({ hasText: 'Destination deep inside' })
      await expect(destination).toBeInViewport()
      await expect(row.locator('img[data-decoded="true"]')).toHaveCount(1)
      await expect(row.locator('img[data-decoded]')).toHaveAttribute('data-intrinsic-width', '1000')
      expect(await page.evaluate(() => window.strataTranscript!.snapshot().events.filter(e => e.kind === 'navigation-failed'))).toEqual([])
      await evidence(page, info)
    } finally { await scenario.dispose(); await engine.close() }
  })
}

test('a stalled navigation times out without a jump and can be retried', async ({}, info) => {
  const engine = await startEngine()
  const scenario = await seededScenario(info, engine.origin)
  scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
  scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
  scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
  const id = engine.postAssistant('t1', paragraphs + '\n\n```mermaid\ngraph LR\nA --> B\n```\n\nRetry destination.\n')
  try {
    const page = await scenario.launch()
    await page.evaluate(() => window.strataTranscript!.hold('mermaid'))
    const panel = await open(page, 'side')
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('Retry destination')
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText(id, { timeout: 10_000 })
    expect(await page.evaluate(() => window.strataTranscript!.snapshot().events.filter(e => e.kind === 'scroll-write' && e.detail?.reason === 'navigation-passage'))).toEqual([])
    await page.evaluate(() => window.strataTranscript!.release('mermaid'))
    await panel.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(panel.locator(`[data-message-id="${id}"] .strata-prosemirror p`).filter({ hasText: 'Retry destination' })).toBeInViewport()
    await evidence(page, info)
  } finally { await scenario.dispose(); await engine.close() }
})

for (const placement of ['side', 'center'] as const) test(`an atomic reading anchor defers safely and explicit Find still works in ${placement}`, async ({}, info) => {
  const engine = await startEngine()
  const scenario = await seededScenario(info, engine.origin)
  scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
  scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
  scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
  const graph = 'graph TD\n' + Array.from({ length: 20 }, (_, i) => `A${i} --> A${i + 1}`).join('\n')
  const id = engine.postAssistant('t1', '# Before diagram\n\n' + Array.from({ length: 10 }, (_, i) => `Intro ${i}. A paragraph before the diagram.`).join('\n\n') + '\n\n```mermaid\n' + graph + '\n```\n\nAtomic escape destination.\n\n' + paragraphs)
  try {
    const page = await scenario.launch()
    await page.evaluate(() => window.strataTranscript!.hold('publish'))
    const panel = await open(page, placement)
    const row = panel.locator(`[data-message-id="${id}"]`)
    await expect.poll(() => page.evaluate(id => window.strataTranscript!.snapshot().events.some(e => e.kind === 'ready' && e.detail?.id === id), id)).toBe(true)
    const diagram = row.locator('[data-atomic="diagram"]')
    await diagram.evaluate(el => {
      const v = el.closest('.conversation-messages')!
      v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
      v.scrollTop += el.getBoundingClientRect().top + 80 - v.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(v).paddingTop)
    })
    await page.evaluate(() => window.strataTranscript!.release('publish'))
    await expect.poll(() => page.evaluate(() => window.strataTranscript!.snapshot().counters.deferred)).toBeGreaterThan(0)
    await expect(diagram).toContainText('A19 --> A20')
    expect(await row.locator('.strata-prosemirror').count()).toBe(0)
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('Atomic escape destination')
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(row.locator('.strata-prosemirror p').filter({ hasText: 'Atomic escape destination' })).toBeInViewport()
    await evidence(page, info)
  } finally { await scenario.dispose(); await engine.close() }
})

test('superseded resource work cannot jump after a newer Find destination', async ({}, info) => {
  const engine = await startEngine()
  const scenario = await seededScenario(info, engine.origin)
  scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
  scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
  scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
  const old = engine.postAssistant('t1', paragraphs + '\n\n```mermaid\ngraph LR\nA --> B\n```\n\nOld destination.\n')
  const current = engine.postAssistant('t1', paragraphs + '\n\nNew destination.\n')
  try {
    const page = await scenario.launch()
    await page.evaluate(() => window.strataTranscript!.hold('mermaid'))
    const panel = await open(page, 'side')
    const find = panel.getByRole('searchbox', { name: 'Find in conversation' })
    await find.fill('Old destination')
    await expect.poll(() => page.evaluate(() => window.strataTranscript!.waiting('mermaid'))).toBeGreaterThan(0)
    await find.fill('New destination')
    const destination = panel.locator(`[data-message-id="${current}"] .strata-prosemirror p`).filter({ hasText: 'New destination' })
    await expect(destination).toBeInViewport()
    await page.evaluate(() => window.strataTranscript!.release('mermaid'))
    await expect.poll(() => page.evaluate(id => window.strataTranscript!.snapshot().events.some(e => (e.kind === 'ready' || e.kind === 'unmount') && e.detail?.id === id), old)).toBe(true)
    await expect(destination).toBeInViewport()
    const events = await page.evaluate(() => window.strataTranscript!.snapshot().events)
    expect(events.filter(e => e.kind === 'navigated').map(e => e.detail?.serial)).toEqual([2])
    expect(events.some(e => e.kind === 'navigation-cancelled' && e.detail?.serial === 1)).toBe(true)
    await evidence(page, info)
  } finally { await scenario.dispose(); await engine.close() }
})

test('screenshot components settle their image and status before publication', async ({}, info) => {
  const engine = await startEngine()
  const scenario = await seededScenario(info, engine.origin)
  scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
  scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
  scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
  engine.setWorkspaceRoot(scenario.root)
  await writeFile(join(scenario.root, 'review.png'), pngBytes(400, 300))
  const id = engine.postAssistant('t1', '<AnnotatedScreenshot>\n![Review screenshot](review.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n| 1 | 20 | 30 | 1:2 | Check this. |\n</AnnotatedScreenshot>\n')
  try {
    const page = await scenario.launch()
    await page.evaluate(() => window.strataTranscript!.hold('image-decode'))
    const panel = await open(page, 'center')
    await expect.poll(() => page.evaluate(() => window.strataTranscript!.waiting('image-decode'))).toBeGreaterThan(0)
    const row = panel.locator(`[data-message-id="${id}"]`)
    expect(await row.locator('.strata-prosemirror').count()).toBe(0)
    await page.evaluate(() => window.strataTranscript!.release('image-decode'))
    await expect(row.locator('.strata-prosemirror')).toBeVisible()
    await expect(row.locator('img[data-decoded]')).toHaveCount(1)
    expect(await page.evaluate(() => window.strataTranscript!.snapshot().counters.deadlines)).toBe(0)
    await evidence(page, info)
  } finally { await scenario.dispose(); await engine.close() }
})

test('a reopened cached answer still waits for a replaced image to decode', async ({}, info) => {
  const engine = await startEngine()
  const scenario = await seededScenario(info, engine.origin)
  scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
  scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
  engine.setWorkspaceRoot(scenario.root)
  const image = join(scenario.root, 'cached.png')
  await writeFile(image, pngBytes(400, 300))
  const id = engine.postAssistant('t1', '![Cached screenshot](cached.png)\n\n' + paragraphs)
  try {
    let page = await scenario.launch()
    let panel = await open(page, 'center')
    await expect(panel.locator(`[data-message-id="${id}"] img[data-decoded]`)).toBeVisible()
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.includes('transcript-geometry') && localStorage.getItem(key)?.includes('cached.png')))).toBe(true)
    await scenario.stop()
    await writeFile(image, pngBytes(400, 600, 2))
    page = await scenario.launch()
    await page.evaluate(() => window.strataTranscript!.hold('image-decode'))
    panel = await open(page, 'center')
    const row = panel.locator(`[data-message-id="${id}"]`)
    await expect.poll(() => page.evaluate(() => window.strataTranscript!.waiting('image-decode'))).toBeGreaterThan(0)
    expect(await row.locator('.strata-prosemirror').count()).toBe(0)
    await page.evaluate(() => window.strataTranscript!.release('image-decode'))
    await expect(row.locator('img[data-decoded]')).toHaveAttribute('data-intrinsic-height', '600')
    await evidence(page, info)
  } finally { await scenario.dispose(); await engine.close() }
})

test('a changed completed answer keeps its displayed geometry through an active gesture', async ({}, info) => {
  const engine = await startEngine()
  const scenario = await seededScenario(info, engine.origin)
  scenario.env.STRATAMD_TRANSCRIPT_PROBE = '1'
  scenario.env.STRATAMD_TRANSCRIPT_CACHE = '0'
  scenario.env.STRATAMD_TRANSCRIPT_SWEEP = '0'
  engine.setMessage(paragraphs)
  engine.complete()
  try {
    const page = await scenario.launch()
    const panel = await open(page, 'side')
    const row = panel.locator('[data-message-id="m1"]')
    await expect(row.locator('.strata-prosemirror')).toBeVisible()
    const viewport = panel.locator('.conversation-messages')
    await viewport.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse' })
    const height = await row.evaluate(el => el.getBoundingClientRect().height)
    engine.setMessage('Changed opening.\n\n' + paragraphs)
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).engine.projects.flatMap(p => p.threads).find(t => t.id === 't1')?.messages.find(m => m.id === 'm1')?.text.startsWith('Changed opening.'))).toBe(true)
    expect(await row.evaluate(el => el.getBoundingClientRect().height)).toBe(height)
    await expect(row).not.toContainText('Changed opening.')
    await viewport.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse' })
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('Changed opening.')
    await expect(row.locator('.strata-prosemirror p').filter({ hasText: 'Changed opening.' })).toBeInViewport().catch(async error => { await evidence(page, info); throw error })
    await evidence(page, info)
  } finally { await scenario.dispose(); await engine.close() }
})
