import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openAppMenu, Scenario } from '../e2e/harness'
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
 */

test('stock theme screenshots', async ({}, testInfo) => {
  test.setTimeout(STOCK_THEMES.size * 60_000)
  const directory = join('test-results', 'themes', process.env.STRATAMD_SHOTS_DIR ?? 'latest')
  await mkdir(directory, { recursive: true })
  const source = process.env.STRATAMD_SHOTS_SOURCE ? await readFile(process.env.STRATAMD_SHOTS_SOURCE, 'utf8') : THEME_SAMPLE_MARKDOWN
  const [width, height] = (process.env.STRATAMD_SHOTS_VIEWPORT ?? '1440x1200').split('x').map(Number) as [number, number]
  const quote = source === THEME_SAMPLE_MARKDOWN ? 'Paragraphs' : source.match(/^[A-Z][a-z]+ [a-z]+ [a-z]+/m)?.[0] ?? 'the'
  for (const id of STOCK_THEMES.keys()) {
    const value = await Scenario.create(testInfo, source, process.env.STRATAMD_SHOTS_SOURCE ? basename(process.env.STRATAMD_SHOTS_SOURCE) : 'palette-review.md')
    try {
      await value.writeSettings({ theme: id })
      const page = await value.launch()
      await page.setViewportSize({ width, height })
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })

      // A pending change (the first heading, revised) and an annotation, so review colors show.
      const state = await value.inspectDocument()
      await value.atomicWrite(state.buffer!, source.replace(/^(#[^\n]*)/m, '$1, revised'))
      await expect(page.getByRole('button', { name: /^Keep change /i }).first()).toBeVisible()
      await page.evaluate(async ({ path, quote, from, to }) => window.strata.addAnnotation(path, {
        kind: 'question', quote, text: 'Does this read well?', from, to,
      }), { path: value.file, quote, from: source.indexOf(quote), to: source.indexOf(quote) + quote.length })

      await page.waitForTimeout(1_500)
      await page.screenshot({ path: join(directory, `${id}.png`), fullPage: false })

      // The lower half of the sample: tasks, quote, table, code block, rule.
      await page.locator('.editor-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(directory, `${id}--bottom.png`), fullPage: false })
      await page.locator('.editor-scroll').evaluate((element) => { element.scrollTop = 0 })

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
