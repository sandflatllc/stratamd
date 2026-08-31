/** Shared Chromium trace-event decoding for the tracing lab profiles. */

export interface TraceEvent {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: {
    name?: string
    data?: {
      type?: string
      cpuProfile?: {
        nodes?: Array<{ id: number; parent?: number; callFrame: { functionName?: string; url?: string; lineNumber?: number } }>
        samples?: number[]
      }
      timeDeltas?: number[]
    }
  }
}

export const STAGE_OF: Record<string, string> = {
  FunctionCall: 'script',
  EvaluateScript: 'script',
  EventDispatch: 'script',
  TimerFire: 'script',
  FireAnimationFrame: 'script',
  'v8.run': 'script',
  V8Execute: 'script',
  UpdateLayoutTree: 'style',
  RecalculateStyles: 'style',
  Animation: 'style',
  Layout: 'layout',
  PrePaint: 'layout',
  Layerize: 'layout',
  UpdateLayerTree: 'layout',
  IntersectionObserverController: 'layout',
  HitTest: 'layout',
  Paint: 'paint',
  PaintImage: 'paint',
  CompositeLayers: 'paint',
  Commit: 'paint',
  MinorGC: 'gc',
  MajorGC: 'gc',
  BlinkGC: 'gc',
}

export function stageOf(name: string): string {
  if (STAGE_OF[name]) return STAGE_OF[name]
  if (name.startsWith('V8.GC') || name.includes('GC')) return 'gc'
  return 'other'
}

/** Self-time per complete event: duration minus the duration of nested events. */
export function selfTimes(events: TraceEvent[]): Array<TraceEvent & { selfUs: number }> {
  const complete = events
    .filter((event) => event.ph === 'X' && typeof event.dur === 'number')
    .sort((left, right) => left.ts - right.ts || (right.dur ?? 0) - (left.dur ?? 0))
  interface Frame { end: number; childUs: number; out: TraceEvent & { selfUs: number } }
  const results: Array<TraceEvent & { selfUs: number }> = []
  const stack: Frame[] = []
  const finalize = (frame: Frame): void => {
    frame.out.selfUs = Math.max(0, (frame.out.dur ?? 0) - frame.childUs)
  }
  for (const event of complete) {
    while (stack.length > 0 && stack.at(-1)!.end <= event.ts) finalize(stack.pop()!)
    const out = { ...event, selfUs: event.dur ?? 0 }
    const parent = stack.at(-1)
    if (parent) parent.childUs += event.dur ?? 0
    stack.push({ end: event.ts + (event.dur ?? 0), childUs: 0, out })
    results.push(out)
  }
  while (stack.length > 0) finalize(stack.pop()!)
  return results
}

/** Thread names from metadata events, keyed by `pid:tid`. */
export function threadNames(events: TraceEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name' && event.args?.name) {
      names.set(`${event.pid}:${event.tid}`, event.args.name)
    }
  }
  return names
}

/**
 * Decode V8 sampling-profiler chunks into per-function self time. Samples name
 * the executing node; each sample costs its time delta.
 */
export function profileSelfTimes(events: TraceEvent[]): Array<{ function: string; selfMs: number }> {
  const nodes = new Map<number, { name: string }>()
  const selfUs = new Map<number, number>()
  for (const event of events) {
    if (event.name !== 'ProfileChunk') continue
    const data = event.args?.data
    for (const node of data?.cpuProfile?.nodes ?? []) {
      const frame = node.callFrame
      const url = frame.url ? frame.url.split('/').at(-1) : ''
      nodes.set(node.id, { name: `${frame.functionName || '(anonymous)'}${url ? ` [${url}]` : ''}` })
    }
    const samples = data?.cpuProfile?.samples ?? []
    const deltas = data?.timeDeltas ?? []
    for (let index = 0; index < samples.length; index += 1) {
      const nodeId = samples[index]!
      selfUs.set(nodeId, (selfUs.get(nodeId) ?? 0) + (deltas[index] ?? 0))
    }
  }
  const byName = new Map<string, number>()
  for (const [nodeId, us] of selfUs) {
    const name = nodes.get(nodeId)?.name ?? `(node ${nodeId})`
    byName.set(name, (byName.get(name) ?? 0) + us)
  }
  return [...byName.entries()]
    .map(([name, us]) => ({ function: name, selfMs: Number((us / 1000).toFixed(1)) }))
    .sort((left, right) => right.selfMs - left.selfMs)
}
