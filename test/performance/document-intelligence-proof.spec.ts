import { expect, test } from '../e2e/test'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario, projectRoot } from '../e2e/harness'

const reviewPath = '/home/dillonc/Projects/_agent_research/2026-09-01-mesa-practices-review/REVIEW.md'

function mermaidFences(markdown: string): string[] {
  return [...markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gmu)].map((match) => match[1] ?? '')
}

async function heapSize(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    return memory?.usedJSHeapSize ?? null
  })
}

test('real review Mermaid fences render under the sandbox before NodeView integration', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const review = await readFile(reviewPath, 'utf8')
  const diagrams = mermaidFences(review)
  expect(diagrams).toHaveLength(3)
  expect(diagrams.some((diagram) => diagram.includes('<br/>'))).toBe(true)

  const scenario = await Scenario.create(testInfo, '# Mermaid dependency proof\n')
  try {
    const page = await scenario.launch()
    await page.waitForFunction(() => window.strataMermaidProof !== undefined)
    const session = await page.context().newCDPSession(page)
    await session.send('HeapProfiler.collectGarbage')
    const baselineHeap = await heapSize(page)

    const rendered: Array<{ durationMs: number; normalizedBreaks: boolean; text: string }> = []
    for (const diagram of diagrams) {
      rendered.push(await page.evaluate(async ({ source }) => {
        if (!window.strataMermaidProof) throw new Error('Mermaid proof hook is unavailable')
        return window.strataMermaidProof.render(source, true)
      }, { source: diagram }))
    }
    const afterRenderHeap = await heapSize(page)
    await page.evaluate(() => window.strataMermaidProof?.clear())
    await session.send('HeapProfiler.collectGarbage')
    const retainedHeap = await heapSize(page)

    const assets = join(projectRoot, 'out/renderer/assets')
    const assetNames = await readdir(assets)
    const chunks = await Promise.all(assetNames
      .filter((name) => /mermaid|diagram|cytoscape|dagre|elk/iu.test(name))
      .map(async (name) => ({ name, bytes: (await stat(join(assets, name))).size })))
    const sample = {
      fixture: reviewPath,
      diagrams: rendered.map((result) => ({
        durationMs: result.durationMs,
        normalizedBreaks: result.normalizedBreaks,
        containsLiteralBreakTag: /<br\s*\/?>/iu.test(result.text),
      })),
      firstRenderMs: rendered[0]?.durationMs ?? null,
      baselineHeap,
      afterRenderHeap,
      retainedHeap,
      retainedDelta: baselineHeap === null || retainedHeap === null ? null : retainedHeap - baselineHeap,
      lazyChunks: chunks,
    }
    const output = testInfo.outputPath('document-intelligence-proof.json')
    await writeFile(output, `${JSON.stringify(sample, null, 2)}\n`)
    await testInfo.attach('document-intelligence-proof.json', { path: output, contentType: 'application/json' })

    expect(rendered).toHaveLength(3)
    expect(rendered.every((result) => result.text.length > 0)).toBe(true)
    expect(rendered.every((result) => !/<br\s*\/?>/iu.test(result.text))).toBe(true)
    expect(sample.firstRenderMs).not.toBeNull()
    expect(sample.firstRenderMs ?? Infinity).toBeLessThan(1_000)
    expect(chunks.length).toBeGreaterThan(0)
  } finally {
    await scenario.dispose()
  }
})
