import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { selfTimes, stageOf, threadNames, type TraceEvent } from './trace-utils'

/**
 * Chromium-trace attribution of the smoke workflow's `tab-switch-large` step
 * (remaining-work "explore before deciding": the large tab switch). Repeats the
 * switch away-and-back under tracing with the V8 sampling profiler on, brackets
 * each switch with user-timing marks, and splits the bracketed window into
 * renderer main-thread stages and named functions, plus the other threads.
 *
 * Variants: `warm` (default LRU, the returned-to tab still holds its editor)
 * and `cold` (`STRATAMD_EDITOR_CACHE=0`, every switch rebuilds by reparse).
 */

const SWITCHES = Number(process.env.STRATAMD_TAB_SWITCHES ?? 6)
const BYTES = Number(process.env.STRATAMD_TAB_BYTES ?? 100_000)

interface SwitchSample {
  index: number
  toLargeMs: number
  toSmallMs: number
  startMark: number
  endMark: number
}

interface DriverResult {
  samples: SwitchSample[]
  domNodes: number
}

/** Sample-level V8 profiler decode so one switch window can be attributed. */
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

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * Drive the smoke workflow's switch repeatedly from inside the page: click the
 * tab, wait until the editor is mounted and shows the document's first heading,
 * then two animation frames, exactly as `measureAction` + its assertions do.
 */
