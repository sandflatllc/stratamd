import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, documentEndKey, primaryKey } from './harness'

/**
 * docs/plans/completed/cold-tab-plan.md §9: with STRATAMD_EDITOR_CACHE=0 every tab switch
 * evicts the editor, so undo, redo, caret, and scroll after a switch exercise
 * the cold record and the splice chain instead of the warm ProseMirror state.
 */
const live = new Set<Scenario>()
async function coldScenario(testInfo: TestInfo, content: string): Promise<Scenario> {
  const value = await Scenario.create(testInfo, content)
  value.env.STRATAMD_EDITOR_CACHE = '0'
  live.add(value)
  return value
}
test.afterEach(async () => {
  await Promise.all([...live].map(async (value) => { await value.dispose(); live.delete(value) }))
})

const BASE = '# Probe\n\nBase.\n'
/** Longer than prosemirror-history's 500 ms group delay, so each burst is its own undo event. */
const GROUP_GAP = 600

async function bufferText(value: Scenario): Promise<string> {
  return readFile((await value.state()).buffer!, 'utf8')
}
function editorOf(page: Page) {
  return page.getByRole('textbox', { name: /document editor/i })
}
async function typeLineAfter(page: Page, paragraphText: string, text: string): Promise<void> {
  await editorOf(page).locator('p').filter({ hasText: paragraphText }).last().click()
  await page.keyboard.press('End')
  await page.waitForTimeout(GROUP_GAP)
  await page.keyboard.press('Enter')
  await page.keyboard.type(text)
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
/** Undo (or redo) until the buffer matches, tolerating multi-group bursts. */
async function stepUntilBuffer(value: Scenario, direction: 'undo' | 'redo', expected: string): Promise<void> {
  const step = direction === 'undo' ? undo : redo
  for (let presses = 0; presses < 6 && (await bufferText(value)) !== expected; presses += 1) {
    await step(value.page!)
    await value.page!.waitForTimeout(150)
  }
  await value.waitForBuffer(expected)
}
/** Open a second document and switch back, forcing a cold rebuild of the first. */
async function coldSwitchAway(value: Scenario): Promise<void> {
  const page = value.page!
  const second = join(dirname(value.file), 'second.md')
  await writeFile(second, '# Second\n')
  expect((await value.cli(['open', second])).code).toBe(0)
  await expect(page.getByRole('tab', { name: /second\.md/i })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: /scenario\.md/i }).click()
  await expect(page.getByRole('tab', { name: /scenario\.md/i })).toHaveAttribute('aria-selected', 'true')
}

test.describe('cold tabs (STRATAMD_EDITOR_CACHE=0)', () => {
  test('1. burst granularity survives a switch: two bursts undo as two entries', async ({}, testInfo) => {
    const value = await coldScenario(testInfo, BASE)
    const page = await value.launch()
    await typeLineAfter(page, 'Base.', 'First burst.')
    await expect.poll(() => bufferText(value)).toContain('First burst.')
    const afterFirst = await bufferText(value)
    await typeLineAfter(page, 'First burst.', 'Second burst.')
    await expect.poll(() => bufferText(value)).toContain('Second burst.')

    await coldSwitchAway(value)

    // The intermediate revision must be reachable: one entry per burst, not one blob.
    await stepUntilBuffer(value, 'undo', afterFirst)
    expect(await bufferText(value)).toContain('First burst.')
    await stepUntilBuffer(value, 'undo', BASE)
  })

  test('2. redo crosses a switch and restores the undone typing', async ({}, testInfo) => {
    const value = await coldScenario(testInfo, BASE)
    const page = await value.launch()
    await typeLineAfter(page, 'Base.', 'Typed here.')
    await expect.poll(() => bufferText(value)).toContain('Typed here.')
    const afterTyping = await bufferText(value)
    await stepUntilBuffer(value, 'undo', BASE)

    await coldSwitchAway(value)

    await stepUntilBuffer(value, 'redo', afterTyping)
  })

  test('3. scroll position is restored after a switch', async ({}, testInfo) => {
    const paragraphs = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1} keeps the page tall.`).join('\n\n')
    const value = await coldScenario(testInfo, `# Long\n\n${paragraphs}\n`)
    const page = await value.launch()
    await expect(editorOf(page).locator('p').first()).toBeVisible()
    await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('.editor-scroll')
      if (pane) pane.scrollTop = 600
    })
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.editor-scroll')?.scrollTop ?? 0)).toBeGreaterThan(400)

    await coldSwitchAway(value)

    await expect.poll(
      () => page.evaluate(() => document.querySelector<HTMLElement>('.editor-scroll')?.scrollTop ?? 0),
    ).toBeGreaterThan(400)
  })

  test('4. source caret lands at the change start after a cold undo', async ({}, testInfo) => {
    const value = await coldScenario(testInfo, BASE)
    const page = await value.launch()
    await editorOf(page).focus()
    await page.keyboard.press(primaryKey('/'))
    const source = page.getByRole('textbox', { name: /source editor/i })
    await expect(source).toBeVisible()
    await source.focus()
    await page.keyboard.press(documentEndKey)
    await page.keyboard.type('Extra line.\n')
    await page.waitForTimeout(GROUP_GAP)
    const afterTyping = `${BASE}Extra line.\n`
    await value.waitForBuffer(afterTyping)

    await coldSwitchAway(value)

    await expect(source).toBeVisible()
    await source.focus()
    for (let presses = 0; presses < 6 && (await bufferText(value)) !== BASE; presses += 1) {
      await page.keyboard.press(primaryKey('z'))
      await page.waitForTimeout(150)
    }
    await value.waitForBuffer(BASE)
    expect(await source.inputValue()).toBe(BASE)
    expect(await source.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(BASE.length)
  })
})
