/**
 * Transcript diagnostics (docs/plans/open/transcript-scroll-stability-2026-09-07-plan.md §6):
 * mount and unmount counts, peak live editors, publication corrections and
 * their reasons, deferred upgrades, resource wait time, navigation latency,
 * scroll writes with their reasons, and main-thread long tasks. Always on and
 * bounded; `window.strataTranscript.snapshot()` reads it from a probe.
 *
 * Test holds pause a resource kind (image metadata, image decode, Mermaid)
 * until released. They exist only when the preload exposed the transcript
 * probe flag, so production builds cannot be held.
 */
export interface TranscriptEvent {
  at: number
  kind: string
  detail?: Record<string, unknown>
}

export interface TranscriptCounters {
  mounts: number
  unmounts: number
  live: number
  peakLive: number
  publications: number
  corrections: number
  deferred: number
  deadlines: number
  navigations: number
  navigationFailures: number
  scrollWrites: number
  longTasks: number
  longTaskMs: number
  resourceWaitMs: number
}

const LIMIT = 4000

class TranscriptDiagnostics {
  private events: TranscriptEvent[] = []
  counters: TranscriptCounters = { mounts: 0, unmounts: 0, live: 0, peakLive: 0, publications: 0, corrections: 0, deferred: 0, deadlines: 0, navigations: 0, navigationFailures: 0, scrollWrites: 0, longTasks: 0, longTaskMs: 0, resourceWaitMs: 0 }
  private holds = new Map<string, Array<() => void>>()
  private held = new Set<string>()
  private observer: PerformanceObserver | null = null

  record(kind: string, detail?: Record<string, unknown>): void {
    this.events.push(detail ? { at: performance.now(), kind, detail } : { at: performance.now(), kind })
    if (this.events.length > LIMIT) this.events.splice(0, this.events.length - LIMIT)
  }

  mounted(): void {
    this.counters.mounts += 1
    this.counters.live += 1
    this.counters.peakLive = Math.max(this.counters.peakLive, this.counters.live)
  }

  unmounted(): void {
    this.counters.unmounts += 1
    this.counters.live = Math.max(0, this.counters.live - 1)
  }

  snapshot(): { counters: TranscriptCounters; events: TranscriptEvent[]; held: string[] } {
    return { counters: { ...this.counters }, events: [...this.events], held: [...this.held] }
  }

  reset(): void {
    this.events = []
    this.counters = { ...this.counters, mounts: 0, unmounts: 0, peakLive: this.counters.live, publications: 0, corrections: 0, deferred: 0, deadlines: 0, navigations: 0, navigationFailures: 0, scrollWrites: 0, longTasks: 0, longTaskMs: 0, resourceWaitMs: 0 }
  }

  observeLongTasks(): void {
    if (this.observer || typeof PerformanceObserver === 'undefined') return
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.counters.longTasks += 1
          this.counters.longTaskMs += entry.duration
          this.record('long-task', { duration: Math.round(entry.duration) })
        }
      })
      this.observer.observe({ entryTypes: ['longtask'] })
    } catch {
      this.observer = null
    }
  }

  get probeEnabled(): boolean {
    return (globalThis as { strataTranscriptProbe?: unknown }).strataTranscriptProbe === '1'
  }

  hold(kind: string): void {
    if (!this.probeEnabled) return
    this.held.add(kind)
  }

  release(kind?: string): void {
    for (const key of kind ? [kind] : [...this.held]) {
      this.held.delete(key)
      const waiting = this.holds.get(key) ?? []
      this.holds.delete(key)
      for (const resolve of waiting) resolve()
    }
  }

  /** Resolves at once unless a test holds this kind of resource. */
  gate(kind: string): Promise<void> {
    if (!this.held.has(kind)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiting = this.holds.get(kind) ?? []
      waiting.push(resolve)
      this.holds.set(kind, waiting)
    })
  }

  isHeld(kind: string): boolean { return this.held.has(kind) }

  /** How many callers currently wait on a held kind. */
  waiting(kind: string): number {
    return this.holds.get(kind)?.length ?? 0
  }
}

export const transcriptDiagnostics = new TranscriptDiagnostics()

declare global {
  interface Window {
    strataTranscriptProbe?: string
    strataTranscript?: {
      snapshot(): ReturnType<TranscriptDiagnostics['snapshot']>
      reset(): void
      hold(kind: string): void
      release(kind?: string): void
      waiting(kind: string): number
    }
  }
}

if (typeof window !== 'undefined') {
  transcriptDiagnostics.observeLongTasks()
  window.strataTranscript = {
    snapshot: () => transcriptDiagnostics.snapshot(),
    reset: () => transcriptDiagnostics.reset(),
    hold: (kind) => transcriptDiagnostics.hold(kind),
    release: (kind) => transcriptDiagnostics.release(kind),
    waiting: (kind) => transcriptDiagnostics.waiting(kind),
  }
}
