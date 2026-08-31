import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, documentEndKey, lineEndKey, lineStartKey, primaryKey, selectTextInVisualEditor, selectToLineEndKey } from './harness'

/**
 * PRD §6.3 undo: one timeline of typing and application steps, in both
 * directions, across Keep, pending hunks, comments, source mode, and tabs.
 */
const live = new Set<Scenario>()
async function scenario(testInfo: TestInfo, content: string): Promise<Scenario> {
  const value = await Scenario.create(testInfo, content)
  live.add(value)
  return value
}
test.afterEach(async () => {
  await Promise.all([...live].map(async (value) => { await value.dispose(); live.delete(value) }))
})

const BASE = '# Probe\n\nBase.\n'
const PROPOSAL = '# Probe\n\nBase.\n\nAgent line.\n'
/** Longer than prosemirror-history's 500 ms group delay, so each burst is its own undo event. */
const GROUP_GAP = 600

async function bufferText(value: Scenario): Promise<string> {
  return readFile((await value.state()).buffer!, 'utf8')
}
function editorOf(page: Page) {
  return page.getByRole('textbox', { name: /document editor/i })
}
function keepButtons(page: Page) {
  return page.getByRole('button', { name: /^Keep(?:\b|$)/i })
}
async function agentWritesBuffer(value: Scenario, next: string): Promise<void> {
  await value.tag('agent-a')
  await value.atomicWrite((await value.state()).buffer!, next)
  await value.waitForBuffer(next)
  await expect(keepButtons(value.page!).first()).toBeVisible()
}
async function typeLineAfter(page: Page, paragraphText: string, text: string): Promise<void> {
  await editorOf(page).locator('p').filter({ hasText: paragraphText }).last().click()
  await page.keyboard.press(lineEndKey)
  await page.waitForTimeout(GROUP_GAP)
  await page.keyboard.press('Enter')
  await page.keyboard.type(text)
  await page.waitForTimeout(GROUP_GAP)
}
async function deleteLine(page: Page, paragraphText: string): Promise<void> {
  await editorOf(page).locator('p').filter({ hasText: paragraphText }).last().click()
  await page.keyboard.press(lineStartKey)
  await page.keyboard.press(selectToLineEndKey)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(GROUP_GAP)
}
async function undo(page: Page): Promise<void> {
  await editorOf(page).focus()
  await page.keyboard.press(primaryKey('z'))
}
async function redo(page: Page): Promise<void> {
  await editorOf(page).focus()
  await page.keyboard.press(primaryKey('Shift+z'))
}

async function typeTwoLinesDeleteOne(value: Scenario): Promise<{ afterTyping: string; afterDelete: string }> {
  const page = value.page!
  await typeLineAfter(page, 'Base.', 'First comment line.')
  await typeLineAfter(page, 'First comment line.', 'Second comment line.')
  await expect.poll(() => bufferText(value)).toContain('Second comment line.')
  const afterTyping = await bufferText(value)
  await deleteLine(page, 'Second comment line.')
  await expect.poll(() => bufferText(value)).not.toContain('Second comment line.')
  const afterDelete = await bufferText(value)
  expect(afterDelete).toContain('First comment line.')
  return { afterTyping, afterDelete }
}

