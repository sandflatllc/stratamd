import { describe, expect, it, vi } from 'vitest'
import { DebouncedMirror, HashReconciler, WatchCoordinator } from '../../src/main/watcher'

describe('HashReconciler', () => {
  it('uses watch events only as wakeups and ignores hashes recorded as its own writes', async () => {
    const files = new Map<string, Buffer | null>([
      ['/doc.md', Buffer.from('disk')],
      ['/ghost/buffer.md', Buffer.from('disk')]
    ])
    const changes = vi.fn()
    const reconciler = new HashReconciler({
      documentPath: '/doc.md',
      bufferPath: '/ghost/buffer.md',
      read: async (path) => files.get(path) ?? null,
      onChange: changes
    })
    await reconciler.initialize()

    files.set('/ghost/buffer.md', Buffer.from('mine'))
    reconciler.noteOwnedWrite('buffer', 'mine')
    await reconciler.wake('watch-event')
    expect(changes).not.toHaveBeenCalled()

    files.set('/ghost/buffer.md', Buffer.from('agent edit'))
    await Promise.all([reconciler.wake('watch-event'), reconciler.wake('watch-event')])
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes.mock.calls[0]?.[0]).toMatchObject({
      source: 'buffer',
      previous: { bytes: Buffer.from('mine') },
      current: { bytes: Buffer.from('agent edit') }
    })
  })

  it('reports document deletion as a hash change', async () => {
    let document: Buffer | null = Buffer.from('before')
    const changes = vi.fn()
    const reconciler = new HashReconciler({
      documentPath: '/doc.md',
      bufferPath: '/buffer.md',
      read: async (path) => path === '/doc.md' ? document : Buffer.from('before'),
      onChange: changes
    })
    await reconciler.initialize()
    document = null
    await reconciler.wake('focus')
    expect(changes.mock.calls[0]?.[0].current.hash).toBeNull()
  })

  it('suppresses each queued owned hash when watcher events arrive out of order', async () => {
    let buffer = Buffer.from('old')
    const changes = vi.fn()
    const reconciler = new HashReconciler({
      documentPath: '/doc.md',
      bufferPath: '/buffer.md',
      read: async (path) => path === '/buffer.md' ? buffer : Buffer.from('disk'),
      onChange: changes
    })
    await reconciler.initialize()
    reconciler.noteOwnedWrite('buffer', 'first')
    reconciler.noteOwnedWrite('buffer', 'second')
    buffer = Buffer.from('first')
    await reconciler.wake('watch-event')
    buffer = Buffer.from('second')
    await reconciler.wake('watch-event')
    expect(changes).not.toHaveBeenCalled()
    buffer = Buffer.from('external')
    await reconciler.wake('watch-event')
    expect(changes.mock.calls[0]?.[0].previous.bytes).toEqual(Buffer.from('second'))
  })

  it('does not suppress a hash after its owned write reservation is cancelled', async () => {
    let document = Buffer.from('old')
    const changes = vi.fn()
    const reconciler = new HashReconciler({
      documentPath: '/doc.md',
      bufferPath: '/buffer.md',
      read: async (path) => path === '/doc.md' ? document : Buffer.from('old'),
      onChange: changes,
    })
    await reconciler.initialize()
    const cancel = reconciler.noteOwnedWrite('document', 'attempted-save')
    cancel()
    document = Buffer.from('attempted-save')
    await reconciler.wake('watch-event')
    expect(changes).toHaveBeenCalledOnce()
  })

  it('does not suppress a later external write after its matching reservation expires', async () => {
    let now = 1_000
    let document = Buffer.from('old')
    const changes = vi.fn()
    const reconciler = new HashReconciler({
      documentPath: '/doc.md',
      bufferPath: '/buffer.md',
      read: async (path) => path === '/doc.md' ? document : Buffer.from('old'),
      onChange: changes,
      now: () => now,
      ownedWriteReservationMs: 500,
    })
    await reconciler.initialize()

    reconciler.noteOwnedWrite('document', 'reserved-content')
    now += 501
    document = Buffer.from('reserved-content')
    await reconciler.wake('watch-event')

    expect(changes).toHaveBeenCalledOnce()
    expect(changes.mock.calls[0]?.[0]).toMatchObject({
      source: 'document',
      previous: { bytes: Buffer.from('old') },
      current: { bytes: Buffer.from('reserved-content') },
    })
  })
})

