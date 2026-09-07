/**
 * Measured answer heights (docs/plans/open/transcript-scroll-stability-2026-09-07-plan.md §4.2).
 *
 * An entry is a hint: it reserves provisional space for an answer whose editor
 * has not been built yet, so the transcript keeps its geometry across reopen
 * and remount. The identity carries everything that changes a height, and
 * image versions are recorded beside the height so a replaced screenshot
 * invalidates it. Persistence is optional and batched; any storage failure
 * leaves the in-memory map as the whole cache.
 */
export const TRANSCRIPT_LAYOUT_VERSION = 2

export interface GeometryIdentity {
  engine: string
  thread: string
  project?: string
  message: string
  /** A fingerprint of the completed source. */
  source: string
  width: number
  placement: string
  zoom: number
  typography: string
  /** The effective heading folds, serialized. */
  folds: string
  layoutVersion: number
}

export interface GeometryEntry {
  height: number
  /** Image source to file version at measurement time. */
  images: Record<string, string>
  measuredAt: number
}

interface ThreadBucket {
  touched: number
  entries: Record<string, GeometryEntry>
}

interface StoreShape {
  version: number
  threads: Record<string, ThreadBucket>
}

export interface GeometryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface GeometryStoreOptions {
  storage?: GeometryStorage | null
  key?: string
  maxThreads?: number
  maxBytes?: number
  /** Schedules the batched write; defaults to a short timer. */
  schedule?(write: () => void): void
  now?(): number
}

export const GEOMETRY_STORAGE_KEY = 'transcript-geometry'
export const GEOMETRY_MAX_THREADS = 200
export const GEOMETRY_MAX_BYTES = 2 * 1024 * 1024

/** A short stable hash for cache identities; not cryptographic. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length.toString(36)}:${hash.toString(36)}`
}

export function threadKey(identity: Pick<GeometryIdentity, 'engine' | 'thread'>): string {
  return `${identity.engine}\0${identity.thread}`
}

export function entryKey(identity: GeometryIdentity): string {
  return [identity.message, identity.project ?? '', identity.source, identity.width, identity.placement, identity.zoom, identity.typography, identity.folds, identity.layoutVersion].join('\0')
}

export class TranscriptGeometryStore {
  private threads = new Map<string, ThreadBucket>()
  private readonly storage: GeometryStorage | null
  private readonly key: string
  private readonly maxThreads: number
  private readonly maxBytes: number
  private readonly schedule: (write: () => void) => void
  private readonly now: () => number
  private dirty = false
  private scheduled = false
  /** Storage failed since the last successful write; the in-memory map is the cache until it recovers. */
  storageFailed = false

  constructor(options: GeometryStoreOptions = {}) {
    this.storage = options.storage ?? null
    this.key = options.key ?? GEOMETRY_STORAGE_KEY
    this.maxThreads = options.maxThreads ?? GEOMETRY_MAX_THREADS
    this.maxBytes = options.maxBytes ?? GEOMETRY_MAX_BYTES
    this.schedule = options.schedule ?? ((write) => { setTimeout(write, 500) })
    this.now = options.now ?? (() => Date.now())
    this.load()
  }

  private load(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(this.key)
      if (!raw || new TextEncoder().encode(raw).length > this.maxBytes) return
      const parsed = JSON.parse(raw) as Partial<StoreShape>
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.threads || typeof parsed.threads !== 'object') return
      for (const [thread, bucket] of Object.entries(parsed.threads)) {
        if (!bucket || typeof bucket !== 'object' || typeof bucket.touched !== 'number' || !bucket.entries || typeof bucket.entries !== 'object') continue
        const entries: Record<string, GeometryEntry> = {}
        for (const [key, entry] of Object.entries(bucket.entries)) {
          if (!entry || typeof entry !== 'object' || typeof entry.height !== 'number' || !Number.isFinite(entry.height) || entry.height <= 0) continue
          if (!entry.images || typeof entry.images !== 'object' || Object.values(entry.images).some(version => typeof version !== 'string')) continue
          entries[key] = { height: entry.height, images: entry.images, measuredAt: typeof entry.measuredAt === 'number' ? entry.measuredAt : 0 }
        }
        this.threads.set(thread, { touched: bucket.touched, entries })
      }
      this.threads = new Map([...this.threads].sort((a, b) => a[1].touched - b[1].touched))
      this.evictThreads()
    } catch {
      // A malformed record behaves like a cache miss.
      this.threads.clear()
    }
  }

  /** The recorded height, or null; the caller validates image versions before trusting it as final. */
  get(identity: GeometryIdentity): GeometryEntry | null {
    const key = threadKey(identity)
    const bucket = this.threads.get(key)
    const entry = bucket?.entries[entryKey(identity)] ?? null
    if (bucket && entry) { bucket.touched = this.now(); this.threads.delete(key); this.threads.set(key, bucket) }
    return entry
  }

  set(identity: GeometryIdentity, entry: GeometryEntry): void {
    const key = threadKey(identity)
    const bucket = this.threads.get(key) ?? { touched: 0, entries: {} }
    bucket.touched = this.now()
    bucket.entries[entryKey(identity)] = entry
    this.threads.delete(key)
    this.threads.set(key, bucket)
    this.evictThreads()
    this.markDirty()
  }

  /** Drops entries for messages that no longer exist in the thread. */
  prune(identity: Pick<GeometryIdentity, 'engine' | 'thread'>, messages: ReadonlySet<string>): void {
    const bucket = this.threads.get(threadKey(identity))
    if (!bucket) return
    let changed = false
    for (const key of Object.keys(bucket.entries)) {
      const message = key.split('\0', 1)[0] ?? ''
      if (!messages.has(message)) { delete bucket.entries[key]; changed = true }
    }
    if (changed) this.markDirty()
  }

  threadCount(): number { return this.threads.size }

  serialize(): string {
    const shape: StoreShape = { version: 1, threads: Object.fromEntries(this.threads) }
    return JSON.stringify(shape)
  }

  private evictThreads(): void {
    while (this.threads.size > this.maxThreads) this.threads.delete(this.threads.keys().next().value!)
    let serialized = this.serialize()
    while (new TextEncoder().encode(serialized).length > this.maxBytes && this.threads.size > 0) {
      const oldest = this.threads.keys().next().value!
      if (this.threads.size > 1) this.threads.delete(oldest)
      else {
        const bucket = this.threads.get(oldest)!
        const first = Object.keys(bucket.entries)[0]
        if (first) delete bucket.entries[first]
        else this.threads.delete(oldest)
      }
      serialized = this.serialize()
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (!this.storage || this.scheduled) return
    this.scheduled = true
    this.schedule(() => { this.scheduled = false; this.flush() })
  }

  /** Writes now; called by the batched schedule and before disposal. Never throws. */
  flush(): void {
    if (!this.storage || !this.dirty) return
    try {
      this.storage.setItem(this.key, this.serialize())
      this.dirty = false
      this.storageFailed = false
    } catch {
      this.storageFailed = true
    }
  }
}
