import { mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication as createApplication, type ApplicationOptions, type StrataApplication } from '../../src/main/application'
import { createAnnotation, createAnnotationLog, isHunkVerdict, type AnnotationLog } from '../../src/core/annotations'
import type { Attachment } from '../../src/core/delivery'
import { PROTOCOL_VERSION, type CommandRequest } from '../../src/cli/protocol'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'

const applications: StrataApplication[] = []

async function createStrataApplication(options: ApplicationOptions = {}): Promise<StrataApplication> {
  const app = await createApplication(options)
  applications.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.shutdown()))
})

async function fixture(content = '# Plan\n\nOriginal.\n') {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-application-'))
  const path = join(root, 'plan.md')
  await writeFile(path, content)
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  return { root, path, store, settingsStore, app }
}

async function command(app: Awaited<ReturnType<typeof createStrataApplication>>, command: CommandRequest['command'], args: unknown) {
  return app.commandHandler()(
    { version: PROTOCOL_VERSION, id: `test-${command}`, command, args } as CommandRequest,
    { connectionId: 'test', signal: new AbortController().signal },
  )
}

interface StoredApplication {
  state: { shadow: string; ghost: string; pendingHunks: readonly unknown[] }
  annotations: AnnotationLog
  attachments: Record<string, Attachment>
}

async function storedApplication(store: GhostStore, path: string): Promise<StoredApplication> {
  const meta = await store.loadMeta(path)
  return {
    state: {
      shadow: meta.shadowBlob
        ? await store.getObjectText(meta.shadowBlob)
        : ((await store.readBuffer(path))?.toString('utf8') ?? ''),
      ghost: await store.getObjectText(meta.ghostBlob),
      pendingHunks: meta.pendingHunks,
    },
    annotations: {
      annotations: meta.annotations as AnnotationLog['annotations'],
      events: meta.annotationEvents as AnnotationLog['events'],
      nextSeq: meta.nextAnnotationSeq as number,
    },
    attachments: meta.attachments as unknown as Record<string, Attachment>,
  }
}

async function trackedDescriptors(path: string): Promise<string[]> {
  if (process.platform !== 'linux') return []
  const descriptors = await readdir('/proc/self/fd')
  const targets = await Promise.all(descriptors.map(async (descriptor) =>
    readlink(join('/proc/self/fd', descriptor)).catch(() => null),
  ))
  return targets.filter((target): target is string =>
    target === path || target === `${path} (deleted)`,
  )
}

