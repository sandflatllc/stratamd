import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { profileSelfTimes, selfTimes, stageOf, type TraceEvent } from './trace-utils'

/**
 * Chromium-trace attribution of the per-keystroke cost at 100 KB rich.
 * Types isolated keystrokes mid-document under tracing and splits renderer
 * main-thread self-time into script, style recalc, layout, paint, and GC,
 * so the input-to-paint budget violation gets a named stage instead of a
 * guess. The motion-off variant isolates the ambient-motion CSS reacting
 * to the per-keystroke `data-typing` toggle.
 */

const KEYSTROKES = 40
const KEY_DELAY_MS = 160

async function traceRun(testInfo: TestInfo, variant: 'default' | 'motion-off'): Promise<void> {
  test.setTimeout(5 * 60_000)
  const corpus = generateCorpus('rich', 100_000)
  const value = await Scenario.create(testInfo, corpus.markdown, 'trace-rich.md')
  if (variant === 'motion-off') await value.writeSettings({ ambientMotion: false })
  try {
    await writeCorpusAssets(value.file)
    const page = await value.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toBeVisible({ timeout: 30_000 })
    // Caret mid-document, then settle so ambient state and parses are quiet.
    const paragraphs = editor.locator('p')
    const middle = paragraphs.nth(Math.floor(await paragraphs.count() / 2))
    await middle.click()
    await page.keyboard.press('End')
    await page.waitForTimeout(1_500)

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
          'blink.user_timing',
          'disabled-by-default-v8.cpu_profiler',
          'disabled-by-default-v8.cpu_profiler.hires',
        ],
      },
    })
    await page.waitForTimeout(300)
    for (let stroke = 0; stroke < KEYSTROKES; stroke += 1) {
      await page.keyboard.type('x')
      await page.waitForTimeout(KEY_DELAY_MS)
    }
    await page.waitForTimeout(400)
    await session.send('Tracing.end')
    await complete

    // Renderer main thread: the (pid, tid) where keydown dispatches happen.
    const keydowns = collected.filter((event) => event.name === 'EventDispatch' && event.args?.data?.type === 'keydown')
    expect(keydowns.length).toBeGreaterThanOrEqual(KEYSTROKES)
    const mainKey = `${keydowns[0]!.pid}:${keydowns[0]!.tid}`
    const mainEvents = collected.filter((event) => `${event.pid}:${event.tid}` === mainKey)

    const withSelf = selfTimes(mainEvents)
    const window = {
      from: Math.min(...keydowns.map((event) => event.ts)) - 5_000,
      to: Math.max(...keydowns.map((event) => event.ts + (event.dur ?? 0))) + KEY_DELAY_MS * 1_000,
    }
    const inWindow = withSelf.filter((event) => event.ts >= window.from && event.ts <= window.to)

    const byStage: Record<string, number> = {}
    const byName: Record<string, number> = {}
    for (const event of inWindow) {
      byStage[stageOf(event.name)] = (byStage[stageOf(event.name)] ?? 0) + event.selfUs
      byName[event.name] = (byName[event.name] ?? 0) + event.selfUs
    }
    const perKeystrokeMs = Object.fromEntries(
      Object.entries(byStage).map(([stage, us]) => [stage, Number((us / 1000 / KEYSTROKES).toFixed(2))]),
    )
    const topNames = Object.entries(byName)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 14)
      .map(([name, us]) => ({ name, totalMs: Number((us / 1000).toFixed(1)), perKeystrokeMs: Number((us / 1000 / KEYSTROKES).toFixed(2)) }))

    // Profiler chunks land on the renderer's profiler thread; match by pid.
    const rendererPid = keydowns[0]!.pid
    const topFunctions = profileSelfTimes(collected.filter((event) => event.pid === rendererPid)).slice(0, 20)

    // Keydown to the next paint-stage event: an input-to-paint approximation.
    const paints = mainEvents
      .filter((event) => (event.name === 'Paint' || event.name === 'Commit') && event.ph === 'X')
      .sort((left, right) => left.ts - right.ts)
    const latencies = keydowns.map((keydown) => {
      const paint = paints.find((candidate) => candidate.ts >= keydown.ts)
      return paint ? (paint.ts + (paint.dur ?? 0) - keydown.ts) / 1000 : null
    }).filter((valueMs): valueMs is number => valueMs !== null).sort((a, b) => a - b)

    const report = {
      schemaVersion: 1,
      variant,
      corpus: corpus.manifest,
      keystrokes: KEYSTROKES,
      perKeystrokeSelfMs: perKeystrokeMs,
      topEvents: topNames,
      topFunctions,
      keydownToPaintMs: {
        p50: latencies[Math.floor(latencies.length / 2)] ?? null,
        p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
        max: latencies.at(-1) ?? null,
      },
      totalTraceEvents: collected.length,
    }
    console.log(JSON.stringify(report, null, 2))
    const outDir = join('test-results', 'performance', 'keystroke')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, `${variant}.json`), `${JSON.stringify({ ...report, events: undefined }, null, 2)}\n`)
    await writeFile(join(outDir, `${variant}-raw-trace.json`), JSON.stringify({ traceEvents: mainEvents }))
  } finally {
    await value.dispose()
  }
}

test('keystroke stage trace at 100 KB, default presentation', async ({}, testInfo) => {
  await traceRun(testInfo, 'default')
})

test('keystroke stage trace at 100 KB, ambient motion disabled', async ({}, testInfo) => {
  await traceRun(testInfo, 'motion-off')
})
