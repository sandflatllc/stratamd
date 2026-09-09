import { BINARY_MIME_PATTERN, MAX_BINARY_BYTES, MAX_IMAGE_BYTES, isSupportedImageType } from '../../core/composer-attachments'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory, isRecord, PRIVATE_FILE_MODE } from '../storage'

/**
 * Files the composer has accepted but not yet sent (PRD §6.0). The bytes
 * live here, in the data directory, the moment the owner pastes or picks
 * them, so a draft survives reload however large its files are. The
 * renderer keeps only the id and a thumbnail. A file leaves when its upload
 * succeeds, when the owner removes it, or when the sweep finds nothing
 * referencing it.
 */
export interface StagedAttachment {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  createdAt: number
}

const ID_PATTERN = /^a_[0-9a-f-]{36}$/u

export function isStagedAttachmentId(value: string): boolean {
  return ID_PATTERN.test(value)
}

export class StagedAttachmentStore {
  readonly #directory: string
  readonly #now: () => number
  #ready: Promise<void> | null = null

  constructor(directory: string, now: () => number = Date.now) {
    this.#directory = directory
    this.#now = now
  }

  #initialize(): Promise<void> {
    this.#ready ??= ensurePrivateDirectory(this.#directory)
    return this.#ready
  }

  #paths(id: string): { bytes: string; meta: string } {
    if (!isStagedAttachmentId(id)) throw new Error(`Attachment id ${id} is not valid`)
    return { bytes: join(this.#directory, `${id}.bin`), meta: join(this.#directory, `${id}.json`) }
  }

  async stage(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<StagedAttachment> {
    if (input.bytes.byteLength === 0) throw new Error(`Attachment ${input.name} is empty`)
    if (!BINARY_MIME_PATTERN.test(input.mimeType) || input.mimeType.length > 100) throw new Error(`Attachment ${input.name} has an invalid MIME type`)
    const limit = isSupportedImageType(input.mimeType) ? MAX_IMAGE_BYTES : MAX_BINARY_BYTES
    if (input.bytes.byteLength > limit) throw new Error(`Attachment ${input.name} exceeds the ${limit / (1024 * 1024)} MB limit`)
    await this.#initialize()
    const record: StagedAttachment = { id: `a_${randomUUID()}`, name: input.name, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength, createdAt: this.#now() }
    const paths = this.#paths(record.id)
    await atomicWriteFile(paths.bytes, input.bytes, { mode: PRIVATE_FILE_MODE })
    await atomicWriteFile(paths.meta, `${JSON.stringify(record)}\n`, { mode: PRIVATE_FILE_MODE })
    return record
  }

  async exists(id: string): Promise<boolean> {
    await this.#initialize()
    try { await stat(this.#paths(id).bytes); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** Null when the attachment was discarded or swept. */
  async read(id: string): Promise<{ meta: StagedAttachment; bytes: Uint8Array } | null> {
    await this.#initialize()
    const paths = this.#paths(id)
    try {
      const raw: unknown = JSON.parse(await readFile(paths.meta, 'utf8'))
      if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.mimeType !== 'string') return null
      const bytes = await readFile(paths.bytes)
      return { meta: { id, name: raw.name, mimeType: raw.mimeType, sizeBytes: bytes.byteLength, createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0 }, bytes }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async discard(id: string): Promise<void> {
    await this.#initialize()
    const paths = this.#paths(id)
    for (const path of [paths.bytes, paths.meta]) {
      try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  /** Deletes every staged attachment whose id is not in `keep`; returns the ids removed. */
  async sweep(keep: ReadonlySet<string>): Promise<string[]> {
    await this.#initialize()
    const removed = new Set<string>()
    for (const entry of await readdir(this.#directory)) {
      const id = entry.replace(/\.(?:bin|json)$/u, '')
      if (!isStagedAttachmentId(id) || keep.has(id) || removed.has(id)) continue
      await this.discard(id)
      removed.add(id)
    }
    return [...removed]
  }
}
