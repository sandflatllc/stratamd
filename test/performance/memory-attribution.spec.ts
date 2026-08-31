import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { Scenario } from '../e2e/harness'
import { generateCorpus, writeCorpusAssets } from './corpus'

/**
 * Lab driver for docs/plans/open/performance-plan.md remaining-work item 6 (memory floor
 * attribution). Walks the tabs ladder's rungs and, at each one, captures every
 * channel that can name where renderer memory sits:
 *
 *  - per-process working set (Electron app metrics) and Linux /proc RSS split
 *    (anon vs file vs shm, Pss, private dirty) — total working set vs private,
 *  - Chromium memory-infra detailed dumps (malloc/partition_alloc/blink_gc/v8/
 *    cc/shared_memory/discardable roots, per-Blink-class Oilpan sizes, and the
 *    live-vs-committed split that separates retained objects from free lists),
 *  - V8 heap usage and DOM counters after a forced GC,
 *  - a full heap snapshot per rung for retainer analysis.
 *
 * Investigation only: nothing here is a gate and no product code is touched.
 */

const SIZE_CYCLE = [100_000, 10_000, 50_000, 100_000, 250_000] as const
const RUNGS = (process.env.STRATAMD_MEMORY_RUNGS ?? '1,4,25')
  .split(',').map(Number).filter((value) => Number.isInteger(value) && value > 0)
  .sort((left, right) => left - right)
const VARIANT = process.env.STRATAMD_MEMORY_VARIANT ?? 'default'
/** Snapshots perturb the very number the ladder reads, so they are opt-in. */
const SNAPSHOTS = process.env.STRATAMD_MEMORY_SNAPSHOTS === '1'
const RUN_ID = process.env.STRATAMD_PERF_RUN_ID ?? 'latest'
// Outside Playwright's outputDir, which is cleaned at the start of every run.
const OUT_DIR = join('test-results', 'memory-lab', `${VARIANT}-${RUN_ID}`)

interface ProcMemory {
  pid: number
  vmRssKB: number | null
  rssAnonKB: number | null
  rssFileKB: number | null
  rssShmemKB: number | null
  pssKB: number | null
  privateDirtyKB: number | null
  privateCleanKB: number | null
  sharedKB: number | null
}

/** Resident bytes grouped by what the mapping is backed by, from /proc/pid/smaps. */
async function smapsBuckets(pid: number): Promise<Record<string, number>> {
  let text = ''
  try { text = await readFile(`/proc/${pid}/smaps`, 'utf8') } catch { return {} }
  const buckets: Record<string, number> = {}
  let bucket = 'anon (heap/other)'
  for (const line of text.split('\n')) {
    const header = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$/.exec(line)
    if (header) {
      const path = (header[1] ?? '').trim()
      bucket = path === '' ? 'anon (heap/other)'
        : path === '[heap]' || path === '[stack]' || path.startsWith('[') ? `anon ${path}`
        : /\.(so|so\.\d+)$/.test(path) ? 'file: shared libraries'
        : /electron$|chrome-sandbox$|\/electron\//.test(path) && !path.includes('.asar') ? 'file: electron binary'
        : path.includes('.asar') || path.endsWith('.js') || path.endsWith('.pak') || path.endsWith('.bin') || path.endsWith('.dat') ? 'file: app + resources'
        : /memfd|dev\/shm|SYSV/.test(path) ? 'shared memory'
        : 'file: other'
      continue
    }
    const rss = /^Rss:\s+(\d+) kB/.exec(line)
    if (rss) buckets[bucket] = (buckets[bucket] ?? 0) + Number(rss[1])
  }
  return buckets
}

/** Resident bytes per mapped file, so 'file-backed' can be named rather than assumed. */
async function smapsFiles(pid: number): Promise<Record<string, number>> {
  let text = ''
  try { text = await readFile(`/proc/${pid}/smaps`, 'utf8') } catch { return {} }
  const files: Record<string, number> = {}
  let current = ''
  for (const line of text.split('\n')) {
    const header = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$/.exec(line)
    if (header) { current = (header[1] ?? '').trim(); continue }
    if (!current || current.startsWith('[anon')) continue
    const rss = /^Rss:\s+(\d+) kB/.exec(line)
    if (rss && Number(rss[1]) > 0) files[current] = (files[current] ?? 0) + Number(rss[1])
  }
  return files
}

