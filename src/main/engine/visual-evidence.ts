import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory, isRecord, PRIVATE_FILE_MODE } from '../storage'
import { VISUAL_EVIDENCE_PREFIX } from '../../core/visual-comments'

/**
 * The visual evidence store: captures, marked captures, crops, and "now"
 * captures for visual comments, in the data directory and separate from the
 * staged composer uploads whose bytes leave on upload. Reads copy; a delivery
 * never consumes evidence. Bytes leave only when nothing references them.
 */
export interface VisualEvidence {
  id: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  createdAt: number
  protected?: boolean
  owners?: string[]
}

const ID_PATTERN = /^e_[0-9a-f-]{36}$/u

export function isVisualEvidenceId(value: string): boolean {
  return ID_PATTERN.test(value)
}

export class VisualEvidenceStore {
  readonly #directory: string
  readonly #now: () => number
  #ready: Promise<void> | null = null
  #ownership: Promise<unknown> = Promise.resolve()

  constructor(directory: string, now: () => number = Date.now) {
    this.#directory = directory
    this.#now = now
  }

  get directory(): string {
    return this.#directory
  }

  #initialize(): Promise<void> {
    this.#ready ??= ensurePrivateDirectory(this.#directory)
    return this.#ready
  }

  path(id: string): string {
    if (!isVisualEvidenceId(id)) throw new Error(`Evidence id ${id} is not valid`)
    return join(this.#directory, `${id}.bin`)
  }

  #metaPath(id: string): string {
    return join(this.#directory, `${id}.json`)
  }

  async put(input: { bytes: Uint8Array; width: number; height: number; mimeType?: string; protected?: boolean }): Promise<VisualEvidence> {
    if (input.bytes.byteLength === 0) throw new Error('A capture cannot be empty')
    await this.#initialize()
    const record: VisualEvidence = { id: `${VISUAL_EVIDENCE_PREFIX}${randomUUID()}`, mimeType: input.mimeType ?? 'image/png', width: Math.max(1, Math.round(input.width)), height: Math.max(1, Math.round(input.height)), sizeBytes: input.bytes.byteLength, createdAt: this.#now(), ...(input.protected ? { protected: true } : {}) }
    await atomicWriteFile(this.#metaPath(record.id), `${JSON.stringify(record)}\n`, { mode: PRIVATE_FILE_MODE })
    await atomicWriteFile(this.path(record.id), input.bytes, { mode: PRIVATE_FILE_MODE })
    return record
  }

  async exists(id: string): Promise<boolean> {
    await this.#initialize()
    try { await stat(this.path(id)); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** The sidecar alone, for sizes and types without reading the bytes. */
  async meta(id: string): Promise<VisualEvidence | null> {
    await this.#initialize()
    try {
      const raw: unknown = JSON.parse(await readFile(this.#metaPath(id), 'utf8'))
      if (!isRecord(raw)) return null
      return { id, mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'image/png', width: typeof raw.width === 'number' ? raw.width : 0, height: typeof raw.height === 'number' ? raw.height : 0, sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0, createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Null when the evidence is gone. The bytes are a copy; the store keeps its own. */
  async read(id: string): Promise<{ meta: VisualEvidence; bytes: Uint8Array } | null> {
    await this.#initialize()
    try {
      const raw: unknown = JSON.parse(await readFile(this.#metaPath(id), 'utf8'))
      const bytes = await readFile(this.path(id))
      const meta: VisualEvidence = { id, mimeType: isRecord(raw) && typeof raw.mimeType === 'string' ? raw.mimeType : 'image/png', width: isRecord(raw) && typeof raw.width === 'number' ? raw.width : 0, height: isRecord(raw) && typeof raw.height === 'number' ? raw.height : 0, sizeBytes: bytes.byteLength, createdAt: isRecord(raw) && typeof raw.createdAt === 'number' ? raw.createdAt : 0 }
      return { meta, bytes }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** A durable owner replaces its previous references atomically per sidecar. */
  retainOwner(owner: string, ids: readonly string[]): Promise<void> {
    const update = this.#ownership.then(async () => {
      await this.#initialize()
      const keep = new Set(ids)
      // Add before releasing, so interruption can retain extra evidence but cannot lose it.
      const files = await readdir(this.#directory)
      for (const id of keep) {
        const path = this.#metaPath(id)
        const meta = JSON.parse(await readFile(path, 'utf8'))
        await atomicWriteFile(path, JSON.stringify({ ...meta, protected: false, owners: [...new Set([...(meta.owners ?? []), owner])] }), { mode: PRIVATE_FILE_MODE })
      }
      for (const file of files) {
        const id = file.replace(/\.json$/, '')
        if (!file.endsWith('.json') || !isVisualEvidenceId(id) || keep.has(id)) continue
        const path = this.#metaPath(id), meta = JSON.parse(await readFile(path, 'utf8'))
        if (!meta.owners?.includes(owner)) continue
        await atomicWriteFile(path, JSON.stringify({ ...meta, owners: meta.owners.filter((value: string) => value !== owner) }), { mode: PRIVATE_FILE_MODE })
      }
    })
    this.#ownership = update.catch(() => undefined)
    return update
  }

  async discard(id: string): Promise<void> {
    await this.#initialize()
    const metadata = JSON.parse(await readFile(this.#metaPath(id), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"protected":true}'; throw error }))
    if (metadata.protected || metadata.owners?.length) return
    for (const path of [this.path(id), this.#metaPath(id)]) {
      try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  /** Deletes every piece of evidence whose id is not in `keep`; returns the ids removed. */
  async sweep(keep: ReadonlySet<string> | null): Promise<string[]> {
    await this.#initialize()
    if (!keep) return []
    const removed = new Set<string>()
    for (const entry of await readdir(this.#directory)) {
      const id = entry.replace(/\.(?:bin|json)$/u, '')
      if (!isVisualEvidenceId(id) || keep.has(id) || removed.has(id)) continue
      // A capture created by an unfinished session remains recoverable across restarts.
      const raw = JSON.parse(await readFile(this.#metaPath(id), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"protected":true}'; throw error }))
      if (raw.protected || raw.owners?.length) continue
      await this.discard(id)
      removed.add(id)
    }
    return [...removed]
  }
}

/** Reads a PNG header for its pixel size; null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let index = 0; index < signature.length; index += 1) if (bytes[index] !== signature[index]) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
