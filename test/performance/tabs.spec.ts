import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { ProcessSampler } from './metrics'
import type { ProcessSummary } from './types'

/**
 * Opens progressively more rich documents as tabs and measures how resource
 * usage scales. Only the focused document is mounted in the renderer, so the
 * expectation to confirm or refute: render cost stays flat while main-process
 * memory, watcher descriptors, and tab-switch latency are the scaling axes.
 */

const rungs = (process.env.STRATAMD_PERF_TAB_RUNGS ?? '1,5,10,25,50,100')
  .split(',')
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0)
  .sort((left, right) => left - right)

// The first file doubles as the constant tab-switch target on every rung.
const SIZE_CYCLE = [100_000, 10_000, 50_000, 100_000, 250_000] as const

interface RungReport {
  openFiles: number
  lastOpenMs: number
  switchToFirstMs: number
  switchBackMs: number
  mainFdCount: number | null
  process: ProcessSummary
}

async function fdCount(pid: number | undefined): Promise<number | null> {
  if (!pid) return null
  try {
    return (await readdir(`/proc/${pid}/fd`)).length
  } catch {
    return null
  }
}

test('resource usage while stacking open documents', async ({}, testInfo) => {
  const maximum = rungs.at(-1)!
  test.setTimeout(30 * 60_000)

  const seed = 1729
  const first = generateCorpus('rich', SIZE_CYCLE[0], seed)
  const value = await Scenario.create(testInfo, first.markdown, 'tab-000.md')
  const documentsDirectory = dirname(value.file)
  await writeCorpusAssets(value.file)
  const paths: string[] = [value.file]
  for (let index = 1; index < maximum; index += 1) {
    const size = SIZE_CYCLE[index % SIZE_CYCLE.length]!
    const corpus = generateCorpus('rich', size, seed + index)
    const path = join(documentsDirectory, `tab-${String(index).padStart(3, '0')}.md`)
    await writeFile(path, corpus.markdown)
    paths.push(path)
  }

  const reports: RungReport[] = []
  const startedAt = new Date()
  try {
    const page = await value.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toBeVisible({ timeout: 30_000 })

    let opened = 1
    let lastOpenMs = 0
    for (const rung of rungs) {
      while (opened < rung) {
        const path = paths[opened]!
        const openStarted = performance.now()
        await page.evaluate((target) => window.strata.openDocument(target), path)
        await expect(page.locator('.tabs .tab').filter({ hasText: basename(path) })).toBeVisible({ timeout: 60_000 })
        await expect(editor).toBeVisible({ timeout: 60_000 })
        lastOpenMs = performance.now() - openStarted
        opened += 1
      }

      // Settle, then sample the quiet state for this rung.
      await page.waitForTimeout(2_000)
      const sampler = new ProcessSampler(value.app!, 1_000)
      await sampler.start()
      await page.waitForTimeout(8_000)
      const processSummary = await sampler.stop()

      const switchStarted = performance.now()
      await page.locator('.tabs .tab').filter({ hasText: basename(paths[0]!) }).click()
      await expect(editor).toContainText(first.firstHeading, { timeout: 60_000 })
      const switchToFirstMs = performance.now() - switchStarted

      const target = paths[opened - 1]!
      const backStarted = performance.now()
      await page.locator('.tabs .tab').filter({ hasText: basename(target) }).click()
      await expect(editor).toBeVisible({ timeout: 60_000 })
      await page.waitForTimeout(100)
      const switchBackMs = performance.now() - backStarted

      reports.push({
        openFiles: rung,
        lastOpenMs,
        switchToFirstMs,
        switchBackMs,
        mainFdCount: await fdCount(value.app!.process().pid ?? undefined),
        process: processSummary,
      })
      console.log(JSON.stringify({
        openFiles: rung,
        lastOpenMs: Math.round(lastOpenMs),
        switchToFirstMs: Math.round(switchToFirstMs),
        totalMB: Math.round(processSummary.endingWorkingSetMB),
        averageCpuPercent: Number(processSummary.averageCpuPercent.toFixed(2)),
        averageCpuByType: Object.fromEntries(Object.entries(processSummary.averageCpuByType).map(([type, cpu]) => [type, Number(cpu.toFixed(2))])),
        mainFdCount: reports.at(-1)!.mainFdCount,
      }))
    }
  } finally {
    await value.dispose()
  }

  const body = `${JSON.stringify({
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    displayMode: process.env.STRATAMD_PERF_DISPLAY_MODE ?? 'unknown',
    sizeCycle: SIZE_CYCLE,
    rungs: reports,
  }, null, 2)}\n`
  const outDir = join('test-results', 'performance', 'tabs')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, `${process.env.STRATAMD_PERF_RUN_ID ?? 'latest'}.json`), body)
  await testInfo.attach('tabs-report.json', { body: Buffer.from(body), contentType: 'application/json' })
})
