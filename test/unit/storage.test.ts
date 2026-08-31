import { chmod, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_META_VERSION,
  GhostStore,
  AtomicWriteConflictError,
  atomicWriteFile,
  getDataDirectory,
  getRuntimeSocketPath,
  sha256,
  type DocumentMeta,
} from '../../src/main/storage'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratamd-storage-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('storage paths', () => {
  it('honors XDG paths and documented fallbacks', () => {
    // These wrappers answer for the host platform; the per-platform matrix
    // lives in test/unit/platform-paths.test.ts.
    const darwin = process.platform === 'darwin'
    const dataFallback = darwin
      ? '/home/test/Library/Application Support/StrataMD'
      : '/home/test/.local/share/stratamd'
    const socketFallback = darwin
      ? '/home/test/Library/Caches/StrataMD/run/stratamd.sock'
      : '/home/test/.cache/stratamd/run/stratamd.sock'
    expect(getDataDirectory({ XDG_DATA_HOME: '/data', HOME: '/home/test' })).toBe('/data/stratamd')
    expect(getDataDirectory({ HOME: '/home/test' })).toBe(dataFallback)
    expect(getRuntimeSocketPath({ XDG_RUNTIME_DIR: '/run/user/7' })).toBe('/run/user/7/stratamd.sock')
    expect(getRuntimeSocketPath({ HOME: '/home/test' })).toBe(socketFallback)
    expect(getRuntimeSocketPath({ HOME: '/home/test', XDG_CACHE_HOME: '/other-cache' })).toBe(socketFallback)
  })
})

describe('atomicWriteFile', () => {
  it('replaces content while preserving a document mode', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'document.md')
    await writeFile(path, 'old')
    await chmod(path, 0o640)
    await atomicWriteFile(path, 'new', { preserveMode: true })
    expect(await readFile(path, 'utf8')).toBe('new')
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it('checks the expected target hash immediately before rename', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'document.md')
    await writeFile(path, 'external')
    await expect(atomicWriteFile(path, 'mine', { expectedTargetHash: sha256('old') }))
      .rejects.toBeInstanceOf(AtomicWriteConflictError)
    expect(await readFile(path, 'utf8')).toBe('external')
  })
})

