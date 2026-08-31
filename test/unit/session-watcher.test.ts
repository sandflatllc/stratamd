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
    const callbacks: Array<(error: Error | null) => unknown> = []
    const reconcile = vi.fn(async () => undefined)
    const coordinator = new WatchCoordinator({
      documentPath: '/docs/doc.md',
      ghostEntryPath: '/data/ghost',
      reconcile,
      subscribe: vi.fn(async (_path, callback) => {
        callbacks.push(callback)
        return { unsubscribe: vi.fn(async () => undefined) }
      })
    })
    await coordinator.start()
    callbacks[0]?.(null)
    callbacks[1]?.(new Error('overflow'))
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    expect(reconcile).toHaveBeenNthCalledWith(1, 'watch-event')
    expect(reconcile).toHaveBeenNthCalledWith(2, 'watch-error')
    await coordinator.stop()
  })
})
