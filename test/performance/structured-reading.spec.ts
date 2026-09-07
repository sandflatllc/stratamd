import { expect, test } from '../e2e/test'
import { writeFile } from 'node:fs/promises'
import { generateCorpus } from './corpus'
import { Scenario } from '../e2e/harness'

interface ReadingPerformanceSample {
  bytes: number
  readyMs: number
  typeHeadingMs: number
  headingIndexMs: number | null
}

test('structured-reading >2 MB open, typing, and heading-index sample', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const corpus = generateCorpus('rich', 2_100_000)
  const value = await Scenario.create(testInfo, corpus.markdown, 'structured-reading-large.md')
  try {
    const readyStarted = performance.now()
    const page = await value.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toContainText(corpus.firstHeading, { timeout: 60_000 })
    const readyMs = performance.now() - readyStarted

    await editor.focus()
    await editor.evaluate((root) => {
      const heading = root.querySelector('h1')
      if (!heading) throw new Error('The performance fixture heading is missing')
      const range = document.createRange()
      range.selectNodeContents(heading)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    const typeStarted = performance.now()
    await page.keyboard.insertText(' measured')
    await expect(editor.getByRole('heading', { name: `${corpus.firstHeading} measured` })).toBeVisible({ timeout: 60_000 })
    const typeHeadingMs = performance.now() - typeStarted
    const headingIndexText = await page.locator('html').getAttribute('data-heading-index-ms')
    const sample: ReadingPerformanceSample = {
      bytes: corpus.manifest.bytes,
      readyMs,
      typeHeadingMs,
      headingIndexMs: headingIndexText === null ? null : Number(headingIndexText),
    }
    const path = testInfo.outputPath('structured-reading-performance.json')
    await writeFile(path, `${JSON.stringify(sample, null, 2)}\n`)
    await testInfo.attach('structured-reading-performance.json', { path, contentType: 'application/json' })
    if (sample.headingIndexMs !== null) expect(sample.headingIndexMs).toBeLessThan(50)
  } finally {
    await value.dispose()
  }
})
