import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { DeliveryMeta } from '../../src/main/storage'
import { attach, deliveryPayloads, fixture, settleDeliveries } from './support/cockpit'

describe('per-document turns (plan 2.3, 2.4, 4.7)', () => {
  it('serves two overlapping saves without a conflict and leaves the file clean', async () => {
    const { app, path } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nBoth saves carry this.\n')
    await Promise.all([app.save(path), app.save(path)])
    expect(await readFile(path, 'utf8')).toBe('# Plan\n\nBoth saves carry this.\n')
    expect((await app.getState()).activeDocument?.dirty).toBe(false)
  })

  it('keeps the session dirty when typing lands while a save is in flight', async () => {
    const { app, path } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nFirst.\n')
    const saving = app.save(path)
    const typing = app.updateBuffer(path, '# Plan\n\nFirst. Second.\n')
    await Promise.all([saving, typing])
    const view = (await app.getState()).activeDocument
    expect(await readFile(path, 'utf8')).toBe('# Plan\n\nFirst.\n')
    expect(view?.content).toBe('# Plan\n\nFirst. Second.\n')
    expect(view?.dirty).toBe(true)
    await app.save(path)
    expect(await readFile(path, 'utf8')).toBe('# Plan\n\nFirst. Second.\n')
    expect((await app.getState()).activeDocument?.dirty).toBe(false)
  })

  it('shares one open between concurrent callers instead of racing for the lock', async () => {
    const { app, path } = await fixture()
    await Promise.all([app.openDocument(path), app.openDocument(path), app.getState()])
    const view = await app.getState()
    expect(view.tabs).toHaveLength(1)
    expect(view.activeDocument?.path).toBe(path)
  })
})

describe('acknowledging after close (plan 2.7, 4.5)', () => {
  it('a delivery sent before close is acknowledged from the transcript on reopen, without a second turn', async () => {
    const value = await fixture()
    const { app, path, store } = value
    await app.openDocument(path)
    const deliveryId = await attach(value, 't1', { acknowledge: false })
    await expect(app.closeDocument(path)).resolves.toBe('closed')
    expect((await store.loadMeta(path)).attachments.t1!.deliveries.map((delivery) => delivery.id)).toEqual([deliveryId])

    // The engine lists the message while the document is closed; nothing reopens for it.
    value.engine.acknowledge('t1', deliveryId)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await app.getState()).tabs).toEqual([])

    await app.openDocument(path)
    await settleDeliveries(value, 't1')
    await expect.poll(async () => (await store.loadMeta(path)).attachments.t1?.deliveries).toEqual([])
    expect(value.engine.deliveries('t1')).toHaveLength(1)

    await app.detachThread(path, 't1')
    expect((await store.loadMeta(path)).attachments.t1).toBeUndefined()
    await expect(app.detachThread(path, 't1')).rejects.toThrow()
  })
})