describe('GhostStore', () => {
  it('uses realpath identities, content-addressed objects, and private modes', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'document.md')
    await writeFile(document, 'hello\n')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    const meta = await store.createDocument(document, 'hello\n')
    const duplicate = await store.putObject('hello\n')

    expect(meta.ghostBlob).toBe(sha256('hello\n'))
    expect(duplicate).toBe(meta.ghostBlob)
    expect(await store.getObjectText(meta.ghostBlob)).toBe('hello\n')
    expect((await stat(store.dataDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(store.pathsForDocument(document).meta)).mode & 0o777).toBe(0o600)
    expect((await stat(join(store.objectsDirectory, meta.ghostBlob))).mode & 0o777).toBe(0o600)
  })

  it('migrates a version-zero metadata envelope on load', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'old.md')
    await writeFile(document, 'old\n')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    await store.initialize()
    const blob = await store.putObject('old\n')
    const paths = store.pathsForDocument(document)
    await atomicWriteFile(paths.meta, JSON.stringify({
      version: 0,
      realpath: document,
      ghost: blob,
      annotations: [],
    }))

    const migrated = await store.loadMeta(document)
    expect(migrated.formatVersion).toBe(CURRENT_META_VERSION)
    expect(migrated.ghostBlob).toBe(blob)
    expect(JSON.parse(await readFile(paths.meta, 'utf8')).formatVersion).toBe(CURRENT_META_VERSION)
  })

  it('preserves a version-zero annotation map while creating an empty event log', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'annotations.md')
    await writeFile(document, 'old\n')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    await store.initialize()
    const blob = await store.putObject('old\n')
    const paths = store.pathsForDocument(document)
    const annotations = { a1: { id: 'a1', kind: 'comment' } }
    await atomicWriteFile(paths.meta, JSON.stringify({
      version: 0,
      realpath: document,
      ghost: blob,
      annotations,
    }))

    const migrated = await store.loadMeta(document)
    expect(migrated.annotationEvents).toEqual([])
    expect(migrated.annotations).toEqual(annotations)
  })

  it('persists the zero segment offset when loading metadata written before the offset existed', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'current-v1.md')
    await writeFile(document, 'current\n')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    await store.initialize()
    const blob = await store.putObject('current\n')
    const paths = store.pathsForDocument(document)
    await atomicWriteFile(paths.meta, JSON.stringify({
      formatVersion: CURRENT_META_VERSION,
      realpath: document,
      ghostBlob: blob,
      pendingHunks: [],
      segments: [],
      attachments: {},
      annotationEvents: [],
    }))

    expect((await store.loadMeta(document)).segmentOffset).toBe(0)
    expect(JSON.parse(await readFile(paths.meta, 'utf8')).segmentOffset).toBe(0)
  })

  it('caps history to a contiguous suffix and advances its absolute offset', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'segments.md')
    await writeFile(document, 'current')
    const store = new GhostStore({ dataDirectory: join(directory, 'data'), segmentLimit: 2 })
    const initial = await store.createDocument(document, 'current')
    const blobs = await Promise.all(['one', 'two', 'three', 'four'].map((text) => store.putObject(text)))
    const meta: DocumentMeta = {
      ...initial,
      segments: blobs.map((blob, index) => ({ blob, author: 'user', time: index })),
      attachments: {
        agent: { baselineBlob: blobs[0]!, segmentIndex: 0, deliveries: [], cursor: 0 },
      },
    }
    const saved = await store.saveMeta(meta)
    expect(saved.segments.map((segment) => segment.blob)).toEqual([blobs[2], blobs[3]])
    expect(saved.segmentOffset).toBe(2)
    expect((await store.loadMeta(document)).segmentOffset).toBe(2)
  })

  it('serializes lock holders and garbage-collects forgotten objects', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'locked.md')
    await writeFile(document, 'content')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    const meta = await store.createDocument(document, 'content')
    const lock = await store.acquireLock(document)
    await expect(store.acquireLock(document)).rejects.toMatchObject({ code: 'ELOCKED' })
    await lock.release()
    await (await store.acquireLock(document)).release()
    await writeFile(store.pathsForDocument(document).lock, JSON.stringify({ pid: 2_147_483_647, token: 'dead' }))
    await (await store.acquireLock(document)).release()
    expect(await store.forgetDocument(document)).toBe(true)
    expect(await store.collectGarbage()).toEqual([])
    await expect(store.getObject(meta.ghostBlob)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves an open document entry and its held lock exactly once', async () => {
    const directory = await temporaryDirectory()
    const oldPath = join(directory, 'old.md')
    const newPath = join(directory, 'new.md')
    await writeFile(oldPath, 'content')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    await store.createDocument(oldPath, 'content')
    const originalEntry = store.pathsForDocument(oldPath).directory
    const lock = await store.acquireLock(oldPath)
    await rename(oldPath, newPath)
    const moved = await store.moveDocument(oldPath, newPath, lock)
    expect(moved.realpath).toBe(newPath)
    expect(store.pathsForDocument(newPath).directory).toBe(originalEntry)
    expect(lock.path).toBe(store.pathsForDocument(newPath).lock)
    await lock.release()
    await expect(stat(store.pathsForDocument(newPath).lock)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.hasDocument(newPath)).toBe(true)
    expect(await store.hasDocument(oldPath)).toBe(false)

    const reopenedStore = new GhostStore({ dataDirectory: join(directory, 'data') })
    await reopenedStore.initialize()
    expect(reopenedStore.pathsForDocument(newPath).directory).toBe(originalEntry)
    expect(await reopenedStore.loadMeta(newPath)).toMatchObject({ realpath: newPath })

    const readOnlyStore = new GhostStore({ dataDirectory: join(directory, 'data') })
    expect(await readOnlyStore.loadMetaReadOnly(newPath)).toMatchObject({ realpath: newPath })
    expect(readOnlyStore.pathsForDocument(newPath).directory).toBe(originalEntry)

    await writeFile(oldPath, 'replacement')
    await reopenedStore.createDocument(oldPath, 'replacement')
    expect(reopenedStore.pathsForDocument(oldPath).directory).not.toBe(originalEntry)
    expect(await reopenedStore.hasDocument(oldPath)).toBe(true)
    expect(await reopenedStore.hasDocument(newPath)).toBe(true)
  })
})

