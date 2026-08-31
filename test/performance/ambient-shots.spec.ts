import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'

/**
 * Full-window screenshots of ambient styles for the owner's visual parity
 * check. STRATAMD_SHOTS_DIR names the output subdirectory (before/after a
 * change); STRATAMD_SHOTS_STYLES overrides the `bg:win` pairs.
 */

const PAIRS = (process.env.STRATAMD_SHOTS_STYLES
  ?? 'rising-motes:glow-orbs,grid-drift:none,none:grid-drift,aurora-drift:none,none:aurora-drift,none:glow-orbs')
  .split(',')
  .map((pair) => pair.split(':') as [string, string])

test('ambient style screenshots', async ({}, testInfo) => {
  test.setTimeout(PAIRS.length * 60_000)
  const directory = join('test-results', 'performance', 'ambient', 'shots', process.env.STRATAMD_SHOTS_DIR ?? 'latest')
  await mkdir(directory, { recursive: true })
  const corpus = generateCorpus('rich', 100_000)
  for (const [background, windows] of PAIRS) {
    const value = await Scenario.create(testInfo, corpus.markdown, 'shots-rich.md')
    try {
      await writeCorpusAssets(value.file)
      const themePath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd/themes/sweep.json')
      await mkdir(dirname(themePath), { recursive: true })
      await writeFile(themePath, `${JSON.stringify({ name: 'Sweep', effects: { 'background-style': background, 'panel-style': windows } }, null, 2)}\n`)
      await value.writeSettings({ theme: 'sweep' })
      const page = await value.launch()
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })
      // Mid-animation moment; timing differs between runs, so these support
      // judging the overall look, not pixel comparison.
      await page.waitForTimeout(6_000)
      await page.screenshot({ path: join(directory, `${background}--${windows}.png`), fullPage: false })
    } finally {
      await value.dispose()
    }
  }
})