async function procMemory(pid: number): Promise<ProcMemory> {
  const read = async (path: string): Promise<string> => {
    try { return await readFile(path, 'utf8') } catch { return '' }
  }
  const field = (text: string, key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)
    return match ? Number(match[1]) : null
  }
  const status = await read(`/proc/${pid}/status`)
  const rollup = await read(`/proc/${pid}/smaps_rollup`)
  const sharedClean = field(rollup, 'Shared_Clean')
  const sharedDirty = field(rollup, 'Shared_Dirty')
  return {
    pid,
    vmRssKB: field(status, 'VmRSS'),
    rssAnonKB: field(status, 'RssAnon'),
    rssFileKB: field(status, 'RssFile'),
    rssShmemKB: field(status, 'RssShmem'),
    pssKB: field(rollup, 'Pss'),
    privateDirtyKB: field(rollup, 'Private_Dirty'),
    privateCleanKB: field(rollup, 'Private_Clean'),
    sharedKB: sharedClean === null && sharedDirty === null ? null : (sharedClean ?? 0) + (sharedDirty ?? 0),
  }
}

interface Capture {
  label: string
  openFiles: number
  appMetrics: Array<{ pid: number; type: string; name: string | null; workingSetMB: number; peakWorkingSetMB: number }>
  proc: ProcMemory[]
  heapUsage: { usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number }
  domCounters: { documents: number; nodes: number; jsEventListeners: number }
  renderer: {
    domNodes: number
    editorNodes: number
    editorTextLength: number
    ambientNodes: number
    scrollHeight: number
    performanceMemory: { usedJSHeapSize: number; totalJSHeapSize: number } | null
  }
  tabSmapsKB: Record<string, number>
  tabSmapsFilesKB: Record<string, number>
  tracePath: string
  snapshotPath: string | null
}

async function capture(
  value: Scenario, page: Page, label: string, openFiles: number,
  options: { snapshot?: boolean; gc?: boolean } = {}
): Promise<Capture> {
  const snapshot = options.snapshot ?? SNAPSHOTS
  const app = value.app!
  await page.waitForTimeout(2_000)
  const cdp = await page.context().newCDPSession(page)
  if (options.gc) {
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(500)
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(1_500)
  }

  const heapUsage = await cdp.send('Runtime.getHeapUsage') as Capture['heapUsage']
  const domCounters = await cdp.send('Memory.getDOMCounters') as Capture['domCounters']
  const renderer = await page.evaluate(() => {
    const host = document.querySelector('.prosemirror-host')
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
    return {
      domNodes: document.getElementsByTagName('*').length,
      editorNodes: host ? host.getElementsByTagName('*').length : 0,
      editorTextLength: host ? (host.textContent ?? '').length : 0,
      ambientNodes: document.querySelectorAll('.ambient-decor, .ambient-decor *').length,
      scrollHeight: document.querySelector<HTMLElement>('.editor-scroll')?.scrollHeight ?? 0,
      performanceMemory: memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null,
    }
  })

  const tracePath = join(process.cwd(), OUT_DIR, `${label}.trace.json`)
  await app.evaluate(async ({ contentTracing }, target) => {
    await contentTracing.startRecording({
      included_categories: ['disabled-by-default-memory-infra'],
      excluded_categories: ['*'],
      memory_dump_config: {
        allowed_dump_modes: ['background', 'light', 'detailed'],
        triggers: [{ mode: 'detailed', periodic_interval_ms: 1_000 }],
      },
    } as Parameters<typeof contentTracing.startRecording>[0])
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    await contentTracing.stopRecording(target)
  }, tracePath)

  const appMetrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name ?? null,
    workingSetMB: metric.memory.workingSetSize / 1024,
    peakWorkingSetMB: (metric.memory.peakWorkingSetSize ?? 0) / 1024,
  })))
  const proc = await Promise.all(appMetrics.map((metric) => procMemory(metric.pid)))
  const tabPid = appMetrics.find((metric) => metric.type === 'Tab')?.pid
  const tabSmapsKB = tabPid ? await smapsBuckets(tabPid) : {}
  const tabSmapsFilesKB = tabPid ? await smapsFiles(tabPid) : {}

  let snapshotPath: string | null = null
  if (snapshot) {
    snapshotPath = join(process.cwd(), OUT_DIR, `${label}.heapsnapshot`)
    await app.evaluate(async ({ BrowserWindow }, target) => {
      await BrowserWindow.getAllWindows()[0]!.webContents.takeHeapSnapshot(target)
    }, snapshotPath)
  }

  const result: Capture = { label, openFiles, appMetrics, proc, heapUsage, domCounters, renderer, tabSmapsKB, tabSmapsFilesKB, tracePath, snapshotPath }
  const tab = appMetrics.find((metric) => metric.type === 'Tab')
  const tabProc = proc.find((entry) => entry.pid === tab?.pid)
  console.log(JSON.stringify({
    label,
    openFiles,
    tabWorkingSetMB: Math.round(tab?.workingSetMB ?? 0),
    tabRssAnonMB: Math.round((tabProc?.rssAnonKB ?? 0) / 1024),
    tabRssFileMB: Math.round((tabProc?.rssFileKB ?? 0) / 1024),
    tabPssMB: Math.round((tabProc?.pssKB ?? 0) / 1024),
    jsHeapUsedMB: Number((heapUsage.usedSize / 1048576).toFixed(2)),
    jsHeapTotalMB: Number((heapUsage.totalSize / 1048576).toFixed(2)),
    domNodes: renderer.domNodes,
    editorNodes: renderer.editorNodes,
    listeners: domCounters.jsEventListeners,
    gpuMB: Math.round(appMetrics.find((metric) => metric.type === 'GPU')?.workingSetMB ?? 0),
    browserMB: Math.round(appMetrics.find((metric) => metric.type === 'Browser')?.workingSetMB ?? 0),
  }))
  return result
}