async function driveSwitches(page: Page, largeTab: string, smallTab: string, heading: string, count: number): Promise<DriverResult> {
  return page.evaluate(({ largeTab, smallTab, heading, count }) => new Promise<DriverResult>((resolve) => {
    const findTab = (label: string): HTMLElement => {
      const tabs = [...document.querySelectorAll<HTMLElement>('.tabs .tab')]
      const match = tabs.find((tab) => (tab.textContent ?? '').includes(label))
      if (!match) throw new Error(`Tab not found: ${label} (have ${tabs.map((tab) => tab.textContent).join(' | ')})`)
      return match
    }
    const settled = (expected: string): boolean => {
      const editor = document.querySelector<HTMLElement>('.prosemirror-host .strata-prosemirror')
      return Boolean(editor && (editor.textContent ?? '').includes(expected))
    }
    const twoFrames = (done: () => void) => requestAnimationFrame(() => requestAnimationFrame(done))
    const click = (label: string, expected: string, mark: string | null, done: (ms: number) => void) => {
      if (mark) performance.mark(`${mark}-start`)
      const started = performance.now()
      findTab(label).click()
      const poll = () => {
        if (settled(expected)) {
          twoFrames(() => {
            const ms = performance.now() - started
            if (mark) performance.mark(`${mark}-end`)
            done(ms)
          })
          return
        }
        requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    }
    const samples: SwitchSample[] = []
    const step = (index: number) => {
      if (index >= count) {
        resolve({ samples, domNodes: document.getElementsByTagName('*').length })
        return
      }
      // Away to the small document, settle, then back to the large one. Only
      // the return leg is bracketed for attribution.
      click(smallTab, 'Performance side note', null, (toSmallMs) => {
        setTimeout(() => {
          click(largeTab, heading, `switch-${index}`, (toLargeMs) => {
            const marks = performance.getEntriesByName(`switch-${index}-start`)
            const endMarks = performance.getEntriesByName(`switch-${index}-end`)
            samples.push({
              index,
              toLargeMs,
              toSmallMs,
              startMark: marks[0]?.startTime ?? 0,
              endMark: endMarks[0]?.startTime ?? 0,
            })
            setTimeout(() => step(index + 1), 900)
          })
        }, 900)
      })
    }
    step(0)
  }), { largeTab, smallTab, heading, count })
}

/**
 * The ceiling on any "keep the editor DOM for warm tabs" fix: the cost of
 * putting an already-built, never-destroyed editor subtree back on screen.
 * Two shapes are measured against the same document — detach/re-append (what a
 * retained-DOM cache would do) and a `display:none` toggle (what keeping every
 * open tab mounted would do) — each timed to the second animation frame after
 * the change, the same settle rule the switch driver uses.
 */
interface ReattachProbe {
  reattachMs: number[]
  displayMs: number[]
  cloneMs: number[]
  /** Scroll heights after each shape settles: proof the subtree is really laid out. */
  scrollHeights: { detached: number[]; reattached: number[]; hidden: number[]; shown: number[]; cloned: number[] }
  subtreeNodes: number
}

async function driveReattach(page: Page, count: number): Promise<ReattachProbe> {
  return page.evaluate(({ count }) => new Promise<ReattachProbe>((resolve) => {
    const host = document.querySelector<HTMLElement>('.prosemirror-host')
    if (!host) throw new Error('The editor host is missing')
    const editor = host.querySelector<HTMLElement>('.strata-visual-editor')
    if (!editor) throw new Error('The visual editor element is missing')
    const scroller = document.querySelector<HTMLElement>('.editor-scroll')
    if (!scroller) throw new Error('The editor scroller is missing')
    const probe: ReattachProbe = {
      reattachMs: [], displayMs: [], cloneMs: [],
      scrollHeights: { detached: [], reattached: [], hidden: [], shown: [], cloned: [] },
      subtreeNodes: editor.getElementsByTagName('*').length,
    }
    const twoFrames = (done: () => void) => requestAnimationFrame(() => requestAnimationFrame(done))
    // While the large editor is detached the pane must show something else, or
    // the compositor keeps the old tiles and the probe under-reports paint.
    const placeholder = window.document.createElement('div')
    placeholder.style.cssText = 'font-size:18px;line-height:1.7'
    placeholder.textContent = ''
    for (let index = 0; index < 400; index += 1) {
      const line = window.document.createElement('p')
      line.textContent = `Placeholder line ${index} standing in for the other tab's document content.`
      placeholder.append(line)
    }
    // Detach and re-append the built subtree: what a retained-DOM cache pays.
    const reattachRound = (index: number, done: () => void) => {
      editor.remove()
      host.append(placeholder)
      // Let the stand-in tab lay out, paint, and raster in the same pane.
      setTimeout(() => {
        probe.scrollHeights.detached.push(scroller.scrollHeight)
        const started = performance.now()
        performance.mark(`reattach-${index}-start`)
        // A real switch also tears the outgoing tab's DOM out of the pane.
        placeholder.remove()
        host.append(editor)
        twoFrames(() => {
          probe.reattachMs.push(performance.now() - started)
          performance.mark(`reattach-${index}-end`)
          probe.scrollHeights.reattached.push(scroller.scrollHeight)
          setTimeout(done, 900)
        })
      }, 900)
    }
    // Keep every open tab mounted and toggle visibility instead.
    const displayRound = (index: number, done: () => void) => {
      editor.style.display = 'none'
      host.append(placeholder)
      setTimeout(() => {
        probe.scrollHeights.hidden.push(scroller.scrollHeight)
        const started = performance.now()
        performance.mark(`display-${index}-start`)
        placeholder.remove()
        editor.style.display = ''
        twoFrames(() => {
          probe.displayMs.push(performance.now() - started)
          performance.mark(`display-${index}-end`)
          probe.scrollHeights.shown.push(scroller.scrollHeight)
          setTimeout(done, 900)
        })
      }, 900)
    }
    // Control: fresh element identities for the same markup must pay full
    // style resolution and layout, so a near-zero reattach is not an artifact
    // of the probe failing to observe the work.
    const cloneRound = (index: number, done: () => void) => {
      const copy = editor.cloneNode(true) as HTMLElement
      editor.remove()
      host.append(placeholder)
      setTimeout(() => {
        const started = performance.now()
        performance.mark(`clone-${index}-start`)
        placeholder.remove()
        host.append(copy)
        twoFrames(() => {
          probe.cloneMs.push(performance.now() - started)
          performance.mark(`clone-${index}-end`)
          probe.scrollHeights.cloned.push(scroller.scrollHeight)
          copy.remove()
          host.append(editor)
          setTimeout(done, 900)
        })
      }, 900)
    }
    const step = (index: number) => {
      if (index >= count) {
        resolve(probe)
        return
      }
      reattachRound(index, () => displayRound(index, () => cloneRound(index, () => step(index + 1))))
    }
    step(0)
  }), { count })
}

async function traceRun(testInfo: TestInfo, variant: string): Promise<void> {
  test.setTimeout(6 * 60_000)
  const corpus = generateCorpus('rich', BYTES)
  const value = await Scenario.create(testInfo, corpus.markdown, 'tab-switch-rich.md')
  if (variant === 'cold') value.env.STRATAMD_EDITOR_CACHE = '0'
  if (variant === 'cache1') value.env.STRATAMD_EDITOR_CACHE = '1'
  try {
    await writeCorpusAssets(value.file)
    const page = await value.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await expect(editor).toContainText(corpus.firstHeading, { timeout: 30_000 })

    const documents = dirname(value.file)
    const second = join(documents, 'performance-side-note.md')
    const third = join(documents, 'performance-checklist.md')
    await writeFile(second, '# Performance side note\n\nSmall tab used for switching.\n')
    await writeFile(third, '# Performance checklist\n\n- [ ] Return to the loaded fixture\n')
    await page.evaluate((path) => window.strata.openDocument(path), second)
    await page.evaluate((path) => window.strata.openDocument(path), third)
    await expect(page.locator('.tabs .tab')).toHaveCount(3, { timeout: 30_000 })
    // Settle launch parses, first paint, and ambient warm-up.
    await page.waitForTimeout(3_000)

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
    if (variant === 'reattach') {
      // Opening the two side documents makes the last one active; the probe
      // needs the large document mounted.
      await page.locator('.tabs .tab').filter({ hasText: basename(value.file) }).click()
      await expect(editor).toContainText(corpus.firstHeading, { timeout: 60_000 })
      await page.waitForTimeout(1_500)
    }
    const reattach = variant === 'reattach' ? await driveReattach(page, SWITCHES) : null
    const driver = reattach
      ? { samples: [], domNodes: 0 }
      : await driveSwitches(page, basename(value.file), basename(second), corpus.firstHeading, SWITCHES)
    await page.waitForTimeout(400)
    await session.send('Tracing.end')
    await complete

    const names = threadNames(collected)
    // The renderer main thread is the one carrying our user-timing marks.
    const prefix = variant === 'reattach' ? 'reattach-' : 'switch-'
    const markEvents = collected.filter((event) => event.name.startsWith(prefix) && (event.name.endsWith('-start') || event.name.endsWith('-end')))
    expect(markEvents.length).toBeGreaterThanOrEqual(SWITCHES * 2)
    const mainKey = `${markEvents[0]!.pid}:${markEvents[0]!.tid}`
    const rendererPid = markEvents[0]!.pid
    const windows: Array<{ index: number; from: number; to: number; ms: number }> = []
    for (let index = 0; index < SWITCHES; index += 1) {
      const from = markEvents.find((event) => event.name === `${prefix}${index}-start`)?.ts
      const to = markEvents.find((event) => event.name === `${prefix}${index}-end`)?.ts
      if (from === undefined || to === undefined) continue
      windows.push({ index, from, to, ms: (to - from) / 1000 })
    }
    expect(windows.length).toBeGreaterThan(0)

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
    const otherSelf = [...byThread.entries()].flatMap(([key, events]) => key === mainKey ? [] : selfTimes(events))
    const samples = profileSamples(collected.filter((event) => event.pid === rendererPid))

    const classify = (key: string): string => {
      const name = names.get(key) ?? ''
      if (key === mainKey) return 'renderer-main'
      if (name === 'Compositor') return 'compositor'
      if (name.startsWith('CompositorTileWorker')) return 'raster'
      if (name === 'VizCompositorThread') return 'viz'
      if (name === 'CrGpuMain') return 'gpu-main'
      if (name === 'CrRendererMain') return 'other-renderer-main'
      if (name === 'CrBrowserMain') return 'browser-main'
      return name || key
    }

    const summarize = (chosen: Array<{ from: number; to: number }>) => {
      const stage = new Map<string, number>()
      const eventName = new Map<string, number>()
      const thread = new Map<string, number>()
      const functionName = new Map<string, number>()
      const sorted = [...chosen].sort((left, right) => left.from - right.from)
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
      // Long events span windows, so charge each window its share of the
      // event's wall-clock span rather than the window where it started.
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
      for (const event of otherSelf) {
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
      const count = chosen.length || 1
      const spanMs = chosen.reduce((total, entry) => total + (entry.to - entry.from) / 1000, 0)
      const mainTotalUs = [...stage.values()].reduce((total, us) => total + us, 0)
      return {
        windows: chosen.length,
        wallMsPerSwitch: Number((spanMs / count).toFixed(2)),
        mainSelfMsPerSwitch: Number((mainTotalUs / 1000 / count).toFixed(2)),
        idleMsPerSwitch: Number(((spanMs * 1000 - mainTotalUs) / 1000 / count).toFixed(2)),
        stagePerSwitchMs: Object.fromEntries([...stage.entries()].sort((l, r) => r[1] - l[1]).map(([key, us]) => [key, Number((us / 1000 / count).toFixed(2))])),
        threadPerSwitchMs: Object.fromEntries([...thread.entries()].sort((l, r) => r[1] - l[1]).map(([key, us]) => [key, Number((us / 1000 / count).toFixed(2))])),
        topEventsPerSwitchMs: topBy(eventName, 20, count),
        topFunctionsPerSwitchMs: topBy(functionName, 25, count),
      }
    }

    /** Ordered top-level main-thread work inside one window: what runs when. */
    const timeline = (window: { from: number; to: number }) => {
      const inside = mainEvents
        // `RunTask` wraps everything; the interesting nesting starts below it.
        .filter((event) => event.ph === 'X' && event.name !== 'RunTask' && typeof event.dur === 'number' && event.ts + event.dur! > window.from && event.ts < window.to)
        .sort((left, right) => left.ts - right.ts || (right.dur ?? 0) - (left.dur ?? 0))
      const stack: number[] = []
      return inside.map((event) => {
        while (stack.length > 0 && stack.at(-1)! <= event.ts) stack.pop()
        const depth = stack.length
        stack.push(event.ts + (event.dur ?? 0))
        return {
          depth,
          name: event.name,
          atMs: Number(((event.ts - window.from) / 1000).toFixed(2)),
          durMs: Number(((event.dur ?? 0) / 1000).toFixed(2)),
        }
      })
    }

    const report = {
      schemaVersion: 1,
      variant,
      corpus: corpus.manifest,
      switches: SWITCHES,
      dom: { nodes: driver.domNodes },
      reattachProbe: reattach ? {
        subtreeNodes: reattach.subtreeNodes,
        scrollHeights: reattach.scrollHeights,
        reattachMs: reattach.reattachMs.map((value) => Number(value.toFixed(1))),
        reattachMedianMs: Number(median(reattach.reattachMs).toFixed(1)),
        displayToggleMs: reattach.displayMs.map((value) => Number(value.toFixed(1))),
        displayToggleMedianMs: Number(median(reattach.displayMs).toFixed(1)),
        cloneMs: reattach.cloneMs.map((value) => Number(value.toFixed(1))),
        cloneMedianMs: Number(median(reattach.cloneMs).toFixed(1)),
      } : null,
      pageClock: {
        toLargeMs: driver.samples.map((sample) => Number(sample.toLargeMs.toFixed(1))),
        toLargeMedianMs: Number(median(driver.samples.map((sample) => sample.toLargeMs)).toFixed(1)),
        toSmallMs: driver.samples.map((sample) => Number(sample.toSmallMs.toFixed(1))),
        toSmallMedianMs: Number(median(driver.samples.map((sample) => sample.toSmallMs)).toFixed(1)),
      },
      traceClock: {
        windowMs: windows.map((window) => Number(window.ms.toFixed(1))),
        medianMs: Number(median(windows.map((window) => window.ms)).toFixed(1)),
      },
      // The first switch after launch behaves differently (JIT, cold caches),
      // so steady state excludes it.
      steadyState: summarize(windows.slice(1)),
      firstSwitch: summarize(windows.slice(0, 1)),
      timelines: windows.slice(1, 3).map((window) => ({ index: window.index, ms: Number(window.ms.toFixed(1)), events: timeline(window) })),
      perSwitch: windows.map((window) => ({ index: window.index, ms: Number(window.ms.toFixed(1)), ...summarize([window]) })),
      totalTraceEvents: collected.length,
    }
    console.log(JSON.stringify({ ...report, perSwitch: undefined }, null, 2))
    const outDir = join('test-results', 'performance', 'tab-switch')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, `${variant}.json`), `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await value.dispose()
  }
}

const variants = (process.env.STRATAMD_TAB_VARIANTS ?? 'warm,cold').split(',').map((entry) => entry.trim()).filter(Boolean)
for (const variant of variants) {
  test(`tab switch trace at ${BYTES} bytes, ${variant}`, async ({}, testInfo) => {
    await traceRun(testInfo, variant)
  })
}
