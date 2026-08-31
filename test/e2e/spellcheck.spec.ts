import { expect, test, type Page } from '@playwright/test'
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { save, selectVisualEditorRange, Scenario } from './harness'

// The annotate menu's spelling column (docs/plans/completed/spellcheck-plan.md): Electron
// detects and suggests, the pill renders, a click corrects through the normal
// edit path. Everything is DOM, so the whole flow runs under Playwright.

/**
 * Chromium loads Hunspell dictionaries from the session profile and downloads
 * them from its CDN when missing, so a fresh offline profile never reports a
 * misspelling. Seed the scenario from a dictionary an Electron app on this
 * machine already fetched; running `pnpm dev` once with network heals a
 * machine that has none.
 */
async function seedDictionaries(scenario: Scenario): Promise<void> {
  const candidates = [
    process.env.STRATAMD_SPELL_DICTIONARIES,
    join(homedir(), '.config/stratamd/Dictionaries'),
    join(homedir(), '.config/Electron/Dictionaries'),
  ].filter((path): path is string => Boolean(path))
  for (const source of candidates) {
    const entries = await readdir(source).catch(() => [])
    const dictionaries = entries.filter((entry) => entry.endsWith('.bdic'))
    if (dictionaries.length === 0) continue
    const target = join(String(scenario.env.XDG_CONFIG_HOME), 'Electron/Dictionaries')
    await mkdir(target, { recursive: true })
    for (const dictionary of dictionaries) await copyFile(join(source, dictionary), join(target, dictionary))
    return
  }
  throw new Error(`No Hunspell dictionary found in ${candidates.join(', ')}; run the app once with network access`)
}

/**
 * Chromium spellchecks lazily, so the first right-click can precede the marks.
 * Retry the gesture until the pill's spelling column attaches. The left click
 * first collapses any standing selection (right-clicking inside one annotates
 * it, by design) — and it must land on a DIFFERENT word: Chromium hides the
 * spelling marker of the word holding the caret, which would blank the params.
 */
async function rightClickMisspelling(page: Page, word: string, neutralWord: string): Promise<void> {
  const point = await wordPoint(page, word)
  const neutral = await wordPoint(page, neutralWord)
  const column = page.locator('.spelling-options')
  const menu = page.getByRole('menu', { name: /annotate selection/i })
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.mouse.click(neutral.x, neutral.y)
    await page.waitForTimeout(400)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await menu.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined)
    await page.waitForTimeout(700)
    if (await menu.isVisible() && await column.isVisible().catch(() => false)) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  throw new Error(`The spelling column never appeared for ${JSON.stringify(word)}`)
}

async function wordPoint(page: Page, word: string): Promise<{ x: number; y: number }> {
  return page.evaluate((needle) => {
    const paragraphs = [...document.querySelectorAll('.strata-prosemirror p')]
    const paragraph = paragraphs.find((el) => el.textContent?.includes(needle))
    if (!paragraph) throw new Error(`Missing paragraph containing ${needle}`)
    paragraph.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let node: Text | null = null
    let start = -1
    while (walker.nextNode()) {
      const candidate = walker.currentNode as Text
      const found = candidate.data.indexOf(needle)
      if (found >= 0) { node = candidate; start = found }
    }
    if (!node) throw new Error(`Missing text node containing ${needle}`)
    const range = document.createRange()
    const middle = start + Math.floor(needle.length / 2)
    range.setStart(node, middle); range.setEnd(node, middle)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + 1, y: rect.top + rect.height / 2 }
  }, word)
}

test('right-click corrects a misspelling through the annotate menu and learns new words', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const sample = 'Alpha beta occured delta.\n\nGamma blorptastic epsilon.\n'
  const corrected = 'Alpha beta occurred delta.\n\nGamma blorptastic epsilon.\n'

  const scenario = await Scenario.create(testInfo, sample, 'spellcheck.md')
  try {
    await seedDictionaries(scenario)
    const page = await scenario.launch()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    const consoleErrors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.waitForTimeout(1_500)

    const menu = page.getByRole('menu', { name: /annotate selection/i })
    const column = page.locator('.spelling-options')

    // First prove the spellchecker is live: the misspelled word gets a column.
    await rightClickMisspelling(page, 'occured', 'Alpha')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    // A section highlight never grows the column, even over that misspelling.
    await selectVisualEditorRange(page, 'beta', 'delta')
    const inSelection = await wordPoint(page, 'occured')
    await page.mouse.click(inSelection.x, inSelection.y, { button: 'right' })
    await expect(menu).toBeVisible()
    await page.waitForTimeout(1_000)
    await expect(column).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    // On the word itself, a click on the suggestion corrects it.
    await rightClickMisspelling(page, 'occured', 'Alpha')
    await expect(column.getByRole('menuitem', { name: 'occurred', exact: true })).toBeVisible()
    await expect(column.getByRole('menuitem', { name: /add “occured” to dictionary/i })).toBeVisible()
    await column.getByRole('menuitem', { name: 'occurred', exact: true }).click()
    await expect(menu).toBeHidden()
    await scenario.waitForBuffer(corrected)

    // The correction is one normal edit step for undo, redo, and save.
    await page.keyboard.press('Control+z')
    await scenario.waitForBuffer(sample)
    await page.keyboard.press('Control+Shift+z')
    await scenario.waitForBuffer(corrected)
    await save(page)
    await expect.poll(() => readFile(scenario.file, 'utf8')).toBe(corrected)

    // Learning a word clears it: the pill stays, the column empties, and a
    // fresh right-click on the learned word never gets a column again.
    await rightClickMisspelling(page, 'blorptastic', 'Gamma')
    await column.getByRole('menuitem', { name: /add “blorptastic” to dictionary/i }).click()
    await expect(menu).toBeVisible()
    await expect(column).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    const learned = await wordPoint(page, 'blorptastic')
    await page.mouse.click(learned.x, learned.y, { button: 'right' })
    await expect(menu).toBeVisible()
    await page.waitForTimeout(1_000)
    await expect(column).toBeHidden()
    await page.keyboard.press('Escape')

    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((entry) => entry.includes('diverged'))).toEqual([])
  } finally {
    await scenario.dispose()
  }
})
