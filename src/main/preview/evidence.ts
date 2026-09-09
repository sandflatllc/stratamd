import { randomUUID } from 'node:crypto'
import { readFile, readdir, realpath, stat, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory, PRIVATE_FILE_MODE } from '../storage'
import type { BrowserEvidenceTransfer, BrowserEvidenceView } from '../../shared/browser-evidence'

/** A completed local file survives an upload failure. Retry is bound to the
 * original destination, never whichever engine happens to be connected later. */
export class BrowserEvidenceStore {
  readonly #directory: string
  readonly #changed: () => void
  readonly #records = new Map<string, BrowserEvidenceView>()
  readonly #transfers = new Map<string, Promise<BrowserEvidenceView>>()
  #destination: BrowserEvidenceTransfer | null = null

  constructor(directory: string, changed: () => void) { this.#directory = directory; this.#changed = changed }
  get destination(): string | null { return this.#destination?.destination ?? null }
  setTransfer(transfer: BrowserEvidenceTransfer): void { this.#destination = transfer }
  view(): BrowserEvidenceView[] { return [...this.#records.values()].map(value => ({ ...value })) }

  async restore(): Promise<void> {
    await ensurePrivateDirectory(this.#directory)
    for (const name of await readdir(this.#directory)) {
      if (!/^browser-[0-9a-f-]{36}\.json$/.test(name)) continue
      try {
        const record = JSON.parse(await readFile(join(this.#directory, name), 'utf8')) as BrowserEvidenceView
        if (record.id + '.json' !== name || typeof record.threadId !== 'string' || typeof record.tabId !== 'string' || !['image/png', 'video/webm'].includes(record.mimeType)) continue
        const extension = record.mimeType === 'image/png' ? 'png' : 'webm'
        if (typeof record.name !== 'string') record.name = `${record.id}.${extension}`; record.path = join(this.#directory, `${record.id}.${extension}`)
        if (record.status === 'transferring') { record.status = 'failed'; record.error = 'Strata closed before the transfer completed.' }
        this.#records.set(record.id, record)
      } catch { /* An incomplete sidecar cannot authorize an evidence action. */ }
    }
    await this.#pruneSnapshots()
    this.#changed()
  }

  // Snapshots are automatic browsing history; completed recordings remain explicit saved files.
  async #pruneSnapshots(): Promise<void> {
    const counts = new Map<string, number>()
    let count = 0, bytes = 0
    const snapshots = [...this.#records.values()].reverse().filter(record => record.mimeType === 'image/png').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const record of snapshots) {
      const perThread = (counts.get(record.threadId) ?? 0) + 1
      counts.set(record.threadId, perThread); count++; bytes += record.sizeBytes
      if (perThread <= 20 && count <= 100 && bytes <= 200 * 1024 * 1024) continue
      if (this.#transfers.has(record.id) || record.status === 'failed') continue
      this.#records.delete(record.id)
      await Promise.all([rm(record.path, { force: true }), rm(join(this.#directory, `${record.id}.json`), { force: true })])
    }
  }

  async #persist(record: BrowserEvidenceView): Promise<void> {
    await atomicWriteFile(join(this.#directory, `${record.id}.json`), JSON.stringify(record), { mode: PRIVATE_FILE_MODE })
  }

  async save(input: { tabId: string; threadId: string; bytes: Uint8Array; mimeType: 'image/png' | 'video/webm'; name?: string; destination?: string | null; truncated?: boolean }): Promise<BrowserEvidenceView> {
    if (!input.bytes.byteLength) throw new Error('The browser evidence is empty')
    await ensurePrivateDirectory(this.#directory)
    const id = `browser-${randomUUID()}`
    const name = `${id}.${input.mimeType === 'image/png' ? 'png' : 'webm'}`
    const path = join(this.#directory, name)
    await atomicWriteFile(path, input.bytes, { mode: PRIVATE_FILE_MODE })
    const saved = await stat(path)
    if (!saved.isFile() || saved.size !== input.bytes.byteLength) throw new Error(`Browser evidence was not saved completely at ${path}`)
    const displayName = input.name?.replace(/[^a-z0-9 ._-]/gi, '').trim().slice(0, 80)
    const record: BrowserEvidenceView = { ...(input.truncated ? { truncated: true } : {}), id, tabId: input.tabId, threadId: input.threadId, name: displayName ? `${displayName}.${input.mimeType === 'image/png' ? 'png' : 'webm'}` : name, path, mimeType: input.mimeType, sizeBytes: saved.size, createdAt: new Date().toISOString(), status: 'saved', destination: input.destination ?? this.#destination?.destination ?? null, error: null }
    await this.#persist(record)
    this.#records.set(id, record)
    await this.#pruneSnapshots()
    this.#changed()
    return { ...record }
  }

  async read(id: string): Promise<{ record: BrowserEvidenceView; bytes: Uint8Array }> {
    const record = this.#records.get(id)
    if (!record) throw new Error(`Browser evidence ${id} is not available`)
    const path = await realpath(record.path)
    if (dirname(path) !== await realpath(this.#directory)) throw new Error(`Browser evidence ${id} no longer points to its saved file`)
    const bytes = await readFile(path)
    if (bytes.byteLength !== record.sizeBytes) throw new Error(`The saved evidence at ${path} changed`)
    return { record: { ...record }, bytes }
  }

  transfer(id: string): Promise<BrowserEvidenceView> {
    const pending = this.#transfers.get(id)
    if (pending) return pending
    const promise = this.#transfer(id).finally(() => this.#transfers.delete(id))
    this.#transfers.set(id, promise)
    return promise
  }

  async #transfer(id: string): Promise<BrowserEvidenceView> {
    const record = this.#records.get(id)
    if (!record) throw new Error(`Browser evidence ${id} is not available`)
    if (record.uploadedAttachmentId) return { ...record }
    const destination = this.#destination
    try {
      if (!destination) throw new Error('No agent environment is connected. The saved copy remains on this computer.')
      if (record.destination && record.destination !== destination.destination) throw new Error(`Reconnect to ${record.destination} to retry this transfer`)
      record.destination = destination.destination
      const { bytes } = await this.read(id)
      if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('The recording exceeds the 50 MiB transfer limit. The saved copy remains on this computer.')
      record.status = 'transferring'; record.error = null; await this.#persist(record); this.#changed()
      record.uploadedAttachmentId = await destination.upload({ name: record.name, mimeType: record.mimeType, bytes })
      record.status = 'saved'; record.error = null
      return { ...record }
    } catch (error) {
      record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { await this.#persist(record); this.#changed() }
  }
}
