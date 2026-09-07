import { settledBox } from './geometry'
import { expect, test, type Locator, type Page } from './test'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { startPreviewPage } from './preview-page'

/**
 * Marking up a running page (docs/plans/open/visual-review, phase 3
 * checklist): Annotate captures the frame and hides the live view, Mark asks
 * the page what is there and names it in plain words with a found check,
 * marking after a scroll takes another capture, the brief carries sources
 * only where the page has them, a live clock never refuses Send while a
 * page that navigated away does, and Show me restores the tab or falls back
 * to the saved evidence.
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

async function openAddress(page: Page, window: Locator, url: string, title: string): Promise<string> {
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

const session = (page: Page) => page.getByRole('dialog', { name: 'Mark up the page' })

async function annotate(page: Page, window: Locator) {
  await window.getByRole('button', { name: /^Annotate/ }).click()
  const dialog = session(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.visual-surface img')).toBeVisible()
  return dialog
}

/** A box read twice across two animation frames and accepted only when it holds: the card growing under the picture moves it a frame later. */

/** Page pixels onto the session's surface: the displayed capture is the page's viewport scaled to fit. */
async function surfaceMap(page: Page, engine: FakeEngine, tabId: string): Promise<(point: { x: number; y: number }) => { x: number; y: number }> {
  const viewport = (await engine.automation('t1', 'evaluate', { expression: '({ vw: window.innerWidth, vh: window.innerHeight })' }, { tabId })).result as { vw: number; vh: number }
  const surface = await settledBox(page, page.locator('.visual-surface'))
  return (point) => ({ x: surface.x + point.x * surface.width / viewport.vw, y: surface.y + point.y * surface.height / viewport.vh })
}

