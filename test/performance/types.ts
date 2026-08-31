export type CorpusShape = 'plain' | 'rich' | 'block-heavy' | 'table-heavy' | 'list-heavy' | 'code-heavy'

export interface CorpusManifest {
  shape: CorpusShape
  requestedBytes: number
  bytes: number
  lines: number
  topLevelBlocks: number
  sections: number
  tables: number
  tableCells: number
  listItems: number
  taskItems: number
  codeBlocks: number
  codeBytes: number
  images: number
  seed: number
}

export interface GeneratedCorpus {
  markdown: string
  manifest: CorpusManifest
  firstHeading: string
  terminalMarker: string
}

export interface RendererProbeSnapshot {
  capturedAt: number
  frames: number
  frameP50Ms: number
  frameP95Ms: number
  frameP99Ms: number
  framesOver50Ms: number
  maximumFrameMs: number
  longTasks: number
  longTaskTotalMs: number
  maximumLongTaskMs: number
  longAnimationFrames: number
  maximumLongAnimationFrameMs: number
  domNodes: number
  heapUsedBytes: number | null
  heapLimitBytes: number | null
  scrollHeight: number
}

export interface ProcessMetricSample {
  at: number
  processes: Array<{
    pid: number
    type: string
    name: string | null
    cpuPercent: number
    idleWakeupsPerSecond: number
    workingSetKB: number
    peakWorkingSetKB: number
  }>
}

export interface ProcessSummary {
  samples: number
  peakWorkingSetMB: number
  endingWorkingSetMB: number
  averageCpuPercent: number
  peakCpuPercent: number
  averageCpuByType: Record<string, number>
  peakWorkingSetByTypeMB: Record<string, number>
}

export interface ActionMeasurement {
  name: string
  durationMs: number
  renderer: RendererProbeSnapshot
}

export interface BudgetViolation {
  metric: string
  actual: number
  limit: number
  unit: 'ms' | 'percent' | 'MB'
}

export type RungClassification = 'comfortable' | 'degraded' | 'failed'

export interface PerformanceRunReport {
  schemaVersion: 1
  runId: string
  startedAt: string
  finishedAt: string
  profile: 'smoke' | 'stress' | 'idle'
  environment: {
    gitCommit: string
    gitDirty: boolean
    platform: string
    release: string
    arch: string
    cpuModel: string
    logicalCpus: number
    totalMemoryMB: number
    node: string
    electron: string
    chrome: string
    displayMode: 'desktop' | 'xvfb' | 'unknown'
  }
  corpus: CorpusManifest
  readyMs: number
  actions: ActionMeasurement[]
  renderer: RendererProbeSnapshot
  process: ProcessSummary
  processSamples: ProcessMetricSample[]
  violations: BudgetViolation[]
  classification: RungClassification
  failure: { stage: string; message: string } | null
}