describe('StrataApplication', () => {
  it('opens, mirrors, and saves a user edit without changing disk before Save', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nChanged.\n')
    expect(await readFile(path, 'utf8')).toContain('Original')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await store.readBuffer(path))?.toString('utf8')).toContain('Changed')
    await app.save(path)
    expect(await readFile(path, 'utf8')).toContain('Changed')
    expect((await app.getState()).activeDocument?.dirty).toBe(false)
  })

  it('treats an agent buffer write as pending and keeps it pending after Save', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await store.writeBuffer(path, '# Plan\n\nAgent proposal.\n')
    await app.recheckFocused()
    let document = (await app.getState()).activeDocument
    expect(document?.content).toContain('Agent proposal')
    expect(document?.pendingHunks.length).toBeGreaterThan(0)
    expect(await readFile(path, 'utf8')).toContain('Original')
    await app.save(path)
    document = (await app.getState()).activeDocument
    expect(await readFile(path, 'utf8')).toContain('Agent proposal')
    expect(document?.pendingHunks.length).toBeGreaterThan(0)
  })

  it('saves the current shadow when the user edits inside pending agent work', async () => {
    const original = '# Plan\n\nShip Friday.\n\nOwner note.\n'
    const proposed = '# Plan\n\nShip Thursday.\n\nOwner note.\n'
    const mixed = '# Plan\n\nShip Thursday after review.\n\nUpdated owner note.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await store.writeBuffer(path, proposed)
    await app.recheckFocused()
    await app.updateBuffer(path, mixed)
    await app.save(path)
    expect(await readFile(path, 'utf8')).toBe(mixed)
    expect((await app.getState()).activeDocument?.pendingHunks.length).toBeGreaterThan(0)
  })

  it('returns an allowlisted protocol URL for a relative image and rejects remote images', async () => {
    const { app, path, root } = await fixture()
    await writeFile(join(root, 'photo.png'), Buffer.from([137, 80, 78, 71]))
    await app.openDocument(path)
    expect(await app.resolveLocalImage(path, 'photo.png')).toMatch(/^strata-image:\/\/local\//)
    expect(await app.resolveLocalImage(path, 'https://example.test/photo.png')).toBeNull()
  })

  it('accepts into shadow and ghost while remapping later annotations', async () => {
    const original = 'Use the old phrase here. Later note.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await command(app, 'annotate', {
      file: path,
      agent: 'ag_1',
      annotations: [{ kind: 'suggestion', quote: 'old phrase', text: 'new wording' }],
    })
    await app.addAnnotation(path, {
      kind: 'comment', quote: 'Later note', text: 'Keep this.',
      from: original.indexOf('Later note'), to: original.indexOf('Later note') + 'Later note'.length,
    })
    const before = await storedApplication(store, path)
    const suggestion = Object.values(before.annotations.annotations).find((item) => item.kind === 'suggestion')!
    const comment = Object.values(before.annotations.annotations).find((item) => item.kind === 'comment')!

    await app.acceptSuggestion(path, suggestion.id)

    const after = await storedApplication(store, path)
    expect(after.state.shadow).toBe('Use the new wording here. Later note.\n')
    expect(after.state.ghost).toBe(after.state.shadow)
    expect(after.state.pendingHunks).toEqual([])
    expect(after.annotations.annotations[comment.id]?.anchor.start).toBe(original.indexOf('Later note') + 1)
    expect(after.annotations.annotations[suggestion.id]).toMatchObject({ status: 'resolved', resolution: 'accepted' })
  })

  it('accepts and rejects all open suggestions for one agent without touching another agent', async () => {
    const { app, path, store } = await fixture('abcdef\n')
    await app.openDocument(path)
    for (const [agent, name] of [['ag_1', 'One'], ['ag_2', 'Two']] as const) {
      await command(app, 'attach', { file: path, agent, name, timeout: 0 })
    }
    await command(app, 'annotate', {
      file: path, agent: 'ag_1', annotations: [
        { kind: 'suggestion', quote: 'bcd', text: 'B' },
        { kind: 'suggestion', quote: 'cd', text: 'C' },
        { kind: 'suggestion', quote: 'ef', text: 'E' },
      ],
    })
    await command(app, 'annotate', {
      file: path, agent: 'ag_2', annotations: [{ kind: 'suggestion', quote: 'a', text: 'A' }],
    })

    const accepted = await app.acceptAllSuggestions(path, 'ag_1')
    expect(accepted.accepted).toHaveLength(2)
    expect(accepted.skipped).toHaveLength(1)
    expect((await app.getState()).activeDocument?.content).toBe('aBE\n')
    expect((await storedApplication(store, path)).state.ghost).toBe('aBE\n')

    const rejected = await app.rejectAllSuggestions(path, 'ag_2')
    expect(rejected).toHaveLength(1)
    const stored = await storedApplication(store, path)
    expect(Object.values(stored.annotations.annotations).find((item) => item.agent === 'ag_2')).toMatchObject({ resolution: 'rejected' })
  })

  it('keeps annotation events recipient-specific and enables Send only for unsent work', async () => {
    const { app, path, store } = await fixture('The old wording stays.\n')
    await app.openDocument(path)
    for (const [agent, name] of [['ag_author', 'Author'], ['ag_peer', 'Peer']] as const) {
      await command(app, 'attach', { file: path, agent, name, timeout: 0 })
    }
    await command(app, 'annotate', {
      file: path, agent: 'ag_author',
      annotations: [{ kind: 'suggestion', quote: 'old wording', text: 'new wording' }],
    })
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await app.acceptSuggestion(path, suggestion.id)
    expect((await app.getState()).activeDocument?.canSend).toBe(true)

    const request = { recipients: ['ag_author', 'ag_peer'], note: '', includeExternal: false }
    const previews = await app.previewSend(path, request)
    expect(previews[0]?.text).toContain(`${suggestion.id} (suggestion) was accepted.`)
    expect(previews[1]?.text).not.toContain(`${suggestion.id} (suggestion) was accepted.`)
    await app.send(path, request)
    expect((await app.getState()).activeDocument?.canSend).toBe(false)

    const queued = (await storedApplication(store, path)).attachments
    const authorAnnotations = queued.ag_author?.deliveries[0]?.payload.annotations ?? []
    const peerAnnotations = queued.ag_peer?.deliveries[0]?.payload.annotations ?? []
    expect(authorAnnotations).toHaveLength(0)
    expect(queued.ag_author?.deliveries[0]?.payload.resolved).toHaveLength(1)
    expect(peerAnnotations).toHaveLength(1)
    expect(queued.ag_author?.deliveries[0]?.to.cursor).toBe(queued.ag_peer?.deliveries[0]?.to.cursor)
  })

  it('sends a later reply without the thread it belongs to, and an agent’s own reply enables nothing', async () => {
    const { app, path, store } = await fixture('The old wording stays.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.addAnnotation(path, { kind: 'comment', quote: 'old wording', text: 'Too vague.', from: 4, to: 15 })
    const annotationId = Object.keys((await storedApplication(store, path)).annotations.annotations)[0]!
    const request = { recipients: ['ag_1'], note: '', includeExternal: false }
    await app.send(path, request)
    const first = (await storedApplication(store, path)).attachments.ag_1?.deliveries[0]
    await command(app, 'ack', { file: path, agent: 'ag_1', deliveryId: first!.id })

    await command(app, 'reply', { file: path, agent: 'ag_1', annotation: annotationId, text: 'Tightened it.' })
    expect((await app.getState()).activeDocument?.canSend).toBe(false)

    await app.reply(path, annotationId, 'Shorter still, please.')
    expect((await app.getState()).activeDocument?.canSend).toBe(true)
    const [preview] = await app.previewSend(path, request)
    expect(preview?.text).toContain(`Replies:\n${annotationId} ← user: Shorter still, please.`)
    expect(preview?.text).not.toContain('Too vague.')
    expect(preview?.text).not.toContain('Tightened it.')
    expect(preview?.text).not.toContain('Annotations:')
  })

  it('counts user hunks that depend on unseen external work in the composer preview', async () => {
    const original = '# Plan\n\nShip Friday.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await store.writeBuffer(path, '# Plan\n\nShip Thursday.\n')
    await app.recheckFocused()
    await app.updateBuffer(path, '# Plan\n\nShip Thursday with checks.\n')

    const [preview] = await app.previewSend(path, {
      recipients: ['ag_1'], note: '', includeExternal: false,
    })
    expect(preview?.dependentExternalHunks).toBe(1)
  })

  it('copies annotations for the clipboard recipient and advances unsent state after success', async () => {
    let copied = ''
    const value = await fixture('A quoted sentence.\n')
    const app = await createStrataApplication({
      store: value.store,
      settingsStore: value.settingsStore,
      watch: false,
      clipboardWrite: async (text) => { copied = text },
    })
    await app.openDocument(value.path)
    await app.addAnnotation(value.path, {
      kind: 'comment', quote: 'quoted sentence', text: 'Read this.', from: 2, to: 17,
    })
    expect((await app.getState()).activeDocument?.canSend).toBe(true)
    await app.copyForAgent(value.path, '', false)
    expect(copied).toContain('comment (user): Read this.')
    expect((await app.getState()).activeDocument?.canSend).toBe(false)
  })

  it('returns only current unreviewed changes and safely clears resolved event records', async () => {
    const { app, path, store } = await fixture('Original.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await store.writeBuffer(path, 'Agent edit.\n')
    await app.recheckFocused()
    const before = await command(app, 'changes', { file: path }) as { segments?: unknown[] }
    expect(before.segments).toHaveLength(1)
    const hunk = (await app.getState()).activeDocument?.pendingHunks[0]
    expect(hunk).toBeTruthy()
    await app.keepHunk(path, hunk!.id)
    const after = await command(app, 'changes', { file: path }) as { segments?: unknown[] }
    expect(after.segments).toEqual([])

    await command(app, 'annotate', {
      file: path, agent: 'ag_1',
      annotations: [{ kind: 'suggestion', quote: 'Agent edit', text: 'Replacement' }],
    })
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations).find((item) => item.kind === 'suggestion')!
    await app.rejectSuggestion(path, suggestion.id)
    await app.clearResolvedAnnotations(path)
    await expect(app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })).resolves.toHaveLength(1)
  })

  it('undoes Accept through the application and reopens its suggestion', async () => {
    const original = 'Use old wording here.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await command(app, 'annotate', {
      file: path,
      agent: 'ag_1',
      annotations: [{ kind: 'suggestion', quote: 'old wording', text: 'new wording' }],
    })
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await app.acceptSuggestion(path, suggestion.id)
    expect((await app.getState()).activeDocument?.content).toContain('new wording')
    await expect(app.undo(path)).resolves.toBe('undone')
    expect((await app.getState()).activeDocument?.content).toBe(original)
    expect((await app.getState()).activeDocument?.annotations[0]).toMatchObject({ status: 'open' })
  })

  it('writes the canonical timeline and preserves attachment metadata at checkpoint', async () => {
    const { app, path, store } = await fixture('Original.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.updateBuffer(path, 'Changed.\n')
    const before = await store.loadMeta(path)
    expect(before.application).toBeUndefined()
    expect(before.segments[0]).toMatchObject({ id: expect.any(String), beforeBlob: expect.any(String), afterBlob: expect.any(String) })
    expect(before.snapshotBlobs).toEqual(expect.arrayContaining([before.segments[0]!.beforeBlob, before.segments[0]!.afterBlob]))
    await command(app, 'checkpoint', { file: path })
    const after = await store.loadMeta(path)
    expect(after.attachments.ag_1).toMatchObject({ id: 'ag_1', name: 'Agent' })
    expect(after.pendingHunks).toEqual([])
  })

  it('persists absolute segment indices and resyncs an old baseline after a capped-history restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-segment-offset-'))
    const path = join(root, 'history.md')
    await writeFile(path, 'zero\n')
    const dataDirectory = join(root, 'data')
    const configDirectory = join(root, 'config')
    const store = new GhostStore({ dataDirectory, segmentLimit: 2 })
    const settingsStore = new SettingsStore({ configDirectory })
    const first = await createStrataApplication({
      store,
      settingsStore,
      watch: false,
      clipboardWrite: async () => undefined,
    })
    await first.openDocument(path)
    await command(first, 'attach', {
      file: path, agent: 'ag_stale', name: 'Stale agent', timeout: 0,
    })

    for (const content of ['one\n', 'two\n', 'three\n']) {
      await first.updateBuffer(path, content)
      await first.copyForAgent(path, '', false)
    }

    const capped = await store.loadMeta(path)
    expect(capped.segmentOffset).toBe(1)
    expect(capped.segments).toHaveLength(2)
    expect(capped.attachments.ag_stale?.segmentIndex).toBe(-1)
    expect(capped.clipboardRecipient).toMatchObject({ segmentIndex: 2 })
    expect(capped.lastSentSegmentIndex).toBe(2)

    // Closing freezes the stale recipient's delivery before releasing the lock.
    // A new application/store instance must restore that exact absolute range.
    await expect(first.closeDocument(path, 'save')).resolves.toBe('closed')
    const persisted = await store.loadMeta(path)
    const queued = persisted.attachments.ag_stale?.deliveries[0] as unknown as {
      id: string
      from: { segmentIndex: number }
      to: { segmentIndex: number }
    }
    expect(queued.from.segmentIndex).toBe(-1)
    expect(queued.to.segmentIndex).toBe(2)

    const reopenedStore = new GhostStore({ dataDirectory, segmentLimit: 2 })
    const reopened = await createStrataApplication({
      store: reopenedStore,
      settingsStore: new SettingsStore({ configDirectory }),
      watch: false,
    })
    await reopened.openDocument(path)
    const resync = await command(reopened, 'attach', {
      file: path, agent: 'ag_stale', name: 'Stale agent', timeout: 0,
    }) as { event: string; deliveryId: string; document?: string }
    expect(resync).toMatchObject({
      event: 'resync',
      deliveryId: queued.id,
      document: 'three\n',
    })

    await command(reopened, 'ack', {
      file: path, agent: 'ag_stale', deliveryId: resync.deliveryId,
    })
    await reopened.updateBuffer(path, 'four\n')
    const [deliveryId] = await reopened.send(path, {
      recipients: ['ag_stale'], note: '', includeExternal: false,
    })
    const incremental = await command(reopened, 'attach', {
      file: path, agent: 'ag_stale', name: 'Stale agent', timeout: 0,
    }) as { event: string; deliveryId: string; segments?: unknown[]; document?: string }
    expect(incremental).toMatchObject({
      event: 'send',
      deliveryId,
      segments: [expect.objectContaining({ author: 'user' })],
    })
    expect(incremental.document).toBeUndefined()

    const finalMeta = await reopenedStore.loadMeta(path)
    expect(finalMeta.segmentOffset).toBe(2)
    expect(finalMeta.segments).toHaveLength(2)
    expect(finalMeta.attachments.ag_stale?.deliveries[0]).toMatchObject({
      from: { segmentIndex: 2 },
      to: { segmentIndex: 3 },
    })
  })

  it('follows an open document outside its parent and explorer roots without changing session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-fd-source-'))
    const outside = await mkdtemp(join(tmpdir(), 'stratamd-fd-outside-'))
    const path = join(root, 'source.md')
    const moved = join(outside, 'moved.md')
    await writeFile(path, '# Move\n\nFollow this session.\n')
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
    await settingsStore.update({ explorerFolders: [root] })
    const app = await createStrataApplication({ store, settingsStore, watch: false })
    await app.openDocument(path)
    await command(app, 'attach', {
      file: path, agent: 'ag_move', name: 'Moving agent', timeout: 0,
    })
    const entry = store.pathsForDocument(path).directory

    await rename(path, moved)
    await app.recheckFocused()

    const view = await app.getState()
    expect(view.tabs).toEqual([
      expect.objectContaining({ path: moved, active: true }),
    ])
    expect(view.activeDocument).toMatchObject({
      path: moved,
      attachments: [expect.objectContaining({ agent: expect.objectContaining({ id: 'ag_move' }) })],
    })
    expect(store.pathsForDocument(moved).directory).toBe(entry)
    expect(await store.loadMeta(moved)).toMatchObject({
      realpath: moved,
      attachments: { ag_move: expect.objectContaining({ id: 'ag_move' }) },
    })
    expect(await store.hasDocument(path)).toBe(false)
    expect(await trackedDescriptors(moved)).toHaveLength(1)

    await expect(app.closeDocument(moved)).resolves.toBe('closed')
    expect(await trackedDescriptors(moved)).toEqual([])
  })

  it('reopens the tracked descriptor after atomic Save and follows the saved inode when it moves', async () => {
    const value = await fixture('# Save then move\n\nOriginal.\n')
    const outside = await mkdtemp(join(tmpdir(), 'stratamd-fd-saved-outside-'))
    const moved = join(outside, 'saved-and-moved.md')
    await value.app.openDocument(value.path)
    await value.app.updateBuffer(value.path, '# Save then move\n\nEdited.\n')
    await value.app.save(value.path)
    expect(await trackedDescriptors(value.path)).toHaveLength(1)

    await rename(value.path, moved)
    await value.app.recheckFocused()

    expect((await value.app.getState()).activeDocument).toMatchObject({
      path: moved,
      content: '# Save then move\n\nEdited.\n',
      deleted: false,
    })
    expect(await value.store.loadMeta(moved)).toMatchObject({ realpath: moved })
    expect(await trackedDescriptors(value.path)).toEqual([])
    expect(await trackedDescriptors(moved)).toHaveLength(1)
    await expect(value.app.closeDocument(moved)).resolves.toBe('closed')
    expect(await trackedDescriptors(moved)).toEqual([])
  })

  it('keeps a deleted session and attachment, then tracks the inode recreated by Save', async () => {
    const original = '# Delete\n\nOriginal.\n'
    const shadow = '# Delete\n\nUnsaved shadow.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await command(app, 'attach', {
      file: path, agent: 'ag_delete', name: 'Delete agent', timeout: 0,
    })
    await app.updateBuffer(path, shadow)

    await rm(path)
    await app.recheckFocused()
    expect((await app.getState()).activeDocument).toMatchObject({
      path,
      deleted: true,
      attachments: [expect.objectContaining({ agent: expect.objectContaining({ id: 'ag_delete' }) })],
    })
    expect(await store.loadMeta(path)).toMatchObject({
      realpath: path,
      attachments: { ag_delete: expect.objectContaining({ id: 'ag_delete' }) },
    })
    expect(await trackedDescriptors(path)).toHaveLength(1)

    await app.save(path)
    expect(await readFile(path, 'utf8')).toBe(shadow)
    expect((await app.getState()).activeDocument).toMatchObject({ deleted: false })
    expect(await trackedDescriptors(path)).toHaveLength(1)
    await expect(app.closeDocument(path)).resolves.toBe('closed')
    expect(await trackedDescriptors(path)).toEqual([])
  })

  it('relocates annotations on each reopen edge without duplicating persisted events', async () => {
    const original = 'Keep this exact phrase.\n'
    const { app, path, store, settingsStore } = await fixture(original)
    await app.openDocument(path)
    await app.addAnnotation(path, {
      kind: 'comment',
      quote: 'exact phrase',
      text: 'Keep it.',
      from: original.indexOf('exact phrase'),
      to: original.indexOf('exact phrase') + 'exact phrase'.length,
    })
    const created = await storedApplication(store, path)
    const annotationId = Object.keys(created.annotations.annotations)[0]!
    expect(await app.closeDocument(path)).toBe('closed')

    await writeFile(path, 'The quoted words are gone.\n')
    const orphanApp = await createStrataApplication({ store, settingsStore, watch: false })
    await orphanApp.openDocument(path)
    const orphaned = await storedApplication(store, path)
    expect(Object.keys(orphaned.annotations.annotations)).toEqual([annotationId])
    expect(orphaned.annotations.annotations[annotationId]).toMatchObject({ status: 'orphaned' })
    expect(orphaned.annotations.events.map((event) => event.type)).toEqual(['created', 'orphaned'])
    expect(orphaned.annotations.nextSeq).toBe(3)
    expect(await orphanApp.closeDocument(path)).toBe('closed')

    await writeFile(path, `Restored ${original}`)
    const reattachApp = await createStrataApplication({ store, settingsStore, watch: false })
    await reattachApp.openDocument(path)
    const reattached = await storedApplication(store, path)
    expect(Object.keys(reattached.annotations.annotations)).toEqual([annotationId])
    expect(reattached.annotations.annotations[annotationId]).toMatchObject({ status: 'open' })
    expect(reattached.annotations.events.map((event) => event.type)).toEqual(['created', 'orphaned', 'reattached'])
    expect(reattached.annotations.nextSeq).toBe(4)
    expect(await reattachApp.closeDocument(path)).toBe('closed')

    const secondReopen = await createStrataApplication({ store, settingsStore, watch: false })
    await secondReopen.openDocument(path)
    const unchanged = await storedApplication(store, path)
    expect(unchanged.annotations.events).toEqual(reattached.annotations.events)
    expect(unchanged.annotations.nextSeq).toBe(reattached.annotations.nextSeq)
  })

  it('relocates annotations across external buffer merges once per edge', async () => {
    const original = 'Keep this exact phrase.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await app.addAnnotation(path, {
      kind: 'comment',
      quote: 'exact phrase',
      text: 'Keep it.',
      from: original.indexOf('exact phrase'),
      to: original.indexOf('exact phrase') + 'exact phrase'.length,
    })

    await store.writeBuffer(path, 'The quoted words are gone.\n')
    await app.recheckFocused()
    let log = (await storedApplication(store, path)).annotations
    expect(Object.values(log.annotations)[0]).toMatchObject({ status: 'orphaned' })
    expect(log.events.map((event) => event.type)).toEqual(['created', 'orphaned'])

    await app.recheckFocused()
    expect((await storedApplication(store, path)).annotations.events).toEqual(log.events)

    await store.writeBuffer(path, `Restored ${original}`)
    await app.recheckFocused()
    log = (await storedApplication(store, path)).annotations
    expect(Object.values(log.annotations)[0]).toMatchObject({ status: 'open' })
    expect(log.events.map((event) => event.type)).toEqual(['created', 'orphaned', 'reattached'])
  })

  it('returns closest text excerpts for online annotation failures without a partial commit', async () => {
    const content = 'First alpha target.\nSecond same phrase.\nThird same phrase.\n'
    const { app, path, store } = await fixture(content)
    await app.openDocument(path)

    await expect(command(app, 'annotate', {
      file: path,
      agent: 'ag_1',
      annotations: [
        { kind: 'comment', quote: 'First', text: 'Valid.' },
        { kind: 'question', quote: 'alpha missing', text: 'Missing?' },
        { kind: 'comment', quote: 'same phrase', text: 'Ambiguous.' },
      ],
    })).rejects.toMatchObject({
      exitCode: 3,
      code: 'QUOTE_INVALID',
      detail: [
        expect.objectContaining({
          index: 1,
          matches: expect.arrayContaining([expect.stringContaining('First alpha target.')]),
        }),
        expect.objectContaining({
          index: 2,
          matches: expect.arrayContaining([expect.stringContaining('same phrase')]),
        }),
      ],
    })
    const stored = await storedApplication(store, path)
    expect(stored.annotations.annotations).toEqual({})
    expect(stored.annotations.events).toEqual([])
    expect(stored.annotations.nextSeq).toBe(1)
  })

  it('prefers canonical annotations over an equal-sequence legacy copy', async () => {
    const { app, path, store, settingsStore } = await fixture('Canonical quote.\n')
    await app.openDocument(path)
    await app.addAnnotation(path, {
      kind: 'comment', quote: 'Canonical', text: 'Current.', from: 0, to: 9,
    })
    const canonical = (await storedApplication(store, path)).annotations
    expect(await app.closeDocument(path)).toBe('closed')

    const meta = await store.loadMeta(path)
    await store.saveMeta({
      ...meta,
      application: {
        annotations: { nextSeq: canonical.nextSeq, annotations: {}, events: [] },
      },
    })
    const reopened = await createStrataApplication({ store, settingsStore, watch: false })
    await reopened.openDocument(path)
    expect((await storedApplication(store, path)).annotations).toEqual(canonical)
    expect((await store.loadMeta(path)).application).toBeUndefined()
  })

  it('reads legacy annotations from closed state without rewriting metadata', async () => {
    const { app, path, store } = await fixture('Legacy quote.\n')
    const meta = await store.createDocument(path, 'Legacy quote.\n')
    const legacy = createAnnotation(createAnnotationLog(), 'Legacy quote.\n', {
      id: 'a_legacy', kind: 'comment', author: 'user', quote: 'Legacy', text: 'Stored.',
    }).log
    await store.saveMeta({ ...meta, application: { annotations: legacy } })
    const metaPath = store.pathsForDocument(path).meta
    const before = await readFile(metaPath, 'utf8')

    const payload = await command(app, 'state', { file: path }) as { annotations?: Array<{ id: string }> }
    expect(payload.annotations).toEqual([expect.objectContaining({ id: 'a_legacy' })])
    expect(await readFile(metaPath, 'utf8')).toBe(before)
  })

  it('uses a newer recovery buffer for the active snapshot and first attach', async () => {
    const original = '# Recovery\n\nSaved.\n'
    const recovered = '# Recovery\n\nUnsaved buffer.\n'
    const { app, path, store } = await fixture(original)
    await store.createDocument(path, original)
    await store.writeBuffer(path, recovered)

    await app.openDocument(path)
    expect((await app.getState()).activeDocument).toMatchObject({ content: recovered })
    const initial = await command(app, 'attach', {
      file: path, agent: 'ag_1', name: 'Agent', timeout: 0,
    }) as { event: string; document?: string; buffer: string }
    expect(initial).toMatchObject({ event: 'initial', document: recovered })
    expect(await readFile(initial.buffer, 'utf8')).toBe(initial.document)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('keeps resolved records until every attachment and clipboard cursor has received them when retention is off', async () => {
    const value = await fixture('A quoted sentence.\n')
    await value.settingsStore.update({ keepResolvedAnnotations: false })
    const app = await createStrataApplication({
      store: value.store,
      settingsStore: value.settingsStore,
      watch: false,
      clipboardWrite: async () => undefined,
    })
    await app.openDocument(value.path)
    await app.addAnnotation(value.path, {
      kind: 'comment', quote: 'quoted sentence', text: 'Read this.', from: 2, to: 17,
    })
    const annotation = Object.values((await storedApplication(value.store, value.path)).annotations.annotations)[0]!
    for (const [agent, name] of [['ag_1', 'One'], ['ag_2', 'Two']] as const) {
      await command(app, 'attach', { file: value.path, agent, name, timeout: 0 })
    }

    await app.resolveAnnotation(value.path, annotation.id)
    let stored = await storedApplication(value.store, value.path)
    expect(stored.annotations.annotations[annotation.id]).toMatchObject({ status: 'resolved' })
    expect(stored.annotations.events.map((event) => event.type)).toEqual(['created', 'resolved'])

    const deliveries = await app.send(value.path, {
      recipients: ['ag_1', 'ag_2'], note: '', includeExternal: false,
    })
    stored = await storedApplication(value.store, value.path)
    expect(stored.attachments.ag_1?.deliveries[0]?.payload.resolved).toEqual([
      expect.objectContaining({ id: annotation.id, resolution: 'resolved' }),
    ])

    await command(app, 'ack', { file: value.path, agent: 'ag_1', deliveryId: deliveries[0] })
    await app.copyForAgent(value.path, '', false)
    stored = await storedApplication(value.store, value.path)
    expect(stored.annotations.annotations[annotation.id]).toBeDefined()
    expect(stored.annotations.events).toHaveLength(2)

    await command(app, 'ack', { file: value.path, agent: 'ag_2', deliveryId: deliveries[1] })
    stored = await storedApplication(value.store, value.path)
    expect(stored.annotations.annotations[annotation.id]).toBeUndefined()
    expect(stored.annotations.events).toEqual([])
    expect(stored.annotations.nextSeq).toBe(3)
  })

  it('retains resolved records after delivery when retention is on until explicit Clear', async () => {
    const value = await fixture('A quoted sentence.\n')
    await value.settingsStore.update({ keepResolvedAnnotations: true })
    const app = await createStrataApplication({
      store: value.store,
      settingsStore: value.settingsStore,
      watch: false,
      clipboardWrite: async () => undefined,
    })
    await app.openDocument(value.path)
    await app.addAnnotation(value.path, {
      kind: 'comment', quote: 'quoted sentence', text: 'Read this.', from: 2, to: 17,
    })
    const annotation = Object.values((await storedApplication(value.store, value.path)).annotations.annotations)[0]!
    await command(app, 'attach', { file: value.path, agent: 'ag_1', name: 'One', timeout: 0 })
    await app.resolveAnnotation(value.path, annotation.id)
    const [deliveryId] = await app.send(value.path, {
      recipients: ['ag_1'], note: '', includeExternal: false,
    })
    await command(app, 'ack', { file: value.path, agent: 'ag_1', deliveryId })
    await app.copyForAgent(value.path, '', false)

    expect((await storedApplication(value.store, value.path)).annotations.annotations[annotation.id]).toBeDefined()
    await app.clearResolvedAnnotations(value.path)
    expect((await storedApplication(value.store, value.path)).annotations.annotations[annotation.id]).toBeUndefined()
  })
})

