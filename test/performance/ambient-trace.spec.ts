import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { selfTimes, threadNames, type TraceEvent } from './trace-utils'

/**
 * Attribute the ambient-motion idle cost: trace visible idle across every
 * process and report per-second self-time for each busy thread (renderer
 * main, renderer compositor, GPU/viz), so the floor-finding work knows
 * whether frames cost main-thread style/paint, re-rasterization, or pure
 * compositing.
 */

const TRACE_MS = 12_000

test('ambient idle trace at 100 KB', async ({}, testInfo) => {
  test.setTimeout(5 * 60_000)
  const corpus = generateCorpus('rich', 100_000)
  const value = await Scenario.create(testInfo, corpus.markdown, 'ambient-rich.md')
  try {
    await writeCorpusAssets(value.file)
    const page = await value.launch()
    await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible({ timeout: 30_000 })
    // Ablation support: hide one ambient element group, or inject raw CSS
    // (e.g. freezing a group with `animation-name: none` so layers and paint
    // stay while ticking stops).
    const ablate = process.env.STRATAMD_AMBIENT_ABLATE
    if (ablate) await page.addStyleTag({ content: `${ablate} { display: none !important; }` })
    const css = process.env.STRATAMD_AMBIENT_CSS
    if (css) await page.addStyleTag({ content: css })
    // Prototype: tick blurred glow animations at a reduced rate instead of the
    // display refresh — identical keyframes, easing, and phase, sampled less
    // often. Pausing the CSS animation and advancing currentTime replays it
    // exactly at the chosen cadence.
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
    // Let launch allocation and first paints settle before measuring.
    await page.waitForTimeout(5_000)

    const session = await page.context().newCDPSession(page)
    const collected: TraceEvent[] = []
    session.on('Tracing.dataCollected', (payload) => {
      collected.push(...((payload as { value: unknown[] }).value as TraceEvent[]))
    })
    const complete = new Promise<void>((resolve) => session.once('Tracing.tracingComplete', () => resolve()))
    await session.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        recordMode: 'recordUntilFull',
        includedCategories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'blink.animations',
          'cc',
          'gpu',
          'viz',
        ],
      },
    })
    // Infinite animations started at launch; restart them under tracing so
    // Blink emits their Animation events with compositing decisions.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>('.ambient-page > i, .ambient-layer > i')) {
        const name = element.style.animationName
        element.style.animationName = 'none'
        void element.offsetWidth
        element.style.animationName = name
      }
    })
    await page.waitForTimeout(TRACE_MS)
    await session.send('Tracing.end')
    await complete

    const names = threadNames(collected)
    const withSelf = selfTimes(collected)
    const byThread = new Map<string, { name: string; totalUs: number; byEvent: Map<string, { us: number; count: number }> }>()
    for (const event of withSelf) {
      const key = `${event.pid}:${event.tid}`
      const entry = byThread.get(key) ?? { name: names.get(key) ?? key, totalUs: 0, byEvent: new Map() }
      entry.totalUs += event.selfUs
      const record = entry.byEvent.get(event.name) ?? { us: 0, count: 0 }
      record.us += event.selfUs
      record.count += 1
      entry.byEvent.set(event.name, record)
      byThread.set(key, entry)
    }
    const threads = [...byThread.values()]
      .filter((entry) => entry.totalUs > 20_000)
      .sort((left, right) => right.totalUs - left.totalUs)
      .map((entry) => ({
        thread: entry.name,
        msPerSecond: Number((entry.totalUs / 1000 / (TRACE_MS / 1000)).toFixed(1)),
        topEvents: [...entry.byEvent.entries()]
          .sort((left, right) => right[1].us - left[1].us)
          .slice(0, 8)
          .map(([name, record]) => ({
            name,
            msPerSecond: Number((record.us / 1000 / (TRACE_MS / 1000)).toFixed(2)),
            countPerSecond: Number((record.count / (TRACE_MS / 1000)).toFixed(1)),
          })),
      }))

    // Blink names each animation's compositing decision; distinct payloads
    // say which keyframes were forced onto the main thread and why.
    const animationPayloads = new Map<string, number>()
    for (const event of collected) {
      if (event.name !== 'Animation' || !event.args?.data) continue
      const key = JSON.stringify(event.args.data)
      animationPayloads.set(key, (animationPayloads.get(key) ?? 0) + 1)
    }
    const animations = [...animationPayloads.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 24)
      .map(([data, count]) => ({ count, data: JSON.parse(data) as unknown }))

    const report = { schemaVersion: 1, corpus: corpus.manifest, traceMs: TRACE_MS, threads, animations, totalTraceEvents: collected.length }
    console.log(JSON.stringify(report, null, 2))
    const outDir = join('test-results', 'performance', 'ambient')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'idle-trace.json'), `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await value.dispose()
  }
})
