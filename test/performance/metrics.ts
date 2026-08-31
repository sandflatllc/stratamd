import type { ElectronApplication, Page } from '@playwright/test'
import type { ActionMeasurement, ProcessMetricSample, ProcessSummary, RendererProbeSnapshot } from './types'

interface ProbeState {
  frameIntervals: number[]
  lastFrame: number | null
  longTasks: number[]
  longAnimationFrames: number[]
}

interface ProbeWindow extends Window {
  __strataPerformanceProbe?: ProbeState
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))
  return sorted[index] ?? 0
}

export async function installRendererProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as ProbeWindow
    if (target.__strataPerformanceProbe) return
    const state: ProbeState = { frameIntervals: [], lastFrame: null, longTasks: [], longAnimationFrames: [] }
    target.__strataPerformanceProbe = state
    const frame = (at: number) => {
      if (state.lastFrame !== null && state.frameIntervals.length < 200_000) state.frameIntervals.push(at - state.lastFrame)
      state.lastFrame = at
      window.requestAnimationFrame(frame)
    }
    window.requestAnimationFrame(frame)
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // The Chromium build may omit the long-task observer entry type.
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longAnimationFrames.push(entry.duration)
      })
      observer.observe({ entryTypes: ['long-animation-frame'] })
    } catch {
      // Long animation frame timing is newer than long-task timing.
    }
  })
}

export async function resetRendererProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as ProbeWindow).__strataPerformanceProbe
    if (!state) return
    state.frameIntervals.length = 0
    state.longTasks.length = 0
    state.longAnimationFrames.length = 0
    state.lastFrame = performance.now()
  })
}

export async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

export async function rendererProbeSnapshot(page: Page): Promise<RendererProbeSnapshot> {
  const raw = await page.evaluate(() => {
    const state = (window as ProbeWindow).__strataPerformanceProbe ?? { frameIntervals: [], longTasks: [], longAnimationFrames: [] }
    const memory = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    return {
      capturedAt: performance.now(),
      frameIntervals: [...state.frameIntervals],
      longTasks: [...state.longTasks],
      longAnimationFrames: [...state.longAnimationFrames],
      domNodes: document.getElementsByTagName('*').length,
      heapUsedBytes: memory.memory?.usedJSHeapSize ?? null,
      heapLimitBytes: memory.memory?.jsHeapSizeLimit ?? null,
      scrollHeight: document.querySelector<HTMLElement>('.editor-scroll')?.scrollHeight ?? 0,
    }
  })
  return {
    capturedAt: raw.capturedAt,
    frames: raw.frameIntervals.length,
    frameP50Ms: percentile(raw.frameIntervals, 0.5),
    frameP95Ms: percentile(raw.frameIntervals, 0.95),
    frameP99Ms: percentile(raw.frameIntervals, 0.99),
    framesOver50Ms: raw.frameIntervals.filter((value) => value > 50).length,
    maximumFrameMs: Math.max(0, ...raw.frameIntervals),
    longTasks: raw.longTasks.length,
    longTaskTotalMs: raw.longTasks.reduce((total, value) => total + value, 0),
    maximumLongTaskMs: Math.max(0, ...raw.longTasks),
    longAnimationFrames: raw.longAnimationFrames.length,
    maximumLongAnimationFrameMs: Math.max(0, ...raw.longAnimationFrames),
    domNodes: raw.domNodes,
    heapUsedBytes: raw.heapUsedBytes,
    heapLimitBytes: raw.heapLimitBytes,
    scrollHeight: raw.scrollHeight,
  }
}

export async function measureAction(page: Page, name: string, job: () => Promise<void>): Promise<ActionMeasurement> {
  await resetRendererProbe(page)
  const started = performance.now()
  await job()
  await waitForPaint(page)
  return { name, durationMs: performance.now() - started, renderer: await rendererProbeSnapshot(page) }
}

