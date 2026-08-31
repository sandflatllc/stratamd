import { expect, test, type TestInfo } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { idleViolations } from './budgets'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { installRendererProbe, ProcessSampler, rendererProbeSnapshot, resetRendererProbe } from './metrics'
import { attachReport, environmentDetails } from './report'
import type { PerformanceRunReport } from './types'

async function idleRun(testInfo: TestInfo, variant: 'default' | 'motion-off'): Promise<void> {
  const durationMs = Number(process.env.STRATAMD_PERF_IDLE_MS ?? (process.env.STRATAMD_PERF_PROFILE === 'idle' ? 10 * 60_000 : 10_000))
  // Warm up before sampling, per the plan: launch-time allocation (ambient
  // animation layers, first paint) otherwise reads as idle memory growth.
  // Measured 2026-08-29: the motion-on run allocates ~66 MB in the first
  // minute and is flat afterward.
  const warmupMs = Number(process.env.STRATAMD_PERF_IDLE_WARMUP_MS ?? (process.env.STRATAMD_PERF_PROFILE === 'idle' ? 90_000 : 2_000))
  test.setTimeout(durationMs + warmupMs + 120_000)
  const corpus = generateCorpus('rich', 100_000)
  const value = await Scenario.create(testInfo, corpus.markdown, 'idle-rich.md')
  if (variant === 'motion-off') await value.writeSettings({ ambientMotion: false })
  const startedAt = new Date()
  try {
    await writeCorpusAssets(value.file)
    const launchStarted = performance.now()
    const page = await value.launch()
    await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })
    const readyMs = performance.now() - launchStarted
    await installRendererProbe(page)
    await resetRendererProbe(page)
    // Ambient floor experiments: inject candidate CSS (docs/plans/open/performance-plan.md item 5).
    const css = process.env.STRATAMD_AMBIENT_CSS
    if (css) await page.addStyleTag({ content: css })
    // Prototype: replay glow animations at a reduced cadence (see ambient-trace).
    const throttleHz = Number(process.env.STRATAMD_AMBIENT_THROTTLE ?? '')
    if (Number.isFinite(throttleHz) && throttleHz > 0) {
      const throttleSelector = process.env.STRATAMD_AMBIENT_THROTTLE_SELECTOR ?? '.ambient-glow'
      await page.evaluate(([hz, selector]) => {
        const animations: Array<{ animation: Animation; startTime: number }> = []
        for (const element of document.querySelectorAll(selector)) {
          for (const animation of element.getAnimations()) {
            animation.pause()
            animations.push({ animation, startTime: Number(animation.currentTime ?? 0) })
          }
        }
        const epoch = performance.now()
        setInterval(() => {
          const elapsed = performance.now() - epoch
          for (const entry of animations) entry.animation.currentTime = entry.startTime + elapsed
        }, 1000 / hz)
      }, [throttleHz, throttleSelector] as const)
    }
    await page.waitForTimeout(warmupMs)
    const sampler = new ProcessSampler(value.app!, 1_000)
    await sampler.start()
    const startingMemory = sampler.samples[0]?.processes.reduce((sum, process) => sum + process.workingSetKB, 0) ?? 0
    await page.waitForTimeout(durationMs)
    const processSummary = await sampler.stop()
    const renderer = await rendererProbeSnapshot(page)
    const endingMemory = sampler.samples.at(-1)?.processes.reduce((sum, process) => sum + process.workingSetKB, 0) ?? startingMemory
    const memoryGrowthMB = (endingMemory - startingMemory) / 1024
    const violations = idleViolations(processSummary, memoryGrowthMB)
    const report: PerformanceRunReport = {
      schemaVersion: 1,
      runId: `idle-${variant}-${durationMs}`,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      profile: 'idle',
      environment: await environmentDetails(value.app!),
      corpus: corpus.manifest,
      readyMs,
      actions: [],
      renderer,
      process: processSummary,
      processSamples: sampler.samples,
      violations,
      classification: violations.length > 0 ? 'degraded' : 'comfortable',
      failure: null,
    }
    await attachReport(testInfo, report)
    if (process.env.STRATAMD_PERF_ENFORCE === '1') expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  } finally {
    await value.dispose()
  }
}

test('idle with the default visual presentation', async ({}, testInfo) => {
  await idleRun(testInfo, 'default')
})

test('idle with ambient motion disabled', async ({}, testInfo) => {
  await idleRun(testInfo, 'motion-off')
})
