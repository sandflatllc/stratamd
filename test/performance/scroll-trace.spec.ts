import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { selfTimes, stageOf, threadNames, type TraceEvent } from './trace-utils'

/**
 * Chromium-trace attribution of the scroll jank at 100 KB rich (remaining-work
 * item 4). Repeats the smoke workflow's 800 ms animated traversal under
 * tracing, finds the frames longer than 50 ms from the trace's own animation
 * frames, and splits each long frame into renderer main-thread stages
 * (script, style, layout, paint, GC), compositor, raster, and GPU/viz work.
 * Variants ablate ambient motion and prototype the plan's item 11
 * containment experiment so the fix candidate is measured, not assumed.
 */

const TRAVERSALS = Number(process.env.STRATAMD_SCROLL_TRAVERSALS ?? 8)
// The smoke workflow's traversal leg. A shorter leg exposes more new content
// per frame, which is how the rare raster stall is made reproducible.
const LEG_MS = Number(process.env.STRATAMD_SCROLL_LEG_MS ?? 400)
const LONG_FRAME_MS = 50
const BYTES = Number(process.env.STRATAMD_SCROLL_BYTES ?? 100_000)

interface PageFrame {
  traversal: number
  intervalMs: number
  scrollTop: number
  fraction: number
}

interface TraversalDriverResult {
  frames: PageFrame[]
  scrollHeight: number
  clientHeight: number
  domNodes: number
}

/** Sample-level V8 profiler decode so a single frame window can be attributed. */
function profileSamples(events: readonly TraceEvent[]): Array<{ ts: number; name: string; us: number }> {
  const nodes = new Map<number, string>()
  const samples: Array<{ ts: number; name: string; us: number }> = []
  let clock: number | null = null
  const ordered = events
    .filter((event) => event.name === 'Profile' || event.name === 'ProfileChunk')
    .sort((left, right) => left.ts - right.ts)
  for (const event of ordered) {
    const data = event.args?.data as { startTime?: number; cpuProfile?: { nodes?: Array<{ id: number; callFrame: { functionName?: string; url?: string } }>; samples?: number[] }; timeDeltas?: number[] } | undefined
    if (event.name === 'Profile') {
      clock = data?.startTime ?? event.ts
      continue
    }
    for (const node of data?.cpuProfile?.nodes ?? []) {
      const url = node.callFrame.url ? node.callFrame.url.split('/').at(-1) : ''
      nodes.set(node.id, `${node.callFrame.functionName || '(anonymous)'}${url ? ` [${url}]` : ''}`)
    }
    const ids = data?.cpuProfile?.samples ?? []
    const deltas = data?.timeDeltas ?? []
    if (clock === null) clock = event.ts
    for (let index = 0; index < ids.length; index += 1) {
      const delta = deltas[index] ?? 0
      clock += delta
      samples.push({ ts: clock, name: nodes.get(ids[index]!) ?? `(node ${ids[index]})`, us: delta })
    }
  }
  return samples
}

function topBy(counts: Map<string, number>, limit: number, divisor = 1): Array<{ name: string; ms: number }> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, us]) => ({ name, ms: Number((us / 1000 / divisor).toFixed(2)) }))
}

