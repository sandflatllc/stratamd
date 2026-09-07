import { expect, test } from '../e2e/test'
import { dirname, join } from 'node:path'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { Scenario } from '../e2e/harness'

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function chartRows(): string {
  return Array.from({ length: 1_000 }, (_, index) => `| Point ${index + 1} | ${(index * 17) % 997} |`).join('\n')
}

async function interactionFeedback(root: import('@playwright/test').Locator, buttonLabel: string, expectedAttribute: string): Promise<number> {
  return root.evaluate(async (element, input) => {
    const button = Array.from(element.querySelectorAll('button')).find((candidate) =>
      candidate.textContent === input.buttonLabel || candidate.getAttribute('aria-label') === input.buttonLabel)
    if (!button) throw new Error(`Missing ${input.buttonLabel} button`)
    const started = performance.now()
    button.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!element.hasAttribute(input.expectedAttribute)) throw new Error(`${input.buttonLabel} produced no visible state`)
    return performance.now() - started
  }, { buttonLabel, expectedAttribute })
}

test('Phase 8 visuals meet chart, interaction, bundle, and single-image budgets', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const scenario = await Scenario.create(testInfo, '# Preparing\n', 'phase8-visuals.md')
  try {
    const image = join(dirname(scenario.file), 'review.png')
    await writeFile(image, imageBytes)
    const details = await stat(image, { bigint: true })
    const version = `${details.size}:${details.mtimeNs}`
    const markdown = `# Phase 8 performance

<DecisionMatrix>
| Criterion | Current | Bounded |
|---|---|---|
| Safety | Partial | Strong |
</DecisionMatrix>

<AnnotatedScreenshot>
![Review screenshot](./review.png)

| Pin | X | Y | Image version | Note |
|---:|---:|---:|---|---|
| 1 | 24.0 | 31.5 | ${version} | Inspect this boundary. |
</AnnotatedScreenshot>

<Chart kind="line">
| Sample | Value |
|---|---:|
${chartRows()}
</Chart>
`
    await writeFile(scenario.file, markdown)
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    const chart = editor.getByRole('region', { name: 'Chart: line' })
    const surface = chart.locator('.strata-chart-surface')
    await expect(surface.getByRole('img', { name: 'line chart with 1000 categories and 1 series' })).toBeVisible({ timeout: 60_000 })
    const chartRenderMs = Number(await surface.getAttribute('data-chart-render-ms'))

    const matrix = editor.getByRole('region', { name: 'DecisionMatrix: DecisionMatrix' })
    const matrixFeedbackMs = await interactionFeedback(matrix, 'Focus Bounded', 'data-focused-alternative')

    const screenshot = editor.getByRole('region', { name: 'AnnotatedScreenshot: AnnotatedScreenshot' })
    const focusFeedbackMs = await interactionFeedback(screenshot, 'Focus image', 'data-screenshot-focused')
    const imageIdentity = await screenshot.evaluate((root) => {
      const images = root.querySelectorAll<HTMLImageElement>('img:not(.ProseMirror-separator)')
      return { count: images.length, complete: images[0]?.complete ?? false, width: images[0]?.naturalWidth ?? 0 }
    })
    const pinFeedbackMs = await interactionFeedback(screenshot, 'Pin 1: Inspect this boundary.', 'data-active-pin')
    await expect(page.locator('.annotation-composer')).toBeVisible()
    const decodedImagesAfterAnnotation = await screenshot.locator('img:not(.ProseMirror-separator)').count()

    const assetDirectory = join(process.cwd(), 'out/renderer/assets')
    const chartChunk = (await readdir(assetDirectory)).find((name) => /^chart-renderer-.*\.js$/u.test(name))
    if (!chartChunk) throw new Error('Chart lazy chunk was not emitted')
    const chartChunkBytes = (await stat(join(assetDirectory, chartChunk))).size
    const externalResources = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /^https?:/u.test(url)))
    const result = {
      chart: { points: 1_000, renderMs: chartRenderMs, lazyChunk: chartChunk, lazyChunkBytes: chartChunkBytes },
      interaction: { matrixFeedbackMs, focusFeedbackMs, pinFeedbackMs },
      screenshot: { beforeAnnotation: imageIdentity, afterAnnotationCount: decodedImagesAfterAnnotation },
      externalResources,
    }
    const output = testInfo.outputPath('visual-components-performance.json')
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
    await testInfo.attach('visual-components-performance.json', { path: output, contentType: 'application/json' })

    expect(chartRenderMs).toBeLessThan(500)
    expect(matrixFeedbackMs).toBeLessThan(100)
    expect(focusFeedbackMs).toBeLessThan(100)
    expect(pinFeedbackMs).toBeLessThan(100)
    expect(imageIdentity).toEqual({ count: 1, complete: true, width: 1 })
    expect(decodedImagesAfterAnnotation).toBe(1)
    expect(externalResources).toEqual([])
  } finally {
    await scenario.dispose()
  }
})
