import { expect, test } from '../e2e/test'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { generateCorpus } from './corpus'
import { Scenario } from '../e2e/harness'

interface Sample {
  disabled: boolean
  readyMs: number
  typingMs: number
  transactionMs: number
  mermaidCoreResources: string[]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

async function measure(testInfo: import('@playwright/test').TestInfo, markdown: string, lastSection: number, disabled: boolean, run: number): Promise<Sample> {
  const scenario = await Scenario.create(testInfo, markdown, `phase6-${disabled ? 'off' : 'on'}-${run}.md`)
  if (disabled) scenario.env.STRATAMD_PHASE6_DISABLED = '1'
  try {
    const started = performance.now()
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    await expect(editor.getByRole('heading', { name: `Plain section ${lastSection}` })).toBeAttached({ timeout: 90_000 })
    const readyMs = performance.now() - started
    const paragraph = editor.locator('p').first()
    await editor.focus()
    await paragraph.evaluate((content) => {
      const range = document.createRange()
      range.selectNodeContents(content)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    const typeStarted = performance.now()
    await page.keyboard.insertText(' measured')
    await expect(paragraph).toContainText('measured', { timeout: 30_000 })
    return {
      disabled,
      readyMs,
      typingMs: performance.now() - typeStarted,
      transactionMs: Number(await page.locator('html').getAttribute('data-editor-transaction-ms')),
      mermaidCoreResources: await page.evaluate(() => performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => /mermaid\.core-/u.test(url))),
    }
  } finally {
    await scenario.dispose()
  }
}

test('construct-free open and typing stay within five percent and preview stays below 100ms', async ({}, testInfo) => {
  test.setTimeout(10 * 60_000)
  const corpus = generateCorpus('plain', 2_100_000)
  const samples: Sample[] = []
  for (let run = 0; run < 3; run += 1) {
    samples.push(await measure(testInfo, corpus.markdown, corpus.manifest.sections, true, run))
    samples.push(await measure(testInfo, corpus.markdown, corpus.manifest.sections, false, run))
  }
  const baseline = samples.filter((sample) => sample.disabled)
  const enabled = samples.filter((sample) => !sample.disabled)
  const readyBaseline = median(baseline.map((sample) => sample.readyMs))
  const typingBaseline = median(baseline.map((sample) => sample.typingMs))
  const readyEnabled = median(enabled.map((sample) => sample.readyMs))
  const typingEnabled = median(enabled.map((sample) => sample.typingMs))
  const transactionBaseline = median(baseline.map((sample) => sample.transactionMs))
  const transactionEnabled = median(enabled.map((sample) => sample.transactionMs))

  const previewScenario = await Scenario.create(testInfo, '# Preview\n\n[Open notes](notes.md)\n', 'preview.md')
  try {
    await writeFile(join(dirname(previewScenario.file), 'notes.md'), '# Notes\n\nFast local preview.\n')
    const page = await previewScenario.launch()
    await page.getByRole('link', { name: 'Open notes' }).click()
    await expect(page.getByRole('dialog', { name: 'Preview notes.md' })).toContainText('Fast local preview.')
    const previewMs = Number(await page.locator('html').getAttribute('data-reference-preview-ms'))
    const result = {
      bytes: corpus.manifest.bytes,
      samples,
      ready: { baseline: readyBaseline, enabled: readyEnabled, regression: (readyEnabled - readyBaseline) / readyBaseline },
      typing: { baseline: typingBaseline, enabled: typingEnabled, regression: (typingEnabled - typingBaseline) / typingBaseline },
      transaction: { baseline: transactionBaseline, enabled: transactionEnabled, regression: (transactionEnabled - transactionBaseline) / transactionBaseline },
      previewMs,
    }
    const output = testInfo.outputPath('document-intelligence-performance.json')
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
    await testInfo.attach('document-intelligence-performance.json', { path: output, contentType: 'application/json' })
    expect(result.ready.regression).toBeLessThanOrEqual(0.05)
    expect(result.transaction.regression).toBeLessThanOrEqual(0.05)
    expect(enabled.every((sample) => sample.mermaidCoreResources.length === 0)).toBe(true)
    expect(previewMs).toBeLessThan(100)
  } finally {
    await previewScenario.dispose()
  }
})
