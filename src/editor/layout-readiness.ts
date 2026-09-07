/**
 * Layout readiness for an editor whose geometry depends on asynchronous work:
 * image metadata and decode, Mermaid rendering, chart drawing, screenshot
 * decoration. A node view registers each piece of work when it starts and
 * settles it at a terminal state (success, failure presentation, or
 * cancellation). Readiness means every registered participant has settled.
 *
 * Generations make late callbacks harmless: work registered before `reset()`
 * or `destroy()` cannot settle a newer generation, and a waiter created for
 * one generation is released, not resolved, when the generation moves on.
 */
export type ReadinessGate = (kind: string) => Promise<void>

export interface ReadinessSnapshot {
  pending: number
  generation: number
  labels: string[]
  destroyed: boolean
}

export class LayoutReadiness {
  private work = new Map<number, string>()
  private next = 0
  private generationValue = 0
  private destroyed = false
  private waiters: Array<{ generation: number; resolve(): void; reject(error: Error): void }> = []
  private listeners = new Set<(snapshot: ReadinessSnapshot) => void>()
  /** Test-controlled holds for a kind of resource; production has none. */
  readonly gate: ReadinessGate | null

  constructor(gate: ReadinessGate | null = null) {
    this.gate = gate
  }

  get pending(): number { return this.work.size }
  get generation(): number { return this.generationValue }
  get isDestroyed(): boolean { return this.destroyed }

  snapshot(): ReadinessSnapshot {
    return { pending: this.work.size, generation: this.generationValue, labels: [...this.work.values()], destroyed: this.destroyed }
  }

  /** Registers work; the returned function settles it once, and is a no-op after a reset or destroy. */
  begin(label: string): () => void {
    if (this.destroyed) return () => undefined
    const id = this.next++
    const generation = this.generationValue
    this.work.set(id, label)
    this.notify()
    let settled = false
    return () => {
      if (settled || generation !== this.generationValue || !this.work.has(id)) return
      settled = true
      this.work.delete(id)
      this.notify()
      if (this.work.size === 0) this.release(generation)
    }
  }

  /** Waits for a hold on `kind` when a gate is installed; otherwise resolves at once. */
  async pass(kind: string): Promise<void> {
    if (this.gate) await this.gate(kind)
  }

  /** Resolves when no work is pending in the current generation; rejects if that generation ends first. */
  whenSettled(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('The editor was destroyed before its layout settled'))
    if (this.work.size === 0) return Promise.resolve()
    return new Promise((resolve, reject) => { this.waiters.push({ generation: this.generationValue, resolve, reject }) })
  }

  onChange(listener: (snapshot: ReadinessSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Starts a new generation: outstanding settles are ignored and current waiters are rejected. */
  reset(): void {
    const generation = this.generationValue
    this.generationValue += 1
    this.work.clear()
    this.rejectWaiters(generation, new Error('Layout readiness was reset'))
    this.notify()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    const generation = this.generationValue
    this.generationValue += 1
    this.work.clear()
    this.rejectWaiters(generation, new Error('The editor was destroyed before its layout settled'))
    this.listeners.clear()
  }

  private release(generation: number): void {
    const waiting = this.waiters.filter((waiter) => waiter.generation === generation)
    this.waiters = this.waiters.filter((waiter) => waiter.generation !== generation)
    for (const waiter of waiting) waiter.resolve()
  }

  private rejectWaiters(generation: number, error: Error): void {
    const waiting = this.waiters.filter((waiter) => waiter.generation === generation)
    this.waiters = this.waiters.filter((waiter) => waiter.generation !== generation)
    for (const waiter of waiting) waiter.reject(error)
  }

  private notify(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
