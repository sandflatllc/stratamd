import { mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication as createApplication, type ApplicationOptions, type StrataApplication } from '../../src/main/application'
import { createAnnotation, createAnnotationLog, isHunkVerdict, type AnnotationLog } from '../../src/core/annotations'
import type { Attachment } from '../../src/core/delivery'
import { PROTOCOL_VERSION, type CommandRequest } from '../../src/cli/protocol'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'
import { tableReferences } from '../../src/main/tables'
import { defaultTableView } from '../../src/shared/tables'
import { annotatedScreenshotData, type ComponentAstNode } from '../../src/core/markdown/components'
import { parseMarkdown } from '../../src/core/markdown'

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
  // Typing and watcher merges reach meta.json on a debounce (plan 4.11);
  // reading the stored form means reading what the app would write next.
  await Promise.all(applications.map((app) => app.flushPersistence()))
  const meta = await store.loadMeta(path)
  // Delivery payloads are objects by hash (format 3); hydrate them so the
  // assertions below read the delivery the agent would collect.
  const attachments: Record<string, Attachment> = {}
  for (const [id, stored] of Object.entries(meta.attachments)) {
    const deliveries = await Promise.all(stored.deliveries.map(async (delivery) => {
      const { payloadBlob, ...rest } = delivery as typeof delivery & { payload?: unknown }
      const payload = payloadBlob ? JSON.parse(await store.getObjectText(payloadBlob)) as unknown : rest.payload
      return { ...rest, payload } as unknown as Attachment['deliveries'][number]
    }))
    attachments[id] = { ...(stored as unknown as Attachment), deliveries }
  }
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
    attachments,
  }
}

/**
 * /proc-visible descriptor counts are the Linux leak check; other hosts have
 * no /proc, so count assertions expect zero there and the portable check is
 * that closing the document succeeds (mac-plan §4.9).
 */
