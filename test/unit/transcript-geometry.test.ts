import { describe, expect, it } from 'vitest'
import { TranscriptGeometryStore, entryKey, fingerprint, type GeometryIdentity, type GeometryStorage } from '../../src/renderer/transcriptGeometry'

class FakeStorage implements GeometryStorage {
  values = new Map<string, string>()
  failWrites = false
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { if (this.failWrites) throw new Error('QuotaExceededError'); this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const identity = (patch: Partial<GeometryIdentity> = {}): GeometryIdentity => ({ engine: 'e', thread: 't1', message: 'm1', source: fingerprint('# Answer'), width: 700, placement: 'side', zoom: 1, typography: '15px Inter', folds: '[]', layoutVersion: 1, ...patch })

describe('transcript geometry cache', () => {
  it('returns a recorded height only for the identical identity', () => {
    const store = new TranscriptGeometryStore()
    store.set(identity(), { height: 2768, images: {}, measuredAt: 1 })
    expect(store.get(identity())?.height).toBe(2768)
    for (const patch of [{ source: fingerprint('# Changed') }, { width: 701 }, { placement: 'center' }, { zoom: 1.2 }, { typography: '17px Inter' }, { folds: '[{"level":2}]' }, { layoutVersion: 2 }, { message: 'm2' }, { thread: 't2' }] as Partial<GeometryIdentity>[]) {
      expect(store.get(identity(patch))).toBeNull()
    }
  })

  it('persists in batches, reloads, and prunes messages that left the thread', () => {
    const storage = new FakeStorage()
    let write: (() => void) | null = null
    const store = new TranscriptGeometryStore({ storage, schedule: (fn) => { write = fn } })
    store.set(identity(), { height: 100, images: { 'a.png': '1:2' }, measuredAt: 1 })
    store.set(identity({ message: 'm2' }), { height: 200, images: {}, measuredAt: 2 })
    expect(storage.values.size).toBe(0)
    write!()
    expect(storage.values.size).toBe(1)
    const reloaded = new TranscriptGeometryStore({ storage, schedule: (fn) => { write = fn } })
    expect(reloaded.get(identity())).toEqual({ height: 100, images: { 'a.png': '1:2' }, measuredAt: 1 })
    reloaded.prune(identity(), new Set(['m2']))
    expect(reloaded.get(identity())).toBeNull()
    expect(reloaded.get(identity({ message: 'm2' }))?.height).toBe(200)
  })

  it('treats malformed records, quota errors, and missing storage as a cache miss', () => {
    const storage = new FakeStorage()
    storage.values.set('transcript-geometry', '{"version":1,"threads":{"e t1":{"touched":1,"entries":{"bad":{"height":"tall"}}}}}')
    const store = new TranscriptGeometryStore({ storage, schedule: (fn) => fn() })
    expect(store.get(identity())).toBeNull()
    storage.values.set('transcript-geometry', 'not json')
    expect(new TranscriptGeometryStore({ storage, schedule: (fn) => fn() }).threadCount()).toBe(0)
    storage.failWrites = true
    const failing = new TranscriptGeometryStore({ storage, schedule: (fn) => fn() })
    failing.set(identity(), { height: 5, images: {}, measuredAt: 1 })
    expect(failing.storageFailed).toBe(true)
    expect(failing.get(identity())?.height).toBe(5)
    const memoryOnly = new TranscriptGeometryStore({ storage: null })
    memoryOnly.set(identity(), { height: 7, images: {}, measuredAt: 1 })
    expect(memoryOnly.get(identity())?.height).toBe(7)
  })

  it('retains at most the configured thread count and stays under the byte cap, oldest first', () => {
    let clock = 0
    const store = new TranscriptGeometryStore({ maxThreads: 3, now: () => ++clock })
    for (const thread of ['a', 'b', 'c', 'd']) store.set(identity({ thread }), { height: 10, images: {}, measuredAt: clock })
    expect(store.threadCount()).toBe(3)
    expect(store.get(identity({ thread: 'a' }))).toBeNull()
    expect(store.get(identity({ thread: 'd' }))?.height).toBe(10)
    const small = new TranscriptGeometryStore({ maxBytes: 400, now: () => ++clock })
    for (let index = 0; index < 12; index += 1) small.set(identity({ thread: `t${index}` }), { height: 10 + index, images: { 'shot.png': '100:200' }, measuredAt: clock })
    expect(small.serialize().length).toBeLessThanOrEqual(400)
    expect(small.threadCount()).toBeGreaterThanOrEqual(1)
    expect(small.get(identity({ thread: 't11' }))?.height).toBe(21)
  })


  it('caps a single thread by UTF-8 bytes and rejects malformed dependency versions', () => {
    const store = new TranscriptGeometryStore({ maxBytes: 600 })
    for (let i = 0; i < 30; i++) store.set(identity({ message: `消息${i}` }), { height: 30, images: { '截图.png': '1:2' }, measuredAt: i })
    expect(new TextEncoder().encode(store.serialize()).length).toBeLessThanOrEqual(600)
    expect(store.get(identity({ message: '消息29' }))?.height).toBe(30)
  })

  it('keys entries by every height-affecting field', () => {
    expect(entryKey(identity())).toBe(['m1', '', fingerprint('# Answer'), '700', 'side', '1', '15px Inter', '[]', '1'].join('\0'))
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })
})