test.describe('undo and redo timeline', () => {
  test('1. plain document: undo restores only the deleted line and redo removes it again', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    await value.launch()
    const { afterTyping, afterDelete } = await typeTwoLinesDeleteOne(value)

    await undo(value.page!)
    await value.waitForBuffer(afterTyping)
    await redo(value.page!)
    await value.waitForBuffer(afterDelete)
  })

  test('2. pending agent hunk: undo and redo leave the hunk alone and never duplicate a line', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    await value.launch()
    await value.attach('agent-a')
    await agentWritesBuffer(value, PROPOSAL)
    const { afterTyping, afterDelete } = await typeTwoLinesDeleteOne(value)

    await undo(value.page!)
    await value.waitForBuffer(afterTyping)
    await redo(value.page!)
    await value.waitForBuffer(afterDelete)
    await expect(keepButtons(value.page!).first()).toBeVisible()
    expect(afterDelete.split('Second comment line.')).toHaveLength(1)
  })

  test('3. after Keep: typing undoes first, then the Keep itself, and redo re-keeps', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    await value.launch()
    await value.attach('agent-a')
    await agentWritesBuffer(value, PROPOSAL)
    await keepButtons(value.page!).first().click()
    await expect(keepButtons(value.page!)).toHaveCount(0)
    const afterKeep = await bufferText(value)
    const { afterTyping } = await typeTwoLinesDeleteOne(value)

    await undo(value.page!)
    await value.waitForBuffer(afterTyping)
    await expect(keepButtons(value.page!)).toHaveCount(0)

    // Two typed lines: each line and its paragraph break undo as separate bursts.
    for (let presses = 0; presses < 6 && (await bufferText(value)) !== afterKeep; presses += 1) {
      await undo(value.page!)
      await value.page!.waitForTimeout(150)
    }
    await value.waitForBuffer(afterKeep)
    await expect(keepButtons(value.page!)).toHaveCount(0)

    await undo(value.page!)
    await expect(keepButtons(value.page!).first()).toBeVisible()
    expect(await bufferText(value)).toBe(PROPOSAL)

    await redo(value.page!)
    await expect(keepButtons(value.page!)).toHaveCount(0)
    expect(await bufferText(value)).toBe(afterKeep)
  })

  test('4. interleaved typing and Keep undo all the way back and redo all the way forward', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    const page = await value.launch()
    await value.attach('agent-a')
    await agentWritesBuffer(value, PROPOSAL)

    await typeLineAfter(page, 'Base.', 'Alpha.')
    await expect.poll(() => bufferText(value)).toContain('Alpha.')
    const afterAlpha = await bufferText(value)
    await keepButtons(page).first().click()
    await expect(keepButtons(page)).toHaveCount(0)
    await typeLineAfter(page, 'Agent line.', 'Beta.')
    await expect.poll(() => bufferText(value)).toContain('Beta.')
    const afterBeta = await bufferText(value)

    await undo(page)
    await value.waitForBuffer(afterAlpha)
    await expect(keepButtons(page)).toHaveCount(0)
    await undo(page)
    await expect(keepButtons(page).first()).toBeVisible()
    expect(await bufferText(value)).toBe(afterAlpha)
    await undo(page)
    await value.waitForBuffer(PROPOSAL)
    await expect(keepButtons(page).first()).toBeVisible()

    await redo(page)
    await value.waitForBuffer(afterAlpha)
    await expect(keepButtons(page).first()).toBeVisible()
    await redo(page)
    await expect(keepButtons(page)).toHaveCount(0)
    expect(await bufferText(value)).toBe(afterAlpha)
    await redo(page)
    await value.waitForBuffer(afterBeta)
  })

  test('5. a comment added before a Keep survives undoing the typing and the Keep', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    const page = await value.launch()
    await value.attach('agent-a')
    await agentWritesBuffer(value, PROPOSAL)

    await selectTextInVisualEditor(page, 'Base.')
    const menu = page.getByRole('menu', { name: /Annotate selection/i })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /Comment/i }).click()
    await page.getByRole('textbox', { name: /Annotation text/i }).fill('Keep this.')
    await page.getByRole('button', { name: /^Add$/i }).click()
    const hasComment = async () => (await value.state()).annotations?.some((item) => item.text === 'Keep this.') === true
    await expect.poll(hasComment).toBe(true)

    await keepButtons(page).first().click()
    await expect(keepButtons(page)).toHaveCount(0)
    await typeLineAfter(page, 'Agent line.', 'Later.')
    await expect.poll(() => bufferText(value)).toContain('Later.')

    await undo(page)
    await expect.poll(() => bufferText(value)).not.toContain('Later.')
    expect(await hasComment()).toBe(true)
    await undo(page)
    await expect(keepButtons(page).first()).toBeVisible()
    expect(await hasComment()).toBe(true)
  })

  test('6. source mode shares one history with visual mode', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    const page = await value.launch()
    await editorOf(page).focus()
    await page.keyboard.press(primaryKey('/'))
    const source = page.getByRole('textbox', { name: /source editor/i })
    await expect(source).toBeVisible()

    await source.focus()
    await page.keyboard.press(documentEndKey)
    await page.keyboard.type('First line.\n')
    await page.waitForTimeout(GROUP_GAP)
    await page.keyboard.type('Second line.\n')
    await page.waitForTimeout(GROUP_GAP)
    const afterTyping = `${BASE}First line.\nSecond line.\n`
    await value.waitForBuffer(afterTyping)

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press(lineStartKey)
    await page.keyboard.press(selectToLineEndKey)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(GROUP_GAP)
    const afterDelete = `${BASE}First line.\n`
    await value.waitForBuffer(afterDelete)

    await source.focus()
    await page.keyboard.press(primaryKey('z'))
    await value.waitForBuffer(afterTyping)
    expect(await source.inputValue()).toBe(afterTyping)
    expect(await source.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(afterTyping.indexOf('Second line.'))

    await page.keyboard.press(primaryKey('/'))
    await redo(page)
    await value.waitForBuffer(afterDelete)
  })

  test('7. history survives switching tabs and coming back', async ({}, testInfo) => {
    const value = await scenario(testInfo, BASE)
    const page = await value.launch()
    const second = join(dirname(value.file), 'second.md')
    await writeFile(second, '# Second\n')

    await typeLineAfter(page, 'Base.', 'Typed here.')
    await expect.poll(() => bufferText(value)).toContain('Typed here.')
    expect((await value.cli(['open', second])).code).toBe(0)
    await expect(page.getByRole('tab', { name: /second\.md/i })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: /scenario\.md/i }).click()
    await expect(page.getByRole('tab', { name: /scenario\.md/i })).toHaveAttribute('aria-selected', 'true')

    await undo(page)
    await value.waitForBuffer(BASE)
  })
})
