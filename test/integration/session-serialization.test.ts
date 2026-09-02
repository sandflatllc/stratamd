import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import { PROTOCOL_VERSION, type CommandRequest } from '../../src/cli/protocol'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore, type DeliveryMeta } from '../../src/main/storage'

const applications: StrataApplication[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.shutdown()))
})

async function fixture(content = '# Plan\n\nOriginal.\n') {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-serialization-'))
  const path = join(root, 'plan.md')
  await writeFile(path, content)
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  applications.push(app)
  return { root, path, store, settingsStore, app }
}

async function command(app: StrataApplication, command: CommandRequest['command'], args: unknown) {
  return app.commandHandler()(
    { version: PROTOCOL_VERSION, id: `test-${command}`, command, args } as CommandRequest,
    { connectionId: 'test', signal: new AbortController().signal },
  )
}

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
    await Promise.all([app.openDocument(path), app.openDocument(path), command(app, 'state', { file: path })])
    const view = await app.getState()
    expect(view.tabs).toHaveLength(1)
    expect(view.activeDocument?.path).toBe(path)
  })
})

describe('acknowledging after close (plan 2.7, 4.5)', () => {
  it('acknowledges and detaches a closed document without reopening it', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await expect(app.closeDocument(path)).resolves.toBe('closed')
    const queued = (await store.loadMeta(path)).attachments.ag_1!.deliveries[0]!
    expect(queued).toBeDefined()

    await expect(command(app, 'ack', { file: path, agent: 'ag_1', deliveryId: queued.id })).resolves.toEqual({ acknowledged: true })
    expect((await app.getState()).tabs).toEqual([])
    expect((await store.loadMeta(path)).attachments.ag_1?.deliveries).toEqual([])

    await expect(command(app, 'detach', { file: path, agent: 'ag_1' })).resolves.toEqual({ detached: true })
    expect((await app.getState()).tabs).toEqual([])
    expect((await store.loadMeta(path)).attachments.ag_1).toBeUndefined()
    await expect(command(app, 'detach', { file: path, agent: 'ag_1' })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })

  it('refuses an ack that names no queued delivery', async () => {
    const { app, path } = await fixture()
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await expect(command(app, 'ack', { file: path, agent: 'ag_1', deliveryId: 'd_nothing' })).rejects.toMatchObject({
      exitCode: 2,
      code: 'DELIVERY_NOT_FOUND',
      detail: { deliveryId: 'd_nothing', agent: 'ag_1', queued: [] },
    })
    await app.updateBuffer(path, '# Plan\n\nEdited.\n')
    const [deliveryId] = await app.send(path, { recipients: ['ag_1'], note: '', includeExternal: false })
    await expect(command(app, 'ack', { file: path, agent: 'ag_1', deliveryId: 'd_wrong' })).rejects.toMatchObject({
      code: 'DELIVERY_NOT_FOUND',
      detail: { queued: [deliveryId] },
    })
    await expect(command(app, 'ack', { file: path, agent: 'ag_1', deliveryId })).resolves.toEqual({ acknowledged: true })
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
    const { app, path, store, settingsStore } = await fixture()
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.updateBuffer(path, '# Plan\n\nA change to deliver.\n')
    const [deliveryId] = await app.send(path, { recipients: ['ag_1'], note: 'Look here.', includeExternal: false })
    const stored = (await store.loadMeta(path)).attachments.ag_1!.deliveries[0] as DeliveryMeta & { payload?: unknown }
    expect(stored.id).toBe(deliveryId)
    expect(stored.payload).toBeUndefined()
    expect(stored.payloadBlob).toMatch(/^[a-f0-9]{64}$/)
    const payload = JSON.parse(await store.getObjectText(stored.payloadBlob!)) as { deliveryId: string; notes: string[] }
    expect(payload).toMatchObject({ deliveryId, notes: ['Look here.'] })
    expect((await store.loadMeta(path)).formatVersion).toBe(3)

    await expect(app.closeDocument(path, 'discard')).resolves.toBe('closed')
    await app.shutdown()
    const reopened = await createStrataApplication({ store, settingsStore, watch: false })
    applications.push(reopened)
    await reopened.openDocument(path)
    const collected = await command(reopened, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 }) as { deliveryId: string; notes?: string[] }
    expect(collected).toMatchObject({ deliveryId, notes: ['Look here.'] })
    // The forgotten-document collector must keep payload objects alive.
    expect(await store.collectGarbage()).toEqual([])
  })

  it('reads a format-2 entry whose deliveries still carry inline payloads', async () => {
    const { app, path, store, settingsStore } = await fixture()
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.updateBuffer(path, '# Plan\n\nLegacy delivery.\n')
    const [deliveryId] = await app.send(path, { recipients: ['ag_1'], note: 'Old style.', includeExternal: false })
    await expect(app.closeDocument(path, 'discard')).resolves.toBe('closed')
    await app.shutdown()

    // Rewrite the entry the way a format-2 build left it: payload inline, no blob.
    const meta = await store.loadMeta(path)
    const delivery = meta.attachments.ag_1!.deliveries[0]!
    const payload = JSON.parse(await store.getObjectText(delivery.payloadBlob!)) as unknown
    const { payloadBlob: _blob, ...inline } = delivery
    await store.saveMeta({
      ...meta,
      formatVersion: 2 as unknown as typeof meta.formatVersion,
      attachments: { ag_1: { ...meta.attachments.ag_1!, deliveries: [{ ...inline, payload } as unknown as DeliveryMeta] } },
    })
    const objects = await readdir(store.objectsDirectory)
    expect(objects.length).toBeGreaterThan(0)

    const reopened = await createStrataApplication({ store, settingsStore, watch: false })
    applications.push(reopened)
    await reopened.openDocument(path)
    const collected = await command(reopened, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 }) as { deliveryId: string; notes?: string[] }
    expect(collected).toMatchObject({ deliveryId, notes: ['Old style.'] })
  })
})
