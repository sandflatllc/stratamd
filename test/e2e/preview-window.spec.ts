import { expect, test, type Page } from '@playwright/test'
import { dirname } from 'node:path'
import { Scenario, switchToDocument } from './harness'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { startPreviewPage } from './preview-page'

/**
 * The preview window and the host connection (docs/plans/open/visual-review,
 * phase 2 checklist). The page is a main-process view over a hole in the
 * window, so what the page sees is read back through the engine's own
 * browser requests, which the fake engine routes to Strata as T3 would.
 */
const state = (page: Page) => page.evaluate(() => window.strata.getState())
const previewTabs = async (page: Page) => (await state(page)).preview.tabs

async function openProjectPreview(page: Page) {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'Open browser for Cockpit project' }).click()
  const window = page.getByRole('region', { name: 'Cockpit project preview' })
  await expect(window).toBeVisible()
  return window
}

async function openAddress(page: Page, window: ReturnType<Page['getByRole']>, url: string, title: string): Promise<string> {
  const address = window.getByRole('textbox', { name: 'Address' })
  await address.fill(url)
  await address.press('Enter')
  await expect.poll(async () => (await previewTabs(page)).find((tab) => tab.url.startsWith(url))?.title ?? '').toBe(title)
  return (await previewTabs(page)).find((tab) => tab.url.startsWith(url))!.id
}

async function browserShared(page: Page, engine: FakeEngine): Promise<void> {
  await expect.poll(async () => (await state(page)).preview.registered).toBe(true)
  await expect(page.getByText('Browser shared', { exact: true })).toHaveCount(0)
  await expect.poll(() => engine.hosts().length).toBe(1)
}

/** A real input into a preview tab through the harness probe: the path an owner's click takes. */
const humanInput = (page: Page, tabId: string) => page.evaluate(({ tabId }) => (window as unknown as { strataPreviewProbe: { humanInput(id: string, point: { x: number; y: number }): Promise<void> } }).strataPreviewProbe.humanInput(tabId, { x: 40, y: 40 }), { tabId })

test('a restored browser remains usable before its project is available', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Startup')
  try {
    let page = await scenario.launchEmpty()
    await page.evaluate(() => localStorage.setItem('stratamd.workspace.v1', JSON.stringify({
      conversationCentered: false, conversationTabs: [], previews: ['restoring-project'], previewCentered: 'restoring-project',
    })))
    await scenario.stop()
    page = await scenario.launchEmpty()
    await expect(page.getByRole('region', { name: 'Project preview', exact: true })).toBeVisible()
    await expect(page.locator('.boundary-card')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'StrataMD menu' })).toBeVisible()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('stratamd.workspace.v1')!).previewCentered)).toBe('restoring-project')
  } finally { await scenario.dispose() }
})