export function aggregateRendererSnapshots(actions: readonly ActionMeasurement[]): RendererProbeSnapshot {
  const snapshots = actions.map((action) => action.renderer)
  const frames = snapshots.reduce((total, snapshot) => total + snapshot.frames, 0)
  return {
    capturedAt: Math.max(0, ...snapshots.map((snapshot) => snapshot.capturedAt)),
    frames,
    frameP50Ms: Math.max(0, ...snapshots.map((snapshot) => snapshot.frameP50Ms)),
    frameP95Ms: Math.max(0, ...snapshots.map((snapshot) => snapshot.frameP95Ms)),
    frameP99Ms: Math.max(0, ...snapshots.map((snapshot) => snapshot.frameP99Ms)),
    framesOver50Ms: snapshots.reduce((total, snapshot) => total + snapshot.framesOver50Ms, 0),
    maximumFrameMs: Math.max(0, ...snapshots.map((snapshot) => snapshot.maximumFrameMs)),
    longTasks: snapshots.reduce((total, snapshot) => total + snapshot.longTasks, 0),
    longTaskTotalMs: snapshots.reduce((total, snapshot) => total + snapshot.longTaskTotalMs, 0),
    maximumLongTaskMs: Math.max(0, ...snapshots.map((snapshot) => snapshot.maximumLongTaskMs)),
    longAnimationFrames: snapshots.reduce((total, snapshot) => total + snapshot.longAnimationFrames, 0),
    maximumLongAnimationFrameMs: Math.max(0, ...snapshots.map((snapshot) => snapshot.maximumLongAnimationFrameMs)),
    domNodes: Math.max(0, ...snapshots.map((snapshot) => snapshot.domNodes)),
    heapUsedBytes: snapshots.reduce<number | null>((maximum, snapshot) => snapshot.heapUsedBytes === null ? maximum : Math.max(maximum ?? 0, snapshot.heapUsedBytes), null),
    heapLimitBytes: snapshots.find((snapshot) => snapshot.heapLimitBytes !== null)?.heapLimitBytes ?? null,
    scrollHeight: Math.max(0, ...snapshots.map((snapshot) => snapshot.scrollHeight)),
  }
}

export async function collectProcessSample(application: ElectronApplication): Promise<ProcessMetricSample> {
  const processes = await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name ?? null,
    cpuPercent: metric.cpu.percentCPUUsage,
    idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
    workingSetKB: metric.memory.workingSetSize,
    peakWorkingSetKB: metric.memory.peakWorkingSetSize,
  })))
  return { at: Date.now(), processes }
}

export class ProcessSampler {
  readonly samples: ProcessMetricSample[] = []
  readonly #application: ElectronApplication
  readonly #intervalMs: number
  #timer: ReturnType<typeof setInterval> | null = null
  #pending: Promise<void> = Promise.resolve()

  constructor(application: ElectronApplication, intervalMs = 500) {
    this.#application = application
    this.#intervalMs = intervalMs
  }

  async start(): Promise<void> {
    await this.sample()
    this.#timer = setInterval(() => {
      this.#pending = this.#pending.then(() => this.sample()).catch(() => undefined)
    }, this.#intervalMs)
    this.#timer.unref?.()
  }

  async sample(): Promise<void> {
    this.samples.push(await collectProcessSample(this.#application))
  }

  async stop(): Promise<ProcessSummary> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#pending
    await this.sample().catch(() => undefined)
    return summarizeProcessSamples(this.samples)
  }
}

export function summarizeProcessSamples(samples: readonly ProcessMetricSample[]): ProcessSummary {
  const totals = samples.map((sample) => sample.processes.reduce((sum, process) => sum + process.workingSetKB, 0) / 1024)
  const cpuTotals = samples.map((sample) => sample.processes.reduce((sum, process) => sum + process.cpuPercent, 0))
  const processTypes = new Set(samples.flatMap((sample) => sample.processes.map((process) => process.type)))
  const averageCpuByType: Record<string, number> = {}
  const peakWorkingSetByTypeMB: Record<string, number> = {}
  for (const type of processTypes) {
    const cpu = samples.map((sample) => sample.processes.filter((process) => process.type === type).reduce((sum, process) => sum + process.cpuPercent, 0))
    const memory = samples.map((sample) => sample.processes.filter((process) => process.type === type).reduce((sum, process) => sum + process.workingSetKB, 0) / 1024)
    averageCpuByType[type] = cpu.length === 0 ? 0 : cpu.reduce((sum, value) => sum + value, 0) / cpu.length
    peakWorkingSetByTypeMB[type] = Math.max(0, ...memory)
  }
  return {
    samples: samples.length,
    peakWorkingSetMB: Math.max(0, ...totals),
    endingWorkingSetMB: totals.at(-1) ?? 0,
    averageCpuPercent: cpuTotals.length === 0 ? 0 : cpuTotals.reduce((sum, value) => sum + value, 0) / cpuTotals.length,
    peakCpuPercent: Math.max(0, ...cpuTotals),
    averageCpuByType,
    peakWorkingSetByTypeMB,
  }
}
