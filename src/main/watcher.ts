import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import watcher, { type AsyncSubscription } from '@parcel/watcher'

export type WatchedSource = 'document' | 'buffer'
export type WakeReason = 'open' | 'focus' | 'before-save' | 'app-start' | 'watch-event' | 'watch-error'

export interface SourceSnapshot {
  source: WatchedSource
  path: string
  bytes: Buffer | null
  hash: string | null
}

export interface ExternalContentChange {
  source: WatchedSource
  path: string
  reason: WakeReason
  previous: SourceSnapshot
  current: SourceSnapshot
}

export interface HashReconcilerOptions {
  documentPath: string
  bufferPath: string
  read?: (path: string) => Promise<Buffer | null>
  onChange: (change: ExternalContentChange) => void | Promise<void>
  now?: () => number
  ownedWriteReservationMs?: number
}

interface MutableSourceState extends SourceSnapshot {}

interface OwnedWriteReservation {
  id: number
  expiresAt: number
}

const DEFAULT_OWNED_WRITE_RESERVATION_MS = 30_000

/**
 * Turns watcher notifications into reads and hash comparisons. Watch events are
 * never interpreted as an operation log, which also handles temp-and-rename
 * writes and coalesced inotify events correctly.
 */
export class HashReconciler {
  readonly #read: (path: string) => Promise<Buffer | null>
  readonly #onChange: HashReconcilerOptions['onChange']
  readonly #now: () => number
  readonly #ownedWriteReservationMs: number
  readonly #sources: Record<WatchedSource, MutableSourceState>
  readonly #ownedHashes: Record<WatchedSource, Map<string, OwnedWriteReservation[]>> = {
    document: new Map(),
    buffer: new Map()
  }
  #nextOwnedWriteReservationId = 0
  #running: Promise<void> | null = null
  #queuedReason: WakeReason | null = null

  constructor(options: HashReconcilerOptions) {
    this.#read = options.read ?? readNullableFile
    this.#onChange = options.onChange
    this.#now = options.now ?? Date.now
    this.#ownedWriteReservationMs = options.ownedWriteReservationMs ?? DEFAULT_OWNED_WRITE_RESERVATION_MS
    if (!Number.isFinite(this.#ownedWriteReservationMs) || this.#ownedWriteReservationMs <= 0) {
      throw new RangeError('Owned-write reservation duration must be positive')
    }
    this.#sources = {
      document: { source: 'document', path: options.documentPath, bytes: null, hash: null },
      buffer: { source: 'buffer', path: options.bufferPath, bytes: null, hash: null }
    }
  }

  snapshot(source: WatchedSource): SourceSnapshot {
    const state = this.#sources[source]
    return { ...state, bytes: state.bytes ? Buffer.from(state.bytes) : null }
  }

  async initialize(reason: Extract<WakeReason, 'open' | 'app-start'> = 'open'): Promise<void> {
    await Promise.all((['document', 'buffer'] as const).map(async (source) => {
      const state = this.#sources[source]
      const bytes = await this.#read(state.path)
      state.bytes = bytes
      state.hash = hashBytes(bytes)
    }))
    void reason
  }

  /** Record a mirror or Save before its rename, so its later watch event is ignored. */
  noteOwnedWrite(source: WatchedSource, bytes: Buffer | string): () => void {
    const next = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes, 'utf8')
    const hash = hashBytes(next)
    if (!hash) return () => undefined
    // Writing the content already observed by the reconciler cannot produce a
    // hash transition, so reserving it would only suppress a later real write.
    if (this.#sources[source].hash === hash) return () => undefined
    const owned = this.#ownedHashes[source]
    const reservation = {
      id: ++this.#nextOwnedWriteReservationId,
      expiresAt: this.#now() + this.#ownedWriteReservationMs,
    }
    owned.set(hash, [...(owned.get(hash) ?? []), reservation])
    let active = true
    return () => {
      if (!active) return
      active = false
      const retained = (owned.get(hash) ?? []).filter((candidate) => candidate.id !== reservation.id)
      if (retained.length === 0) owned.delete(hash)
      else owned.set(hash, retained)
    }
  }

  #consumeOwnedWrite(source: WatchedSource, hash: string): boolean {
    const owned = this.#ownedHashes[source]
    const now = this.#now()
    for (const [candidateHash, reservations] of owned) {
      const active = reservations.filter((reservation) => reservation.expiresAt > now)
      if (active.length === 0) owned.delete(candidateHash)
      else if (active.length !== reservations.length) owned.set(candidateHash, active)
    }
    const reservations = owned.get(hash)
    if (!reservations?.length) return false
    if (reservations.length === 1) owned.delete(hash)
    else owned.set(hash, reservations.slice(1))
    return true
  }

  wake(reason: WakeReason): Promise<void> {
    this.#queuedReason = reason
    if (!this.#running) {
      this.#running = this.#drain().finally(() => {
        this.#running = null
      })
    }
    return this.#running
  }

  async #drain(): Promise<void> {
    while (this.#queuedReason) {
      const reason = this.#queuedReason
      this.#queuedReason = null
      await this.#poll(reason)
    }
  }

  async #poll(reason: WakeReason): Promise<void> {
    for (const source of ['document', 'buffer'] as const) {
      const state = this.#sources[source]
      const bytes = await this.#read(state.path)
      const hash = hashBytes(bytes)
      if (hash === state.hash) continue

      if (hash !== null && this.#consumeOwnedWrite(source, hash)) {
        state.bytes = bytes
        state.hash = hash
        continue
      }

      const previous = this.snapshot(source)
      state.bytes = bytes
      state.hash = hash
      await this.#onChange({
        source,
        path: state.path,
        reason,
        previous,
        current: this.snapshot(source)
      })
    }
  }
}