test('memory attribution across the tabs ladder', async ({}, testInfo) => {
  test.setTimeout(60 * 60_000)
  await mkdir(OUT_DIR, { recursive: true })
  const maximum = RUNGS.at(-1)!
  const seed = 1729
  const first = generateCorpus('rich', SIZE_CYCLE[0], seed)
  const value = await Scenario.create(testInfo, first.markdown, 'tab-000.md')
  if (VARIANT === 'ambient-off') await value.writeSettings({ animatedBackground: false })
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

  const captures: Capture[] = []
  const startedAt = new Date()
  try {
    // The shell with no document open is the baseline every rung is measured against.
    const page = await value.launchEmpty()
    await page.waitForTimeout(3_000)
    captures.push(await capture(value, page, 'shell-empty', 0, { gc: false }))
    captures.push(await capture(value, page, 'shell-empty-gc', 0, { gc: true }))

    const editor = page.getByRole('textbox', { name: /document editor/i })
    let opened = 0
    for (const rung of RUNGS) {
      while (opened < rung) {
        const path = paths[opened]!
        await page.evaluate((target) => window.strata.openDocument(target), path)
        await expect(page.locator('.tabs .tab').filter({ hasText: basename(path) })).toBeVisible({ timeout: 60_000 })
        await expect(editor).toBeVisible({ timeout: 60_000 })
        opened += 1
      }
      const rungLabel = `tabs-${String(rung).padStart(3, '0')}`
      if (rung === maximum && process.env.STRATAMD_MEMORY_IDLE_SECONDS) {
        // Does the settled reading fall on its own, or only under a forced GC?
        const seconds = Number(process.env.STRATAMD_MEMORY_IDLE_SECONDS)
        const curve: Array<{ atSeconds: number; tabMB: number }> = []
        for (let elapsed = 0; elapsed <= seconds; elapsed += 10) {
          const metrics = await value.app!.evaluate(({ app: electronApp }) =>
            electronApp.getAppMetrics().filter((metric) => metric.type === 'Tab').reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024)
          curve.push({ atSeconds: elapsed, tabMB: Math.round(metrics) })
          await page.waitForTimeout(10_000)
        }
        console.log(JSON.stringify({ idleDecayCurve: curve }))
      }
      // Settled first (what the tabs ladder reads), then after a forced GC:
      // the difference is memory no collector had gotten to yet.
      captures.push(await capture(value, page, rungLabel, rung, { gc: false, snapshot: false }))
      captures.push(await capture(value, page, `${rungLabel}-gc`, rung, { gc: true }))
    }
  } finally {
    const body = `${JSON.stringify({
      schemaVersion: 1,
      variant: VARIANT,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      displayMode: process.env.STRATAMD_PERF_DISPLAY_MODE ?? 'unknown',
      editorCache: process.env.STRATAMD_EDITOR_CACHE ?? 'default(3)',
      sizeCycle: SIZE_CYCLE,
      rungs: RUNGS,
      captures,
    }, null, 2)}\n`
    await writeFile(join(OUT_DIR, 'report.json'), body)
    await value.dispose()
  }
})
