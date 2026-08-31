import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { AMBIENT_STYLES } from '../../src/shared/theme-keys'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { ProcessSampler } from './metrics'

/**
 * Idle cost of every ambient style, measured one at a time: each of the
 * background styles with windows off, each window style with the background
 * off, plus the all-off baseline. Short settled-idle sampling per the
 * owner's method (the 30 s baseline reproduces the ten-minute run).
 */

const SETTLE_MS = 15_000
const SAMPLE_MS = 25_000

interface SweepRow {
  background: string
  windows: string
  averageCpuPercent: number
  cpuByType: Record<string, number>
}

test('ambient style sweep', async ({}, testInfo) => {
  const styles = AMBIENT_STYLES.map((style) => style.id).filter((id) => id !== 'none')
  const configurations: Array<{ background: string; windows: string }> = [
    { background: 'none', windows: 'none' },
    ...styles.map((id) => ({ background: id, windows: 'none' })),
    ...styles.map((id) => ({ background: 'none', windows: id })),
  ]
  test.setTimeout(configurations.length * (SETTLE_MS + SAMPLE_MS + 45_000))

  const corpus = generateCorpus('rich', 100_000)
  const rows: SweepRow[] = []
  for (const configuration of configurations) {
    const value = await Scenario.create(testInfo, corpus.markdown, 'sweep-rich.md')
    try {
      await writeCorpusAssets(value.file)
      const themePath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd/themes/sweep.json')
      await mkdir(dirname(themePath), { recursive: true })
      await writeFile(themePath, `${JSON.stringify({
        name: 'Sweep',
        effects: { 'background-style': configuration.background, 'panel-style': configuration.windows },
      }, null, 2)}\n`)
      await value.writeSettings({ theme: 'sweep' })
      const page = await value.launch()
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(SETTLE_MS)
      const sampler = new ProcessSampler(value.app!, 1_000)
      await sampler.start()
      await page.waitForTimeout(SAMPLE_MS)
      const summary = await sampler.stop()
      const row: SweepRow = {
        background: configuration.background,
        windows: configuration.windows,
        averageCpuPercent: Number(summary.averageCpuPercent.toFixed(2)),
        cpuByType: Object.fromEntries(Object.entries(summary.averageCpuByType).map(([type, cpu]) => [type, Number(cpu.toFixed(2))])),
      }
      rows.push(row)
      console.log(JSON.stringify(row))
    } finally {
      await value.dispose()
    }
  }

  const report = { schemaVersion: 1, settleMs: SETTLE_MS, sampleMs: SAMPLE_MS, corpus: corpus.manifest, rows }
  const outDir = join('test-results', 'performance', 'ambient')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'style-sweep.json'), `${JSON.stringify(report, null, 2)}\n`)
})
