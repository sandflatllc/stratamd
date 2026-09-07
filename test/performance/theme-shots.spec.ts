import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expect, test } from '../e2e/test'
import { openAppMenu, primaryKey, Scenario } from '../e2e/harness'
import { STOCK_THEMES } from '../../src/shared/bundled-themes'
import { THEME_SAMPLE_MARKDOWN } from '../../src/shared/theme-sample'

/**
 * Full-window screenshots of every stock theme for the owner's palette-pass
 * review: a document plus a pending change, an annotation, and the theme
 * panel. Review evidence, never a checked-in gate.
 *
 * STRATAMD_SHOTS_DIR names the output subdirectory. STRATAMD_SHOTS_SOURCE
 * points at a Markdown file to open instead of the theme sample (the README
 * theme captures use the agent collaboration plan), and STRATAMD_SHOTS_VIEWPORT
 * is `WIDTHxHEIGHT` (default 1440x1200).
 * STRATAMD_SHOTS_OUTPUT overrides the entire output path, keeping comparisons
 * outside Playwright's cleanup directory. STRATAMD_SHOTS_THEME selects one
 * theme; STRATAMD_SHOTS_INSPECT pauses it for CDP inspection on port 19347.
 */

test('stock theme screenshots', async ({}, testInfo) => {
  test.setTimeout(STOCK_THEMES.size * 60_000)
  const directory = process.env.STRATAMD_SHOTS_OUTPUT ?? join('test-results', 'themes', process.env.STRATAMD_SHOTS_DIR ?? 'latest')
  await mkdir(directory, { recursive: true })
  const source = process.env.STRATAMD_SHOTS_SOURCE ? await readFile(process.env.STRATAMD_SHOTS_SOURCE, 'utf8') : THEME_SAMPLE_MARKDOWN
  const [width, height] = (process.env.STRATAMD_SHOTS_VIEWPORT ?? '1440x1200').split('x').map(Number) as [number, number]
  const quote = source === THEME_SAMPLE_MARKDOWN ? 'Paragraphs' : source.match(/^[A-Z][a-z]+ [a-z]+ [a-z]+/m)?.[0] ?? 'the'
  for (const id of STOCK_THEMES.keys()) {
    if (process.env.STRATAMD_SHOTS_THEME && process.env.STRATAMD_SHOTS_THEME !== id) continue
    const value = await Scenario.create(testInfo, source, process.env.STRATAMD_SHOTS_SOURCE ? basename(process.env.STRATAMD_SHOTS_SOURCE) : 'palette-review.md')
    try {
      await value.writeSettings({ theme: id })
      const page = await value.launch(value.file, process.env.STRATAMD_SHOTS_INSPECT ? ['--remote-debugging-port=19347'] : [])
      await page.setViewportSize({ width, height })
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })

      // A direct replacement and a suggestion exercise both review renderers.
      const state = await value.inspectDocument()
      await value.atomicWrite(state.buffer!, source === THEME_SAMPLE_MARKDOWN
        ? source.replace('It uses the', 'This heading uses the')
        : source.replace(/^(#[^\n]*)/m, '$1, revised'))
      await expect(page.getByRole('button', { name: /^Keep change /i }).first()).toBeVisible()
      await page.evaluate(async ({ path, quote, from, to }) => window.strata.addAnnotation(path, {
        kind: 'question', quote, text: 'Does this read well?', from, to,
      }), { path: value.file, quote, from: source.indexOf(quote), to: source.indexOf(quote) + quote.length })

      if (source === THEME_SAMPLE_MARKDOWN) {
        const quote = 'Inside a paragraph'
        await page.evaluate(async ({ path, quote, from }) => window.strata.addAnnotation(path, {
          kind: 'suggestion', quote, text: 'Within each paragraph', from, to: from + quote.length,
        }), { path: value.file, quote, from: source.indexOf(quote) })
        await expect(page.locator('.strata-suggestion-replacement')).toBeVisible()
      }

      await page.waitForTimeout(1_500)
      await page.screenshot({ path: join(directory, `${id}.png`), fullPage: false })
      if (process.env.STRATAMD_SHOTS_INSPECT) await page.waitForTimeout(60_000)

      if (source === THEME_SAMPLE_MARKDOWN) {
        await page.getByRole('tab', { name: /^Items/ }).click()
        await expect(page.locator('#review-panel-annotations')).toBeVisible()
        await page.screenshot({ path: join(directory, `${id}--comments.png`), fullPage: false })
        await page.getByRole('tab', { name: /^Changes/ }).click()
        await expect(page.locator('#review-panel-changes')).toBeVisible()
      }

      // The lower half of the sample: tasks, quote, table, code block, rule.
      await page.locator('.editor-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(directory, `${id}--bottom.png`), fullPage: false })
      await page.locator('.editor-scroll').evaluate((element) => { element.scrollTop = 0 })

      if (source === THEME_SAMPLE_MARKDOWN) {
        await page.getByRole('textbox', { name: /document editor/i }).focus()
        await page.locator('.ProseMirror p').filter({ hasText: 'Levels three through six' }).evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
        })
        await page.waitForTimeout(250)
        await page.screenshot({ path: join(directory, `${id}--selection.png`), fullPage: false })
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press(primaryKey('/'))
        await expect(page.getByRole('textbox', { name: /source editor/i })).toBeVisible()
        await page.locator('.editor-scroll').evaluate((element) => { element.scrollTop = 0 })
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(directory, `${id}--source.png`), fullPage: false })
        await page.keyboard.press(primaryKey('/'))
        await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible()
      }

      await openAppMenu(page)
      await page.getByRole('menuitem', { name: 'Theme', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Theme' })).toBeVisible()
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(directory, `${id}--panel.png`), fullPage: false })
    } finally {
      await value.dispose()
    }
  }
})