describe('save history and the version-1 upgrade', () => {
  async function storeFixture() {
    const directory = await temporaryDirectory()
    const document = join(directory, 'plan.md')
    await writeFile(document, 'current\n')
    const store = new GhostStore({ dataDirectory: join(directory, 'data') })
    await store.initialize()
    return { directory, document, store }
  }

  function versionOneMeta(document: string, ghostBlob: string): Record<string, unknown> {
    return {
      formatVersion: 1,
      realpath: document,
      ghostBlob,
      pendingHunks: [],
      segments: [],
      segmentOffset: 0,
      attachments: {},
      annotationEvents: [],
    }
  }

  it('round-trips saves and starts every new document with an empty history', async () => {
    const { document, store } = await storeFixture()
    const created = await store.createDocument(document, 'current\n')
    expect(created.saves).toEqual([])
    const beforeBlob = await store.putObject('current\n')
    const afterBlob = await store.putObject('current plus\n')
    await store.saveMeta({
      ...created,
      saves: [{ beforeBlob, afterBlob, time: 42, authors: [{ name: 'Ada', user: false }, { name: 'you', user: true }] }],
    })
    expect((await store.loadMeta(document)).saves).toEqual([
      { beforeBlob, afterBlob, time: 42, authors: [{ name: 'Ada', user: false }, { name: 'you', user: true }] },
    ])
  })

  it('upgrades a version-1 meta to empty history and keeps the empty-ghost marker until consumed', async () => {
    const { document, store } = await storeFixture()
    const emptyGhost = await store.putObject('')
    const paths = store.pathsForDocument(document)
    await atomicWriteFile(paths.meta, JSON.stringify(versionOneMeta(document, emptyGhost)))

    // The marker survives normalize-and-persist load cycles (loadMeta writes
    // the migrated meta back before returning it).
    expect((await store.loadMeta(document)).reseedFromDisk).toBe(true)
    const reloaded = await store.loadMeta(document)
    expect(reloaded.formatVersion).toBe(CURRENT_META_VERSION)
    expect(reloaded.saves).toEqual([])
    expect(reloaded.reseedFromDisk).toBe(true)

    const consumed = await store.consumeReseedMarker(reloaded, 'current\n')
    expect(consumed.reseedFromDisk).toBeUndefined()
    expect(await store.getObjectText(consumed.ghostBlob)).toBe('current\n')
    expect((await store.loadMeta(document)).reseedFromDisk).toBeUndefined()
  })

  it('keeps an empty ghost when the document is empty too, and never marks non-empty ghosts', async () => {
    const { document, store } = await storeFixture()
    const emptyGhost = await store.putObject('')
    const paths = store.pathsForDocument(document)
    await atomicWriteFile(paths.meta, JSON.stringify(versionOneMeta(document, emptyGhost)))
    const consumed = await store.consumeReseedMarker(await store.loadMeta(document), '')
    expect(consumed.reseedFromDisk).toBeUndefined()
    expect(consumed.ghostBlob).toBe(emptyGhost)

    const contentGhost = await store.putObject('reviewed\n')
    await atomicWriteFile(paths.meta, JSON.stringify(versionOneMeta(document, contentGhost)))
    expect((await store.loadMeta(document)).reseedFromDisk).toBeUndefined()
  })

  it('a deliberate empty ghost written at the current version survives loading', async () => {
    const { document, store } = await storeFixture()
    const created = await store.createDocument(document, 'current\n')
    const emptyGhost = await store.putObject('')
    await store.saveMeta({ ...created, ghostBlob: emptyGhost })
    const loaded = await store.loadMeta(document)
    expect(loaded.reseedFromDisk).toBeUndefined()
    expect(loaded.ghostBlob).toBe(emptyGhost)
  })

  it('garbage collection retains both blobs of every save entry', async () => {
    const { document, store } = await storeFixture()
    const created = await store.createDocument(document, 'current\n')
    const beforeBlob = await store.putObject('round before\n')
    const afterBlob = await store.putObject('round after\n')
    const orphan = await store.putObject('orphaned content\n')
    await store.saveMeta({
      ...created,
      saves: [{ beforeBlob, afterBlob, time: 1, authors: [] }],
    })
    expect(await store.collectGarbage()).toEqual([orphan])
    expect(await store.getObjectText(beforeBlob)).toBe('round before\n')
    expect(await store.getObjectText(afterBlob)).toBe('round after\n')
  })

  it('capping segments never touches the save history', async () => {
    const directory = await temporaryDirectory()
    const document = join(directory, 'capped.md')
    await writeFile(document, 'current\n')
    const store = new GhostStore({ dataDirectory: join(directory, 'data'), segmentLimit: 1 })
    const created = await store.createDocument(document, 'current\n')
    const blobs = await Promise.all(['one', 'two', 'three'].map((text) => store.putObject(text)))
    const saved = await store.saveMeta({
      ...created,
      segments: [
        { id: 'segment-1', beforeBlob: blobs[0]!, afterBlob: blobs[1]!, author: 'external', time: 1 },
        { id: 'segment-2', beforeBlob: blobs[1]!, afterBlob: blobs[2]!, author: 'external', time: 2 },
      ],
      saves: [{ beforeBlob: blobs[0]!, afterBlob: blobs[2]!, time: 3, authors: [{ name: 'Ada', user: false }] }],
    })
    expect(saved.segments).toHaveLength(1)
    expect(saved.saves).toEqual([{ beforeBlob: blobs[0]!, afterBlob: blobs[2]!, time: 3, authors: [{ name: 'Ada', user: false }] }])
  })
})