interface MessagePayload {
  event: string
  deliveryId: string
  from?: { agent: string; name: string }
  notes?: string[]
  text?: string
}

describe('agent-to-agent messages', () => {
  async function attachedPair(content = '# Plan\n\nOriginal.\n') {
    const value = await fixture(content)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_a', name: 'Agent A', timeout: 0 })
    await command(value.app, 'attach', { file: value.path, agent: 'ag_b', name: 'Agent B', timeout: 0 })
    return value
  }

  async function waitForState(app: StrataApplication, agent: string, state: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const view = await app.getState()
      if (view.activeDocument?.attachments.find((item) => item.agent.id === agent)?.state === state) {
        // The panel shows `waiting` from the session state, which is published a
        // moment before the blocked call finishes registering its waker.
        await new Promise((resolve) => setTimeout(resolve, 100))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Attachment ${agent} never reached ${state}`)
  }

  it('wakes a blocked attach immediately and shows the recipient pending while queued', async () => {
    const { app, path } = await attachedPair()
    const blocked = command(app, 'attach', { file: path, agent: 'ag_b', name: 'Agent B', timeout: 10 })
    await waitForState(app, 'ag_b', 'waiting')

    const sent = await command(app, 'send', { file: path, agent: 'ag_a', text: 'Ready for review.' }) as { sent: unknown[] }
    expect(sent.sent).toEqual([{ agent: 'ag_b', name: 'Agent B' }])
    const payload = await blocked as MessagePayload
    expect(payload).toMatchObject({
      event: 'message',
      from: { agent: 'ag_a', name: 'Agent A' },
      notes: ['Ready for review.'],
    })
    expect(payload.text).toContain('Message from Agent A (ag_a):')
  })

  it('queues for a working recipient, shows pending in the panel, and arrives on the next attach', async () => {
    const { app, path } = await attachedPair()
    await command(app, 'send', { file: path, agent: 'ag_a', text: 'Knock knock.' })
    const view = await app.getState()
    expect(view.activeDocument?.attachments.find((item) => item.agent.id === 'ag_b')?.state).toBe('pending')

    const payload = await command(app, 'attach', { file: path, agent: 'ag_b', name: 'Agent B', timeout: 0 }) as MessagePayload
    expect(payload).toMatchObject({ event: 'message', notes: ['Knock knock.'] })
  })

  it('survives a restart and repeats with the same id until acknowledged', async () => {
    const value = await attachedPair()
    await command(value.app, 'send', { file: value.path, agent: 'ag_a', text: 'Persist me.' })
    await expect(value.app.closeDocument(value.path)).resolves.toBe('closed')
    await value.app.shutdown()

    const reopened = await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false })
    await reopened.openDocument(value.path)
    const first = await command(reopened, 'attach', { file: value.path, agent: 'ag_b', name: 'Agent B', timeout: 0 }) as MessagePayload
    expect(first).toMatchObject({ event: 'message', notes: ['Persist me.'], from: { agent: 'ag_a' } })
    const again = await command(reopened, 'attach', { file: value.path, agent: 'ag_b', name: 'Agent B', timeout: 0 }) as MessagePayload
    expect(again.deliveryId).toBe(first.deliveryId)
    await command(reopened, 'ack', { file: value.path, agent: 'ag_b', deliveryId: first.deliveryId })
  })

  it('allows one unacknowledged message per sender→recipient pair', async () => {
    const { app, path } = await attachedPair()
    await command(app, 'send', { file: path, agent: 'ag_a', text: 'First.' })
    await expect(command(app, 'send', { file: path, agent: 'ag_a', text: 'Second.' })).rejects.toMatchObject({
      exitCode: 3,
      code: 'MESSAGE_PENDING',
      detail: { recipient: 'ag_b' },
    })
    // A different sender to the same recipient is not blocked; only the pair is.
    await command(app, 'attach', { file: path, agent: 'ag_c', name: 'Agent C', timeout: 0 })
    await command(app, 'send', { file: path, agent: 'ag_c', text: 'Other sender.', to: ['ag_b'] })

    const collected = await command(app, 'attach', { file: path, agent: 'ag_b', name: 'Agent B', timeout: 0 }) as MessagePayload
    await command(app, 'ack', { file: path, agent: 'ag_b', deliveryId: collected.deliveryId })
    await expect(command(app, 'send', { file: path, agent: 'ag_a', text: 'Second try.' })).resolves.toBeTruthy()
  })

  it('treats a multi-recipient send as all-or-nothing and enqueues nothing on failure', async () => {
    const { app, path, store } = await attachedPair()
    for (const [agent, name] of [['ag_c', 'Agent C'], ['ag_d', 'Agent D']] as const) {
      await command(app, 'attach', { file: path, agent, name, timeout: 0 })
    }
    await command(app, 'send', { file: path, agent: 'ag_a', text: 'Block one pair.', to: ['ag_d'] })
    const before = await storedApplication(store, path)

    await expect(command(app, 'send', {
      file: path, agent: 'ag_a', text: 'Broadcast.', to: ['ag_b', 'ag_c', 'ag_d'],
    })).rejects.toMatchObject({ exitCode: 3, code: 'MESSAGE_PENDING', detail: { recipient: 'ag_d' } })

    const after = await storedApplication(store, path)
    for (const agent of ['ag_b', 'ag_c', 'ag_d']) {
      expect(after.attachments[agent]?.deliveries.length).toBe(before.attachments[agent]?.deliveries.length)
    }
  })

  it('rejects self-addressed sends, unattached recipients, and sends with no other agents', async () => {
    const { app, path } = await attachedPair()
    await expect(command(app, 'send', { file: path, agent: 'ag_a', text: 'Hi me.', to: ['ag_a'] }))
      .rejects.toMatchObject({ exitCode: 2 })
    await expect(command(app, 'send', { file: path, agent: 'ag_a', text: 'Hi ghost.', to: ['ag_missing'] }))
      .rejects.toMatchObject({ exitCode: 2, code: 'ATTACHMENT_NOT_FOUND' })
    await expect(command(app, 'send', { file: path, agent: 'ag_nobody', text: 'Hi.' }))
      .rejects.toMatchObject({ exitCode: 2, code: 'ATTACHMENT_NOT_FOUND' })

    const lonely = await fixture('# Lonely\n\nOne agent.\n')
    await lonely.app.openDocument(lonely.path)
    await command(lonely.app, 'attach', { file: lonely.path, agent: 'ag_solo', name: 'Solo', timeout: 0 })
    await expect(command(lonely.app, 'send', { file: lonely.path, agent: 'ag_solo', text: 'Anyone?' }))
      .rejects.toMatchObject({ exitCode: 2, code: 'NO_RECIPIENTS' })
  })

  it('changes no user review state across a message round-trip', async () => {
    const { app, path, store } = await attachedPair()
    const before = await store.loadMeta(path)
    expect((await app.getState()).activeDocument?.canSend).toBe(false)

    await command(app, 'send', { file: path, agent: 'ag_a', text: 'Nothing moves.' })
    const collected = await command(app, 'attach', { file: path, agent: 'ag_b', name: 'Agent B', timeout: 0 }) as MessagePayload
    await command(app, 'ack', { file: path, agent: 'ag_b', deliveryId: collected.deliveryId })

    const after = await store.loadMeta(path)
    expect((await app.getState()).activeDocument?.canSend).toBe(false)
    await expect(app.undo(path)).resolves.toBe('empty')
    expect(after.lastSentSegmentIndex).toBe(before.lastSentSegmentIndex)
    expect(after.lastSentAnnotationSeq).toBe(before.lastSentAnnotationSeq)
    expect(after.attachments.ag_b).toMatchObject({
      baselineBlob: before.attachments.ag_b!.baselineBlob,
      segmentIndex: before.attachments.ag_b!.segmentIndex,
      cursor: before.attachments.ag_b!.cursor,
    })
  })

  it('expires an attachment holding only a message on the live timer while a Send delivery holds another open', async () => {
    const value = await fixture()
    await value.settingsStore.update({ attachmentIdleTimeoutMs: 150 })
    const app = await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false })
    await app.openDocument(value.path)
    for (const [agent, name] of [['ag_a', 'A'], ['ag_b', 'B'], ['ag_c', 'C']] as const) {
      await command(app, 'attach', { file: value.path, agent, name, timeout: 0 })
    }
    await command(app, 'send', { file: value.path, agent: 'ag_a', text: 'Only a note.', to: ['ag_b'] })
    await app.updateBuffer(value.path, '# Plan\n\nEdited.\n')
    await app.send(value.path, { recipients: ['ag_c'], note: '', includeExternal: false })

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const view = await app.getState()
      const ids = view.activeDocument?.attachments.map((item) => item.agent.id) ?? []
      if (!ids.includes('ag_b')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const remaining = (await app.getState()).activeDocument?.attachments.map((item) => item.agent.id) ?? []
    expect(remaining).not.toContain('ag_b')
    expect(remaining).toContain('ag_c')
  })
})

describe('the Lead agent', () => {
  async function leadFixture(content = 'Use the old wording here.\n') {
    const value = await fixture(content)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_lead', name: 'Lead Agent', timeout: 0 })
    await command(value.app, 'attach', { file: value.path, agent: 'ag_peer', name: 'Peer', timeout: 0 })
    return value
  }

  it('grants a claim, denies the second naming the holder, and lets the user transfer and revoke', async () => {
    const { app, path } = await leadFixture()
    await expect(command(app, 'lead', { file: path, agent: 'ag_lead' })).resolves.toEqual({ lead: 'ag_lead' })
    expect((await app.getState()).activeDocument?.leadAgentId).toBe('ag_lead')
    // Re-claiming what you already hold is not a denial.
    await expect(command(app, 'lead', { file: path, agent: 'ag_lead' })).resolves.toEqual({ lead: 'ag_lead' })

    await expect(command(app, 'lead', { file: path, agent: 'ag_peer' })).rejects.toMatchObject({
      exitCode: 3,
      code: 'LEAD_TAKEN',
      detail: { holder: { agent: 'ag_lead', name: 'Lead Agent' } },
    })

    await app.setLead(path, 'ag_peer')
    expect((await app.getState()).activeDocument?.leadAgentId).toBe('ag_peer')
    await app.setLead(path, null)
    expect((await app.getState()).activeDocument?.leadAgentId).toBeNull()
    await expect(command(app, 'lead', { file: path, agent: 'ag_peer' })).resolves.toEqual({ lead: 'ag_peer' })
  })

  it('dies with its attachment on detach and on disconnect', async () => {
    const { app, path } = await leadFixture()
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await command(app, 'detach', { file: path, agent: 'ag_lead' })
    expect((await app.getState()).activeDocument?.leadAgentId).toBeNull()

    await command(app, 'attach', { file: path, agent: 'ag_lead', name: 'Lead Agent', timeout: 0 })
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await app.disconnectAgent(path, 'ag_lead')
    expect((await app.getState()).activeDocument?.leadAgentId).toBeNull()
    await expect(command(app, 'lead', { file: path, agent: 'ag_peer' })).resolves.toEqual({ lead: 'ag_peer' })
  })

  it('restores as null after a restart that expires the holder, and a fresh claim succeeds', async () => {
    const value = await leadFixture()
    await command(value.app, 'lead', { file: value.path, agent: 'ag_lead' })
    expect((await value.store.loadMeta(value.path)).leadAgentId).toBe('ag_lead')
    await expect(value.app.closeDocument(value.path)).resolves.toBe('closed')
    await value.app.shutdown()

    // Both attachments have queued `closed` deliveries and would never expire;
    // drop the holder's queue so only idle time decides.
    const meta = await value.store.loadMeta(value.path)
    await value.store.saveMeta({
      ...meta,
      attachments: Object.fromEntries(Object.entries(meta.attachments).map(([id, attachment]) => [
        id,
        { ...attachment, deliveries: [], lastCallAt: 0, attachedAt: 0 },
      ])),
    })
    await value.settingsStore.update({ attachmentIdleTimeoutMs: 1 })
    const reopened = await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false })
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.attachments).toEqual([])
    expect((await reopened.getState()).activeDocument?.leadAgentId).toBeNull()
    expect((await value.store.loadMeta(value.path)).leadAgentId).toBeNull()

    await command(reopened, 'attach', { file: value.path, agent: 'ag_new', name: 'New', timeout: 0 })
    await expect(command(reopened, 'lead', { file: value.path, agent: 'ag_new' })).resolves.toEqual({ lead: 'ag_new' })
  })

  it('gates accept, reject, resolve on others\' annotations, and save behind the Lead', async () => {
    const { app, path, store } = await leadFixture()
    await command(app, 'annotate', {
      file: path, agent: 'ag_lead',
      annotations: [{ kind: 'suggestion', quote: 'old wording', text: 'new wording' }],
    })
    await app.addAnnotation(path, { kind: 'comment', quote: 'here', text: 'User note.', from: 20, to: 24 })
    const stored = await storedApplication(store, path)
    const suggestion = Object.values(stored.annotations.annotations).find((item) => item.kind === 'suggestion')!
    const comment = Object.values(stored.annotations.annotations).find((item) => item.kind === 'comment')!

    for (const verb of ['accept', 'reject', 'resolve'] as const) {
      await expect(command(app, verb, { file: path, agent: 'ag_peer', annotation: verb === 'resolve' ? comment.id : suggestion.id }))
        .rejects.toMatchObject({ exitCode: 3, code: 'NOT_LEAD' })
    }
    await expect(command(app, 'save', { file: path, agent: 'ag_peer' }))
      .rejects.toMatchObject({ exitCode: 3, code: 'NOT_LEAD' })

    // Any agent may resolve annotations it authored, without the Lead.
    await expect(command(app, 'resolve', { file: path, agent: 'ag_lead', annotation: suggestion.id }))
      .resolves.toEqual({ resolved: suggestion.id })
  })

  it('accepts and saves as the Lead: external authorship, a surviving pending hunk, and routed events', async () => {
    const original = 'Use the old wording here.\n'
    const { app, path, store } = await leadFixture(original)
    await command(app, 'attach', { file: path, agent: 'ag_third', name: 'Third', timeout: 0 })
    await command(app, 'annotate', {
      file: path, agent: 'ag_peer',
      annotations: [{ kind: 'suggestion', quote: 'old wording', text: 'new wording' }],
    })
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await command(app, 'accept', { file: path, agent: 'ag_lead', annotation: suggestion.id })

    let document = (await app.getState()).activeDocument!
    expect(document.content).toBe('Use the new wording here.\n')
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({
      author: expect.objectContaining({ id: 'ag_lead', name: 'Lead Agent' }),
      saved: false,
    })
    expect(await readFile(path, 'utf8')).toBe(original)

    await expect(command(app, 'save', { file: path, agent: 'ag_lead' })).resolves.toEqual({ saved: true })
    expect(await readFile(path, 'utf8')).toBe('Use the new wording here.\n')
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({
      author: expect.objectContaining({ id: 'ag_lead' }),
      saved: true,
    })

    // Other agents see the change only as an external segment, only when included.
    const included = await app.previewSend(path, { recipients: ['ag_third'], note: '', includeExternal: true })
    expect(included[0]?.text).toContain('Changes by Lead Agent (ag_lead):')
    expect(included[0]?.text).toContain('+Use the new wording here.')

    // The suggestion's author receives `accepted`; the Lead's own delivery does not carry it.
    await app.send(path, { recipients: ['ag_lead', 'ag_peer', 'ag_third'], note: '', includeExternal: false })
    const queued = (await storedApplication(store, path)).attachments
    expect(queued.ag_peer?.deliveries.at(-1)?.payload.resolved).toEqual([
      expect.objectContaining({ id: suggestion.id, resolution: 'accepted' }),
    ])
    expect(queued.ag_lead?.deliveries.at(-1)?.payload.resolved ?? []).toEqual([])
    expect(queued.ag_third?.deliveries.at(-1)?.payload.segments ?? []).toEqual([])

    // Revert removes the text while the annotation log keeps the accept: two records, two actors.
    const hunkId = document.pendingHunks[0]!.id
    await app.revertHunk(path, hunkId)
    document = (await app.getState()).activeDocument!
    expect(document.content).toBe(original)
    expect(document.dirty).toBe(true)
    const log = (await storedApplication(store, path)).annotations
    expect(log.annotations[suggestion.id]).toMatchObject({ status: 'resolved', resolution: 'accepted' })
  })

  it('rejects as the Lead with the Lead recorded as the event actor', async () => {
    const { app, path, store } = await leadFixture()
    await command(app, 'annotate', {
      file: path, agent: 'ag_peer',
      annotations: [{ kind: 'suggestion', quote: 'old wording', text: 'new wording' }],
    })
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await command(app, 'reject', { file: path, agent: 'ag_lead', annotation: suggestion.id })

    const log = (await storedApplication(store, path)).annotations
    expect(log.annotations[suggestion.id]).toMatchObject({ status: 'resolved', resolution: 'rejected' })
    const event = log.events.find((item) => item.type === 'rejected')!
    expect(event).toMatchObject({ author: 'agent', agent: 'ag_lead' })
    expect((await app.getState()).activeDocument?.content).toBe('Use the old wording here.\n')
  })

  it('fails a Lead save against a disk conflict with SAVE_BLOCKED and changes nothing', async () => {
    const { app, path } = await leadFixture('# Save\n\nOriginal.\n')
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await app.updateBuffer(path, '# Save\n\nMine.\n')
    await writeFile(path, '# Save\n\nRaced.\n')

    await expect(command(app, 'save', { file: path, agent: 'ag_lead' }))
      .rejects.toMatchObject({ exitCode: 3, code: 'SAVE_BLOCKED' })
    expect(await readFile(path, 'utf8')).toBe('# Save\n\nRaced.\n')
    expect((await app.getState()).activeDocument?.content).toBe('# Save\n\nMine.\n')
  })

  it('lists attachments with state and lead in the state payload, omitted for closed documents', async () => {
    const { app, path } = await leadFixture()
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await command(app, 'send', { file: path, agent: 'ag_peer', text: 'One update.', to: ['ag_lead'] })

    const open = await command(app, 'state', { file: path }) as { attachments?: unknown[] }
    expect(open.attachments).toEqual([
      { agent: 'ag_lead', name: 'Lead Agent', state: 'pending', lead: true },
      { agent: 'ag_peer', name: 'Peer', state: 'working', lead: false },
    ])

    await expect(app.closeDocument(path)).resolves.toBe('closed')
    const closed = await command(app, 'state', { file: path }) as { attachments?: unknown[] }
    expect(closed.attachments).toBeUndefined()
  })
})

describe('save-state classification', () => {
  it('classifies each pending hunk against the file, including the mixed case', async () => {
    const { app, path, store } = await fixture('# Plan\n\nOriginal.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_a', name: 'A', timeout: 0 })

    await store.writeBuffer(path, '# Plan\n\nOriginal.\n\nFirst agent line.\n')
    await app.recheckFocused()
    let document = (await app.getState()).activeDocument!
    expect(document.pendingHunks.map((hunk) => hunk.saved)).toEqual([false])
    expect(document.dirty).toBe(true)

    await app.save(path)
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks.map((hunk) => hunk.saved)).toEqual([true])
    expect(document.dirty).toBe(false)

    // One saved and one fresh agent edit classify independently.
    await store.writeBuffer(path, '# Plan the second\n\nOriginal.\n\nFirst agent line.\n')
    await app.recheckFocused()
    document = (await app.getState()).activeDocument!
    const saved = document.pendingHunks.map((hunk) => hunk.saved).sort()
    expect(saved).toEqual([false, true])

    // Reverting a saved hunk restores text the file does not have: unsaved again.
    await app.save(path)
    const target = (await app.getState()).activeDocument!.pendingHunks[0]!
    await app.revertHunk(path, target.id)
    expect((await app.getState()).activeDocument!.dirty).toBe(true)
  })
})

describe('application undo and redo', () => {
  async function keptFixture(content = '# Plan\n\nOriginal.\n', proposal = '# Plan\n\nOriginal.\n\nAgent line.\n') {
    const value = await fixture(content)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await value.store.writeBuffer(value.path, proposal)
    await value.app.recheckFocused()
    const hunk = (await value.app.getState()).activeDocument?.pendingHunks[0]
    expect(hunk).toBeTruthy()
    return { ...value, hunkId: hunk!.id, proposal }
  }

  it('reverses and replays a Keep, counting only the Keep as a step', async () => {
    const { app, path, hunkId } = await keptFixture()
    const stepBefore = (await app.getState()).activeDocument!.historyStep
    await app.keepHunk(path, hunkId)
    let document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(0)
    expect(document.historyStep).toBe(stepBefore + 1)

    await expect(app.undo(path)).resolves.toBe('undone')
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks.map((hunk) => hunk.id)).toEqual([hunkId])
    expect(document.historyStep).toBe(stepBefore + 1)

    await expect(app.redo(path)).resolves.toBe('redone')
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(0)
    expect(document.historyStep).toBe(stepBefore + 1)
  })

  it('records nothing for a Keep that fails on a stale id', async () => {
    const { app, path } = await keptFixture()
    const stepBefore = (await app.getState()).activeDocument!.historyStep
    await expect(app.keepHunk(path, 'pending-999')).rejects.toThrow()
    expect((await app.getState()).activeDocument!.historyStep).toBe(stepBefore)
    // Only the merge that seeded the fixture is on the stack; the failed Keep left nothing.
    await expect(app.undo(path)).resolves.toBe('undone')
    expect((await app.getState()).activeDocument!.pendingHunks).toHaveLength(0)
    await expect(app.undo(path)).resolves.toBe('empty')
  })

  it('undoing an Accept reopens the suggestion and leaves a later comment and nextSeq alone', async () => {
    const original = 'Use old wording here. Later note.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await command(app, 'annotate', {
      file: path, agent: 'ag_1',
      annotations: [{ kind: 'suggestion', quote: 'old wording', text: 'new wording' }],
    })
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await app.acceptSuggestion(path, suggestion.id)
    const accepted = (await app.getState()).activeDocument!.content
    await app.addAnnotation(path, {
      kind: 'comment', quote: 'Later note', text: 'Keep this.',
      from: accepted.indexOf('Later note'), to: accepted.indexOf('Later note') + 'Later note'.length,
    })
    const seqBefore = (await storedApplication(store, path)).annotations.nextSeq

    await expect(app.undo(path)).resolves.toBe('undone')
    const document = (await app.getState()).activeDocument!
    expect(document.content).toBe(original)
    const log = (await storedApplication(store, path)).annotations
    expect(log.annotations[suggestion.id]).toMatchObject({ status: 'open' })
    const comment = Object.values(log.annotations).find((item) => item.kind === 'comment')!
    expect(comment).toMatchObject({ text: 'Keep this.', quote: 'Later note' })
    expect(log.events.some((event) => event.type === 'accepted')).toBe(false)
    expect(log.events.some((event) => !isHunkVerdict(event) && event.annotationId === comment.id)).toBe(true)
    expect(log.nextSeq).toBe(seqBefore)
    const previews = await app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })
    expect(previews[0]?.text).not.toContain('was accepted')
    expect(previews[0]?.text).not.toContain('new wording')
  })

  it('reverses an external merge as a user hunk and replays it with its pending hunk', async () => {
    const { app, path, store, hunkId, proposal } = await keptFixture()
    const original = '# Plan\n\nOriginal.\n'
    await expect(app.undo(path)).resolves.toBe('undone')
    let document = (await app.getState()).activeDocument!
    expect(document.content).toBe(original)
    expect(document.pendingHunks).toHaveLength(0)
    const previews = await app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })
    expect(previews[0]?.text).toContain('-Agent line.')
    expect((await storedApplication(store, path)).state.shadow).toBe(original)

    await expect(app.redo(path)).resolves.toBe('redone')
    document = (await app.getState()).activeDocument!
    expect(document.content).toBe(proposal)
    expect(document.pendingHunks.map((hunk) => hunk.id)).toEqual([hunkId])
  })

  it('Save, Send, and Copy for agent end the application history', async () => {
    for (const boundary of ['save', 'send', 'copy'] as const) {
      let copied = ''
      const value = await fixture()
      const app = boundary === 'copy'
        ? await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false, clipboardWrite: async (text) => { copied = text } })
        : value.app
      const { path, store } = value
      await app.openDocument(path)
      await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
      await store.writeBuffer(path, '# Plan\n\nOriginal.\n\nAgent line.\n')
      await app.recheckFocused()
      const hunkId = (await app.getState()).activeDocument!.pendingHunks[0]!.id
      await app.keepHunk(path, hunkId)
      if (boundary === 'save') await app.save(path)
      else if (boundary === 'send') await app.send(path, { recipients: ['ag_1'], note: '', includeExternal: false })
      else await app.copyForAgent(path, '', false)
      if (boundary === 'copy') expect(copied).not.toBe('')
      await expect(app.undo(path)).resolves.toBe('empty')
      expect((await app.getState()).activeDocument!.pendingHunks).toHaveLength(0)
    }
  })

  it('keeps redo across history replay and clears it on a new edit', async () => {
    const { app, path, hunkId } = await keptFixture()
    await app.keepHunk(path, hunkId)
    await expect(app.undo(path)).resolves.toBe('undone')
    const content = (await app.getState()).activeDocument!.content
    await app.updateBuffer(path, `${content}Replayed.\n`, 'history')
    await expect(app.redo(path)).resolves.toBe('redone')
    await expect(app.undo(path)).resolves.toBe('undone')
    await app.updateBuffer(path, `${content}Replayed.\nTyped.\n`, 'edit')
    await expect(app.redo(path)).resolves.toBe('empty')
  })

  it('clears redo on every user annotation mutation', async () => {
    const mutations: Array<[string, (app: StrataApplication, path: string, ids: { comment: string; suggestion: string; quote: { from: number; to: number } }) => Promise<unknown>]> = [
      ['addAnnotation', (app, path, ids) => app.addAnnotation(path, { kind: 'comment', quote: 'Original', text: 'Hi', ...ids.quote })],
      ['reply', (app, path, ids) => app.reply(path, ids.comment, 'Reply')],
      ['resolveAnnotation', (app, path, ids) => app.resolveAnnotation(path, ids.comment)],
      ['rejectSuggestion', (app, path, ids) => app.rejectSuggestion(path, ids.suggestion)],
      ['rejectAllSuggestions', (app, path) => app.rejectAllSuggestions(path, 'ag_1')],
      ['clearResolvedAnnotations', (app, path) => app.clearResolvedAnnotations(path)],
    ]
    for (const [name, mutate] of mutations) {
      const { app, path, store, hunkId } = await keptFixture()
      await command(app, 'annotate', {
        file: path, agent: 'ag_1',
        annotations: [
          { kind: 'comment', quote: 'Agent line', text: 'Why?' },
          { kind: 'suggestion', quote: 'Agent line', text: 'Agent sentence' },
        ],
      })
      const log = (await storedApplication(store, path)).annotations
      const ids = {
        comment: Object.values(log.annotations).find((item) => item.kind === 'comment')!.id,
        suggestion: Object.values(log.annotations).find((item) => item.kind === 'suggestion')!.id,
        quote: { from: '# Plan\n\n'.length, to: '# Plan\n\nOriginal'.length },
      }
      await app.keepHunk(path, hunkId)
      await expect(app.undo(path)).resolves.toBe('undone')
      await mutate(app, path, ids)
      await expect(app.redo(path), name).resolves.toBe('empty')
    }
  })

  it('undo and redo on empty stacks change nothing', async () => {
    const { app, path } = await fixture()
    await app.openDocument(path)
    const before = (await app.getState()).activeDocument!
    await expect(app.undo(path)).resolves.toBe('empty')
    await expect(app.redo(path)).resolves.toBe('empty')
    expect((await app.getState()).activeDocument).toEqual(before)
  })
})

describe('send composer semantics', () => {
  async function revertedFixture() {
    const value = await fixture()
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_a', name: 'Agent A', timeout: 0 })
    await command(value.app, 'attach', { file: value.path, agent: 'ag_b', name: 'Agent B', timeout: 0 })
    await command(value.app, 'changed', { file: value.path, agent: 'ag_a', name: 'Agent A' })
    await value.store.writeBuffer(value.path, '# Plan\n\nOriginal.\n\nAgent line.\n')
    await value.app.recheckFocused()
    const hunk = (await value.app.getState()).activeDocument!.pendingHunks[0]!
    await value.app.revertHunk(value.path, hunk.id)
    return value
  }

  it('a reverted hunk reaches others as a user diff and its author as a verdict', async () => {
    const { app, path } = await revertedFixture()
    const request = { recipients: ['ag_a', 'ag_b'], note: '', includeExternal: false }
    const previews = await app.previewSend(path, request)

    const author = previews.find((preview) => preview.recipient.id === 'ag_a')!
    expect(author.text).toContain('Your change was reverted: Agent line.')
    expect(author.text).not.toContain('Changes by user:')

    const peer = previews.find((preview) => preview.recipient.id === 'ag_b')!
    expect(peer.text).toContain('Changes by user:')
    expect(peer.text).not.toContain('Your change was reverted')
  })

  it('undoing the Revert retracts the verdict before it is delivered', async () => {
    const { app, path } = await revertedFixture()
    await expect(app.undo(path)).resolves.toBe('undone')
    const [author] = await app.previewSend(path, { recipients: ['ag_a'], note: '', includeExternal: false })
    expect(author!.text).not.toContain('Your change was reverted')
  })

  it('with only the author attached, Send delivers the verdict and no diff, then goes quiet', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_a', name: 'Agent A', timeout: 0 })
    await command(app, 'changed', { file: path, agent: 'ag_a', name: 'Agent A' })
    await store.writeBuffer(path, '# Plan\n\nOriginal.\n\nAgent line.\n')
    await app.recheckFocused()
    const hunk = (await app.getState()).activeDocument!.pendingHunks[0]!
    await app.revertHunk(path, hunk.id)

    // The pending verdict for the author is deliverable content, so Send stays enabled.
    expect((await app.getState()).activeDocument!.canSend).toBe(true)
    await app.send(path, { recipients: ['ag_a'], note: '', includeExternal: false })
    const delivery = (await storedApplication(store, path)).attachments.ag_a!.deliveries[0]!
    expect(delivery.payload.segments).toEqual([])
    expect(delivery.payload.edits).toEqual([
      { seq: delivery.payload.edits![0]!.seq, verdict: 'reverted', quote: 'Agent line.' },
    ])

    await command(app, 'ack', { file: path, agent: 'ag_a', deliveryId: delivery.id })
    expect((await app.getState()).activeDocument!.canSend).toBe(false)
  })

  it('a stale preview token fails the send; a fresh preview sends', async () => {
    const { app, path } = await fixture()
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.updateBuffer(path, '# Plan\n\nOriginal. First edit.\n')
    const [preview] = await app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })

    await app.updateBuffer(path, '# Plan\n\nOriginal. First edit. Second edit.\n')
    const stale = { recipients: ['ag_1'], note: '', includeExternal: false, token: preview!.token }
    await expect(app.send(path, stale)).rejects.toThrow('The document changed')

    const [fresh] = await app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })
    await expect(app.send(path, { ...stale, token: fresh!.token })).resolves.toHaveLength(1)
  })

  it('a deselected hunk is skipped, marked partial, and never offered again', async () => {
    const { app, path, store } = await fixture('a\n\nb\n\nc\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.updateBuffer(path, 'A\n\nb\n\nC\n')
    const segmentId = (await store.loadMeta(path)).segments.at(-1)!.id as string
    const [preview] = await app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })

    const request = {
      recipients: ['ag_1'],
      note: '',
      includeExternal: false,
      excludedHunks: [`${segmentId}:0`],
      token: preview!.token,
    }
    await app.send(path, request)
    const delivery = (await storedApplication(store, path)).attachments.ag_1!.deliveries[0]!
    expect(delivery.payload.segments?.[0]?.hunks.map((hunk) => hunk.added[0])).toEqual(['C'])
    expect(delivery.payload.partial).toBe(true)
    expect(delivery.payload.text).toContain('Parts of the document changed that are not included here.')

    await command(app, 'ack', { file: path, agent: 'ag_1', deliveryId: delivery.id })
    expect((await app.getState()).activeDocument!.canSend).toBe(false)
    const [after] = await app.previewSend(path, { recipients: ['ag_1'], note: '', includeExternal: false })
    expect(after!.text).not.toContain('Changes by user:')
  })
})

describe('ghost seeding and save history', () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('git', ['-C', cwd, ...args])
  }

  async function gitFixture(content = '# Plan\n\nOriginal.\n') {
    const value = await fixture(content)
    await git(value.root, 'init', '-q')
    await git(value.root, 'config', 'user.name', 'Test')
    await git(value.root, 'config', 'user.email', 'test@example.com')
    await writeFile(join(value.root, 'other.md'), 'committed\n')
    await git(value.root, 'add', 'other.md')
    await git(value.root, 'commit', '-qm', 'unrelated')
    return value
  }

  it('seeds an untracked file from itself so a tagged burst shows discrete named hunks', async () => {
    const content = '# Plan\n\nOriginal.\n'
    const { app, path, store } = await gitFixture(content)
    await app.openDocument(path)
    expect(await store.getObjectText((await store.loadMeta(path)).ghostBlob)).toBe(content)

    await command(app, 'changed', { file: path, agent: 'ag_test', name: 'Claude' })
    await store.writeBuffer(path, '# Plan, revised\n\nOriginal.\n')
    await app.recheckFocused()
    await store.writeBuffer(path, '# Plan, revised\n\nOriginal.\n\nAppendix.\n')
    await app.recheckFocused()

    const document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(2)
    for (const hunk of document.pendingHunks) expect(hunk.author?.name).toBe('Claude')
  })

  it('a checkpoint-created empty ghost is deliberate and survives reopening', async () => {
    const content = '# Plan\n\nOriginal.\n'
    const { app, path, store } = await gitFixture(content)
    await app.openDocument(path)
    await command(app, 'checkpoint', { file: path })
    expect(await store.getObjectText((await store.loadMeta(path)).ghostBlob)).toBe('')

    await app.closeDocument(path)
    await app.openDocument(path)
    const meta = await store.loadMeta(path)
    expect(await store.getObjectText(meta.ghostBlob)).toBe('')
    expect(meta.reseedFromDisk).toBeUndefined()
    expect((await app.getState()).activeDocument!.pendingHunks).toHaveLength(1)
  })

  it('re-seeds a stranded version-1 empty ghost from disk, keeping only unsaved work pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-application-'))
    const path = join(root, 'plan.md')
    const saved = '# Plan\n\nSaved version.\n'
    await writeFile(path, saved)
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    await store.initialize()
    const emptyGhost = await store.putObject('')
    await store.saveMeta({
      formatVersion: 1,
      realpath: path,
      ghostBlob: emptyGhost,
      pendingHunks: [],
      segments: [],
      segmentOffset: 0,
      attachments: {},
      annotationEvents: [],
    } as unknown as Parameters<typeof store.saveMeta>[0])
    await store.writeBuffer(path, `${saved}\nUnsaved agent work.\n`)

    const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
    const app = await createStrataApplication({ store, settingsStore, watch: false })
    await app.openDocument(path)

    const meta = await store.loadMeta(path)
    expect(meta.reseedFromDisk).toBeUndefined()
    expect(await store.getObjectText(meta.ghostBlob)).toBe(saved)
    const document = (await app.getState()).activeDocument!
    expect(document.content).toContain('Unsaved agent work')
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]?.removed).toEqual([])
    expect(document.pendingHunks[0]?.added).toEqual(['', 'Unsaved agent work.'])
  })

  it('save appends a round whose authors mean activity, and a no-change save appends nothing', async () => {
    const original = '# Plan\n\nShip Friday.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)

    await command(app, 'changed', { file: path, agent: 'ag_test', name: 'Claude' })
    await store.writeBuffer(path, '# Plan\n\nShip Thursday.\n')
    await app.recheckFocused()
    // The user overwrites the agent's text before saving; the agent stays in
    // the round's author list because the label means activity, not survival.
    await app.updateBuffer(path, '# Plan\n\nShip Wednesday.\n')
    await app.save(path)

    let meta = await store.loadMeta(path)
    expect(meta.saves).toHaveLength(1)
    expect(await store.getObjectText(meta.saves[0]!.beforeBlob)).toBe(original)
    expect(await store.getObjectText(meta.saves[0]!.afterBlob)).toBe('# Plan\n\nShip Wednesday.\n')
    const names = meta.saves[0]!.authors.map((author) => author.name).sort()
    expect(names).toEqual(['Claude', 'you'])

    await app.save(path)
    meta = await store.loadMeta(path)
    expect(meta.saves).toHaveLength(1)
  })

  it('back-to-back saves attribute each round to exactly its own contributors', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nUser round.\n')
    await app.save(path)

    await command(app, 'changed', { file: path, agent: 'ag_test', name: 'Claude' })
    await store.writeBuffer(path, '# Plan\n\nUser round.\n\nAgent round.\n')
    await app.recheckFocused()
    await app.save(path)

    const meta = await store.loadMeta(path)
    expect(meta.saves).toHaveLength(2)
    expect(meta.saves[0]!.authors).toEqual([{ name: 'you', user: true }])
    expect(meta.saves[1]!.authors).toEqual([{ name: 'Claude', user: false }])
  })

  it('an upgraded store uses lastSavedAt as its first round threshold', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nPre-upgrade user edit.\n')
    await app.save(path)
    await app.closeDocument(path)

    // Strip the history and drop the meta back to version 1, as a pre-upgrade
    // store would be: lastSavedAt survives, saves does not.
    const meta = await store.loadMeta(path)
    const { saves: _saves, ...withoutSaves } = meta as unknown as Record<string, unknown>
    await store.saveMeta({ ...withoutSaves, formatVersion: 1 } as unknown as Parameters<typeof store.saveMeta>[0])

    await app.openDocument(path)
    await command(app, 'changed', { file: path, agent: 'ag_test', name: 'Claude' })
    await store.writeBuffer(path, '# Plan\n\nPre-upgrade user edit.\n\nPost-upgrade agent edit.\n')
    await app.recheckFocused()
    await app.save(path)

    const upgraded = await store.loadMeta(path)
    expect(upgraded.saves).toHaveLength(1)
    expect(upgraded.saves[0]!.authors).toEqual([{ name: 'Claude', user: false }])
  })

  it('serves each round read-only from its own snapshots, excluding unsaved work', async () => {
    const { app, path } = await fixture('# Plan\n\nOriginal.\n')
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nRound one.\n')
    await app.save(path)
    await app.updateBuffer(path, '# Plan\n\nRound two.\n')
    await app.save(path)
    await app.updateBuffer(path, '# Plan\n\nUnsaved.\n')

    const document = (await app.getState()).activeDocument!
    expect(document.saves).toHaveLength(2)

    const first = await app.saveRound(path, 0)
    expect(first.hunks).toHaveLength(1)
    expect(first.hunks[0]?.removed).toEqual(['Original.'])
    expect(first.hunks[0]?.added).toEqual(['Round one.'])

    const second = await app.saveRound(path, 1)
    expect(second.hunks[0]?.removed).toEqual(['Round one.'])
    expect(second.hunks[0]?.added).toEqual(['Round two.'])

    await expect(app.saveRound(path, 2)).rejects.toThrow('No such save')
  })
})