describe('DebouncedMirror', () => {
  it('survives a failed write, reports it once, and retries the content on the next flush', async () => {
    const written: string[] = []
    const failures: unknown[] = []
    let failNext = true
    const write = async (content: string) => {
      if (failNext) {
        failNext = false
        throw new Error('ENOSPC')
      }
      written.push(content)
    }
    const mirror = new DebouncedMirror({
      writer: { write },
      onError: (error) => { failures.push(error) },
      debounceMs: 10_000,
    })

    mirror.schedule('first')
    await expect(mirror.flush()).rejects.toThrow('ENOSPC')
    expect(failures).toHaveLength(1)
    expect(written).toEqual([])

    // Nothing newer was scheduled, so the failed content is still queued and
    // the chain is not poisoned: the next flush writes it.
    await mirror.flush()
    expect(written).toEqual(['first'])

    mirror.schedule('second')
    await mirror.flush()
    expect(written).toEqual(['first', 'second'])
  })

  it('drops failed content when newer content has already replaced it', async () => {
    const written: string[] = []
    let failNext = true
    const write = async (content: string) => {
      if (failNext) {
        failNext = false
        throw new Error('EACCES')
      }
      written.push(content)
    }
    const mirror = new DebouncedMirror({ writer: { write }, onError: () => {}, debounceMs: 10_000 })
    mirror.schedule('stale')
    const first = mirror.flush()
    mirror.schedule('fresh')
    await expect(first).rejects.toThrow('EACCES')
    await mirror.flush()
    expect(written).toEqual(['fresh'])
  })

  it('atomically hands only the latest pending content to its writer', async () => {
    const write = vi.fn(async () => undefined)
    const written = vi.fn()
    const mirror = new DebouncedMirror({ writer: { write }, onWritten: written, debounceMs: 10_000 })
    mirror.schedule('one')
    mirror.schedule('two')
    await mirror.flush()
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('two')
    expect(written).toHaveBeenCalledWith('two')
  })
})

describe('WatchCoordinator', () => {
  it('re-reads after events and watcher errors', async () => {
    const callbacks: Array<(error: Error | null, filename: string | null) => unknown> = []
    const directories: string[] = []
    const reconcile = vi.fn(async () => undefined)
    const coordinator = new WatchCoordinator({
      documentPath: '/docs/doc.md',
      bufferPath: '/data/ghost/abc/buffer.md',
      reconcile,
      subscribe: vi.fn(async (path, callback) => {
        directories.push(path)
        callbacks.push(callback)
        return { unsubscribe: vi.fn(async () => undefined) }
      })
    })
    await coordinator.start()
    // Flat watches on exactly the two parents, never a recursive one above them.
    expect(directories).toEqual(['/docs', '/data/ghost/abc'])
    callbacks[0]?.(null, 'doc.md')
    callbacks[1]?.(new Error('overflow'), null)
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    expect(reconcile).toHaveBeenNthCalledWith(1, 'watch-event')
    expect(reconcile).toHaveBeenNthCalledWith(2, 'watch-error')
    await coordinator.stop()
  })

  it('ignores events for other names in the same directory and wakes on nameless ones', async () => {
    const callbacks: Array<(error: Error | null, filename: string | null) => unknown> = []
    const reconcile = vi.fn(async () => undefined)
    const coordinator = new WatchCoordinator({
      documentPath: '/docs/doc.md',
      bufferPath: '/docs/.ghost/buffer.md',
      reconcile,
      subscribe: vi.fn(async (_path, callback) => {
        callbacks.push(callback)
        return { unsubscribe: vi.fn(async () => undefined) }
      })
    })
    await coordinator.start()
    callbacks[0]?.(null, 'other.md')
    callbacks[0]?.(null, 'notes.txt')
    expect(reconcile).not.toHaveBeenCalled()
    callbacks[0]?.(null, 'doc.md')
    callbacks[1]?.(null, 'meta.json')
    callbacks[1]?.(null, 'buffer.md')
    callbacks[1]?.(null, null)
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
    await coordinator.stop()
  })

  it('shares one real directory watch and reports a rename of the document', async () => {
    const { mkdtemp, writeFile, rename } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'stratamd-watch-'))
    const document = join(root, 'doc.md')
    await writeFile(document, 'one')
    const reconcile = vi.fn(async () => undefined)
    const coordinator = new WatchCoordinator({
      documentPath: document,
      bufferPath: join(root, 'buffer.md'),
      reconcile,
    })
    await coordinator.start()
    await writeFile(document, 'two')
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('watch-event'))
    reconcile.mockClear()
    await rename(document, join(root, 'moved.md'))
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('watch-event'))
    await coordinator.stop()
  })
})
