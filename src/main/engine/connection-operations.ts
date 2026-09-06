/** Switching waits for started operations and refuses new ones until the new store is active. */
export class ConnectionOperations {
  #pending = new Set<Promise<unknown>>()
  #switching = false
  get accepting(): boolean { return !this.#switching }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#switching) return Promise.reject(new Error('The engine connection is changing. Try again when it is connected.'))
    const result = operation()
    this.#pending.add(result)
    void result.finally(() => this.#pending.delete(result)).catch(() => undefined)
    return result
  }
  async switch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#switching) throw new Error('An engine connection change is already in progress')
    this.#switching = true
    try { await Promise.allSettled([...this.#pending]); return await operation() } finally { this.#switching = false }
  }
}