async function driveTraversals(page: Page): Promise<TraversalDriverResult> {
  return page.locator('.editor-scroll').evaluate((node, options) => new Promise<TraversalDriverResult>((resolve) => {
    const frames: PageFrame[] = []
    const maximum = node.scrollHeight - node.clientHeight
    let last: number | null = null
    let traversal = 0
    const record = (now: number) => {
      if (last !== null) {
        frames.push({
          traversal,
          intervalMs: now - last,
          scrollTop: Math.round(node.scrollTop),
          fraction: maximum === 0 ? 0 : Number((node.scrollTop / maximum).toFixed(3)),
        })
      }
      last = now
    }
    // The smoke workflow's traversal: 400 ms down, 400 ms back, rAF-driven.
    const animate = (from: number, to: number, durationMs: number, done: () => void) => {
      const started = performance.now()
      const step = (now: number) => {
        record(now)
        const progress = Math.min(1, (now - started) / durationMs)
        node.scrollTop = from + (to - from) * progress
        if (progress < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    }
    const runTraversal = () => {
      if (traversal >= options.traversals) {
        resolve({ frames, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, domNodes: document.getElementsByTagName('*').length })
        return
      }
      animate(0, maximum, options.legMs, () => animate(maximum, 0, options.legMs, () => {
        traversal += 1
        last = null
        setTimeout(runTraversal, 250)
      }))
    }
    runTraversal()
  }), { traversals: TRAVERSALS, legMs: LEG_MS })
}

async function traceRun(testInfo: TestInfo, variant: string): Promise<void> {
  test.setTimeout(6 * 60_000)
  const corpus = generateCorpus('rich', BYTES)
  const value = await Scenario.create(testInfo, corpus.markdown, 'scroll-rich.md')
  if (variant.includes('motion-off')) await value.writeSettings({ ambientMotion: false })
  try {
    await writeCorpusAssets(value.file)
    const page = await value.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toBeVisible({ timeout: 30_000 })
    if (variant.includes('contain') && !variant.includes('strict')) {
      // Item 11's experiment as a throwaway prototype: skip rendering work for
      // offscreen top-level editor blocks.
      await page.addStyleTag({ content: '.prosemirror-host .ProseMirror > * { content-visibility: auto; contain-intrinsic-size: auto 160px; }' })
    }
    if (variant === 'contain-strict') {
      await page.addStyleTag({ content: '.prosemirror-host .ProseMirror > * { contain: layout paint style; }' })
    }
    const extraCss = process.env.STRATAMD_SCROLL_CSS
    if (extraCss) await page.addStyleTag({ content: extraCss })
    // Settle launch parses, first paint, and ambient warm-up.
    await page.waitForTimeout(3_000)
    // The smoke workflow scrolls immediately after opening two extra tabs and
    // switching back to the large document, so its scroll window can contain
    // the tail of that rebuild. This variant reproduces that exact context.
    if (variant === 'after-tab-switch') {
      const documents = dirname(value.file)
      await writeFile(join(documents, 'performance-side-note.md'), '# Performance side note\n\nSmall tab used for switching.\n')
      await writeFile(join(documents, 'performance-checklist.md'), '# Performance checklist\n\n- [ ] Return to the loaded fixture\n')
      await page.evaluate((path) => window.strata.openDocument(path), join(documents, 'performance-side-note.md'))
      await page.evaluate((path) => window.strata.openDocument(path), join(documents, 'performance-checklist.md'))
      await page.locator('.tabs .tab').filter({ hasText: basename(value.file) }).click()
      await expect(editor).toBeVisible({ timeout: 60_000 })
      await expect(editor).toContainText(corpus.firstHeading, { timeout: 60_000 })
    }

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
          'cc',
          'gpu',
          'viz',
        ],
      },
    })
    if (variant !== 'after-tab-switch') await page.waitForTimeout(300)
    const driver = await driveTraversals(page)
    await page.waitForTimeout(400)
    await session.send('Tracing.end')
    await complete

    const names = threadNames(collected)
    // The renderer main thread is the one firing our traversal's rAF callbacks.
    const animationFrames = collected.filter((event) => event.name === 'FireAnimationFrame' && event.ph === 'X')
    expect(animationFrames.length).toBeGreaterThan(50)
    const byThreadCount = new Map<string, number>()
    for (const event of animationFrames) {
      const key = `${event.pid}:${event.tid}`
      byThreadCount.set(key, (byThreadCount.get(key) ?? 0) + 1)
    }
    const mainKey = [...byThreadCount.entries()].sort((left, right) => right[1] - left[1])[0]![0]
    const rendererPid = Number(mainKey.split(':')[0])
    const mainEvents = collected.filter((event) => `${event.pid}:${event.tid}` === mainKey)
    const mainSelf = selfTimes(mainEvents)
    // Self time is only meaningful per thread: nesting is a per-thread stack.
    const byThread = new Map<string, TraceEvent[]>()
    for (const event of collected) {
      const key = `${event.pid}:${event.tid}`
      const bucket = byThread.get(key)
      if (bucket) bucket.push(event)
      else byThread.set(key, [event])
    }
    const allSelf = [...byThread.entries()].flatMap(([key, events]) => key === mainKey ? [] : selfTimes(events))

    // Frames: clusters of rAF callbacks that share one animation-frame task.
    const frameStarts: number[] = []
    for (const event of animationFrames.filter((candidate) => `${candidate.pid}:${candidate.tid}` === mainKey).sort((left, right) => left.ts - right.ts)) {
      if (frameStarts.length === 0 || event.ts - frameStarts.at(-1)! > 3_000) frameStarts.push(event.ts)
    }
    const intervals = frameStarts.slice(1).map((ts, index) => ({ from: frameStarts[index]!, to: ts, ms: (ts - frameStarts[index]!) / 1000 }))
    // Between-traversal pauses are not frames of the measured traversal.
    const measured = intervals.filter((interval) => interval.ms < 200)
    const long = measured.filter((interval) => interval.ms > LONG_FRAME_MS)

    const samples = profileSamples(collected.filter((event) => event.pid === rendererPid))
    const classify = (key: string): string => {
      const name = names.get(key) ?? ''
      if (key === mainKey) return 'renderer-main'
      if (name === 'Compositor') return 'compositor'
      if (name.startsWith('CompositorTileWorker')) return 'raster'
      if (name === 'VizCompositorThread') return 'viz'
      if (name === 'CrGpuMain') return 'gpu-main'
      if (name === 'CrRendererMain') return 'other-renderer-main'
      return name || key
    }

    const summarize = (windows: Array<{ from: number; to: number }>) => {
      const stage = new Map<string, number>()
      const eventName = new Map<string, number>()
      const thread = new Map<string, number>()
      const functionName = new Map<string, number>()
      // Long events span frames, so charge each window its share of the
      // event's wall-clock span rather than the frame where it started.
      const sorted = [...windows].sort((left, right) => left.from - right.from)
      const firstAfter = (ts: number): number => {
        let low = 0
        let high = sorted.length
        while (low < high) {
          const middle = (low + high) >> 1
          if (sorted[middle]!.to <= ts) low = middle + 1
          else high = middle
        }
        return low
      }
      const share = (event: { ts: number; dur?: number }): number => {
        const span = Math.max(1, event.dur ?? 1)
        let inside = 0
        for (let index = firstAfter(event.ts); index < sorted.length && sorted[index]!.from < event.ts + span; index += 1) {
          inside += Math.max(0, Math.min(event.ts + span, sorted[index]!.to) - Math.max(event.ts, sorted[index]!.from))
        }
        return inside / span
      }
      for (const event of mainSelf) {
        const weight = share(event) * event.selfUs
        if (weight <= 0) continue
        stage.set(stageOf(event.name), (stage.get(stageOf(event.name)) ?? 0) + weight)
        eventName.set(event.name, (eventName.get(event.name) ?? 0) + weight)
      }
      for (const event of allSelf) {
        const weight = share(event) * event.selfUs
        if (weight <= 0) continue
        const bucket = classify(`${event.pid}:${event.tid}`)
        thread.set(bucket, (thread.get(bucket) ?? 0) + weight)
        eventName.set(`${bucket}:${event.name}`, (eventName.get(`${bucket}:${event.name}`) ?? 0) + weight)
      }
      for (const sample of samples) {
        const index = firstAfter(sample.ts)
        const window = sorted[index]
        if (window && sample.ts >= window.from) functionName.set(sample.name, (functionName.get(sample.name) ?? 0) + sample.us)
      }
      const count = windows.length || 1
      const spanMs = windows.reduce((total, w) => total + (w.to - w.from) / 1000, 0)
      return {
        windows: windows.length,
        spanMs: Number(spanMs.toFixed(1)),
        mainSelfMsPerFrame: Number(([...stage.values()].reduce((total, us) => total + us, 0) / 1000 / count).toFixed(2)),
        stagePerFrameMs: Object.fromEntries([...stage.entries()].sort((l, r) => r[1] - l[1]).map(([key, us]) => [key, Number((us / 1000 / count).toFixed(2))])),
        threadPerFrameMs: Object.fromEntries([...thread.entries()].sort((l, r) => r[1] - l[1]).map(([key, us]) => [key, Number((us / 1000 / count).toFixed(2))])),
        topEventsPerFrameMs: topBy(eventName, 16, count),
        topFunctionsPerFrameMs: topBy(functionName, 14, count),
      }
    }

    const pageFrames = driver.frames
    const pageLong = pageFrames.filter((frame) => frame.intervalMs > LONG_FRAME_MS)
    const report = {
      schemaVersion: 1,
      variant,
      corpus: corpus.manifest,
      traversals: TRAVERSALS,
      dom: { nodes: driver.domNodes, scrollHeight: driver.scrollHeight, clientHeight: driver.clientHeight },
      pageClock: {
        frames: pageFrames.length,
        framesOver50: pageLong.length,
        percentOver50: Number((pageLong.length / Math.max(1, pageFrames.length) * 100).toFixed(2)),
        p50Ms: Number(([...pageFrames].map((frame) => frame.intervalMs).sort((a, b) => a - b)[Math.floor(pageFrames.length * 0.5)] ?? 0).toFixed(1)),
        p95Ms: Number(([...pageFrames].map((frame) => frame.intervalMs).sort((a, b) => a - b)[Math.floor(pageFrames.length * 0.95)] ?? 0).toFixed(1)),
        maxMs: Number(Math.max(0, ...pageFrames.map((frame) => frame.intervalMs)).toFixed(1)),
        perTraversalOver50: Array.from({ length: TRAVERSALS }, (_, index) => pageLong.filter((frame) => frame.traversal === index).length),
        perTraversalFrames: Array.from({ length: TRAVERSALS }, (_, index) => pageFrames.filter((frame) => frame.traversal === index).length),
        longFrames: pageLong.slice(0, 40).map((frame) => ({ traversal: frame.traversal, ms: Number(frame.intervalMs.toFixed(1)), fraction: frame.fraction })),
      },
      traceClock: {
        frames: measured.length,
        framesOver50: long.length,
        percentOver50: Number((long.length / Math.max(1, measured.length) * 100).toFixed(2)),
        maxMs: Number(Math.max(0, ...measured.map((interval) => interval.ms)).toFixed(1)),
      },
      longFrameAttribution: summarize(long),
      normalFrameAttribution: summarize(measured.filter((interval) => interval.ms <= LONG_FRAME_MS)),
      longFrameDetail: long.slice(0, 12).map((interval) => ({ ms: Number(interval.ms.toFixed(1)), ...summarize([interval]) })),
      totalTraceEvents: collected.length,
    }
    console.log(JSON.stringify({ ...report, longFrameDetail: undefined }, null, 2))
    const outDir = join('test-results', 'performance', 'scroll')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, `${variant}.json`), `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await value.dispose()
  }
}

const variants = (process.env.STRATAMD_SCROLL_VARIANTS ?? 'default,motion-off,contain').split(',').map((entry) => entry.trim()).filter(Boolean)
for (const variant of variants) {
  test(`scroll frame trace at 100 KB, ${variant}`, async ({}, testInfo) => {
    await traceRun(testInfo, variant)
  })
}
