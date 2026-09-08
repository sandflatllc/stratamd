import { settledBox } from './geometry'
import { expect, test, type Locator, type Page } from './test'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { startPreviewPage } from './preview-page'

/**
 * Comparisons, then adjustments (docs/plans/open/visual-review, phase 4
 * checklist): a ready reply produces Then / now from Strata's own capture,
 * with "views differ" when the mark is gone; an adjustment on the selected
 * mark changes only that mark on the live page and re-captures, recorded
 * as property and value, with Undo and Reset; ending the session removes
 * only Strata's overrides, and a Then / now taken afterward shows no change
 * until the code changed.
 */
const state = (page: Page) => page.evaluate(() => window.strata.getState())
const previewTabs = async (page: Page) => (await state(page)).preview.tabs
const visualComments = async (page: Page) => (await state(page)).engine.projects.flatMap((project) => project.visualComments ?? [])

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

async function annotate(page: Page, window: Locator) {
  await window.getByRole('button', { name: /^Annotate/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Mark up the page' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.visual-surface img')).toBeVisible()
  return dialog
}

const evaluate = async <T,>(engine: FakeEngine, tabId: string, expression: string): Promise<T> => (await engine.automation('t1', 'evaluate', { expression }, { tabId })).result as T

/** A box read twice across two animation frames and accepted only when it holds: the card growing under the picture moves it a frame later. */

/** Where a page thing sits on the session's surface. */
async function surfacePoint(page: Page, engine: FakeEngine, tabId: string, selector: string): Promise<{ x: number; y: number }> {
  const rect = await evaluate<{ x: number; y: number; width: number; height: number; vw: number; vh: number }>(engine, tabId, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight } })()`)
  const surface = await settledBox(page, page.locator('.visual-surface'))
  return { x: surface.x + (rect.x + rect.width / 2) * surface.width / rect.vw, y: surface.y + (rect.y + rect.height / 2) * surface.height / rect.vh }
}

/** The agent answers a visual comment by revision. */
function agentReplies(engine: FakeEngine, id: string, revision: number, text: string, ready: boolean): string {
  return engine.postAssistant('t1', `${text}\n\n\`\`\`strata\n${JSON.stringify([{ verb: 'reply', anchor: { item: id }, revision, text, ready }])}\n\`\`\``)
}

/** Mark the New client button and send the comment; returns its id. */
async function sendButtonComment(page: Page, engine: FakeEngine, window: Locator, tabId: string, note: string): Promise<string> {
  const dialog = await annotate(page, window)
  const button = await surfacePoint(page, engine, tabId, '#new-client')
  await page.mouse.click(button.x, button.y)
  await expect(dialog.locator('.visual-chip').filter({ hasText: 'New client button' })).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Visual comment' }).fill(note)
  await dialog.getByRole('button', { name: 'Hold' }).click()
    await page.getByRole('textbox', { name: 'Message conversation' }).filter({ visible: true }).press('Enter')
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await visualComments(page)).find((comment) => comment.status === 'sent')?.id ?? null).not.toBeNull()
  return (await visualComments(page)).find((comment) => comment.status === 'sent')!.id
}

/** The picture behind an evidence URL as pixels, read the way Hold reads a capture: drawn to a canvas. */
const bytesOf = (page: Page, url: string) => page.evaluate(async (source) => {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error(`The picture could not be read: ${source}`)); image.src = source })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas.toDataURL('image/png')
}, url)

