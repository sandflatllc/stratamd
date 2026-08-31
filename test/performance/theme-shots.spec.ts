import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { STOCK_THEMES } from '../../src/shared/bundled-themes'
import { THEME_SAMPLE_MARKDOWN } from '../../src/shared/theme-sample'

/**
 * Full-window screenshots of every stock theme for the owner's palette-pass
 * review (theme-restructure-plan.md §7.3): the sample document plus an attached
 * agent, a pending change, an annotation, and the theme panel. Review evidence,
 * never a checked-in gate. STRATAMD_SHOTS_DIR names the output subdirectory.
 */

test('stock theme screenshots', async ({}, testInfo) => {
  test.setTimeout(STOCK_THEMES.size * 60_000)
  const directory = join('test-results', 'themes', process.env.STRATAMD_SHOTS_DIR ?? 'latest')
  await mkdir(directory, { recursive: true })
  for (const id of STOCK_THEMES.keys()) {
    const value = await Scenario.create(testInfo, THEME_SAMPLE_MARKDOWN, 'palette-review.md')
    try {
      await value.writeSettings({ theme: id })
      const page = await value.launch()
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })

      // Attribution, a pending change, and an annotation, so review and people colors show.
      expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
      const state = await value.state()
      await value.tag('agent-a', 'Agent A')
      await value.atomicWrite(state.buffer!, THEME_SAMPLE_MARKDOWN.replace('level-one heading', 'level-one heading, revised'))
      await expect(page.getByRole('button', { name: /^Keep change /i }).first()).toBeVisible()
      const quote = 'Paragraphs'
      await page.evaluate(async ({ path, from, to }) => window.strata.addAnnotation(path, {
        kind: 'question', quote: 'Paragraphs', text: 'Does this read well?', from, to,
      }), { path: value.file, from: THEME_SAMPLE_MARKDOWN.indexOf(quote), to: THEME_SAMPLE_MARKDOWN.indexOf(quote) + quote.length })

      await page.waitForTimeout(1_500)
      await page.screenshot({ path: join(directory, `${id}.png`), fullPage: false })

      await page.getByRole('button', { name: 'Theme', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Theme' })).toBeVisible()
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(directory, `${id}--panel.png`), fullPage: false })
    } finally {
      await value.dispose()
    }
  }
})