describe('durability (plan 2.5, 2.6, 4.10, 4.11)', () => {
  it('flushes unwritten typing to the buffer on shutdown', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nTyped just before quit.\n')
    // No wait for the 80 ms mirror: shutdown itself must carry the text.
    await app.shutdown()
    expect((await store.readBuffer(path))?.toString('utf8')).toBe('# Plan\n\nTyped just before quit.\n')
    const meta = await store.loadMeta(path)
    expect(await store.getObjectText(meta.shadowBlob!)).toBe('# Plan\n\nTyped just before quit.\n')
  })

  it('records the mirror only after its write succeeded', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    const original = store.writeBuffer.bind(store)
    let failing = true
    store.writeBuffer = async (file: string, content: string) => {
      if (failing) throw new Error('ENOSPC: no space left on device')
      return original(file, content)
    }
    await app.updateBuffer(path, '# Plan\n\nUnwritten.\n')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await app.flushPersistence(path)
    let meta = await store.loadMeta(path)
    expect(await store.getObjectText(meta.mirrorBlob!)).toBe('# Plan\n\nOriginal.\n')

    failing = false
    await app.updateBuffer(path, '# Plan\n\nWritten.\n')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await app.flushPersistence(path)
    meta = await store.loadMeta(path)
    expect(await store.getObjectText(meta.mirrorBlob!)).toBe('# Plan\n\nWritten.\n')
  })

  it('coalesces meta writes while typing and writes at once on save', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    const original = store.saveMeta.bind(store)
    let writes = 0
    store.saveMeta = async (meta) => {
      writes += 1
      return original(meta)
    }
    let text = '# Plan\n\nOriginal.'
    for (let step = 0; step < 30; step += 1) {
      text += String.fromCharCode(97 + (step % 26))
      await app.updateBuffer(path, `${text}\n`)
    }
    expect(writes).toBe(0)
    await app.flushPersistence(path)
    expect(writes).toBe(1)
    expect(await store.getObjectText((await store.loadMeta(path)).shadowBlob!)).toBe(`${text}\n`)
    await app.save(path)
    expect(writes).toBe(2)
  })

  it('stores queued delivery payloads as objects by hash and restores them', async () => {
    const value = await fixture()
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.updateBuffer(path, '# Plan\n\nA change to deliver.\n')
    const [deliveryId] = await app.send(path, { recipients: ['t1'], note: 'Look here.', includeExternal: false })
    const stored = (await store.loadMeta(path)).attachments.t1!.deliveries[0] as DeliveryMeta & { payload?: unknown }
    expect(stored.id).toBe(deliveryId)
    expect(stored.payload).toBeUndefined()
    expect(stored.payloadBlob).toMatch(/^[a-f0-9]{64}$/)
    const payload = JSON.parse(await store.getObjectText(stored.payloadBlob!)) as { deliveryId: string; notes: string[] }
    expect(payload).toMatchObject({ deliveryId, notes: ['Look here.'] })
    expect((await store.loadMeta(path)).formatVersion).toBe(3)

    await expect(app.closeDocument(path, 'discard')).resolves.toBe('closed')
    const reopened = await value.restart()
    await reopened.openDocument(path)
    // The restored payload goes out again under the same id, note and all.
    await expect.poll(() => value.engine.deliveries('t1').length).toBe(3)
    const repeated = value.engine.deliveries('t1').at(-1)!
    expect(repeated).toMatchObject({ messageId: deliveryId, commandId: `strata-${deliveryId}` })
    expect(repeated.attachment?.text).toContain('Look here.')
    expect((await deliveryPayloads(store, path, 't1'))[0]).toMatchObject({ id: deliveryId, payload: { notes: ['Look here.'] } })
    // The collector must keep the queued payload object alive; it may drop the
    // acknowledged attach delivery's payload, which nothing references any more.
    expect(await store.collectGarbage()).not.toContain(stored.payloadBlob)
    await expect(store.getObjectText(stored.payloadBlob!)).resolves.toContain('Look here.')
  })

  it('reads a format-2 entry whose deliveries still carry inline payloads', async () => {
    const value = await fixture()
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.updateBuffer(path, '# Plan\n\nLegacy delivery.\n')
    const [deliveryId] = await app.send(path, { recipients: ['t1'], note: 'Old style.', includeExternal: false })
    await expect(app.closeDocument(path, 'discard')).resolves.toBe('closed')
    await app.shutdown()

    // Rewrite the entry the way a format-2 build left it: payload inline, no blob.
    const meta = await store.loadMeta(path)
    const delivery = meta.attachments.t1!.deliveries[0]!
    const payload = JSON.parse(await store.getObjectText(delivery.payloadBlob!)) as unknown
    const { payloadBlob: _blob, ...inline } = delivery
    await store.saveMeta({
      ...meta,
      formatVersion: 2 as unknown as typeof meta.formatVersion,
      attachments: { t1: { ...meta.attachments.t1!, deliveries: [{ ...inline, payload } as unknown as DeliveryMeta] } },
    })
    const objects = await readdir(store.objectsDirectory)
    expect(objects.length).toBeGreaterThan(0)

    const reopened = await value.restart()
    await reopened.openDocument(path)
    await expect.poll(() => value.engine.deliveries('t1').length).toBe(3)
    const repeated = value.engine.deliveries('t1').at(-1)!
    expect(repeated).toMatchObject({ messageId: deliveryId })
    expect(repeated.attachment?.text).toContain('Old style.')
    expect((await deliveryPayloads(store, path, 't1'))[0]).toMatchObject({ id: deliveryId, payload: { notes: ['Old style.'] } })
  })
})