test('the preview pill, the right window, Fit window edge to edge, and a device size as a narrowed viewport', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    await page.getByRole('button', { name: 'Web views menu' }).click()
    await expect(page.getByRole('menu', { name: 'Open web views' }).getByRole('menuitem', { name: /^Cockpit project · (Preview|New tab)/ })).toHaveAttribute('aria-current', 'true')
    await page.keyboard.press('Escape')
    const rail = page.getByRole('region', { name: 'Preview review' })
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('tab', { name: /^Changes/ })).toBeVisible()
    await expect(rail.getByRole('tab', { name: /^Items/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Attached' })).toBeVisible()

    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    await page.getByRole('button', { name: 'Web views menu' }).click()
    await expect(page.getByRole('menu', { name: 'Open web views' }).getByRole('menuitem', { name: /^Cockpit project · Clients · Mesa Office/ })).toBeVisible()
    await page.keyboard.press('Escape')
    // Fit window: the page fills the stage edge to edge, and the page itself measures that size.
    const stage = (await window.locator('.preview-stage').boundingBox())!
    const hole = (await window.locator('.preview-hole').boundingBox())!
    expect(Math.abs(hole.width - stage.width)).toBeLessThan(2)
    expect(Math.abs(hole.height - stage.height)).toBeLessThan(2)
    await expect.poll(async () => { const status = await engine.automation('t1', 'status', {}, { tabId }); return (status.result as { viewport?: { width: number } })?.viewport?.width ?? 0 }).toBeGreaterThan(stage.width - 3)
    // A device size boxes the page and says what it is: a narrowed viewport, not a phone.
    await window.getByRole('button', { name: 'Page size' }).click()
    await window.getByRole('menuitemradio', { name: /^Phone/ }).click()
    await expect(window.getByText('Narrowed viewport · Phone · 390 × 844')).toBeVisible()
    // The frame keeps the size's shape and never grows past it; a stage too small for it shrinks the picture, and the page still sees 390 × 844.
    const framed = (await window.locator('.preview-hole').boundingBox())!
    expect(framed.width).toBeLessThanOrEqual(390)
    expect(Math.abs(framed.width / framed.height - 390 / 844)).toBeLessThan(0.01)
    await expect.poll(async () => { const status = await engine.automation('t1', 'status', {}, { tabId }); return (status.result as { viewport?: { width: number; height: number } })?.viewport }).toEqual({ width: 390, height: 844 })
    await expect(window.getByRole('button', { name: 'Page size' })).toHaveText(/Phone/)
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('a page keeps its state while a document is centered, and a Strata dialog hides it and gives focus back', async ({}, testInfo) => {
  test.setTimeout(45_000)
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin, '# Notes\n\nA document beside the preview.\n', 'beside-preview.md')
  scenario.env.STRATAMD_PREVIEW_PROBE = '1'
  try {
    const page = await scenario.launch()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    // Fill the form and scroll through the engine's own requests, naming the owner's tab.
    expect((await engine.automation('t1', 'type', { locator: "role=textbox[name='Client name']", text: 'Harbor Dental' }, { tabId })).ok).toBe(true)
    expect((await engine.automation('t1', 'scroll', { deltaY: 600 }, { tabId })).ok).toBe(true)
    const read = async () => (await engine.automation('t1', 'evaluate', { expression: '({ name: document.getElementById("name").value, scroll: Math.round(window.scrollY) })' }, { tabId })).result as { name: string; scroll: number }
    await expect.poll(async () => (await read()).scroll).toBeGreaterThanOrEqual(500)
    const before = await read()
    expect(before.name).toBe('Harbor Dental')

    // Switching to a document and back leaves the page state, scroll, and form contents intact.
    await switchToDocument(page, /beside-preview\.md/)
    await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible()
    await expect(window).toBeHidden()
    await expect.poll(async () => (await engine.automation('t1', 'status', {}, { tabId })).result).toMatchObject({ visible: false })
    await page.getByRole('button', { name: 'Web views menu' }).click()
    await page.getByRole('menu', { name: 'Open web views' }).getByRole('menuitem', { name: /^Cockpit project · Clients · Mesa Office/ }).click()
    await expect(window).toBeVisible()
    await expect.poll(async () => (await engine.automation('t1', 'status', {}, { tabId })).result).toMatchObject({ visible: true })
    expect(await read()).toEqual(before)

    // A click into the page gives it focus; a Strata dialog over the preview hides the page; closing it gives focus back.
    await humanInput(page, tabId)
    const focused = async () => (await engine.automation('t1', 'evaluate', { expression: 'document.hasFocus()' }, { tabId })).result
    await expect.poll(focused).toBe(true)
    await page.getByRole('button', { name: 'Engine status' }).click()
    await expect(page.getByRole('dialog', { name: /Engine/ })).toBeVisible()
    await expect.poll(async () => (await engine.automation('t1', 'status', {}, { tabId })).result).toMatchObject({ visible: false })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Engine/ })).toBeHidden()
    await expect.poll(async () => (await engine.automation('t1', 'status', {}, { tabId })).result).toMatchObject({ visible: true })
    await expect.poll(focused).toBe(true)
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('an agent opens its own dashed tab, fills a form, snapshots it, and the badge follows the requests Strata serves', async ({}, testInfo) => {
  test.setTimeout(45_000)
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const ownerTab = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')

    const opened = await engine.automation('t1', 'open', { url: `${site.origin}/invoices` })
    expect(opened.ok).toBe(true)
    const agentTab = (opened.result as { tabId: string }).tabId
    expect(agentTab).not.toBe(ownerTab)
    const agentStrip = window.locator('.preview-tab[data-kind="agent"]')
    await expect(agentStrip).toHaveCount(1)
    await expect(agentStrip).toContainText('Invoices · Mesa Office')
    await expect(agentStrip).toHaveAttribute('aria-selected', 'false')
    // The owner's tab stays in front; the status pill offers Watch.
    await expect(window.getByRole('button', { name: /Watch$/ })).toBeVisible()

    // Fill the form and read it back: a tool call with no tab id lands in the thread's current tab, never the owner's active tab.
    expect((await engine.automation('t1', 'type', { locator: "role=textbox[name='Amount']", text: '42' })).ok).toBe(true)
    expect((await engine.automation('t1', 'press', { key: 'Enter' })).ok).toBe(true)
    await expect.poll(async () => (await engine.automation('t1', 'evaluate', { expression: 'document.getElementById("total").textContent' })).result).toBe('Total 42')
    expect((await engine.automation('t1', 'evaluate', { expression: 'document.title' })).result).toBe('Invoices · Mesa Office')
    expect((await engine.automation('t1', 'evaluate', { expression: 'document.title' }, { tabId: ownerTab })).result).toBe('Clients · Mesa Office')

    const snapshot = await engine.automation('t1', 'snapshot', {})
    expect(snapshot.ok).toBe(true)
    const result = snapshot.result as { url: string; title: string; visibleText: string; interactiveElements: Array<{ role: string; name: string }>; screenshot: { mimeType: string; data: string; width: number; height: number } }
    expect(result.title).toBe('Invoices · Mesa Office')
    expect(result.visibleText).toContain('Nothing is late.')
    expect(result.interactiveElements).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'button', name: 'Add invoice' }), expect.objectContaining({ role: 'textbox', name: 'Amount' })]))
    expect(result.screenshot.mimeType).toBe('image/png')
    expect(result.screenshot.width).toBeGreaterThan(0)
    expect(Buffer.from(result.screenshot.data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    // The Attached row carries the browser badge while Strata serves a request, and clears afterward.
    const rail = page.getByRole('region', { name: 'Preview review' }).locator('..')
    const badge = rail.locator('.agent-row[data-thread="t1"] .agent-browser-badge')
    const slow = engine.automation('t1', 'waitFor', { text: 'never appears here', timeoutMs: 3_000 })
    await expect(badge).toBeVisible()
    const outcome = await slow
    expect(outcome.ok).toBe(false)
    expect(outcome.error?._tag).toBe('PreviewAutomationTimeoutError')
    await expect(badge).toHaveCount(0)

    // A closed tab id returns an error, and the thread no longer has a current tab.
    await agentStrip.getByRole('button', { name: /^Close tab/ }).click()
    await expect(agentStrip).toHaveCount(0)
    expect((await engine.automation('t1', 'evaluate', { expression: '1' }, { tabId: agentTab })).error?._tag).toBe('PreviewAutomationTabNotFoundError')
    expect((await engine.automation('t1', 'evaluate', { expression: '1' })).error?._tag).toBe('PreviewAutomationTabNotFoundError')
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('clicking in an agent tab stops the wait it was in, Resume replays nothing, and Watch does not pause', async ({}, testInfo) => {
  test.setTimeout(45_000)
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  scenario.env.STRATAMD_PREVIEW_PROBE = '1'
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    await openAddress(page, window, `${site.origin}/about`, 'About · Mesa Office')
    const opened = await engine.automation('t1', 'open', { url: `${site.origin}/` })
    const agentTab = (opened.result as { tabId: string }).tabId
    const agentStrip = window.locator('.preview-tab[data-kind="agent"]')
    await expect(agentStrip).toHaveCount(1)

    // The agent waits for something that never comes; Watch reveals its tab without pausing it.
    const waiting = engine.automation('t1', 'waitFor', { text: 'never appears here', timeoutMs: 20_000 })
    await expect(window.getByRole('button', { name: /waiting · Watch$/ })).toBeVisible()
    await window.getByRole('button', { name: /Watch$/ }).click()
    await expect(agentStrip).toHaveAttribute('aria-selected', 'true')
    expect((await previewTabs(page)).find((tab) => tab.id === agentTab)?.paused).toBe(false)

    // Deliberate interaction in the agent tab takes control: the wait stops and nothing runs until Resume.
    await humanInput(page, agentTab)
    const interrupted = await waiting
    expect(interrupted.ok).toBe(false)
    expect(interrupted.error?._tag).toBe('PreviewAutomationControlInterruptedError')
    await expect(window.getByText('Paused: you took control')).toBeVisible()
    expect((await engine.automation('t1', 'evaluate', { expression: '1 + 1' })).error?._tag).toBe('PreviewAutomationControlInterruptedError')
    // Resume allows new actions and replays nothing.
    await window.getByRole('button', { name: 'Resume' }).click()
    await expect(window.getByText('Paused: you took control')).toHaveCount(0)
    expect((await engine.automation('t1', 'evaluate', { expression: '1 + 1' })).result).toBe(2)
    expect((await engine.automation('t1', 'evaluate', { expression: 'document.body.innerText.includes("never appears here")' })).result).toBe(false)
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})
