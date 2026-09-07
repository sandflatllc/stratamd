import { expect, test } from '../e2e/test'
import { writeFile } from 'node:fs/promises'
import { Scenario } from '../e2e/harness'
import { generateCorpus } from './corpus'

interface Sample {
  disabled: boolean
  readyMs: number
  typingMs: number
  transactionMs: number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

async function measure(
  testInfo: import('@playwright/test').TestInfo,
  markdown: string,
  lastSection: number,
  disabled: boolean,
  run: number,
): Promise<Sample> {
  const scenario = await Scenario.create(testInfo, markdown, `phase7-${disabled ? 'off' : 'on'}-${run}.md`)
  if (disabled) scenario.env.STRATAMD_PHASE7_DISABLED = '1'
  try {
    const started = performance.now()
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    await expect(editor.getByRole('heading', { name: `Plain section ${lastSection}` })).toBeAttached({ timeout: 90_000 })
    const readyMs = performance.now() - started
    const paragraph = editor.locator('p').first()
    await paragraph.evaluate((content) => {
      const range = document.createRange()
      range.selectNodeContents(content)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    const typingStarted = performance.now()
    await page.keyboard.insertText(' measured')
    await expect(paragraph).toContainText('measured', { timeout: 30_000 })
    return {
      disabled,
      readyMs,
      typingMs: performance.now() - typingStarted,
      transactionMs: Number(await page.locator('html').getAttribute('data-editor-transaction-ms')),
    }
  } finally {
    await scenario.dispose()
  }
}

test('greater-than-2-MB component parsing and child serialization stay within the Phase 7 budget', async ({}, testInfo) => {
  test.setTimeout(10 * 60_000)
  const corpus = generateCorpus('plain', 2_100_000)
  const markdown = `<PhaseBoard>\n${corpus.markdown}\n</PhaseBoard>\n`
  const samples: Sample[] = []
  for (let run = 0; run < 3; run += 1) {
    samples.push(await measure(testInfo, markdown, corpus.manifest.sections, true, run))
    samples.push(await measure(testInfo, markdown, corpus.manifest.sections, false, run))
  }
  const baseline = samples.filter((sample) => sample.disabled)
  const enabled = samples.filter((sample) => !sample.disabled)
  const result = {
    bytes: Buffer.byteLength(markdown),
    samples,
    ready: {
      baseline: median(baseline.map((sample) => sample.readyMs)),
      enabled: median(enabled.map((sample) => sample.readyMs)),
    },
    transaction: {
      baseline: median(baseline.map((sample) => sample.transactionMs)),
      enabled: median(enabled.map((sample) => sample.transactionMs)),
    },
    typing: {
      baseline: median(baseline.map((sample) => sample.typingMs)),
      enabled: median(enabled.map((sample) => sample.typingMs)),
    },
  }
  const readyRegression = (result.ready.enabled - result.ready.baseline) / result.ready.baseline
  const transactionRegression = (result.transaction.enabled - result.transaction.baseline) / result.transaction.baseline
  const output = testInfo.outputPath('components-performance.json')
  await writeFile(output, `${JSON.stringify({ ...result, readyRegression, transactionRegression }, null, 2)}\n`)
  await testInfo.attach('components-performance.json', { path: output, contentType: 'application/json' })
  expect(readyRegression).toBeLessThanOrEqual(0.10)
  expect(transactionRegression).toBeLessThanOrEqual(0.10)
  expect(result.transaction.enabled).toBeLessThan(100)
})
