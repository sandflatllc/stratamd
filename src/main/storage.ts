import {
  constants as fsConstants,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const CURRENT_META_VERSION = 2
export const PRIVATE_DIRECTORY_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600
export const DEFAULT_SEGMENT_LIMIT = 200

export interface StorageEnvironment {
  readonly XDG_DATA_HOME?: string
  readonly XDG_CONFIG_HOME?: string
  readonly XDG_RUNTIME_DIR?: string
  readonly XDG_CACHE_HOME?: string
  readonly HOME?: string
}

export interface PendingHunkMeta {
  readonly id: string
  readonly status: 'pending' | 'mixed'
  readonly author: unknown
}

export interface SegmentMeta {
  readonly id?: string
  readonly beforeBlob?: string
  readonly afterBlob?: string
  /** Version-0 compatibility. New metadata uses beforeBlob/afterBlob. */
  readonly blob?: string
  readonly author: 'user' | 'external'
  readonly tag?: unknown
  readonly time: number
}

export interface DeliveryMeta {
  readonly id: string
  readonly snapshotBlob: string
}

export interface SaveAuthorMeta {
  readonly name: string
  readonly user: boolean
}

/** One Save: self-contained before/after snapshots plus who was active in the round. */
export interface SaveMeta {
  readonly beforeBlob: string
  readonly afterBlob: string
  readonly time: number
  readonly authors: readonly SaveAuthorMeta[]
}

export interface AttachmentMeta {
  readonly id?: string
  readonly name?: string
  readonly attachedAt?: number
  readonly lastCallAt?: number
  readonly waiting?: boolean
  readonly baselineBlob: string
  readonly segmentIndex: number
  readonly deliveries: readonly DeliveryMeta[]
  readonly cursor: number
}

/**
 * The main process owns the exact shapes inside annotations and range anchors.
 * Storage validates the durable envelope while retaining those versioned values.
 */
export interface DocumentMeta {
  readonly formatVersion: typeof CURRENT_META_VERSION
  readonly realpath: string
  readonly ghostBlob: string
  readonly saves: readonly SaveMeta[]
  /** Version-1 upgrade marker: the ghost was empty and should re-seed from disk (§6.3). */
  readonly reseedFromDisk?: boolean
  readonly pendingHunks: readonly PendingHunkMeta[]
  readonly segments: readonly SegmentMeta[]
  /** Absolute index of segments[0]; older version-1 metadata defaults to zero. */
  readonly segmentOffset: number
  readonly attachments: Readonly<Record<string, AttachmentMeta>>
  /** The attachment holding the Lead, if any; metadata written before this field reads as null. */
  readonly leadAgentId?: string | null
  readonly annotationEvents: readonly unknown[]
  readonly snapshotBlobs?: readonly string[]
  readonly diskBlob?: string
  readonly shadowBlob?: string
  readonly mirrorBlob?: string
  readonly conflicts?: readonly unknown[]
  readonly nextId?: number
  readonly forceNewUserSegment?: boolean
  readonly pendingTag?: unknown
  readonly clipboardRecipient?: unknown
  readonly [key: string]: unknown
}

export interface DocumentPaths {
  readonly key: string
  readonly directory: string
  readonly meta: string
  readonly buffer: string
  readonly lock: string
}

export interface GhostStoreOptions {
  readonly dataDirectory?: string
  readonly env?: StorageEnvironment
  readonly homeDirectory?: string
  readonly segmentLimit?: number
}

export interface AtomicWriteOptions {
  readonly mode?: number
  readonly preserveMode?: boolean
  readonly fsync?: boolean
  /** undefined disables the compare; null requires the target to be absent. */
  readonly expectedTargetHash?: string | null
}

export class AtomicWriteConflictError extends Error {
  readonly code = 'EATOMICCONFLICT'

  constructor(readonly actualHash: string | null) {
    super('The target changed before the atomic rename')
    this.name = 'AtomicWriteConflictError'
  }
}

export interface DocumentLock {
  readonly path: string
  /** Update the lease if its ghost-entry path changes. */
  retarget(path: string): Promise<void>
  release(): Promise<void>
}

/** Entry directory names are 12 hex (new) or 64 hex (pre-v9 entries); object blobs stay 64. */
const DOCUMENT_KEY_LENGTH = 12

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function environmentHome(env: StorageEnvironment, explicitHome?: string): string {
  return explicitHome ?? env.HOME ?? homedir()
}

export function getDataDirectory(
  env: StorageEnvironment = process.env,
  homeDirectory?: string,
): string {
  const base = env.XDG_DATA_HOME || join(environmentHome(env, homeDirectory), '.local', 'share')
  return join(base, 'stratamd')
}

export const getDataRoot = getDataDirectory

export function getRuntimeSocketPath(
  env: StorageEnvironment = process.env,
  homeDirectory?: string,
): string {
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'stratamd.sock')
  // The CLI contract fixes this fallback exactly; XDG_CACHE_HOME must not make
  // independently started client and server processes derive different paths.
  const cache = join(environmentHome(env, homeDirectory), '.cache')
  return join(cache, 'stratamd', 'run', 'stratamd.sock')
}