function trackedCount(count: number): number {
  return process.platform === 'linux' ? count : 0
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
  it('quick sends one comment while held drafts stay private and durable', async () => {
    const source = '# Plan\n\nFirst sentence. Second sentence. Third sentence.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    for (const [agent, name] of [['ag_active', 'Active'], ['ag_other', 'Other']] as const) {
      await command(value.app, 'attach', { file: value.path, agent, name, timeout: 0 })
    }
    const range = (quote: string) => ({ quote, from: source.indexOf(quote), to: source.indexOf(quote) + quote.length })
    const first = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Held first.', recipients: ['ag_active'], ...range('First sentence') })
    const second = await value.app.holdDraft(value.path, { kind: 'question', text: 'Held second?', recipients: ['ag_active'], ...range('Second sentence') })
    const deliveries = await value.app.quickSend(value.path, { kind: 'suggestion', text: 'Third line.', recipients: ['ag_active'], ...range('Third sentence') })

    expect(deliveries).toHaveLength(1)
    const document = (await value.app.getState()).activeDocument!
    expect(document.drafts.map((draft) => draft.id)).toEqual([first, second])
    expect(document.annotations).toHaveLength(1)
    expect(document.content).toBe(source)
    const stored = await storedApplication(value.store, value.path)
    const payload = stored.attachments.ag_active!.deliveries[0]!.payload
    expect(payload.annotations).toHaveLength(1)
    expect(payload.annotations![0]).toMatchObject({ text: 'Third line.', quote: 'Third sentence' })
    expect(JSON.stringify(payload)).not.toContain('Held first')
    expect(JSON.stringify(payload)).not.toContain('Held second')
    expect(JSON.stringify(await command(value.app, 'state', { file: value.path }))).not.toContain('Held first')
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).drafts, 'utf8')).drafts).toHaveLength(2)
  })

  it('materializes only checked drafts and offers the unchecked draft again', async () => {
    const source = '# Plan\n\nAlpha. Beta.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    const first = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Send alpha.', recipients: ['ag_1'], quote: 'Alpha', from: source.indexOf('Alpha'), to: source.indexOf('Alpha') + 5 })
    const second = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Keep beta.', recipients: ['ag_1'], quote: 'Beta', from: source.indexOf('Beta'), to: source.indexOf('Beta') + 4 })
    const request = { recipients: ['ag_1'], note: '', includeExternal: false, draftIds: [first] }
    const [preview] = await value.app.previewSend(value.path, request)
    expect(preview?.text).toContain('Send alpha.')
    expect(preview?.text).not.toContain('Keep beta.')
    expect(preview?.items.events.find((event) => event.draftId === first)).toBeTruthy()
    await value.app.send(value.path, { ...request, token: preview!.token })
    const document = (await value.app.getState()).activeDocument!
    expect(document.drafts.map((draft) => draft.id)).toEqual([second])
    expect(document.annotations.map((annotation) => annotation.id)).toEqual([first])
    await value.app.closeDocument(value.path)
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.drafts.map((draft) => draft.id)).toEqual([second])
  })

  it('keeps a selected draft private when delivery enqueue fails', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    const id = await value.app.holdDraft(value.path, {
      kind: 'comment', text: 'Still private.', recipients: ['ag_1'], quote: 'Keep this passage',
      from: source.indexOf('Keep this passage'), to: source.indexOf('Keep this passage') + 'Keep this passage'.length,
    })

    await expect(value.app.send(value.path, {
      recipients: ['ag_1'], note: 'x'.repeat(64 * 1_024 + 1), includeExternal: false, draftIds: [id],
    })).rejects.toThrow('Delivery note exceeds the 64 KB limit')

    const document = (await value.app.getState()).activeDocument!
    expect(document.drafts.map((draft) => draft.id)).toEqual([id])
    expect(document.annotations).toEqual([])
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).drafts, 'utf8')).drafts)
      .toEqual([expect.objectContaining({ id })])
  })

  it('keeps drafts when malformed reading state is discarded', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    const id = await value.app.holdDraft(value.path, {
      kind: 'comment', text: 'Private note.', recipients: [], quote: 'Keep this passage',
      from: source.indexOf('Keep this passage'), to: source.indexOf('Keep this passage') + 'Keep this passage'.length,
    })
    await value.app.closeDocument(value.path)
    await writeFile(value.store.pathsForDocument(value.path).reading, '{malformed')
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.drafts.map((draft) => draft.id)).toEqual([id])
  })

  it('opens with no drafts and preserves a malformed private draft store', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await value.app.holdDraft(value.path, {
      kind: 'comment', text: 'Private note.', recipients: [], quote: 'Keep this passage',
      from: source.indexOf('Keep this passage'), to: source.indexOf('Keep this passage') + 'Keep this passage'.length,
    })
    await value.app.closeDocument(value.path)
    const draftPath = value.store.pathsForDocument(value.path).drafts
    await writeFile(draftPath, '{malformed')

    await value.app.openDocument(value.path)

    expect((await value.app.getState()).activeDocument?.drafts).toEqual([])
    const preserved = (await readdir(value.store.pathsForDocument(value.path).directory))
      .find((name) => name.startsWith('drafts.json.broken-'))
    expect(preserved).toBeDefined()
    expect(await readFile(join(value.store.pathsForDocument(value.path).directory, preserved!), 'utf8')).toBe('{malformed')
  })

  it('drops a stored draft whose annotation was already persisted', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    const from = source.indexOf('Keep this passage')
    const id = await value.app.holdDraft(value.path, {
      kind: 'comment', text: 'Already sent.', recipients: [], quote: 'Keep this passage',
      from, to: from + 'Keep this passage'.length,
    })
    await value.app.closeDocument(value.path)
    const meta = await value.store.loadMeta(value.path)
    const materialized = createAnnotation(createAnnotationLog(), source, {
      id, kind: 'comment', author: 'user', quote: 'Keep this passage', text: 'Already sent.', start: from, createdAt: 1,
    }).log
    await value.store.saveMeta({
      ...meta,
      annotations: materialized.annotations,
      annotationEvents: materialized.events,
      nextAnnotationSeq: materialized.nextSeq,
    })

    await value.app.openDocument(value.path)

    expect((await value.app.getState()).activeDocument?.drafts).toEqual([])
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).drafts, 'utf8')).drafts).toEqual([])
  })

  it('keeps private shell tab choices in reading.json across close and restart without touching meta.json', async () => {
    const value = await fixture()
    await value.app.openDocument(value.path)
    const metaBefore = await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')
    await value.app.updateReadingState(value.path, { navigationTab: 'contents', reviewTab: 'annotations' })
    expect((await value.app.getState()).activeDocument?.reading).toEqual({ formatVersion: 4, navigationTab: 'contents', reviewTab: 'annotations', walkthrough: { active: false, level: 'h2', current: null, excluded: [], markers: [] }, tables: [], foldedHeadings: [] })
    expect(await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')).toBe(metaBefore)
    await value.app.closeDocument(value.path)
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.reading).toMatchObject({ navigationTab: 'contents', reviewTab: 'annotations' })
    await value.app.shutdown()
    const reopened = await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false })
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.reading).toMatchObject({ navigationTab: 'contents', reviewTab: 'annotations' })
  })

  it('persists table views outside meta.json and drops a table whose identity disappears', async () => {
    const source = '# Report\n\n## Islands\n\n| Name | Score |\n| --- | ---: |\n| Alpha | 12 |\n| Beta | 3 |\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    const metaBefore = await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')
    const table = tableReferences(source)[0]!
    const state = {
      ...defaultTableView(table),
      presentation: 'compare' as const,
      sort: { column: 1, direction: 'descending' as const },
      hiddenColumns: [1],
      selectedRows: [0, 1],
      focusedRow: 1,
      focusedColumn: 0,
      density: 'compact' as const,
      columnWidths: [240, 110],
    }
    await value.app.updateTableView(value.path, state)
    expect((await value.app.getState()).activeDocument?.reading.tables).toEqual([state])
    expect(await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')).toBe(metaBefore)

    await value.app.closeDocument(value.path)
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.reading.tables).toEqual([state])
    await value.app.shutdown()
    const reopened = await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false })
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.reading.tables).toEqual([state])

    await reopened.closeDocument(value.path)
    await writeFile(value.path, source.replace('| Name | Score |', '| Island | Score |'))
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.reading.tables).toEqual([])
  })

  it('returns a table annotation id and sends exact row text with structured context', async () => {
    const source = '# Report\n\n## Islands\n\n| Name | Verdict |\n| --- | --- |\n| Alpha | Unprotected |\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_1', name: 'Editor', timeout: 0 })
    const quote = '| Alpha | Unprotected |'
    const from = source.indexOf(quote)
    const context = {
      kind: 'table-cell' as const,
      heading: 'Islands',
      columns: ['Name', 'Verdict'],
      column: { index: 1, label: 'Verdict' },
    }
    const id = await value.app.addAnnotation(value.path, { kind: 'question', quote, text: 'What protects this?', from, to: from + quote.length, context })
    const annotation = (await value.app.getState()).activeDocument?.annotations.find((candidate) => candidate.id === id)
    expect(annotation).toMatchObject({ id, quote, context })
    const preview = await value.app.previewSend(value.path, { recipients: ['ag_1'], note: '', includeExternal: false })
    expect(preview[0]?.text).toContain('[Table under Islands; columns Name, Verdict; column 2 Verdict]')
  })

  it('keeps reading choices session-only for invalid UTF-8 without creating a ghost entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-reading-invalid-'))
    const path = join(root, 'invalid.md')
    await writeFile(path, Buffer.from([0xff, 0xfe]))
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const app = await createStrataApplication({ store, settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), watch: false })
    await app.openDocument(path)
    await app.updateReadingState(path, { navigationTab: 'contents', reviewTab: 'annotations' })
    expect((await app.getState()).activeDocument?.reading).toMatchObject({ navigationTab: 'contents', reviewTab: 'annotations' })
    expect(await store.hasDocument(path)).toBe(false)
    await expect(readFile(store.pathsForDocument(path).reading, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('updates Reviewed and Revisit through user and agent text paths without touching meta.json', async () => {
    const original = '# Guide\n\n## One\n\nBody.\n\n## Two\n\nEnd.\n'
    const value = await fixture(original)
    await value.app.openDocument(value.path)
    const metaBefore = await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')
    await value.app.updateWalkthrough(value.path, { type: 'start' })
    const first = (await value.app.getState()).activeDocument!.reading.walkthrough.current!
    await value.app.updateWalkthrough(value.path, { type: 'mark', heading: first, status: 'reviewed' })
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')
    expect(await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')).toBe(metaBefore)

    const userEdit = original.replace('Body.', 'User changed body.')
    await value.app.updateBuffer(value.path, userEdit)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.updateBuffer(value.path, original, 'history')
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')
    await value.app.updateBuffer(value.path, userEdit, 'history')
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.updateBuffer(value.path, original, 'history')
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')

    await command(value.app, 'attach', { file: value.path, agent: 'ag_1', name: 'Editor', timeout: 0 })
    await command(value.app, 'edit', { file: value.path, agent: 'ag_1', edits: [{ match: 'Body.', replace: 'Agent body.' }] })
    const changed = (await value.app.getState()).activeDocument!
    expect(changed.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.revertHunk(value.path, changed.pendingHunks[0]!.id)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')

    const outsideEdit = original.replace('Body.', 'Outside body.')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await value.store.writeBuffer(value.path, outsideEdit)
    await value.app.recheckFocused()
    let outside = (await value.app.getState()).activeDocument!
    expect(outside.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.keepHunk(value.path, outside.pendingHunks[0]!.id)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await expect(value.app.undo(value.path)).resolves.toBe('undone')
    outside = (await value.app.getState()).activeDocument!
    expect(outside.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.revertHunk(value.path, outside.pendingHunks[0]!.id)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')

    await command(value.app, 'annotate', {
      file: value.path,
      agent: 'ag_1',
      annotations: [{ kind: 'suggestion', quote: 'Body.', text: 'Suggested body.' }],
    })
    const suggestion = (await value.app.getState()).activeDocument!.annotations.find((annotation) => annotation.kind === 'suggestion')!
    await value.app.acceptSuggestion(value.path, suggestion.id)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await expect(value.app.undo(value.path)).resolves.toBe('undone')
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')
    await expect(value.app.redo(value.path)).resolves.toBe('redone')
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await expect(value.app.undo(value.path)).resolves.toBe('undone')
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status).toBe('reviewed')

    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).reading, 'utf8'))).toMatchObject({
      formatVersion: 4,
      navigationTab: 'contents',
      walkthrough: { active: true, markers: [{ status: 'reviewed' }] },
    })
  })

  it('relocates a unique walkthrough marker on reopen and drops it when the heading becomes ambiguous', async () => {
    const original = '# Old title\n\n## One\n\nBody.\n\n## Two\n\nEnd.\n'
    const value = await fixture(original)
    await value.app.openDocument(value.path)
    await value.app.updateWalkthrough(value.path, { type: 'start' })
    const first = (await value.app.getState()).activeDocument!.reading.walkthrough.current!
    await value.app.updateWalkthrough(value.path, { type: 'mark', heading: first, status: 'reviewed' })
    await expect(value.app.closeDocument(value.path)).resolves.toBe('closed')

    const retitled = original.replace('# Old title', '# New title')
    await writeFile(value.path, retitled)
    await value.app.openDocument(value.path)
    const marker = (await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!
    expect(marker).toMatchObject({ status: 'reviewed', heading: { text: 'One', parentText: 'New title' } })
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).reading, 'utf8'))).toMatchObject({
      walkthrough: { markers: [{ heading: { text: 'One', parentText: 'New title' } }] },
    })
    await expect(value.app.closeDocument(value.path)).resolves.toBe('closed')

    await writeFile(value.path, '# New title\n\n## One\n\nFirst.\n\n## Middle\n\nMiddle.\n\n## One\n\nSecond.\n')
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers).toEqual([])
  })

  it('opens, mirrors, and saves a user edit without changing disk before Save', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nChanged.\n')
    expect(await readFile(path, 'utf8')).toContain('Original')
    await expect.poll(async () => (await store.readBuffer(path))?.toString('utf8')).toContain('Changed')
    await app.save(path)
    expect(await readFile(path, 'utf8')).toContain('Changed')
    expect((await app.getState()).activeDocument?.dirty).toBe(false)
  })

  it('shows a mirror failure to the user and clears it once the buffer writes again', async () => {
    const { app, path, store } = await fixture()
    await app.openDocument(path)
    const original = store.writeBuffer.bind(store)
    let failing = true
    store.writeBuffer = async (file: string, content: string) => {
      if (failing) throw new Error('ENOSPC: no space left on device')
      return original(file, content)
    }

    await app.updateBuffer(path, '# Plan\n\nFirst edit.\n')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await app.getState()).activeDocument?.problems).toEqual(['mirror'])

    failing = false
    await app.updateBuffer(path, '# Plan\n\nSecond edit.\n')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await app.getState()).activeDocument?.problems).toEqual([])
    expect((await store.readBuffer(path))?.toString('utf8')).toContain('Second edit')
  })

  it('stamps annotations and replies with a creation time the thread panel can show', async () => {
    const { app, path } = await fixture()
    await app.openDocument(path)
    const before = Date.now()
    await app.addAnnotation(path, { kind: 'comment', quote: 'Original.', text: 'Why?', from: 8, to: 17 })
    const [annotation] = (await app.getState()).activeDocument!.annotations
    expect(annotation!.createdAt).toBeGreaterThanOrEqual(before)
    await app.reply(path, annotation!.id, 'Because.')
    const [replied] = (await app.getState()).activeDocument!.annotations
    expect(replied!.replies[0]!.createdAt).toBeGreaterThanOrEqual(before)
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
    expect(await app.resolveLocalImage(path, 'photo.png')).toMatchObject({ url: expect.stringMatching(/^strata-image:\/\/local\//), path: join(root, 'photo.png') })
    expect(await app.resolveLocalImage(path, 'https://example.test/photo.png')).toBeNull()
  })

  it('returns only bounded allowlisted Markdown previews', async () => {
    const { app, path, root } = await fixture()
    const target = join(root, 'notes.md')
    await writeFile(target, `# Notes\n\n${'x'.repeat(300_000)}`)
    await writeFile(join(root, 'notes.ts'), 'export {}\n')
    await app.openDocument(path)
    const preview = await app.resolveLocalMarkdown(path, 'notes.md#notes')
    expect(preview).toMatchObject({ path: target, truncated: true })
    expect(Buffer.byteLength(preview?.source ?? '', 'utf8')).toBe(256 * 1024)
    expect(await app.resolveLocalMarkdown(path, 'notes.ts')).toBeNull()
    expect(await app.resolveLocalMarkdown(path, 'https://example.test/notes.md')).toBeNull()
    expect(await app.resolveLocalMarkdown(path, '../outside.md')).toBeNull()
  })

  it('persists folded headings in reading.json v4 without changing Markdown or meta', async () => {
    const value = await fixture('# Plan\n\n## Part\n\nBody.\n')
    await value.app.openDocument(value.path)
    const beforeMeta = await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')
    const beforeDocument = await readFile(value.path, 'utf8')
    const heading = { level: 2 as const, text: 'Part', parentText: 'Plan', previousText: 'Plan', nextText: null }
    await value.app.updateFold(value.path, heading, true)
    expect((await value.app.getState()).activeDocument?.reading.foldedHeadings).toEqual([heading])
    expect(await readFile(value.path, 'utf8')).toBe(beforeDocument)
    expect(await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')).toBe(beforeMeta)
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).reading, 'utf8'))).toMatchObject({ formatVersion: 4, foldedHeadings: [heading] })
  })

  it('accepts a folded heading rename before the debounced buffer and relocates it on reopen', async () => {
    const before = '# Plan\n\n## Part\n\nBody.\n'
    const after = before.replace('## Part', '## Renamed part')
    const value = await fixture(before)
    await value.app.openDocument(value.path)
    const original = { level: 2 as const, text: 'Part', parentText: 'Plan', previousText: 'Plan', nextText: null }
    const renamed = { ...original, text: 'Renamed part' }

    await value.app.updateFold(value.path, original, true)
    // Editor transactions report the source-identity rename before the 180 ms
    // buffer mirror reaches the main process.
    await value.app.updateFold(value.path, renamed, true)
    expect((await value.app.getState()).activeDocument?.reading.foldedHeadings).toEqual([original, renamed])
    await value.app.updateBuffer(value.path, after)
    await value.app.flushPersistence()
    await value.app.shutdown()

    const reopened = await createStrataApplication({ store: value.store, settingsStore: value.settingsStore, watch: false })
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.reading.foldedHeadings).toEqual([renamed])
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
    // The reply travels alone, with one line naming the thread it continues (plan 3.7).
    expect(preview?.text).toContain('\n  thread: comment on line 1 about "old wording": Too vague.')
    expect(preview?.text).not.toContain('⟦')
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
    await app.flushPersistence(path)
    const before = await store.loadMeta(path)
    expect(before.application).toBeUndefined()
    expect(before.segments[0]).toMatchObject({ id: expect.any(String), beforeBlob: expect.any(String), afterBlob: expect.any(String) })
    expect(before.snapshotBlobs).toEqual(expect.arrayContaining([before.segments[0]!.beforeBlob, before.segments[0]!.afterBlob]))
    await command(app, 'checkpoint', { file: path })
    const after = await store.loadMeta(path)
    expect(after.attachments.ag_1).toMatchObject({ id: 'ag_1', name: 'Agent' })
    // The ghost moved to the file's content; the unsaved edit now differs from
    // it and is listed exactly as the offline `changes` command would list it.
    expect(after.pendingHunks).toHaveLength(1)
    const changes = await command(app, 'changes', { file: path }) as { segments: Array<{ author: string; hunks: unknown[] }> }
    expect(changes.segments).toEqual([{
      author: 'external',
      hunks: [expect.objectContaining({ removed: ['Original.'], added: ['Changed.'] })],
    }])
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
    expect(await trackedDescriptors(moved)).toHaveLength(trackedCount(1))

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
    expect(await trackedDescriptors(value.path)).toHaveLength(trackedCount(1))

    await rename(value.path, moved)
    await value.app.recheckFocused()

    expect((await value.app.getState()).activeDocument).toMatchObject({
      path: moved,
      content: '# Save then move\n\nEdited.\n',
      deleted: false,
    })
    expect(await value.store.loadMeta(moved)).toMatchObject({ realpath: moved })
    expect(await trackedDescriptors(value.path)).toEqual([])
    expect(await trackedDescriptors(moved)).toHaveLength(trackedCount(1))
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
    expect(await trackedDescriptors(path)).toHaveLength(trackedCount(1))

    await app.save(path)
    expect(await readFile(path, 'utf8')).toBe(shadow)
    expect((await app.getState()).activeDocument).toMatchObject({ deleted: false })
    expect(await trackedDescriptors(path)).toHaveLength(trackedCount(1))
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
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })

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
      message: 'One or more quotes are invalid',
      detail: [
        expect.objectContaining({
          index: 1,
          quote: 'alpha missing',
          reason: 'missing',
          candidates: expect.arrayContaining([expect.objectContaining({ line: 1, quote: 'First alpha target.' })]),
          hint: expect.stringContaining('buffer file'),
        }),
        expect.objectContaining({
          index: 2,
          reason: 'ambiguous',
          total: 2,
          candidates: [
            { line: 2, before: 'Second ', quote: 'same phrase', after: '.' },
            { line: 3, before: 'Third ', quote: 'same phrase', after: '.' },
          ],
          hint: expect.stringContaining('--preceded-by'),
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

  it('delivers an answer once before pruning a resolved decision', async () => {
    const value = await fixture('# Decision\n')
    await value.settingsStore.update({ keepResolvedAnnotations: false })
    const app = await createStrataApplication({
      store: value.store,
      settingsStore: value.settingsStore,
      watch: false,
      clipboardWrite: async () => undefined,
    })
    await app.openDocument(value.path)
    await command(app, 'attach', { file: value.path, agent: 'ag_1', name: 'One', timeout: 0 })
    const created = await command(app, 'annotate', {
      file: value.path,
      agent: 'ag_1',
      annotations: [{ kind: 'decision', text: 'Which?', options: ['A', 'B'], document: true }],
    }) as { created: Array<{ id: string }> }
    const decision = created.created[0]!.id
    const [initialDelivery] = await app.send(value.path, { recipients: ['ag_1'], note: '', includeExternal: false })
    await command(app, 'ack', { file: value.path, agent: 'ag_1', deliveryId: initialDelivery })
    await app.copyForAgent(value.path, '', false)

    await app.answerDecision(value.path, decision, { option: 'A' })
    await command(app, 'changed', { file: value.path, agent: 'ag_1', name: 'One' })
    expect((await storedApplication(value.store, value.path)).annotations.annotations[decision]).toBeDefined()
    await app.send(value.path, { recipients: ['ag_1'], note: '', includeExternal: false })
    expect((await storedApplication(value.store, value.path)).attachments.ag_1?.deliveries.at(-1)?.payload.answers)
      .toEqual([expect.objectContaining({ annotation: decision, option: 'A' })])
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

  it('delivers a message sent while the blocked attach is still persisting', async () => {
    const { app, path, store } = await attachedPair()

    // Park the blocked attach inside its persist by gating the store's
    // saveMeta once. The send that arrives meanwhile takes its turn on the
    // document after the attach's registration completes (plan 2.4), and the
    // wait is already registered by then, so the message reaches the attach
    // instead of the attach sitting out its full timeout.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let parked!: () => void
    const parkedAt = new Promise<void>((resolve) => { parked = resolve })
    const original = store.saveMeta.bind(store)
    let armed = true
    store.saveMeta = async (meta) => {
      if (armed) {
        armed = false
        parked()
        await gate
      }
      return original(meta)
    }

    const blocked = command(app, 'attach', { file: path, agent: 'ag_b', name: 'Agent B', timeout: 3 })
    await parkedAt
    const sending = command(app, 'send', { file: path, agent: 'ag_a', text: 'Mid-persist ping.' }) as Promise<{ sent: unknown[] }>
    let sentEarly = false
    void sending.then(() => { sentEarly = true }, () => { sentEarly = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sentEarly).toBe(false)
    release()

    expect((await sending).sent).toEqual([{ agent: 'ag_b', name: 'Agent B' }])
    const payload = await blocked as MessagePayload
    expect(payload).toMatchObject({
      event: 'message',
      from: { agent: 'ag_a', name: 'Agent A' },
      notes: ['Mid-persist ping.'],
    })
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
      detail: { recipients: ['ag_b'], others: [] },
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
    })).rejects.toMatchObject({
      exitCode: 3,
      code: 'MESSAGE_PENDING',
      message: expect.stringContaining('--to'),
      detail: { recipients: ['ag_d'], others: ['ag_b', 'ag_c'] },
    })

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

  it('keeps decision answers owner-only and sends their structured history without a document change', async () => {
    const { app, path, store } = await leadFixture('# Lead\n\nChoose here.\n')
    const created = await command(app, 'annotate', {
      file: path, agent: 'ag_peer',
      annotations: [{ kind: 'decision', text: 'Which gate?', options: ['CI', 'Manual'], document: true }],
    }) as { created: Array<{ id: string }> }
    const id = created.created[0]!.id
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await expect(command(app, 'answer', { file: path, agent: 'ag_peer', decision: id, choice: 'CI' }))
      .rejects.toMatchObject({ exitCode: 3, code: 'DECISION_OWNER_REQUIRED' })
    await expect(command(app, 'resolve', { file: path, agent: 'ag_lead', annotation: id }))
      .rejects.toMatchObject({ exitCode: 3, code: 'DECISION_OWNER_REQUIRED' })

    const before = (await app.getState()).activeDocument!.content
    await app.answerDecision(path, id, { option: 'CI' })
    const answered = (await app.getState()).activeDocument!.annotations.find((annotation) => annotation.id === id)!
    expect(answered).toMatchObject({ kind: 'decision', status: 'resolved', anchor: 'document', from: null, to: null, decision: { options: ['CI', 'Manual'], answers: [{ option: 'CI', author: 'user' }] } })
    expect((await app.getState()).activeDocument!.content).toBe(before)
    expect((await app.getState()).activeDocument!.pendingHunks).toEqual([])
    const [preview] = await app.previewSend(path, { recipients: ['ag_peer'], note: '', includeExternal: false })
    expect(preview?.items.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'answer', annotationKind: 'decision', text: 'CI' })]))
    expect(preview?.text).toContain('Decision answers:')
    await app.send(path, { recipients: ['ag_peer'], note: '', includeExternal: false })
    expect((await storedApplication(store, path)).attachments.ag_peer?.deliveries.at(-1)?.payload.answers)
      .toEqual([expect.objectContaining({ annotation: id, option: 'CI' })])

    await app.reopenDecision(path, id)
    await app.answerDecision(path, id, { option: null, other: 'Stage it' })
    expect((await storedApplication(store, path)).annotations.annotations[id]?.decision?.answers).toHaveLength(2)
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

  it('reports a moved suggestion on accept with excerpts and a hint instead of a bare refusal', async () => {
    const { app, path } = await leadFixture('# Lead\n\nOld wording stays here.\n\nOther text.\n')
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    const { created } = await command(app, 'annotate', {
      file: path,
      agent: 'ag_peer',
      annotations: [{ kind: 'suggestion', quote: 'Old wording', text: 'New wording' }],
    }) as { created: Array<{ id: string }> }
    await app.updateBuffer(path, '# Lead\n\nRewritten by the user.\n\nOther text.\n')

    await expect(command(app, 'accept', { file: path, agent: 'ag_lead', annotation: created[0]!.id }))
      .rejects.toMatchObject({
        exitCode: 3,
        code: 'QUOTE_INVALID',
        detail: [{
          index: 0,
          quote: 'Old wording',
          reason: 'missing',
          candidates: [expect.objectContaining({ line: 3, quote: 'Rewritten by the user.' })],
          hint: expect.stringContaining('run stratamd state'),
        }],
      })
  })
})

describe('agent command results and views', () => {
  it('adds an agent-attributed screenshot pin to the buffer without writing the document', async () => {
    const value = await fixture()
    const image = join(value.root, 'review.png')
    await writeFile(image, Buffer.from([137, 80, 78, 71]))
    const details = await stat(image, { bigint: true })
    const version = `${details.size}:${details.mtimeNs}`
    const original = [
      '# Review', '', '<AnnotatedScreenshot>', '![Review](./review.png)', '',
      '| Pin | X | Y | Image version | Note |', '|---:|---:|---:|---|---|',
      `| 1 | 10.0 | 20.0 | ${version} | Existing note. |`, '', 'Caption after the table.', '</AnnotatedScreenshot>', '',
    ].join('\n')
    await writeFile(value.path, original)
    await value.app.openDocument(value.path)
    await command(value.app, 'attach', { file: value.path, agent: 'ag_1', name: 'Inspector', timeout: 0 })

    const result = await command(value.app, 'pin', {
      file: value.path, agent: 'ag_1', name: 'Inspector', componentLine: 3,
      x: 24.25, y: 81, note: 'Check | boundary',
    })
    expect(result).toEqual({ pinned: 2, component: 3, x: 24.25, y: 81, note: 'Check | boundary' })
    const document = (await value.app.getState()).activeDocument!
    expect(document.content).toContain(`| 2 | 24.3 | 81.0 | ${version} | Check \\| boundary |`)
    expect(document.content.indexOf('| 2 |')).toBeLessThan(document.content.indexOf('Caption after the table.'))
    const component = parseMarkdown(document.content).blocks.find((block) => (block.node as { type: string }).type === 'mdxJsxFlowElement')?.node as unknown as ComponentAstNode
    expect(annotatedScreenshotData(component)?.pins).toHaveLength(2)
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({ author: { id: 'ag_1', name: 'Inspector' } })
    expect((await value.store.readBuffer(value.path))?.toString('utf8')).toBe(document.content)
    expect(await readFile(value.path, 'utf8')).toBe(original)
  })

  it('refuses stale pins, missing images, and a nonmatching component line', async () => {
    const stale = await fixture([
      '# Review', '', '<AnnotatedScreenshot>', '![Review](./review.png)', '',
      '| Pin | X | Y | Image version | Note |', '|---:|---:|---:|---|---|',
      '| 1 | 10 | 20 | 1:1 | Existing. |', '</AnnotatedScreenshot>', '',
    ].join('\n'))
    await writeFile(join(stale.root, 'review.png'), Buffer.from([137, 80, 78, 71]))
    await stale.app.openDocument(stale.path)
    await command(stale.app, 'attach', { file: stale.path, agent: 'ag_1', name: 'Inspector', timeout: 0 })
    await expect(command(stale.app, 'pin', {
      file: stale.path, agent: 'ag_1', componentLine: 3, x: 10, y: 20, note: 'Another',
    })).rejects.toMatchObject({ exitCode: 3, code: 'IMAGE_VERIFICATION_REQUIRED' })
    await expect(command(stale.app, 'pin', {
      file: stale.path, agent: 'ag_1', componentLine: 4, x: 10, y: 20, note: 'Another',
    })).rejects.toMatchObject({ exitCode: 2, code: 'COMPONENT_NOT_FOUND' })

    const missing = await fixture([
      '# Review', '', '<AnnotatedScreenshot>', '![Missing](./missing.png)', '',
      '| Pin | X | Y | Image version | Note |', '|---:|---:|---:|---|---|',
      '</AnnotatedScreenshot>', '',
    ].join('\n'))
    await missing.app.openDocument(missing.path)
    await command(missing.app, 'attach', { file: missing.path, agent: 'ag_1', name: 'Inspector', timeout: 0 })
    await expect(command(missing.app, 'pin', {
      file: missing.path, agent: 'ag_1', componentLine: 3, x: 10, y: 20, note: 'First',
    })).rejects.toMatchObject({ exitCode: 2, code: 'IMAGE_NOT_FOUND' })
  })

  it('returns the created annotation ids and the reply id', async () => {
    const { app, path } = await fixture('First line.\n\nSecond line.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'GPT', timeout: 0 })
    const result = await command(app, 'annotate', {
      file: path,
      agent: 'ag_1',
      annotations: [
        { kind: 'comment', quote: 'First', text: 'One.', label: 'Tone' },
        { kind: 'question', quote: 'Second', text: 'Two?' },
      ],
    }) as { created: Array<{ id: string; kind: string; quote: string }> }
    expect(result.created).toEqual([
      { id: expect.stringMatching(/^a_/), kind: 'comment', quote: 'First' },
      { id: expect.stringMatching(/^a_/), kind: 'question', quote: 'Second' },
    ])
    const state = await command(app, 'state', { file: path }) as { annotations: Array<{ id: string; name?: string; label?: string }>; text: string }
    expect(state.annotations.map((annotation) => annotation.id)).toEqual(result.created.map((row) => row.id))
    // Agent-authored annotations carry the attachment's name and the label; the marker reads (GPT ag_1) (plan 3.9).
    expect(state.annotations[0]).toMatchObject({ name: 'GPT', label: 'Tone' })
    expect(state.text).toContain(`⟦${result.created[0]!.id} comment (GPT ag_1) [Tone]: One.⟧First⟦/${result.created[0]!.id}⟧`)

    const reply = await command(app, 'reply', {
      file: path, agent: 'ag_1', annotation: result.created[1]!.id, text: 'Because.',
    }) as { replied: string; annotation: string }
    expect(reply).toEqual({ replied: expect.stringMatching(/^r_/), annotation: result.created[1]!.id })
    const replied = await command(app, 'state', { file: path }) as { annotations: Array<{ replies: Array<{ id: string }> }> }
    expect(replied.annotations[1]?.replies.map((entry) => entry.id)).toEqual([reply.replied])
  })

  it('reports open, theme, and the brief and text-only views of state', async () => {
    const { app, path } = await fixture('# Views\n\nBody text.\n')
    const closed = await command(app, 'state', { file: path }) as Record<string, unknown>
    expect(closed).toMatchObject({ event: 'state', open: false, theme: { id: expect.any(String) } })
    expect(closed.attachments).toBeUndefined()

    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    const full = await command(app, 'state', { file: path }) as Record<string, unknown>
    expect(full).toMatchObject({
      open: true,
      document: '# Views\n\nBody text.\n',
      attachments: [{ agent: 'ag_1', name: 'Agent', state: 'working', lead: false }],
      theme: { id: expect.any(String) },
    })

    const brief = await command(app, 'state', { file: path, brief: true }) as Record<string, unknown>
    expect(brief).toMatchObject({
      event: 'state', open: true, file: path, buffer: full.buffer, cursor: full.cursor,
      attachments: full.attachments, theme: full.theme,
    })
    expect(brief).not.toHaveProperty('document')
    expect(brief).not.toHaveProperty('text')
    expect(brief).not.toHaveProperty('annotations')

    const textOnly = await command(app, 'state', { file: path, textOnly: true }) as Record<string, unknown>
    expect(textOnly).not.toHaveProperty('document')
    expect(textOnly).toMatchObject({ text: full.text, annotations: full.annotations, open: true })

    await expect(app.closeDocument(path)).resolves.toBe('closed')
    const closedBrief = await command(app, 'state', { file: path, brief: true }) as Record<string, unknown>
    expect(closedBrief).toMatchObject({ open: false, theme: full.theme })
    expect(closedBrief).not.toHaveProperty('document')
    expect(closedBrief).not.toHaveProperty('text')
  })

  it('omits the document from a text-only attach while text still carries the buffer', async () => {
    const { app, path } = await fixture('# Attach\n\nBody text.\n')
    await app.openDocument(path)
    const initial = await command(app, 'attach', {
      file: path, agent: 'ag_1', name: 'Agent', timeout: 0, textOnly: true,
    }) as Record<string, unknown>
    expect(initial).toMatchObject({ event: 'initial', agent: 'ag_1' })
    expect(initial).not.toHaveProperty('document')
    expect(initial.text).toContain('# Attach\n\nBody text.')

    const again = await command(app, 'attach', {
      file: path, agent: 'ag_2', name: 'Other', timeout: 0,
    }) as Record<string, unknown>
    expect(again.document).toBe('# Attach\n\nBody text.\n')
  })

  it('lists the open documents with focus, unsaved state, and attachments', async () => {
    const { app, path, root } = await fixture('# One\n')
    const empty = await command(app, 'docs', {}) as { event: string; documents: unknown[]; text: string }
    expect(empty).toEqual({ version: expect.any(Number), event: 'docs', documents: [], text: 'No document is open.' })

    const second = join(root, 'two.md')
    await writeFile(second, '# Two\n')
    await app.openDocument(path)
    await app.openDocument(second)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await app.updateBuffer(path, '# One edited\n')

    const docs = await command(app, 'docs', {}) as {
      event: string
      documents: Array<{ file: string; buffer: string; focused: boolean; dirty: boolean; attachments: unknown[] }>
      text: string
    }
    expect(docs.event).toBe('docs')
    expect(docs.documents).toEqual([
      { file: path, buffer: expect.stringMatching(/buffer\.md$/), focused: false, dirty: true, attachments: [{ agent: 'ag_1', name: 'Agent', state: 'working', lead: false }] },
      { file: second, buffer: expect.stringMatching(/buffer\.md$/), focused: true, dirty: false, attachments: [] },
    ])
    expect(docs.documents[0]!.buffer).not.toBe(docs.documents[1]!.buffer)
    expect(docs.text).toContain(`${path} (unsaved changes)`)
    expect(docs.text).toContain(`${second} (focused)`)
    expect(docs.text).toContain('Agent (ag_1): working')
  })

  it('applies an edit as the agent\'s pending hunk against the live buffer', async () => {
    const original = '# Plan\n\nOriginal passage.\n\nKeep me.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Editor', timeout: 0 })
    // The user's own unsaved edit sits elsewhere in the buffer and must survive.
    await app.updateBuffer(path, '# Plan\n\nOriginal passage.\n\nKeep me, says the user.\n')

    const result = await command(app, 'edit', {
      file: path,
      agent: 'ag_1',
      edits: [{ match: 'Original passage.', replace: 'Rewritten passage.' }],
    })
    expect(result).toEqual({ applied: [{ line: 3, match: 'Original passage.', replace: 'Rewritten passage.' }] })

    const expected = '# Plan\n\nRewritten passage.\n\nKeep me, says the user.\n'
    const document = (await app.getState()).activeDocument!
    expect(document.content).toBe(expected)
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({
      removed: ['Original passage.'],
      added: ['Rewritten passage.'],
      author: expect.objectContaining({ id: 'ag_1', name: 'Editor' }),
    })
    expect((await store.readBuffer(path))?.toString('utf8')).toBe(expected)
    expect((await storedApplication(store, path)).state.ghost).toBe(original)
    expect(await readFile(path, 'utf8')).toBe(original)

    const changes = await command(app, 'changes', { file: path }) as { segments: Array<{ tag?: { agent: string } }> }
    expect(changes.segments.map((segment) => segment.tag?.agent)).toEqual(['ag_1'])

    // A batch lands in one step, with lines reported against the new buffer.
    const batch = await command(app, 'edit', {
      file: path,
      agent: 'ag_1',
      edits: [
        { match: 'Keep me, says the user.', replace: 'Kept.' },
        { match: '# Plan', replace: '# Plan\n\nIntro.' },
      ],
    })
    expect(batch).toEqual({ applied: [
      { line: 7, match: 'Keep me, says the user.', replace: 'Kept.' },
      { line: 1, match: '# Plan', replace: '# Plan\n\nIntro.' },
    ] })
    expect((await app.getState()).activeDocument!.content).toBe('# Plan\n\nIntro.\n\nRewritten passage.\n\nKept.\n')
  })

  it('refuses a stale or overlapping edit without changing anything', async () => {
    const { app, path, store } = await fixture('First same phrase.\n\nSecond same phrase.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Editor', timeout: 0 })
    const before = (await app.getState()).activeDocument!.content

    await expect(command(app, 'edit', {
      file: path,
      agent: 'ag_1',
      edits: [
        { match: 'First', replace: 'Valid' },
        { match: 'gone phrase', replace: 'x' },
        { match: 'same phrase', replace: 'y' },
      ],
    })).rejects.toMatchObject({
      exitCode: 3,
      code: 'QUOTE_INVALID',
      message: 'One or more matches are invalid',
      detail: [
        expect.objectContaining({
          index: 1, quote: 'gone phrase', reason: 'missing',
          candidates: expect.arrayContaining([expect.objectContaining({ quote: expect.stringContaining('same phrase') })]),
          hint: expect.stringContaining('buffer file'),
        }),
        expect.objectContaining({ index: 2, reason: 'ambiguous', total: 2, hint: expect.stringContaining('--preceded-by') }),
      ],
    })
    // Exactly one bad match puts its own message at the top level.
    await expect(command(app, 'edit', {
      file: path, agent: 'ag_1', edits: [{ match: 'First  same', replace: 'y' }],
    })).rejects.toMatchObject({
      message: expect.stringContaining('whitespace normalization'),
      detail: [expect.objectContaining({ reason: 'whitespace', total: 1, exact: 'First same' })],
    })
    // Two places match once whitespace is normalized: still missing, with both listed.
    await expect(command(app, 'edit', {
      file: path, agent: 'ag_1', edits: [{ match: 'same  phrase', replace: 'y' }],
    })).rejects.toMatchObject({
      detail: [expect.objectContaining({ reason: 'missing', total: 2, candidates: [expect.objectContaining({ line: 1 }), expect.objectContaining({ line: 3 })] })],
    })

    await expect(command(app, 'edit', {
      file: path,
      agent: 'ag_1',
      edits: [
        { match: 'First same', replace: 'a' },
        { match: 'same phrase', replace: 'b', precededBy: 'First ' },
      ],
    })).rejects.toMatchObject({
      exitCode: 3,
      code: 'EDITS_OVERLAP',
      message: 'Edits 1 and 2 overlap in the buffer',
      detail: { edits: [0, 1], matches: ['First same', 'same phrase'] },
    })

    const document = (await app.getState()).activeDocument!
    expect(document.content).toBe(before)
    expect(document.pendingHunks).toEqual([])
    expect((await storedApplication(store, path)).state.pendingHunks).toEqual([])

    // Context resolves the ambiguity; an empty replacement deletes the passage.
    await command(app, 'edit', {
      file: path,
      agent: 'ag_1',
      edits: [{ match: 'same phrase', replace: 'phrase', followedBy: '.\n\nSecond' }],
    })
    await command(app, 'edit', {
      file: path,
      agent: 'ag_1',
      edits: [{ match: ' same', replace: '', precededBy: 'Second' }],
    })
    expect((await app.getState()).activeDocument!.content).toBe('First phrase.\n\nSecond phrase.\n')
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
    await app.flushPersistence(path)
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
    // The legacy threshold is a file mtime from the kernel's coarse clock; an
    // edit and a Save inside the same millisecond can land on either side of
    // it. A person's edit precedes their Save by far more than a clock tick.
    await new Promise((resolve) => setTimeout(resolve, 10))
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

describe('agent surface, round 2', () => {
  it('refuses annotate, edit, and reply under an id the document does not know', async () => {
    const { app, path } = await fixture('Body text.\n')
    await app.openDocument(path)
    const refusal = {
      exitCode: 2,
      code: 'ATTACHMENT_NOT_FOUND',
      message: expect.stringContaining('run stratamd attach first'),
      detail: { agent: 'ag_ghost', file: path },
    }
    await expect(command(app, 'annotate', {
      file: path, agent: 'ag_ghost', annotations: [{ kind: 'comment', quote: 'Body', text: 'x' }],
    })).rejects.toMatchObject(refusal)
    await expect(command(app, 'edit', {
      file: path, agent: 'ag_ghost', edits: [{ match: 'Body', replace: 'Text' }],
    })).rejects.toMatchObject(refusal)
    await expect(command(app, 'reply', {
      file: path, agent: 'ag_ghost', annotation: 'a_none', text: 'x',
    })).rejects.toMatchObject(refusal)
    expect((await app.getState()).activeDocument?.content).toBe('Body text.\n')
  })

  it('inserts without an anchor: an empty match with a context, --append, and --dry-run', async () => {
    const { app, path } = await fixture('# Doc\n\nBody.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Editor', timeout: 0 })

    const preview = await command(app, 'edit', {
      file: path, agent: 'ag_1', dryRun: true,
      edits: [{ match: '', precededBy: '', replace: 'Top\n\n' }, { match: 'Body.', replace: 'Text.' }],
    })
    expect(preview).toEqual({ located: [{ line: 1, match: '' }, { line: 3, match: 'Body.' }] })
    expect((await app.getState()).activeDocument?.content).toBe('# Doc\n\nBody.\n')

    const result = await command(app, 'edit', {
      file: path, agent: 'ag_1',
      edits: [
        { match: '', precededBy: '', replace: 'Top\n\n' },
        { match: '', append: true, replace: '\nEnd.\n' },
        { match: '', precededBy: '# Doc\n', replace: '\nSub\n' },
      ],
    }) as { applied: Array<{ line: number; match: string; replace: string }> }
    expect(result.applied.map((entry) => entry.replace)).toEqual(['Top\n\n', '\nEnd.\n', '\nSub\n'])
    expect((await app.getState()).activeDocument?.content).toBe('Top\n\n# Doc\n\nSub\n\nBody.\n\nEnd.\n')

    // Ambiguous context is refused with every place it could mean.
    await expect(command(app, 'edit', {
      file: path, agent: 'ag_1', edits: [{ match: '', followedBy: '\n', replace: 'x' }],
    })).rejects.toMatchObject({ code: 'QUOTE_INVALID', detail: [expect.objectContaining({ reason: 'ambiguous' })] })
  })

  it('appends to an empty document', async () => {
    const { app, path } = await fixture('')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Editor', timeout: 0 })
    await command(app, 'edit', { file: path, agent: 'ag_1', edits: [{ match: '', append: true, replace: '# Fresh\n' }] })
    expect((await app.getState()).activeDocument?.content).toBe('# Fresh\n')
  })

  it('names the Lead holder in NOT_LEAD and LEAD_TAKEN, or says nobody holds it', async () => {
    const { app, path } = await fixture('# Lead\n\nText.\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_lead', name: 'Lead', timeout: 0 })
    await command(app, 'attach', { file: path, agent: 'ag_peer', name: 'Peer', timeout: 0 })
    await expect(command(app, 'save', { file: path, agent: 'ag_peer' })).rejects.toMatchObject({
      exitCode: 3,
      code: 'NOT_LEAD',
      message: expect.stringContaining('no agent holds the Lead; run stratamd lead'),
      detail: { holder: null },
    })
    await command(app, 'lead', { file: path, agent: 'ag_lead' })
    await expect(command(app, 'save', { file: path, agent: 'ag_peer' })).rejects.toMatchObject({
      code: 'NOT_LEAD',
      message: expect.stringContaining('(ag_lead) holds the Lead'),
      detail: { holder: { agent: 'ag_lead', name: expect.any(String) } },
    })
    await expect(command(app, 'lead', { file: path, agent: 'ag_peer' })).rejects.toMatchObject({
      code: 'LEAD_TAKEN',
      message: expect.stringContaining('(ag_lead) already holds the Lead'),
      detail: { holder: { agent: 'ag_lead' } },
    })
  })

  it('delivers hunks with one context line each side and lines against the delivered buffer', async () => {
    const { app, path, store } = await fixture('# T\n\nline a\nline b\nline c\n')
    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    await command(app, 'attach', { file: path, agent: 'ag_2', name: 'Other', timeout: 0 })

    await app.updateBuffer(path, '# T\n\nline a\nline B\nline c\n')
    // A send to the other agent ends the first round; the next edit lands in a later segment.
    await app.send(path, { recipients: ['ag_2'], note: '', includeExternal: false })
    await app.updateBuffer(path, 'intro\n# T\n\nline a\nline B\nline c\n')
    await app.send(path, { recipients: ['ag_1'], note: '', includeExternal: false })

    const delivery = (await storedApplication(store, path)).attachments.ag_1?.deliveries[0]
    const hunks = (delivery?.payload.segments ?? []).flatMap((segment) => segment.hunks)
    const changed = hunks.find((hunk) => hunk.added.includes('line B'))
    expect(changed).toMatchObject({
      removed: ['line b'], added: ['line B'],
      contextBefore: ['line a'], contextAfter: ['line c'],
      newStart: 4,
      // Mapped through the later top insertion: line 5 of the buffer the recipient reads.
      line: 5,
    })
    const inserted = hunks.find((hunk) => hunk.added.includes('intro'))
    expect(inserted).toMatchObject({ contextBefore: [], contextAfter: ['# T'], line: 1 })
    expect(delivery?.payload.text).toContain(' line a\n-line b\n+line B\n line c')
  })
})

describe('rail timestamps (plan 5.5, 5.6)', () => {
  it('stamps hunks with when they were recorded and attachments with when the agent last called', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-application-'))
    const path = join(root, 'plan.md')
    await writeFile(path, 'Original.\n')
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
    let clock = 1_000_000
    const app = await createStrataApplication({ store, settingsStore, watch: false, now: () => clock })

    await app.openDocument(path)
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    expect((await app.getState()).activeDocument?.attachments[0]).toMatchObject({ state: 'working', lastCallAt: 1_000_000 })

    // An edit the agent lands in the buffer is a change, not a call.
    clock = 2_000_000
    await store.writeBuffer(path, 'Agent edit.\n')
    await app.recheckFocused()
    let document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]?.changedAt).toBe(2_000_000)
    expect(document.attachments[0]?.lastCallAt).toBe(1_000_000)

    // The stamp holds as the clock moves on; the agent's next attach call updates only the attachment.
    clock = 3_000_000
    await command(app, 'attach', { file: path, agent: 'ag_1', name: 'Agent', timeout: 0 })
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks[0]?.changedAt).toBe(2_000_000)
    expect(document.attachments[0]?.lastCallAt).toBe(3_000_000)

    // The stamp is written with the hunk and survives a close (saving keeps the
    // hunk pending, PRD §6.9) and a reopen.
    await app.flushPersistence()
    expect((await store.loadMeta(path)).pendingHunks[0]).toMatchObject({ changedAt: 2_000_000 })
    await expect(app.closeDocument(path, 'save')).resolves.toBe('closed')
    clock = 4_000_000
    await app.openDocument(path)
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]?.changedAt).toBe(2_000_000)
  })
})