test('a ready reply produces Then / now from Strata\'s own capture, and says the views differ once the mark is gone', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    const id = await sendButtonComment(page, engine, window, tabId, 'Into the header row.')
    agentReplies(engine, id, 1, 'Moved it into the header row.', true)
    await page.getByRole('region', { name: 'Preview review' }).getByRole('tab', { name: /^Items/ }).click()
    const card = page.locator('#preview-review-panel-annotations .visual-card-row')
    await expect(card.locator('.visual-status')).toHaveText('ready for review')
    // Then / now: the original crop beside Strata's own capture of the same target, both present, no note.
    const compare = card.locator('.visual-compare')
    await expect(compare.locator('img')).toHaveCount(2)
    await expect(compare.locator('.visual-compare-note')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Then / now' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Looks right' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Still wrong' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Show me' })).toBeVisible()
    // Nothing Strata drew is in the page after the capture.
    expect(await evaluate<number>(engine, tabId, 'document.querySelectorAll("[data-strata-visual]").length')).toBe(0)
    // The mark is gone from the page: the next ready reply says the views differ rather than showing an empty pair.
    await evaluate(engine, tabId, 'document.querySelector("#new-client").remove(), true')
    agentReplies(engine, id, 1, 'Removed the button entirely.', true)
    await expect(compare.locator('.visual-compare-note')).toHaveText('The views differ: New client button was not found on the page now.')
    await expect(compare.locator('.visual-compare-missing')).toHaveText('views differ')
    await expect(compare.locator('img')).toHaveCount(1)
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('adjusting text size on the selected mark changes only that mark on the live page and re-captures; Undo and Reset work; ending the session removes only the overrides', async ({}, testInfo) => {
  const engine = await startEngine({ previewAutomation: true, pendingRequests: false })
  const site = await startPreviewPage()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    await browserShared(page, engine)
    const window = await openProjectPreview(page)
    const tabId = await openAddress(page, window, `${site.origin}/`, 'Clients · Mesa Office')
    const fontSize = () => evaluate<string>(engine, tabId, 'getComputedStyle(document.querySelector("#new-client")).fontSize')
    const headingSize = () => evaluate<string>(engine, tabId, 'getComputedStyle(document.querySelector("header h1")).fontSize')
    const original = await fontSize()
    const heading = await headingSize()
    const dialog = await annotate(page, window)
    const button = await surfacePoint(page, engine, tabId, '#new-client')
    await page.mouse.click(button.x, button.y)
    await expect(dialog.locator('.visual-chip').filter({ hasText: 'New client button' })).toBeVisible()
    const adjustments = dialog.getByRole('region', { name: 'Adjustments' })
    await expect(adjustments).toBeVisible()
    await expect(adjustments).toContainText('not shown yet')
    const size = adjustments.locator('[data-kind="text-size"] output')
    await expect(size).toHaveText('as is')
    // One step: the live page changes for that mark only, and the picture is re-captured with the adjustment on it.
    await adjustments.getByRole('button', { name: 'Text size more' }).click()
    await expect(size).toHaveText('slightly larger')
    await expect.poll(fontSize).not.toBe(original)
    await expect(adjustments).toContainText('shown live')
    const larger = await fontSize()
    expect(await headingSize()).toBe(heading)
    await expect(dialog.locator('.visual-surface img[data-requested]')).toBeVisible()
    await adjustments.getByRole('button', { name: 'Text size more' }).click()
    await expect(size).toHaveText('larger')
    await expect.poll(fontSize).not.toBe(larger)
    await adjustments.getByRole('button', { name: 'Undo' }).click()
    await expect(size).toHaveText('slightly larger')
    await expect.poll(fontSize).toBe(larger)
    await adjustments.getByRole('button', { name: 'Reset' }).click()
    await expect(size).toHaveText('as is')
    await expect.poll(fontSize).toBe(original)
    await expect(dialog.locator('.visual-surface img[data-requested]')).toHaveCount(0)
    // The request is recorded as property and value with the owner's words; Hold keeps it and the requested picture.
    await adjustments.getByRole('button', { name: 'Text size more' }).click()
    await expect(size).toHaveText('slightly larger')
    await expect.poll(fontSize).toBe(larger)
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('A touch bigger, like this.')
    await dialog.getByRole('button', { name: 'Hold' }).click()
    await expect(dialog).toBeHidden()
    const held = (await visualComments(page)).find((comment) => comment.status === 'held')!
    expect(held.draft?.adjustments).toEqual([{ markId: expect.any(String), property: 'font-size', value: larger, label: 'Text size: slightly larger' }])
    expect(held.captures.some((capture) => capture.requested)).toBe(true)
    expect(held.summary).toContain('1 adjustment')
    // Ending the session removed only Strata's overrides: the page is its own again.
    await expect.poll(fontSize).toBe(original)
    expect(await evaluate<number>(engine, tabId, 'document.querySelectorAll("[data-strata-visual], [data-strata-target]").length')).toBe(0)
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})

test('a Then / now taken after an adjustment session shows no change until the code changed', async ({}, testInfo) => {
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
    const adjustments = dialog.getByRole('region', { name: 'Adjustments' })
    await adjustments.getByRole('button', { name: 'Text size more' }).click()
    await expect(adjustments.locator('[data-kind="text-size"] output')).toHaveText('slightly larger')
    await expect(dialog.locator('.visual-surface img[data-requested]')).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Visual comment' }).fill('Bigger, like this.')
    await dialog.getByRole('button', { name: 'Hold' }).click()
    await page.getByRole('textbox', { name: 'Message conversation' }).filter({ visible: true }).press('Enter')
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await visualComments(page)).find((comment) => comment.status === 'sent')?.id ?? null).not.toBeNull()
    const sent = (await visualComments(page)).find((comment) => comment.status === 'sent')!
    // The requested appearance travelled as a reference beside the marked capture.
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { attachments: Array<{ id: string }> }
    expect(turn.attachments).toHaveLength(2)
    // Nothing changed in the code: the comparison shows the same picture twice.
    agentReplies(engine, sent.id, 1, 'Looking at it now.', true)
    await page.getByRole('region', { name: 'Preview review' }).getByRole('tab', { name: /^Items/ }).click()
    const card = page.locator('#preview-review-panel-annotations .visual-card-row')
    await expect(card.locator('.visual-compare img')).toHaveCount(2)
    const first = (await visualComments(page)).find((comment) => comment.id === sent.id)!.revisions[0]!.replies.at(-1)!.comparison!
    expect(first.nowUrl).not.toBeNull()
    expect(await bytesOf(page, first.nowUrl!)).toEqual(await bytesOf(page, first.thenUrl))
    // The code changed: the page is served with the bigger button, the tab reloads, and the next Then / now differs.
    site.setVariant('bigger')
    await window.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => evaluate<string>(engine, tabId, 'getComputedStyle(document.querySelector("#new-client")).fontSize')).toBe('20px')
    agentReplies(engine, sent.id, 1, 'Made it bigger in the stylesheet.', true)
    await expect.poll(async () => (await visualComments(page)).find((comment) => comment.id === sent.id)!.revisions[0]!.replies.at(-1)?.comparison?.nowUrl ?? first.nowUrl).not.toBe(first.nowUrl)
    const second = (await visualComments(page)).find((comment) => comment.id === sent.id)!.revisions[0]!.replies.at(-1)!.comparison!
    expect((await visualComments(page)).find(comment => comment.id === sent.id)!.revisions[0]!.replies[0]!.comparison).toEqual(first)
    expect(second.note).toBeNull()
    expect(await bytesOf(page, second.nowUrl!)).not.toEqual(await bytesOf(page, second.thenUrl))
  } finally {
    await scenario.dispose()
    await site.close()
    await engine.close()
  }
})