export async function prepareRuntimeSocketPath(
  env: StorageEnvironment = process.env,
  homeDirectory?: string,
): Promise<string> {
  const path = getRuntimeSocketPath(env, homeDirectory)
  if (!env.XDG_RUNTIME_DIR) await ensurePrivateDirectory(dirname(path))
  return path
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  // mkdir honors umask and does not tighten an existing directory.
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    await handle.chmod(PRIVATE_DIRECTORY_MODE)
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    await handle.sync()
  } catch (error) {
    // Some supported filesystems can reject directory fsync. Rename is still atomic.
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error
  } finally {
    await handle?.close()
  }
}

export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })

  let mode = options.mode ?? PRIVATE_FILE_MODE
  if (options.preserveMode) {
    try {
      mode = (await stat(target)).mode & 0o7777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  const temporary = join(
    parent,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let handle
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode)
    await handle.writeFile(content)
    // Writing may clear setuid/setgid bits, so apply the preserved mode last.
    await handle.chmod(mode)
    if (options.fsync !== false) await handle.sync()
    await handle.close()
    handle = undefined
    if (options.expectedTargetHash !== undefined) {
      let actualHash: string | null
      try {
        actualHash = sha256(await readFile(target))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        actualHash = null
      }
      if (actualHash !== options.expectedTargetHash) throw new AtomicWriteConflictError(actualHash)
    }
    await rename(temporary, target)
    if (options.fsync !== false) await syncDirectory(parent)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const EMPTY_CONTENT_HASH = sha256(new Uint8Array(0))

function normalizeMeta(value: unknown, expectedRealpath?: string): DocumentMeta {
  if (!isRecord(value)) throw new Error('Invalid document metadata: expected an object')

  let migrated: Record<string, unknown> = { ...value }
  let version = migrated.formatVersion ?? migrated.version ?? 0
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new Error('Invalid document metadata format version')
  }
  if ((version as number) > CURRENT_META_VERSION) {
    throw new Error(`Document metadata version ${String(version)} is newer than this build`)
  }

  if (version === 0) {
    const legacyAnnotations = migrated.annotations
    migrated = {
      ...migrated,
      formatVersion: 1,
      ghostBlob: migrated.ghostBlob ?? migrated.ghost ?? '',
      pendingHunks: migrated.pendingHunks ?? [],
      segments: migrated.segments ?? [],
      attachments: migrated.attachments ?? {},
      annotationEvents: migrated.annotationEvents
        ?? (Array.isArray(legacyAnnotations) ? legacyAnnotations : []),
      ...(isRecord(legacyAnnotations) ? { annotations: legacyAnnotations } : {}),
    }
    delete migrated.version
    delete migrated.ghost
    if (!isRecord(legacyAnnotations)) delete migrated.annotations
    version = 1
  }

  if (version === 1) {
    // A version-1 store whose ghost is the empty content was stranded by the
    // old git seeding rule; the marker survives every load until an open can
    // re-seed the ghost from the document itself (PRD §6.3).
    migrated = {
      ...migrated,
      formatVersion: 2,
      saves: migrated.saves ?? [],
      ...(migrated.ghostBlob === EMPTY_CONTENT_HASH ? { reseedFromDisk: true } : {}),
    }
    version = 2
  }

  if (version !== CURRENT_META_VERSION) throw new Error('No metadata migration is available')
  const saves = migrated.saves ?? []
  if (!Array.isArray(saves)) {
    throw new Error('Invalid document metadata save history')
  }
  migrated.saves = saves
  if (typeof migrated.realpath !== 'string' || !migrated.realpath.startsWith('/')) {
    throw new Error('Invalid document metadata realpath')
  }
  if (expectedRealpath && migrated.realpath !== expectedRealpath) {
    throw new Error('Document metadata does not match its ghost-store entry')
  }
  if (typeof migrated.ghostBlob !== 'string' || !/^[a-f0-9]{64}$/.test(migrated.ghostBlob)) {
    throw new Error('Invalid document metadata ghost blob')
  }
  if (!Array.isArray(migrated.pendingHunks) || !Array.isArray(migrated.segments)) {
    throw new Error('Invalid document metadata state')
  }
  if (!isRecord(migrated.attachments) || !Array.isArray(migrated.annotationEvents)) {
    throw new Error('Invalid document metadata attachment or annotation state')
  }
  const segmentOffset = migrated.segmentOffset ?? 0
  if (!Number.isSafeInteger(segmentOffset) || (segmentOffset as number) < 0) {
    throw new Error('Invalid document metadata segment offset')
  }
  migrated.segmentOffset = segmentOffset
  return migrated as unknown as DocumentMeta
}

function referencedBlobs(meta: DocumentMeta): Set<string> {
  const result = new Set<string>([meta.ghostBlob])
  if (meta.diskBlob) result.add(meta.diskBlob)
  if (meta.shadowBlob) result.add(meta.shadowBlob)
  if (meta.mirrorBlob) result.add(meta.mirrorBlob)
  for (const blob of meta.snapshotBlobs ?? []) result.add(blob)
  for (const save of meta.saves) {
    result.add(save.beforeBlob)
    result.add(save.afterBlob)
  }
  for (const segment of meta.segments) {
    if (segment.blob) result.add(segment.blob)
    if (segment.beforeBlob) result.add(segment.beforeBlob)
    if (segment.afterBlob) result.add(segment.afterBlob)
  }
  for (const attachment of Object.values(meta.attachments)) {
    result.add(attachment.baselineBlob)
    for (const delivery of attachment.deliveries) result.add(delivery.snapshotBlob)
  }
  const clipboard = meta.clipboardRecipient
  if (isRecord(clipboard)) {
    for (const key of ['baselineBlob', 'snapshotBlob']) {
      if (typeof clipboard[key] === 'string') result.add(clipboard[key])
    }
    if (Array.isArray(clipboard.deliveries)) {
      for (const delivery of clipboard.deliveries) {
        if (isRecord(delivery) && typeof delivery.snapshotBlob === 'string') {
          result.add(delivery.snapshotBlob)
        }
      }
    }
    if (isRecord(clipboard.pending) && typeof clipboard.pending.snapshotBlob === 'string') {
      result.add(clipboard.pending.snapshotBlob)
    }
  }
  return result
}

function capSegments(meta: DocumentMeta, limit: number): DocumentMeta {
  if (meta.segments.length <= limit) return meta
  const removedCount = meta.segments.length - limit
  const segments = meta.segments.slice(removedCount)
  const retainedSnapshots = new Set<string>()
  if (meta.diskBlob) retainedSnapshots.add(meta.diskBlob)
  if (meta.shadowBlob) retainedSnapshots.add(meta.shadowBlob)
  if (meta.mirrorBlob) retainedSnapshots.add(meta.mirrorBlob)
  for (const segment of segments) {
    if (segment.beforeBlob) retainedSnapshots.add(segment.beforeBlob)
    if (segment.afterBlob) retainedSnapshots.add(segment.afterBlob)
    if (segment.blob) retainedSnapshots.add(segment.blob)
  }
  return {
    ...meta,
    segments,
    segmentOffset: meta.segmentOffset + removedCount,
    ...(meta.snapshotBlobs === undefined
      ? {}
      : { snapshotBlobs: meta.snapshotBlobs.filter((blob) => retainedSnapshots.has(blob)) }),
  }
}

export class GhostStore {
  readonly dataDirectory: string
  readonly documentsDirectory: string
  readonly objectsDirectory: string
  readonly segmentLimit: number
  #initialization: Promise<void> | undefined
  readonly #entryKeysByRealpath = new Map<string, string>()
  readonly #entryRealpathsByKey = new Map<string, string>()

  constructor(options: GhostStoreOptions = {}) {
    this.dataDirectory = options.dataDirectory
      ? resolve(options.dataDirectory)
      : getDataDirectory(options.env, options.homeDirectory)
    this.documentsDirectory = join(this.dataDirectory, 'docs')
    this.objectsDirectory = join(this.dataDirectory, 'objects')
    this.segmentLimit = options.segmentLimit ?? DEFAULT_SEGMENT_LIMIT
    if (!Number.isInteger(this.segmentLimit) || this.segmentLimit < 1) {
      throw new RangeError('segmentLimit must be a positive integer')
    }
  }

  async initialize(): Promise<void> {
    if (!this.#initialization) {
      this.#initialization = this.initializeOnce().catch((error) => {
        this.#initialization = undefined
        throw error
      })
    }
    await this.#initialization
  }

  private async initializeOnce(): Promise<void> {
    await ensurePrivateDirectory(this.dataDirectory)
    await Promise.all([
      ensurePrivateDirectory(this.documentsDirectory),
      ensurePrivateDirectory(this.objectsDirectory),
    ])
    const [documents, objects] = await Promise.all([
      readdir(this.documentsDirectory, { withFileTypes: true }),
      readdir(this.objectsDirectory, { withFileTypes: true }),
    ])
    await Promise.all([
      ...objects
        .filter((entry) => entry.isFile())
        .map((entry) => chmod(join(this.objectsDirectory, entry.name), PRIVATE_FILE_MODE)),
      ...documents
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const directory = join(this.documentsDirectory, entry.name)
          await chmod(directory, PRIVATE_DIRECTORY_MODE)
          const files = await readdir(directory, { withFileTypes: true })
          await Promise.all(files
            .filter((file) => file.isFile())
            .map((file) => chmod(join(directory, file.name), PRIVATE_FILE_MODE)))
          try {
            const parsed: unknown = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'))
            const meta = normalizeMeta(parsed)
            this.#entryKeysByRealpath.set(meta.realpath, entry.name)
            this.#entryRealpathsByKey.set(entry.name, meta.realpath)
          } catch {
            // Corrupt entries remain available for manual recovery.
          }
        }),
    ])
  }

  /**
   * Entry keys are short so the buffer path costs agents few tokens on every
   * delivery. Entries are resolved by the realpath in meta.json, so older
   * full-length keys keep working, and pathsForDocument salts on collision.
   */
  documentKey(documentRealpath: string): string {
    if (!documentRealpath.startsWith('/')) throw new Error('A document realpath must be absolute')
    return sha256(documentRealpath).slice(0, DOCUMENT_KEY_LENGTH)
  }

  pathsForDocument(documentRealpath: string): DocumentPaths {
    let key = this.#entryKeysByRealpath.get(documentRealpath) ?? this.documentKey(documentRealpath)
    if (!this.#entryKeysByRealpath.has(documentRealpath)) {
      let salt = 0
      while (this.#entryRealpathsByKey.has(key) && this.#entryRealpathsByKey.get(key) !== documentRealpath) {
        key = sha256(`${documentRealpath}\0${salt++}`).slice(0, DOCUMENT_KEY_LENGTH)
      }
    }
    const directory = join(this.documentsDirectory, key)
    return {
      key,
      directory,
      meta: join(directory, 'meta.json'),
      buffer: join(directory, 'buffer.md'),
      lock: join(directory, 'lock'),
    }
  }

  async hasDocument(documentRealpath: string): Promise<boolean> {
    await this.initialize()
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.pathsForDocument(documentRealpath).meta, 'utf8'),
      )
      return normalizeMeta(parsed).realpath === documentRealpath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async putObject(content: string | Uint8Array): Promise<string> {
    await this.initialize()
    const hash = sha256(content)
    const target = join(this.objectsDirectory, hash)
    try {
      const existing = await readFile(target)
      if (sha256(existing) !== hash) throw new Error(`Corrupt object ${hash}`)
      return hash
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Objects use temp-and-rename too. A crash cannot leave a partial object at
    // its content-addressed final name. Concurrent writers may replace the same
    // hash with the same bytes, which is harmless.
    await atomicWriteFile(target, content, { mode: PRIVATE_FILE_MODE })
    return hash
  }

  async getObject(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid object hash')
    const content = await readFile(join(this.objectsDirectory, hash))
    if (sha256(content) !== hash) throw new Error(`Corrupt object ${hash}`)
    return content
  }

  async getObjectText(hash: string): Promise<string> {
    return (await this.getObject(hash)).toString('utf8')
  }

  async hasObject(hash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return false
    try {
      const content = await readFile(join(this.objectsDirectory, hash))
      return sha256(content) === hash
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async createDocument(documentRealpath: string, ghost: string | Uint8Array): Promise<DocumentMeta> {
    await this.initialize()
    const canonical = await realpath(documentRealpath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(documentRealpath)
      throw error
    })
    const paths = this.pathsForDocument(canonical)
    await ensurePrivateDirectory(paths.directory)
    if (await this.hasDocument(canonical)) return this.loadMeta(canonical)
    const ghostBlob = await this.putObject(ghost)
    const meta: DocumentMeta = {
      formatVersion: CURRENT_META_VERSION,
      realpath: canonical,
      ghostBlob,
      saves: [],
      pendingHunks: [],
      segments: [],
      segmentOffset: 0,
      attachments: {},
      annotationEvents: [],
    }
    this.#entryKeysByRealpath.set(canonical, paths.key)
    this.#entryRealpathsByKey.set(paths.key, canonical)
    await this.saveMeta(meta)
    return meta
  }

  /**
   * Consumes the version-1 upgrade marker: a stranded empty ghost re-seeds from
   * the document's current content, once (PRD §6.3). An empty document keeps
   * its empty ghost; the marker clears either way.
   */
  async consumeReseedMarker(meta: DocumentMeta, disk: string | Uint8Array): Promise<DocumentMeta> {
    if (meta.reseedFromDisk !== true) return meta
    const { reseedFromDisk: _consumed, ...rest } = meta
    const empty = typeof disk === 'string' ? disk.length === 0 : disk.byteLength === 0
    const ghostBlob = empty ? meta.ghostBlob : await this.putObject(disk)
    return await this.saveMeta({ ...rest, ghostBlob })
  }

  async loadMeta(documentRealpath: string): Promise<DocumentMeta> {
    await this.initialize()
    const canonical = await realpath(documentRealpath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(documentRealpath)
      throw error
    })
    const paths = this.pathsForDocument(canonical)
    const parsed: unknown = JSON.parse(await readFile(paths.meta, 'utf8'))
    const meta = normalizeMeta(parsed, canonical)
    if (
      isRecord(parsed)
      && (parsed.formatVersion !== CURRENT_META_VERSION || parsed.segmentOffset === undefined)
    ) {
      await this.saveMeta(meta)
    }
    return meta
  }

  /** Reads existing metadata without initializing, migrating, or writing the store. */
  async loadMetaReadOnly(documentRealpath: string): Promise<DocumentMeta | undefined> {
    const canonical = await realpath(documentRealpath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(documentRealpath)
      throw error
    })
    const paths = this.pathsForDocument(canonical)
    try {
      const parsed: unknown = JSON.parse(await readFile(paths.meta, 'utf8'))
      return normalizeMeta(parsed, canonical)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    // A moved open document retains its original docs/<entry> identity. A new
    // offline process has no alias cache, so locate that entry by meta.realpath
    // without creating or chmodding anything.
    let entries
    try {
      entries = await readdir(this.documentsDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{12,64}$/.test(entry.name)) continue
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(this.documentsDirectory, entry.name, 'meta.json'), 'utf8'),
        )
        const meta = normalizeMeta(parsed)
        if (meta.realpath !== canonical) continue
        this.#entryKeysByRealpath.set(canonical, entry.name)
        this.#entryRealpathsByKey.set(entry.name, canonical)
        return meta
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  async saveMeta(meta: DocumentMeta): Promise<DocumentMeta> {
    await this.initialize()
    const normalized = capSegments(normalizeMeta(meta), this.segmentLimit)
    const paths = this.pathsForDocument(normalized.realpath)
    this.#entryKeysByRealpath.set(normalized.realpath, paths.key)
    this.#entryRealpathsByKey.set(paths.key, normalized.realpath)
    await ensurePrivateDirectory(paths.directory)
    await atomicWriteFile(paths.meta, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    })
    return normalized
  }

  async writeBuffer(documentRealpath: string, content: string | Uint8Array): Promise<string> {
    await this.initialize()
    const paths = this.pathsForDocument(documentRealpath)
    await ensurePrivateDirectory(paths.directory)
    await atomicWriteFile(paths.buffer, content, { mode: PRIVATE_FILE_MODE })
    return sha256(content)
  }

  async readBuffer(documentRealpath: string): Promise<Buffer | undefined> {
    await this.initialize()
    try {
      return await readFile(this.pathsForDocument(documentRealpath).buffer)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async moveDocument(
    oldRealpath: string,
    newPath: string,
    heldLock?: DocumentLock,
  ): Promise<DocumentMeta> {
    const oldCanonical = resolve(oldRealpath)
    const newCanonical = await realpath(newPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(newPath)
      throw error
    })
    await this.initialize()
    const oldPaths = this.pathsForDocument(oldCanonical)
    const newPaths = this.pathsForDocument(newCanonical)
    if (oldPaths.directory === newPaths.directory) return this.loadMeta(newCanonical)
    if (await this.hasDocument(newCanonical)) throw new Error('The destination already has a ghost entry')
    if (!heldLock) {
      try {
        await stat(oldPaths.lock)
        if (!await this.removeStaleLock(oldPaths.lock)) {
          throw Object.assign(new Error('Document is locked; pass its lease when moving it'), { code: 'ELOCKED' })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const meta = await this.loadMeta(oldCanonical)
    const moved = { ...meta, realpath: newCanonical } as DocumentMeta
    this.#entryKeysByRealpath.delete(oldCanonical)
    this.#entryKeysByRealpath.set(newCanonical, oldPaths.key)
    this.#entryRealpathsByKey.set(oldPaths.key, newCanonical)
    try {
      await this.saveMeta(moved)
    } catch (error) {
      this.#entryKeysByRealpath.delete(newCanonical)
      this.#entryKeysByRealpath.set(oldCanonical, oldPaths.key)
      this.#entryRealpathsByKey.set(oldPaths.key, oldCanonical)
      throw error
    }
    if (heldLock) await heldLock.retarget(oldPaths.lock)
    await syncDirectory(this.documentsDirectory)
    return moved
  }

  async forgetDocument(documentRealpath: string): Promise<boolean> {
    await this.initialize()
    const paths = this.pathsForDocument(documentRealpath)
    try {
      const parsed: unknown = JSON.parse(await readFile(paths.meta, 'utf8'))
      if (normalizeMeta(parsed).realpath !== documentRealpath) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    try {
      await rm(paths.directory, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    this.#entryKeysByRealpath.delete(documentRealpath)
    this.#entryRealpathsByKey.delete(paths.key)
    await this.collectGarbage()
    return true
  }

  async listDocuments(): Promise<readonly DocumentMeta[]> {
    await this.initialize()
    const entries = await readdir(this.documentsDirectory, { withFileTypes: true })
    const documents: DocumentMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{12,64}$/.test(entry.name)) continue
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(this.documentsDirectory, entry.name, 'meta.json'), 'utf8'),
        )
        documents.push(normalizeMeta(parsed))
      } catch {
        // A corrupt entry stays on disk for recovery, but cannot poison the explorer.
      }
    }
    return documents
  }

  async collectGarbage(): Promise<readonly string[]> {
    await this.initialize()
    const referenced = new Set<string>()
    const entries = await readdir(this.documentsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{12,64}$/.test(entry.name)) continue
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(this.documentsDirectory, entry.name, 'meta.json'), 'utf8'),
        )
        for (const hash of referencedBlobs(normalizeMeta(parsed))) referenced.add(hash)
      } catch {
        // Deleting blobs while an entry cannot be read would make recovery
        // harder. Leave all objects alone until the corrupt entry is repaired.
        return []
      }
    }
    const removed: string[] = []
    for (const entry of await readdir(this.objectsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name) || referenced.has(entry.name)) continue
      await unlink(join(this.objectsDirectory, entry.name))
      removed.push(entry.name)
    }
    if (removed.length > 0) await syncDirectory(this.objectsDirectory)
    return removed
  }

  async acquireLock(documentRealpath: string, timeoutMs = 0): Promise<DocumentLock> {
    await this.initialize()
    const paths = this.pathsForDocument(documentRealpath)
    await ensurePrivateDirectory(paths.directory)
    const deadline = Date.now() + timeoutMs
    const token = randomBytes(16).toString('hex')

    for (;;) {
      try {
        const handle = await open(
          paths.lock,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          PRIVATE_FILE_MODE,
        )
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`)
        await handle.sync()
        let released = false
        let currentPath = paths.lock
        return {
          get path() {
            return currentPath
          },
          retarget: async (nextPath: string) => {
            if (released) throw new Error('Cannot retarget a released document lock')
            const lock = JSON.parse(await readFile(nextPath, 'utf8')) as { token?: unknown }
            if (lock.token !== token) throw new Error('The moved lock lease does not match')
            currentPath = nextPath
          },
          release: async () => {
            if (released) return
            released = true
            await handle.close()
            try {
              const lock = JSON.parse(await readFile(currentPath, 'utf8')) as { token?: unknown }
              if (lock.token === token) await unlink(currentPath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await this.removeStaleLock(paths.lock)) continue
        if (Date.now() >= deadline) throw Object.assign(new Error('Document is locked'), { code: 'ELOCKED' })
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(25, deadline - Date.now())))
      }
    }
  }

  async withLock<T>(documentRealpath: string, operation: () => Promise<T>, timeoutMs = 0): Promise<T> {
    const lock = await this.acquireLock(documentRealpath, timeoutMs)
    try {
      return await operation()
    } finally {
      await lock.release()
    }
  }

  private async removeStaleLock(lockPath: string): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
      if (!isRecord(value) || !Number.isInteger(value.pid)) return false
      try {
        process.kill(value.pid as number, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(lockPath).catch(() => undefined)
          return true
        }
      }
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      // An unparseable lock might still belong to a live writer. Do not steal it.
      return false
    }
  }
}