/** Where a page thing sits on the session's surface. */
async function surfacePoint(page: Page, engine: FakeEngine, tabId: string, selector: string): Promise<{ x: number; y: number }> {
  const rect = (await engine.automation('t1', 'evaluate', { expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()` }, { tabId })).result as { x: number; y: number; width: number; height: number }
  return (await surfaceMap(page, engine, tabId))({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
}

const visible = async (engine: FakeEngine, tabId: string) => ((await engine.automation('t1', 'status', {}, { tabId })).result as { visible: boolean }).visible

/** The exact visual matching data carried in the message alongside the image. */
function contextOf(engine: FakeEngine, index = 0): string {
  const turns = engine.commands.filter((command) => command.type === 'thread.turn.start')
  const turn = turns[index]!.message as { text: string }
  expect(turn.text).toContain('## Visual comments')
  return turn.text
}

test('Annotate captures the frame and hides the view, Mark names things from the page with a found check, a box over nothing stays a region, and a live clock sends', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    await expect.poll(() => visible(engine, tabId)).toBe(true)
    const dialog = await annotate(page, window)
    // The live view is hidden beneath the session; the page keeps running and is still on the tab strip.
    await expect.poll(() => visible(engine, tabId)).toBe(false)
    await expect(window.getByRole('button', { name: /^Annotating/ })).toBeVisible()
    // Mark: clicking a button proposes a chip named by the button's label with a found check.
    const button = await surfacePoint(page, engine, tabId, '#new-client')
    await page.mouse.click(button.x, button.y)
    const chip = dialog.locator('.visual-chip').filter({ hasText: 'New client button' })
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('found')
    // Dragging over empty space, the header room between the heading and the button, leaves a region chip, which can be removed.
    const map = await surfaceMap(page, engine, tabId)
    const from = map({ x: 130, y: 28 })
    const to = map({ x: 210, y: 58 })
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // The drag rectangle appears once the session has taken the press; moving before that would be a click somewhere else.
    await expect(dialog.locator('.visual-drag')).toHaveCount(1)
    await page.mouse.move(to.x, to.y, { steps: 4 })
    await page.mouse.up()
    const region = dialog.locator('.visual-chip').filter({ hasText: 'Region 1' })
    await expect(region).toBeVisible()
    await region.getByRole('button', { name: 'Remove Region 1' }).click()
    await expect(region).toHaveCount(0)
    // Nothing Strata drew is in the page: an agent snapshot of it carries no palette, card, or draft text.
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Move this into the header row.')
    const snapshot = JSON.stringify((await engine.automation('t1', 'snapshot', {}, { tabId })).result)
    expect(snapshot).not.toContain('What should change here')
    expect(snapshot).not.toContain('Move this into the header row')
    expect(snapshot).not.toContain('Send now')
    // The clock repaints every 200 ms; Send is not refused for that.
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { attachments: Array<{ id: string }> }
    expect(turn.attachments).toHaveLength(1)
    const context = contextOf(engine)
    expect(context).toContain('New client button')
    expect(context).toContain('src/pages/Clients.tsx')
    expect(context).toContain('"testIds"')
    // The view returns once the session closes; the card says the page and size in plain words.
    await expect.poll(() => visible(engine, tabId)).toBe(true)
    await page.getByRole('region', { name: 'Preview review' }).getByRole('tab', { name: /^Items/ }).click()
    const card = page.locator('#preview-review-panel-annotations .visual-card-row')
    await expect(card.locator('.visual-status')).toHaveText('sent')
    await expect(card.locator('.visual-where')).toHaveText('Clients · Mesa Office · window size')
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('marking after a scroll takes a second capture at the new position, and Send carries both', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    const dialog = await annotate(page, window)
    const button = await surfacePoint(page, engine, tabId, '#new-client')
    await page.mouse.click(button.x, button.y)
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'New client button' })).toBeVisible()
    // Scrolling over the session scrolls the live page and takes another capture.
    const surface = await settledBox(page, dialog.locator('.visual-surface'))
    await page.mouse.move(surface.x + surface.width / 2, surface.y + surface.height / 2)
    await page.mouse.wheel(0, 1800)
    await expect(dialog).toHaveAttribute('data-captures', '2')
    await expect.poll(async () => ((await engine.automation('t1', 'evaluate', { expression: 'window.scrollY' }, { tabId })).result as number)).toBeGreaterThan(100)
    const bottom = await surfacePoint(page, engine, tabId, '#bottom')
    await page.mouse.click(bottom.x, bottom.y)
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'The end of the page.' })).toBeVisible()
    // The earlier mark is listed as made at another scroll position.
    await expect(dialog.locator('.visual-chip[data-elsewhere]').filter({ hasText: 'New client button' })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Both ends of the page.')
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { attachments: Array<{ id: string }> }
    expect(turn.attachments).toHaveLength(2)
    const context = contextOf(engine)
    const scrolls = [...context.matchAll(/"scroll": \{\s*"x": \d+,\s*"y": (\d+)/g)].map((match) => Number(match[1]))
    expect(scrolls).toHaveLength(2)
    expect(scrolls[0]).toBe(0)
    expect(scrolls[1]).toBeGreaterThan(100)
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('a React page without stamps sends its component sources, and a static page with no source at all still sends', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const scheduleTab = await openAddress(page, window, `${site.origin}/schedule`, 'Schedule · Mesa Office')
    let dialog = await annotate(page, window)
    const book = await surfacePoint(page, engine, scheduleTab, '#book')
    await page.mouse.click(book.x, book.y)
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'Book a visit button' })).toContainText('found')
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Make this the primary button.')
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const fiber = contextOf(engine, 0)
    expect(fiber).toContain('/srv/mesa/src/schedule/BookButton.tsx')
    expect(fiber).toContain('/srv/mesa/src/pages/Schedule.tsx')

    const aboutTab = await openAddress(page, window, `${site.origin}/about`, 'About · Mesa Office')
    dialog = await annotate(page, window)
    const blurb = await surfacePoint(page, engine, aboutTab, '#blurb')
    await page.mouse.click(blurb.x, blurb.y)
    // A long line is cut short in its chip; the brief carries the whole text.
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'Mesa Office keeps small practices' })).toContainText('found')
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Give this line more room.')
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(2)
    const plain = contextOf(engine, 1)
    expect(plain).toContain('Mesa Office keeps small practices organized.')
    expect(plain).toContain('"sources": []')
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('a page that navigated away refuses Send and keeps the draft', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    let dialog = await annotate(page, window)
    const button = await surfacePoint(page, engine, tabId, '#new-client')
    await page.mouse.click(button.x, button.y)
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'New client button' })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Keep this wording.')
    await dialog.getByRole('button', { name: 'Hold' }).click()
    await expect(dialog).toBeHidden()
    await openAddress(page, window, `${site.origin}/about`, 'About · Mesa Office')
    await page.getByRole('region', { name: 'Preview review' }).getByRole('tab', { name: /^Items/ }).click()
    const card = page.locator('#preview-review-panel-annotations .visual-card-row')
    await expect(card.locator('.visual-status')).toHaveText('held')
    await card.getByRole('button', { name: 'Open', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Mark up the page' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(page.getByRole('alert')).toContainText('The page has moved on since you marked it')
    expect(engine.commands.filter((command) => command.type === 'thread.turn.start')).toHaveLength(0)
    await expect(card.locator('.visual-status')).toHaveText('held')
    await expect(card.locator('.visual-text')).toHaveText('Keep this wording.')
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('Show me restores size and scroll and outlines the thing while the tab still shows the page, and offers to open the page once it is gone', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    const before = (await engine.automation('t1', 'status', {}, { tabId })).result as { viewport: { width: number; height: number } }
    const dialog = await annotate(page, window)
    const button = await surfacePoint(page, engine, tabId, '#new-client')
    await page.mouse.click(button.x, button.y)
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'New client button' })).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Into the header row.')
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    // The page moves on: a device size and a scroll. Show me brings back the size and scroll of the comment and outlines the button.
    await window.getByRole('button', { name: 'Page size' }).click()
    await window.getByRole('menuitemradio', { name: /^Phone/ }).click()
    await expect.poll(async () => ((await engine.automation('t1', 'status', {}, { tabId })).result as { viewport: { width: number } }).viewport.width).toBe(390)
    await engine.automation('t1', 'scroll', { deltaY: 900 }, { tabId })
    await expect.poll(async () => (await engine.automation('t1', 'evaluate', { expression: 'window.scrollY' }, { tabId })).result as number).toBeGreaterThan(100)
    await page.getByRole('region', { name: 'Preview review' }).getByRole('tab', { name: /^Items/ }).click()
    const card = page.locator('#preview-review-panel-annotations .visual-card-row')
    await expect(card.locator('.visual-status')).toHaveText('sent')
    await card.getByRole('button', { name: 'Show me' }).click()
    await expect(page.getByRole('status')).toContainText('the marked things are outlined')
    await expect.poll(async () => ((await engine.automation('t1', 'status', {}, { tabId })).result as { viewport: { width: number; height: number } }).viewport).toEqual(before.viewport)
    await expect.poll(async () => (await engine.automation('t1', 'evaluate', { expression: 'window.scrollY' }, { tabId })).result as number).toBe(0)
    await expect.poll(async () => (await engine.automation('t1', 'evaluate', { expression: 'document.querySelectorAll(\'[data-strata-visual="outline"]\').length' }, { tabId })).result as number).toBe(1)
    // The tab closes: Show me shows the saved evidence and offers to open the page.
    await window.getByRole('tab', { name: /Clients · Mesa Office/ }).getByRole('button', { name: /^Close/ }).click()
    await expect.poll(async () => (await previewTabs(page)).length).toBe(0)
    await card.getByRole('button', { name: 'Show me' }).click()
    const panel = page.getByRole('dialog', { name: 'Visual comment' })
    await expect(panel.getByRole('status')).toContainText('That page is no longer open.')
    await expect(panel.locator('.visual-thumb img')).toBeVisible()
    await panel.getByRole('button', { name: 'Open the page' }).click()
    await expect.poll(async () => (await previewTabs(page)).map((tab) => tab.url)).toEqual([`${site.origin}/`])
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('annotation note and destination survive visiting a conversation and the toggle holds the same session', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage(), scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const preview = await openProjectPreview(page)
    await openAddress(page, preview, `${site.origin}/`, 'Clients · Mesa Office')
    const dialog = await annotate(page, preview)
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Keep this note through navigation.')
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible()
    await openProjectPreview(page)
    await expect(dialog.getByRole('textbox', { name: 'Visual comment' })).toHaveValue('Keep this note through navigation.')
    await expect(dialog.locator('.visual-context')).toHaveText('Send to this conversation')
    await expect(dialog.locator('.visual-context')).toHaveAttribute('title', /Live engine thread$/)
    await preview.getByRole('button', { name: /^Annotat/ }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await state(page)).engine.projects[0]?.visualComments?.[0]?.draft?.text).toBe('Keep this note through navigation.')
  } finally { await scenario.dispose(); await site.close(); await engine.close() }
})