export interface WatchCoordinatorOptions {
  documentPath: string
  ghostEntryPath: string
  reconcile: (reason: WakeReason) => void | Promise<void>
  onError?: (error: Error) => void
  subscribe?: typeof watcher.subscribe
}

export class WatchCoordinator {
  readonly #directories: string[]
  readonly #reconcile: WatchCoordinatorOptions['reconcile']
  readonly #onError?: WatchCoordinatorOptions['onError']
  readonly #subscribe: typeof watcher.subscribe
  readonly #subscriptions: AsyncSubscription[] = []
  #started = false

  constructor(options: WatchCoordinatorOptions) {
    this.#directories = [...new Set([dirname(options.documentPath), options.ghostEntryPath])]
    this.#reconcile = options.reconcile
    this.#onError = options.onError
    this.#subscribe = options.subscribe ?? watcher.subscribe
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    try {
      for (const directory of this.#directories) {
        const subscription = await this.#subscribe(directory, (error) => {
          if (error) {
            this.#onError?.(error)
            void this.#reconcile('watch-error')
            return
          }
          void this.#reconcile('watch-event')
        })
        this.#subscriptions.push(subscription)
      }
    } catch (error) {
      this.#started = false
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const subscriptions = this.#subscriptions.splice(0)
    await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()))
    this.#started = false
  }
}

export interface MirrorWriter {
  write(content: string): Promise<void>
}

export interface DebouncedMirrorOptions {
  writer: MirrorWriter
  onWritten?: (content: string) => void
  debounceMs?: number
}

export class DebouncedMirror {
  readonly #writer: MirrorWriter
  readonly #onWritten?: DebouncedMirrorOptions['onWritten']
  readonly #debounceMs: number
  #timer: ReturnType<typeof setTimeout> | null = null
  #content: string | null = null
  #writeChain: Promise<void> = Promise.resolve()

  constructor(options: DebouncedMirrorOptions) {
    this.#writer = options.writer
    this.#onWritten = options.onWritten
    this.#debounceMs = options.debounceMs ?? 80
  }

  schedule(content: string): void {
    this.#content = content
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#debounceMs)
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const content = this.#content
    if (content === null) return this.#writeChain
    this.#content = null
    this.#writeChain = this.#writeChain.then(async () => {
      await this.#writer.write(content)
      this.#onWritten?.(content)
    })
    await this.#writeChain
    if (this.#content !== null) await this.flush()
  }

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#content = null
  }
}

export function hashBytes(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
}

async function readNullableFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
