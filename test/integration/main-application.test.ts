import { mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createAnnotation, createAnnotationLog, isHunkVerdict } from '../../src/core/annotations'
import type { StrataApplication } from '../../src/main/application'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'
import { tableReferences } from '../../src/main/tables'
import { defaultTableView } from '../../src/shared/tables'
import { attach, createStrataApplication, deliveryPayloads, FakeEngine, fixture, post, settleDeliveries, storedApplication } from './support/cockpit'

const range = (source: string, quote: string) => ({ quote, from: source.indexOf(quote), to: source.indexOf(quote) + quote.length })
const twoThreads = { threads: [{ id: 't_a', title: 'Agent A' }, { id: 't_b', title: 'Agent B' }] }

describe('StrataApplication: drafts and quick send', () => {
  it('quick sends one comment while held drafts stay private and durable', async () => {
    const source = '# Plan\n\nFirst sentence. Second sentence. Third sentence.\n'
    const value = await fixture(source, twoThreads)
    await value.app.openDocument(value.path)
    await attach(value, 't_a')
    await attach(value, 't_b')
    const first = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Held first.', ...range(source, 'First sentence') })
    const second = await value.app.holdDraft(value.path, { kind: 'question', text: 'Held second?', ...range(source, 'Second sentence') })
    const deliveries = await value.app.quickSend(value.path, { kind: 'suggestion', text: 'Third line.', recipients: ['t_a'], ...range(source, 'Third sentence') })

    expect(deliveries).toHaveLength(1)
    const document = (await value.app.getState()).activeDocument!
    expect(document.drafts.map((draft) => draft.id)).toEqual([first, second])
    expect(document.annotations).toHaveLength(1)
    expect(document.content).toBe(source)
    const stored = await storedApplication(value.store, value.path)
    const payload = stored.attachments.t_a!.deliveries[0]!.payload
    expect(payload.annotations).toHaveLength(1)
    expect(payload.annotations![0]).toMatchObject({ text: 'Third line.', quote: 'Third sentence' })
    expect(JSON.stringify(payload)).not.toContain('Held first')
    expect(JSON.stringify(payload)).not.toContain('Held second')
    // The turn the engine received carries exactly that delivery and nothing private.
    const turn = value.engine.deliveries('t_a').at(-1)!
    expect(turn.attachment?.text).toContain('Third line.')
    expect(turn.attachment?.text).not.toContain('Held')
    expect(value.engine.deliveries('t_b')).toHaveLength(1)
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).drafts, 'utf8')).drafts).toHaveLength(2)
  })

  it('quick send survives reopen without consuming pending edits or annotation events', async () => {
    const source = '# Plan\n\nFirst sentence. Second sentence. Third sentence.\n'
    const edited = source.replace('First sentence', 'Edited first sentence')
    const value = await fixture(source, twoThreads)
    await value.app.openDocument(value.path)
    await attach(value, 't_a')
    await attach(value, 't_b')
    await value.app.updateBuffer(value.path, edited)
    const earlierId = await value.app.addAnnotation(value.path, { kind: 'question', text: 'Earlier question?', ...range(edited, 'Second sentence') })
    const beforeQuick = await value.store.loadMeta(value.path)
    const [quickDeliveryId] = await value.app.quickSend(value.path, { kind: 'comment', text: 'Quick comment.', recipients: ['t_a'], ...range(edited, 'Third sentence') })
    const quickId = (await value.app.getState()).activeDocument!.annotations.find((annotation) => annotation.text === 'Quick comment.')!.id
    const quickSeq = (await value.store.loadMeta(value.path)).annotationEvents.find((event) => (event as { annotationId?: string }).annotationId === quickId) as { seq: number }

    const quick = (await storedApplication(value.store, value.path)).attachments.t_a!.deliveries[0]!.payload
    expect(quick.event).toBe('send')
    expect(quick.segments).toBeUndefined()
    expect(quick.partial).toBeUndefined()
    expect(quick.annotations).toEqual([expect.objectContaining({ id: quickId })])
    expect(value.engine.deliveries('t_a').at(-1)).toMatchObject({ messageId: quickDeliveryId, commandId: `strata-${quickDeliveryId}` })
    expect(value.engine.deliveries('t_b')).toHaveLength(1)

    // A restart repeats the unacknowledged delivery with the same id, then the engine acknowledges it.
    const reopened = await value.restart()
    await reopened.openDocument(value.path)
    await reopened.resolveRecovery(value.path, 'recover')
    await expect.poll(() => value.engine.deliveries('t_a').length).toBe(3)
    expect(value.engine.deliveries('t_a').at(-1)).toMatchObject({ messageId: quickDeliveryId, commandId: `strata-${quickDeliveryId}` })
    value.engine.acknowledge('t_a', quickDeliveryId!)
    await settleDeliveries(value, 't_a')
    const afterQuickAck = await value.store.loadMeta(value.path)
    expect(afterQuickAck.attachments.t_a).toMatchObject({
      baselineBlob: beforeQuick.attachments.t_a!.baselineBlob,
      segmentIndex: beforeQuick.attachments.t_a!.segmentIndex,
      cursor: beforeQuick.attachments.t_a!.cursor,
    })
    expect(afterQuickAck.attachments.t_a!.deliveredSeqs).toContain(quickSeq.seq)
    expect(afterQuickAck.attachments.t_b!.deliveredSeqs).toContain(quickSeq.seq)

    const request = { recipients: ['t_a'], note: '', includeExternal: false }
    const [previewA] = await reopened.previewSend(value.path, request)
    const [previewB] = await reopened.previewSend(value.path, { ...request, recipients: ['t_b'] })
    for (const preview of [previewA!, previewB!]) {
      expect(preview.items.changes).not.toHaveLength(0)
      expect(preview.items.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'annotation', text: 'Earlier question?' })]))
      expect(preview.items.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Quick comment.' })]))
    }

    await reopened.send(value.path, { ...request, token: previewA!.token })
    const sent = (await storedApplication(value.store, value.path)).attachments.t_a!.deliveries.at(-1)!.payload
    expect(sent.segments).not.toHaveLength(0)
    expect(sent.annotations).toEqual([expect.objectContaining({ id: earlierId })])
    expect(sent.annotations).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: quickId })]))

    await reopened.reply(value.path, quickId, 'Later reply.')
    const [replyPreview] = await reopened.previewSend(value.path, { recipients: ['t_b'], note: '', includeExternal: false })
    const replySeq = (await value.store.loadMeta(value.path)).annotationEvents.findLast((event) => (event as { annotationId?: string }).annotationId === quickId) as { seq: number }
    await reopened.send(value.path, {
      recipients: ['t_b'], note: '', includeExternal: false,
      excludedHunks: replyPreview!.items.changes.map((item) => item.key),
      excludedEvents: replyPreview!.items.events.filter((item) => item.seq !== replySeq.seq).map((item) => item.seq),
      token: replyPreview!.token,
    })
    const replyDelivery = (await storedApplication(value.store, value.path)).attachments.t_b!.deliveries.at(-1)!.payload
    expect(replyDelivery.annotations).toEqual([])
    expect(replyDelivery.replies).toEqual([expect.objectContaining({ annotation: quickId, parent: expect.objectContaining({ text: 'Quick comment.' }) })])
  })

  it('quick send settles the comment for every attachment without hiding it from the document', async () => {
    const source = '# Plan\n\nOne sentence.\n'
    const value = await fixture(source, twoThreads)
    await value.app.openDocument(value.path)
    await attach(value, 't_a')
    await attach(value, 't_b')
    await value.app.quickSend(value.path, { kind: 'comment', text: 'Only Agent A receives this.', recipients: ['t_a'], ...range(source, 'One sentence') })

    const document = (await value.app.getState()).activeDocument!
    expect(document.canSend).toBe(false)
    expect(document.annotations.map((annotation) => annotation.text)).toEqual(['Only Agent A receives this.'])
    expect(value.engine.deliveries('t_a')).toHaveLength(2)
    expect(value.engine.deliveries('t_b')).toHaveLength(1)
  })

  it('quick send works without a baseline and the following Send resyncs with the comment', async () => {
    const source = '# Plan\n\nOne sentence.\n'
    const value = await fixture(source, twoThreads)
    await value.app.openDocument(value.path)
    await attach(value, 't_a')
    await value.app.flushPersistence()
    const baseline = (await value.store.loadMeta(value.path)).attachments.t_a!.baselineBlob
    await rename(join(value.store.objectsDirectory, baseline), join(value.root, 'missing-baseline'))

    const [quickId] = await value.app.quickSend(value.path, { kind: 'comment', text: 'Quick without baseline.', recipients: ['t_a'], ...range(source, 'One sentence') })
    const [quick] = await deliveryPayloads(value.store, value.path, 't_a')
    expect(quick!.payload).toMatchObject({ event: 'send', annotations: [expect.objectContaining({ text: 'Quick without baseline.' })] })
    value.engine.acknowledge('t_a', quickId!)
    await settleDeliveries(value, 't_a')

    await value.app.send(value.path, { recipients: ['t_a'], note: '', includeExternal: false })
    const [resync] = await deliveryPayloads(value.store, value.path, 't_a')
    expect(resync!.payload.event).toBe('resync')
    expect(resync!.payload.annotations).toEqual([expect.objectContaining({ text: 'Quick without baseline.' })])
    expect(value.engine.deliveries('t_a').at(-1)!.attachment?.text).toContain('One sentence.')
  })

  it('materializes only checked drafts and offers the unchecked draft again', async () => {
    const source = '# Plan\n\nAlpha. Beta.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await attach(value, 't1')
    const first = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Send alpha.', ...range(source, 'Alpha') })
    const second = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Keep beta.', ...range(source, 'Beta') })
    const request = { recipients: ['t1'], note: '', includeExternal: false, draftIds: [first] }
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

  it('enables Send for a held draft only once a thread is attached', async () => {
    const source = '# Plan\n\nHold this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await value.app.holdDraft(value.path, { kind: 'comment', text: 'Send this later.', ...range(source, 'Hold this passage') })

    expect((await value.app.getState()).activeDocument?.canSend).toBe(false)
    await attach(value, 't1')
    expect((await value.app.getState()).activeDocument?.canSend).toBe(true)
  })

  it('keeps a selected draft private when delivery enqueue fails', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await attach(value, 't1')
    const id = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Still private.', ...range(source, 'Keep this passage') })

    await expect(value.app.send(value.path, { recipients: ['t1'], note: 'x'.repeat(64 * 1_024 + 1), includeExternal: false, draftIds: [id] })).rejects.toThrow('Delivery note exceeds the 64 KB limit')

    const document = (await value.app.getState()).activeDocument!
    expect(document.drafts.map((draft) => draft.id)).toEqual([id])
    expect(document.annotations).toEqual([])
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).drafts, 'utf8')).drafts).toEqual([expect.objectContaining({ id })])
  })

  it('keeps drafts when malformed reading state is discarded', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    const id = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Private note.', ...range(source, 'Keep this passage') })
    await value.app.closeDocument(value.path)
    await writeFile(value.store.pathsForDocument(value.path).reading, '{malformed')
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.drafts.map((draft) => draft.id)).toEqual([id])
  })

  it('opens with no drafts and preserves a malformed private draft store', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    await value.app.holdDraft(value.path, { kind: 'comment', text: 'Private note.', ...range(source, 'Keep this passage') })
    await value.app.closeDocument(value.path)
    const draftPath = value.store.pathsForDocument(value.path).drafts
    await writeFile(draftPath, '{malformed')

    await value.app.openDocument(value.path)

    expect((await value.app.getState()).activeDocument?.drafts).toEqual([])
    const preserved = (await readdir(value.store.pathsForDocument(value.path).directory)).find((name) => name.startsWith('drafts.json.broken-'))
    expect(preserved).toBeDefined()
    expect(await readFile(join(value.store.pathsForDocument(value.path).directory, preserved!), 'utf8')).toBe('{malformed')
  })

  it('drops a stored draft whose annotation was already persisted', async () => {
    const source = '# Plan\n\nKeep this passage.\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    const from = source.indexOf('Keep this passage')
    const id = await value.app.holdDraft(value.path, { kind: 'comment', text: 'Already sent.', quote: 'Keep this passage', from, to: from + 'Keep this passage'.length })
    await value.app.closeDocument(value.path)
    const meta = await value.store.loadMeta(value.path)
    const materialized = createAnnotation(createAnnotationLog(), source, { id, kind: 'comment', author: 'user', quote: 'Keep this passage', text: 'Already sent.', start: from, createdAt: 1 }).log
    await value.store.saveMeta({ ...meta, annotations: materialized.annotations, annotationEvents: materialized.events, nextAnnotationSeq: materialized.nextSeq })

    await value.app.openDocument(value.path)

    expect((await value.app.getState()).activeDocument?.drafts).toEqual([])
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).drafts, 'utf8')).drafts).toEqual([])
  })
})

describe('StrataApplication: reading state, tables, and the walkthrough', () => {
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
    const reopened = await value.restart()
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.reading).toMatchObject({ navigationTab: 'contents', reviewTab: 'annotations' })
  })

  it('persists table views outside meta.json and drops a table whose identity disappears', async () => {
    const source = '# Report\n\n## Islands\n\n| Name | Score |\n| --- | ---: |\n| Alpha | 12 |\n| Beta | 3 |\n'
    const value = await fixture(source)
    await value.app.openDocument(value.path)
    const metaBefore = await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')
    const table = tableReferences(source)[0]!
    const state = { ...defaultTableView(table), presentation: 'compare' as const, sort: { column: 1, direction: 'descending' as const }, hiddenColumns: [1], selectedRows: [0, 1], focusedRow: 1, focusedColumn: 0, density: 'compact' as const, columnWidths: [240, 110] }
    await value.app.updateTableView(value.path, state)
    expect((await value.app.getState()).activeDocument?.reading.tables).toEqual([state])
    expect(await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')).toBe(metaBefore)

    await value.app.closeDocument(value.path)
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.reading.tables).toEqual([state])
    const reopened = await value.restart()
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
    await attach(value, 't1')
    const quote = '| Alpha | Unprotected |'
    const from = source.indexOf(quote)
    const context = { kind: 'table-cell' as const, heading: 'Islands', columns: ['Name', 'Verdict'], column: { index: 1, label: 'Verdict' } }
    const id = await value.app.addAnnotation(value.path, { kind: 'question', quote, text: 'What protects this?', from, to: from + quote.length, context })
    const annotation = (await value.app.getState()).activeDocument?.annotations.find((candidate) => candidate.id === id)
    expect(annotation).toMatchObject({ id, quote, context })
    const preview = await value.app.previewSend(value.path, { recipients: ['t1'], note: '', includeExternal: false })
    expect(preview[0]?.text).toContain('[Table under Islands; columns Name, Verdict; column 2 Verdict]')
  })

  it('keeps reading choices session-only for invalid UTF-8 without creating a ghost entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-reading-invalid-'))
    const path = join(root, 'invalid.md')
    await writeFile(path, Buffer.from([0xff, 0xfe]))
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const app = await createStrataApplication({ store, settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine: new FakeEngine(), watch: false })
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
    const marker = async () => (await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!.status
    expect(await marker()).toBe('reviewed')
    expect(await readFile(value.store.pathsForDocument(value.path).meta, 'utf8')).toBe(metaBefore)

    const userEdit = original.replace('Body.', 'User changed body.')
    await value.app.updateBuffer(value.path, userEdit)
    expect(await marker()).toBe('revisit')
    await value.app.updateBuffer(value.path, original, 'history')
    expect(await marker()).toBe('reviewed')
    await value.app.updateBuffer(value.path, userEdit, 'history')
    expect(await marker()).toBe('revisit')
    await value.app.updateBuffer(value.path, original, 'history')
    expect(await marker()).toBe('reviewed')

    // An agent edit arrives through its strata block (§5.9) and counts like any other change to the section.
    await attach(value, 't1')
    expect(await post(value, 't1', [{ verb: 'edit', anchor: { document: value.path, quote: 'Body.' }, match: 'Body.', replace: 'Agent body.' }])).toEqual(['1. applied'])
    const changed = (await value.app.getState()).activeDocument!
    expect(changed.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.revertHunk(value.path, changed.pendingHunks[0]!.id)
    expect(await marker()).toBe('reviewed')

    const outsideEdit = original.replace('Body.', 'Outside body.')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await value.store.writeBuffer(value.path, outsideEdit)
    await value.app.recheckFocused()
    let outside = (await value.app.getState()).activeDocument!
    expect(outside.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.keepHunk(value.path, outside.pendingHunks[0]!.id)
    expect(await marker()).toBe('revisit')
    await expect(value.app.undo(value.path)).resolves.toBe('undone')
    outside = (await value.app.getState()).activeDocument!
    expect(outside.reading.walkthrough.markers[0]!.status).toBe('revisit')
    await value.app.revertHunk(value.path, outside.pendingHunks[0]!.id)
    expect(await marker()).toBe('reviewed')

    await post(value, 't1', [{ verb: 'suggest', anchor: { document: value.path, quote: 'Body.' }, replacement: 'Suggested body.' }])
    const suggestion = (await value.app.getState()).activeDocument!.annotations.find((annotation) => annotation.kind === 'suggestion')!
    await value.app.acceptSuggestion(value.path, suggestion.id)
    expect(await marker()).toBe('revisit')
    await expect(value.app.undo(value.path)).resolves.toBe('undone')
    expect(await marker()).toBe('reviewed')
    await expect(value.app.redo(value.path)).resolves.toBe('redone')
    expect(await marker()).toBe('revisit')
    await expect(value.app.undo(value.path)).resolves.toBe('undone')
    expect(await marker()).toBe('reviewed')

    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).reading, 'utf8'))).toMatchObject({ formatVersion: 4, navigationTab: 'contents', walkthrough: { active: true, markers: [{ status: 'reviewed' }] } })
  })

  it('relocates a unique walkthrough marker on reopen and drops it when the heading becomes ambiguous', async () => {
    const original = '# Old title\n\n## One\n\nBody.\n\n## Two\n\nEnd.\n'
    const value = await fixture(original)
    await value.app.openDocument(value.path)
    await value.app.updateWalkthrough(value.path, { type: 'start' })
    const first = (await value.app.getState()).activeDocument!.reading.walkthrough.current!
    await value.app.updateWalkthrough(value.path, { type: 'mark', heading: first, status: 'reviewed' })
    await expect(value.app.closeDocument(value.path)).resolves.toBe('closed')

    await writeFile(value.path, original.replace('# Old title', '# New title'))
    await value.app.openDocument(value.path)
    const marker = (await value.app.getState()).activeDocument!.reading.walkthrough.markers[0]!
    expect(marker).toMatchObject({ status: 'reviewed', heading: { text: 'One', parentText: 'New title' } })
    expect(JSON.parse(await readFile(value.store.pathsForDocument(value.path).reading, 'utf8'))).toMatchObject({ walkthrough: { markers: [{ heading: { text: 'One', parentText: 'New title' } }] } })
    await expect(value.app.closeDocument(value.path)).resolves.toBe('closed')

    await writeFile(value.path, '# New title\n\n## One\n\nFirst.\n\n## Middle\n\nMiddle.\n\n## One\n\nSecond.\n')
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument!.reading.walkthrough.markers).toEqual([])
  })
})

describe('StrataApplication: the buffer, the mirror, and Save', () => {
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

  it('stamps annotations and replies with a creation time the conversation can show', async () => {
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
})

describe('StrataApplication: agent work in the buffer, previews, and suggestions', () => {
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
    // Editor transactions report the source-identity rename before the 180 ms buffer mirror reaches the main process.
    await value.app.updateFold(value.path, renamed, true)
    expect((await value.app.getState()).activeDocument?.reading.foldedHeadings).toEqual([original, renamed])
    await value.app.updateBuffer(value.path, after)
    await value.app.flushPersistence()

    const reopened = await value.restart()
    await reopened.openDocument(value.path)
    expect((await reopened.getState()).activeDocument?.reading.foldedHeadings).toEqual([renamed])
  })

  it('accepts into shadow and ghost while remapping later annotations', async () => {
    const original = 'Use the old phrase here. Later note.\n'
    const value = await fixture(original)
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'suggest', anchor: { document: path, quote: 'old phrase' }, replacement: 'new wording' }])
    await app.addAnnotation(path, { kind: 'comment', text: 'Keep this.', ...range(original, 'Later note') })
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

  it('accepts and rejects all open suggestions for one thread without touching another thread', async () => {
    const value = await fixture('abcdef\n', { threads: [{ id: 't_1', title: 'One' }, { id: 't_2', title: 'Two' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't_1')
    await attach(value, 't_2')
    await post(value, 't_1', [
      { verb: 'suggest', anchor: { document: path, quote: 'bcd' }, replacement: 'B' },
      { verb: 'suggest', anchor: { document: path, quote: 'cd' }, replacement: 'C' },
      { verb: 'suggest', anchor: { document: path, quote: 'ef' }, replacement: 'E' },
    ])
    await post(value, 't_2', [{ verb: 'suggest', anchor: { document: path, quote: 'a' }, replacement: 'A' }])

    const accepted = await app.acceptAllSuggestions(path, 't_1')
    expect(accepted.accepted).toHaveLength(2)
    expect(accepted.skipped).toHaveLength(1)
    expect((await app.getState()).activeDocument?.content).toBe('aBE\n')
    expect((await storedApplication(store, path)).state.ghost).toBe('aBE\n')

    const rejected = await app.rejectAllSuggestions(path, 't_2')
    expect(rejected).toHaveLength(1)
    const stored = await storedApplication(store, path)
    expect(Object.values(stored.annotations.annotations).find((item) => item.agent === 't_2')).toMatchObject({ resolution: 'rejected' })
  })

  it('keeps annotation events recipient-specific and enables Send only for unsent work', async () => {
    const value = await fixture('The old wording stays.\n', { threads: [{ id: 't_author', title: 'Author' }, { id: 't_peer', title: 'Peer' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't_author')
    await attach(value, 't_peer')
    await post(value, 't_author', [{ verb: 'suggest', anchor: { document: path, quote: 'old wording' }, replacement: 'new wording' }])
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await app.acceptSuggestion(path, suggestion.id)
    expect((await app.getState()).activeDocument?.canSend).toBe(true)

    const request = { recipients: ['t_author', 't_peer'], note: '', includeExternal: false }
    const previews = await app.previewSend(path, request)
    expect(previews[0]?.text).toContain(`${suggestion.id} (suggestion) was accepted.`)
    expect(previews[1]?.text).not.toContain(`${suggestion.id} (suggestion) was accepted.`)
    await app.send(path, request)
    expect((await app.getState()).activeDocument?.canSend).toBe(false)

    const queued = (await storedApplication(store, path)).attachments
    expect(queued.t_author?.deliveries[0]?.payload.annotations ?? []).toHaveLength(0)
    expect(queued.t_author?.deliveries[0]?.payload.resolved).toHaveLength(1)
    expect(queued.t_peer?.deliveries[0]?.payload.annotations ?? []).toHaveLength(1)
    expect(queued.t_author?.deliveries[0]?.to.cursor).toBe(queued.t_peer?.deliveries[0]?.to.cursor)
  })

  it('sends a later reply without the thread it belongs to, and a thread\u2019s own reply enables nothing', async () => {
    const value = await fixture('The old wording stays.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.addAnnotation(path, { kind: 'comment', quote: 'old wording', text: 'Too vague.', from: 4, to: 15 })
    const annotationId = Object.keys((await storedApplication(store, path)).annotations.annotations)[0]!
    const request = { recipients: ['t1'], note: '', includeExternal: false }
    const [first] = await app.send(path, request)
    value.engine.acknowledge('t1', first!)
    await settleDeliveries(value, 't1')

    await post(value, 't1', [{ verb: 'reply', anchor: { item: annotationId }, text: 'Tightened it.' }])
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
    const value = await fixture('# Plan\n\nShip Friday.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await store.writeBuffer(path, '# Plan\n\nShip Thursday.\n')
    await app.recheckFocused()
    await app.updateBuffer(path, '# Plan\n\nShip Thursday with checks.\n')

    const [preview] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })
    expect(preview?.dependentExternalHunks).toBe(1)
  })

  it('offers only current unreviewed changes and safely clears resolved event records', async () => {
    const value = await fixture('Original.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await store.writeBuffer(path, 'Agent edit.\n')
    await app.recheckFocused()
    const [before] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: true })
    expect(before?.items.changes).toHaveLength(1)
    const hunk = (await app.getState()).activeDocument?.pendingHunks[0]
    expect(hunk).toBeTruthy()
    await app.keepHunk(path, hunk!.id)
    // Kept, the change is the owner's and no longer waits for review; it still travels as the owner's work.
    expect((await app.getState()).activeDocument?.pendingHunks).toEqual([])

    await post(value, 't1', [{ verb: 'suggest', anchor: { document: path, quote: 'Agent edit' }, replacement: 'Replacement' }])
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations).find((item) => item.kind === 'suggestion')!
    await app.rejectSuggestion(path, suggestion.id)
    await app.clearResolvedAnnotations(path)
    await expect(app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })).resolves.toHaveLength(1)
  })

  it('undoes Accept through the application and reopens its suggestion', async () => {
    const original = 'Use old wording here.\n'
    const value = await fixture(original)
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'suggest', anchor: { document: path, quote: 'old wording' }, replacement: 'new wording' }])
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await app.acceptSuggestion(path, suggestion.id)
    expect((await app.getState()).activeDocument?.content).toContain('new wording')
    await expect(app.undo(path)).resolves.toBe('undone')
    expect((await app.getState()).activeDocument?.content).toBe(original)
    expect((await app.getState()).activeDocument?.annotations[0]).toMatchObject({ status: 'open' })
  })

  it('an agent block edit is one application step: undo removes its hunk in order with the owner typing, redo lands it again', async () => {
    const original = '# Undo\n\nBase.\n'
    const value = await fixture(original)
    const { app, path } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.updateBuffer(path, '# Undo\n\nBase. Owner\n')
    const stepBefore = (await app.getState()).activeDocument!.historyStep
    await post(value, 't1', [{ verb: 'edit', anchor: { document: path, quote: 'Base. Owner' }, match: 'Owner', replace: 'Owner Agent.' }])
    let document = (await app.getState()).activeDocument!
    expect(document.content).toBe('# Undo\n\nBase. Owner Agent.\n')
    expect(document.pendingHunks.map((hunk) => hunk.author?.name)).toEqual(['Reviewer'])
    expect(document.historyStep).toBe(stepBefore + 1)

    await expect(app.undo(path)).resolves.toBe('undone')
    document = (await app.getState()).activeDocument!
    expect(document.content).toBe('# Undo\n\nBase. Owner\n')
    expect(document.pendingHunks).toHaveLength(0)
    await expect(app.redo(path)).resolves.toBe('redone')
    document = (await app.getState()).activeDocument!
    expect(document.content).toBe('# Undo\n\nBase. Owner Agent.\n')
    expect(document.pendingHunks).toHaveLength(1)
  })

  it('writes the canonical timeline with its blobs and keeps attachment metadata beside it', async () => {
    const value = await fixture('Original.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.updateBuffer(path, 'Changed.\n')
    await app.flushPersistence(path)
    const meta = await store.loadMeta(path)
    expect(meta.application).toBeUndefined()
    expect(meta.segments[0]).toMatchObject({ id: expect.any(String), beforeBlob: expect.any(String), afterBlob: expect.any(String) })
    expect(meta.snapshotBlobs).toEqual(expect.arrayContaining([meta.segments[0]!.beforeBlob, meta.segments[0]!.afterBlob]))
    expect(meta.attachments.t1).toMatchObject({ id: 't1', name: 'Reviewer' })
  })

  it('persists absolute segment indices and resyncs an old baseline after a capped-history restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-segment-offset-'))
    const path = join(root, 'history.md')
    await writeFile(path, 'zero\n')
    const dataDirectory = join(root, 'data')
    const configDirectory = join(root, 'config')
    const store = new GhostStore({ dataDirectory, segmentLimit: 2 })
    const settingsStore = new SettingsStore({ configDirectory })
    const engine = new FakeEngine([{ id: 't_stale', title: 'Stale thread' }, { id: 't_fresh', title: 'Fresh thread' }])
    const first = await createStrataApplication({ store, settingsStore, engine, watch: false })
    const value = { app: first, engine, path, store }
    await first.openDocument(path)
    await attach(value, 't_stale')
    await attach(value, 't_fresh')

    // Every Send to the fresh thread freezes a segment; the stale thread never hears from anyone.
    for (const content of ['one\n', 'two\n', 'three\n']) {
      await first.updateBuffer(path, content)
      const [id] = await first.send(path, { recipients: ['t_fresh'], note: '', includeExternal: false })
      engine.acknowledge('t_fresh', id!)
      await settleDeliveries(value, 't_fresh')
    }

    const capped = await store.loadMeta(path)
    expect(capped.segmentOffset).toBe(1)
    expect(capped.segments).toHaveLength(2)
    expect(capped.attachments.t_stale?.segmentIndex).toBe(-1)
    expect(capped.lastSentSegmentIndex).toBe(2)

    await expect(first.closeDocument(path, 'save')).resolves.toBe('closed')
    await first.shutdown()

    // A new store restores the absolute indices; the stale thread's next delivery is a resync of the whole document.
    const reopenedStore = new GhostStore({ dataDirectory, segmentLimit: 2 })
    const reopened = await createStrataApplication({ store: reopenedStore, settingsStore: new SettingsStore({ configDirectory }), engine, watch: false })
    const reopenedValue = { app: reopened, engine, path, store: reopenedStore }
    await reopened.openDocument(path)
    expect((await reopenedStore.loadMeta(path)).attachments.t_stale?.segmentIndex).toBe(-1)
    const [resyncId] = await reopened.send(path, { recipients: ['t_stale'], note: '', includeExternal: false })
    const [resync] = await deliveryPayloads(reopenedStore, path, 't_stale')
    expect(resync!.payload).toMatchObject({ event: 'resync', document: 'three\n' })
    expect(engine.deliveries('t_stale').at(-1)).toMatchObject({ messageId: resyncId })
    engine.acknowledge('t_stale', resyncId!)
    await settleDeliveries(reopenedValue, 't_stale')

    await reopened.updateBuffer(path, 'four\n')
    const [deliveryId] = await reopened.send(path, { recipients: ['t_stale'], note: '', includeExternal: false })
    const [incremental] = await deliveryPayloads(reopenedStore, path, 't_stale')
    expect(incremental).toMatchObject({ id: deliveryId, payload: { event: 'send', segments: [expect.objectContaining({ author: 'user' })] } })
    expect(incremental!.payload.document).toBeUndefined()
    expect(engine.deliveries('t_stale').at(-1)).toMatchObject({ messageId: deliveryId })

    const finalMeta = await reopenedStore.loadMeta(path)
    expect(finalMeta.segmentOffset).toBe(2)
    expect(finalMeta.segments).toHaveLength(2)
    expect(finalMeta.attachments.t_stale?.deliveries[0]).toMatchObject({ from: { segmentIndex: 2 }, to: { segmentIndex: 3 } })
  })
})

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
  const targets = await Promise.all(descriptors.map(async (descriptor) => readlink(join('/proc/self/fd', descriptor)).catch(() => null)))
  return targets.filter((target): target is string => target === path || target === `${path} (deleted)`)
}

describe('StrataApplication: file identity and annotation relocation', () => {
  it('follows an open document outside its parent and explorer roots without changing session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-fd-source-'))
    const outside = await mkdtemp(join(tmpdir(), 'stratamd-fd-outside-'))
    const path = join(root, 'source.md')
    const moved = join(outside, 'moved.md')
    await writeFile(path, '# Move\n\nFollow this session.\n')
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
    await settingsStore.update({ explorerFolders: [root] })
    const engine = new FakeEngine([{ id: 't_move', title: 'Moving thread' }])
    const app = await createStrataApplication({ store, settingsStore, engine, watch: false })
    await app.openDocument(path)
    await attach({ app, engine, path }, 't_move')
    const entry = store.pathsForDocument(path).directory

    await rename(path, moved)
    await app.recheckFocused()

    const view = await app.getState()
    expect(view.tabs).toEqual([expect.objectContaining({ path: moved, active: true })])
    expect(view.activeDocument).toMatchObject({ path: moved, attachments: [expect.objectContaining({ agent: expect.objectContaining({ id: 't_move' }) })] })
    expect(store.pathsForDocument(moved).directory).toBe(entry)
    expect(await store.loadMeta(moved)).toMatchObject({ realpath: moved, attachments: { t_move: expect.objectContaining({ id: 't_move' }) } })
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

    expect((await value.app.getState()).activeDocument).toMatchObject({ path: moved, content: '# Save then move\n\nEdited.\n', deleted: false })
    expect(await value.store.loadMeta(moved)).toMatchObject({ realpath: moved })
    expect(await trackedDescriptors(value.path)).toEqual([])
    expect(await trackedDescriptors(moved)).toHaveLength(trackedCount(1))
    await expect(value.app.closeDocument(moved)).resolves.toBe('closed')
    expect(await trackedDescriptors(moved)).toEqual([])
  })

  it('keeps a deleted session and attachment, then tracks the inode recreated by Save', async () => {
    const original = '# Delete\n\nOriginal.\n'
    const shadow = '# Delete\n\nUnsaved shadow.\n'
    const value = await fixture(original, { threads: [{ id: 't_delete', title: 'Delete thread' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't_delete')
    await app.updateBuffer(path, shadow)

    await rm(path)
    await app.recheckFocused()
    expect((await app.getState()).activeDocument).toMatchObject({ path, deleted: true, attachments: [expect.objectContaining({ agent: expect.objectContaining({ id: 't_delete' }) })] })
    expect(await store.loadMeta(path)).toMatchObject({ realpath: path, attachments: { t_delete: expect.objectContaining({ id: 't_delete' }) } })
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
    const value = await fixture(original)
    const { path, store } = value
    await value.app.openDocument(path)
    await value.app.addAnnotation(path, { kind: 'comment', text: 'Keep it.', ...range(original, 'exact phrase') })
    const created = await storedApplication(store, path)
    const annotationId = Object.keys(created.annotations.annotations)[0]!
    expect(await value.app.closeDocument(path)).toBe('closed')

    await writeFile(path, 'The quoted words are gone.\n')
    const orphanApp = await value.restart()
    await orphanApp.openDocument(path)
    const orphaned = await storedApplication(store, path)
    expect(Object.keys(orphaned.annotations.annotations)).toEqual([annotationId])
    expect(orphaned.annotations.annotations[annotationId]).toMatchObject({ status: 'orphaned' })
    expect(orphaned.annotations.events.map((event) => event.type)).toEqual(['created', 'orphaned'])
    expect(orphaned.annotations.nextSeq).toBe(3)
    expect(await orphanApp.closeDocument(path)).toBe('closed')

    await writeFile(path, `Restored ${original}`)
    const reattachApp = await value.restart()
    await reattachApp.openDocument(path)
    const reattached = await storedApplication(store, path)
    expect(Object.keys(reattached.annotations.annotations)).toEqual([annotationId])
    expect(reattached.annotations.annotations[annotationId]).toMatchObject({ status: 'open' })
    expect(reattached.annotations.events.map((event) => event.type)).toEqual(['created', 'orphaned', 'reattached'])
    expect(reattached.annotations.nextSeq).toBe(4)
    expect(await reattachApp.closeDocument(path)).toBe('closed')

    const secondReopen = await value.restart()
    await secondReopen.openDocument(path)
    const unchanged = await storedApplication(store, path)
    expect(unchanged.annotations.events).toEqual(reattached.annotations.events)
    expect(unchanged.annotations.nextSeq).toBe(reattached.annotations.nextSeq)
  })

  it('relocates annotations across external buffer merges once per edge', async () => {
    const original = 'Keep this exact phrase.\n'
    const { app, path, store } = await fixture(original)
    await app.openDocument(path)
    await app.addAnnotation(path, { kind: 'comment', text: 'Keep it.', ...range(original, 'exact phrase') })

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

  it('prefers canonical annotations over an equal-sequence legacy copy', async () => {
    const value = await fixture('Canonical quote.\n')
    const { path, store } = value
    await value.app.openDocument(path)
    await value.app.addAnnotation(path, { kind: 'comment', quote: 'Canonical', text: 'Current.', from: 0, to: 9 })
    const canonical = (await storedApplication(store, path)).annotations
    expect(await value.app.closeDocument(path)).toBe('closed')

    const meta = await store.loadMeta(path)
    await store.saveMeta({ ...meta, application: { annotations: { nextSeq: canonical.nextSeq, annotations: {}, events: [] } } })
    const reopened = await value.restart()
    await reopened.openDocument(path)
    expect((await storedApplication(store, path)).annotations).toEqual(canonical)
    expect((await store.loadMeta(path)).application).toBeUndefined()
  })

  it('uses a newer recovery buffer for the active snapshot and the first delivery', async () => {
    const original = '# Recovery\n\nSaved.\n'
    const recovered = '# Recovery\n\nUnsaved buffer.\n'
    const value = await fixture(original)
    const { app, path, store } = value
    await store.createDocument(path, original)
    await store.writeBuffer(path, recovered)

    await app.openDocument(path)
    expect((await app.getState()).activeDocument).toMatchObject({ content: recovered })
    // Recover keeps the newer buffer; the first delivery then carries it, not the saved file.
    await app.resolveRecovery(path, 'recover')
    await attach(value, 't1', { acknowledge: false })
    const [initial] = await deliveryPayloads(store, path, 't1')
    expect(initial!.payload).toMatchObject({ document: recovered })
    expect(['initial', 'resync']).toContain(initial!.payload.event)
    expect(value.engine.deliveries('t1')[0]!.attachment?.text).toContain('Unsaved buffer.')
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})

describe('StrataApplication: resolved-record retention', () => {
  it('keeps resolved records until every attachment has received them when retention is off', async () => {
    const value = await fixture('A quoted sentence.\n', { threads: [{ id: 't_1', title: 'One' }, { id: 't_2', title: 'Two' }] })
    await value.settingsStore.update({ keepResolvedAnnotations: false })
    const app = await value.restart()
    await app.openDocument(value.path)
    await app.addAnnotation(value.path, { kind: 'comment', quote: 'quoted sentence', text: 'Read this.', from: 2, to: 17 })
    const annotation = Object.values((await storedApplication(value.store, value.path)).annotations.annotations)[0]!
    await attach(value, 't_1')
    await attach(value, 't_2')

    await app.resolveAnnotation(value.path, annotation.id)
    let stored = await storedApplication(value.store, value.path)
    expect(stored.annotations.annotations[annotation.id]).toMatchObject({ status: 'resolved' })
    expect(stored.annotations.events.map((event) => event.type)).toEqual(['created', 'resolved'])

    const deliveries = await app.send(value.path, { recipients: ['t_1', 't_2'], note: '', includeExternal: false })
    stored = await storedApplication(value.store, value.path)
    expect(stored.attachments.t_1?.deliveries[0]?.payload.resolved).toEqual([expect.objectContaining({ id: annotation.id, resolution: 'resolved' })])

    value.engine.acknowledge('t_1', deliveries[0]!)
    await settleDeliveries(value, 't_1')
    stored = await storedApplication(value.store, value.path)
    expect(stored.annotations.annotations[annotation.id]).toBeDefined()
    expect(stored.annotations.events).toHaveLength(2)

    value.engine.acknowledge('t_2', deliveries[1]!)
    await settleDeliveries(value, 't_2')
    stored = await storedApplication(value.store, value.path)
    expect(stored.annotations.annotations[annotation.id]).toBeUndefined()
    expect(stored.annotations.events).toEqual([])
    expect(stored.annotations.nextSeq).toBe(3)
  })

  it('delivers an answer once before pruning a resolved decision', async () => {
    const value = await fixture('# Decision\n\nPick one.\n')
    await value.settingsStore.update({ keepResolvedAnnotations: false })
    const app = await value.restart()
    await app.openDocument(value.path)
    await attach(value, 't1')
    const [posted] = await post(value, 't1', [{ verb: 'decision', anchor: { document: value.path, quote: 'Pick one' }, text: 'Which?', options: ['A', 'B'] }])
    const decision = /applied as (a_[\w-]+)/u.exec(posted!)![1]!

    await app.answerDecision(value.path, decision, { option: 'A' })
    expect((await storedApplication(value.store, value.path)).annotations.annotations[decision]).toBeDefined()
    const [deliveryId] = await app.send(value.path, { recipients: ['t1'], note: '', includeExternal: false })
    expect((await storedApplication(value.store, value.path)).attachments.t1?.deliveries.at(-1)?.payload.answers).toEqual([expect.objectContaining({ annotation: decision, option: 'A' })])
    value.engine.acknowledge('t1', deliveryId!)
    await settleDeliveries(value, 't1')
    expect((await storedApplication(value.store, value.path)).annotations.annotations[decision]).toBeUndefined()
  })

  it('retains resolved records after delivery when retention is on until explicit Clear', async () => {
    const value = await fixture('A quoted sentence.\n')
    await value.settingsStore.update({ keepResolvedAnnotations: true })
    const app = await value.restart()
    await app.openDocument(value.path)
    await app.addAnnotation(value.path, { kind: 'comment', quote: 'quoted sentence', text: 'Read this.', from: 2, to: 17 })
    const annotation = Object.values((await storedApplication(value.store, value.path)).annotations.annotations)[0]!
    await attach(value, 't1')
    await app.resolveAnnotation(value.path, annotation.id)
    const [deliveryId] = await app.send(value.path, { recipients: ['t1'], note: '', includeExternal: false })
    value.engine.acknowledge('t1', deliveryId!)
    await settleDeliveries(value, 't1')

    expect((await storedApplication(value.store, value.path)).annotations.annotations[annotation.id]).toBeDefined()
    await app.clearResolvedAnnotations(value.path)
    expect((await storedApplication(value.store, value.path)).annotations.annotations[annotation.id]).toBeUndefined()
  })
})

describe('StrataApplication: agent block anchors', () => {
  it('returns closest text excerpts for a missing or ambiguous quote and applies the rest of the block', async () => {
    const content = 'First alpha target.\nSecond same phrase.\nThird same phrase.\n'
    const value = await fixture(content)
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')

    const outcomes = await post(value, 't1', [
      { verb: 'comment', anchor: { document: path, quote: 'First' }, text: 'Valid.' },
      { verb: 'question', anchor: { document: path, quote: 'alpha missing' }, text: 'Missing?' },
      { verb: 'comment', anchor: { document: path, quote: 'same phrase' }, text: 'Ambiguous.' },
    ])
    expect(outcomes[0]).toMatch(/^1\. applied as a_/u)
    expect(outcomes[1]).toBe('2. failed: quote missing: "alpha missing"; nearest: line 1: "First alpha target."')
    expect(outcomes[2]).toBe('3. failed: quote ambiguous (2 places): "same phrase"; nearest: line 2: "same phrase" | line 3: "same phrase"')
    // The valid entry landed; the two failures changed nothing else.
    const stored = await storedApplication(store, path)
    expect(Object.values(stored.annotations.annotations).map((annotation) => annotation.text)).toEqual(['Valid.'])
    expect(stored.annotations.events.map((event) => event.type)).toEqual(['created'])
    // The next delivery reports every outcome in order (plan §5.9).
    const [preview] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })
    expect(preview?.text).toContain('2. failed: quote missing')
    expect(preview?.text).toContain('3. failed: quote ambiguous (2 places)')
  })

  it('applies an edit as the thread\u2019s pending hunk against the live buffer', async () => {
    const original = '# Plan\n\nOriginal passage.\n\nKeep me.\n'
    const value = await fixture(original, { threads: [{ id: 't1', title: 'Editor' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    // The user's own unsaved edit sits elsewhere in the buffer and must survive.
    await app.updateBuffer(path, '# Plan\n\nOriginal passage.\n\nKeep me, says the user.\n')

    expect(await post(value, 't1', [{ verb: 'edit', anchor: { document: path, quote: 'Original passage.' }, match: 'Original passage.', replace: 'Rewritten passage.' }])).toEqual(['1. applied'])

    const expected = '# Plan\n\nRewritten passage.\n\nKeep me, says the user.\n'
    const document = (await app.getState()).activeDocument!
    expect(document.content).toBe(expected)
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({ removed: ['Original passage.'], added: ['Rewritten passage.'], author: expect.objectContaining({ id: 't1', name: 'Editor' }) })
    // The mirror follows on its debounce; the ghost and the file do not move.
    await expect.poll(async () => (await store.readBuffer(path))?.toString('utf8')).toBe(expected)
    expect((await storedApplication(store, path)).state.ghost).toBe(original)
    expect(await readFile(path, 'utf8')).toBe(original)

    // A block with several edits lands them in order against the buffer each one left behind.
    expect(await post(value, 't1', [
      { verb: 'edit', anchor: { document: path, quote: 'Keep me, says the user.' }, match: 'Keep me, says the user.', replace: 'Kept.' },
      { verb: 'edit', anchor: { document: path, quote: '# Plan' }, match: '# Plan', replace: '# Plan\n\nIntro.' },
    ])).toEqual(['1. applied', '2. applied'])
    expect((await app.getState()).activeDocument!.content).toBe('# Plan\n\nIntro.\n\nRewritten passage.\n\nKept.\n')
  })

  it('refuses a stale, ambiguous, or empty-match edit without changing anything, and context in the quote resolves it', async () => {
    const value = await fixture('First same phrase.\n\nSecond same phrase.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    const before = (await app.getState()).activeDocument!.content

    const outcomes = await post(value, 't1', [
      { verb: 'edit', anchor: { document: path, quote: 'gone phrase' }, match: 'gone phrase', replace: 'x' },
      { verb: 'edit', anchor: { document: path, quote: 'same phrase' }, match: 'same phrase', replace: 'y' },
      { verb: 'edit', anchor: { document: path, quote: 'First same phrase.' }, match: 'missing inside', replace: 'z' },
    ])
    expect(outcomes[0]).toMatch(/^1\. failed: quote missing: "gone phrase"; nearest: line \d: "/u)
    expect(outcomes[1]).toBe('2. failed: quote ambiguous (2 places): "same phrase"; nearest: line 1: "same phrase" | line 3: "same phrase"')
    expect(outcomes[2]).toBe('3. failed: edit match is missing or ambiguous in the block')
    const document = (await app.getState()).activeDocument!
    expect(document.content).toBe(before)
    expect(document.pendingHunks).toEqual([])
    expect((await storedApplication(store, path)).state.pendingHunks).toEqual([])

    // A longer quote picks the place; an empty replacement deletes the passage.
    expect(await post(value, 't1', [
      { verb: 'edit', anchor: { document: path, quote: 'First same phrase.' }, match: 'same phrase', replace: 'phrase' },
      { verb: 'edit', anchor: { document: path, quote: 'Second same phrase.' }, match: ' same', replace: '' },
    ])).toEqual(['1. applied', '2. applied'])
    expect((await app.getState()).activeDocument!.content).toBe('First phrase.\n\nSecond phrase.\n')
  })

  it('reports a moved suggestion on accept with the nearest excerpt instead of a bare refusal', async () => {
    const value = await fixture('# Lead\n\nOld wording stays here.\n\nOther text.\n', { threads: [{ id: 't_lead', title: 'Lead Agent' }, { id: 't_peer', title: 'Peer' }] })
    const { app, path } = value
    await app.openDocument(path)
    await attach(value, 't_lead')
    await attach(value, 't_peer')
    await post(value, 't_lead', [{ verb: 'lead', document: path, action: 'claim' }])
    const [posted] = await post(value, 't_peer', [{ verb: 'suggest', anchor: { document: path, quote: 'Old wording' }, replacement: 'New wording' }])
    const suggestionId = /applied as (a_[\w-]+)/u.exec(posted!)![1]!
    await app.updateBuffer(path, '# Lead\n\nRewritten by the user.\n\nOther text.\n')

    const [outcome] = await post(value, 't_lead', [{ verb: 'accept', anchor: { item: suggestionId } }])
    expect(outcome).toMatch(/^1\. failed: /u)
    expect(outcome).not.toContain('NOT_LEAD')
    expect((await app.getState()).activeDocument!.annotations.find((annotation) => annotation.id === suggestionId)).toMatchObject({ status: 'orphaned' })
  })
})

describe('StrataApplication: save-state classification', () => {
  it('classifies each pending hunk against the file, including the mixed case', async () => {
    const value = await fixture('# Plan\n\nOriginal.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')

    await store.writeBuffer(path, '# Plan\n\nOriginal.\n\nFirst agent line.\n')
    await app.recheckFocused()
    let document = (await app.getState()).activeDocument!
    expect(document.pendingHunks.map((hunk) => hunk.saved)).toEqual([false])
    expect(document.dirty).toBe(true)

    await app.save(path)
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks.map((hunk) => hunk.saved)).toEqual([true])
    expect(document.dirty).toBe(false)

    // One saved and one fresh external edit classify independently.
    await store.writeBuffer(path, '# Plan the second\n\nOriginal.\n\nFirst agent line.\n')
    await app.recheckFocused()
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks.map((hunk) => hunk.saved).sort()).toEqual([false, true])

    // Reverting a saved hunk restores text the file does not have: unsaved again.
    await app.save(path)
    const target = (await app.getState()).activeDocument!.pendingHunks[0]!
    await app.revertHunk(path, target.id)
    expect((await app.getState()).activeDocument!.dirty).toBe(true)
  })
})

describe('StrataApplication: undo and redo', () => {
  async function keptFixture(content = '# Plan\n\nOriginal.\n', proposal = '# Plan\n\nOriginal.\n\nAgent line.\n') {
    const value = await fixture(content)
    await value.app.openDocument(value.path)
    await attach(value, 't1')
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
    const value = await fixture(original)
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'suggest', anchor: { document: path, quote: 'old wording' }, replacement: 'new wording' }])
    const suggestion = Object.values((await storedApplication(store, path)).annotations.annotations)[0]!
    await app.acceptSuggestion(path, suggestion.id)
    const accepted = (await app.getState()).activeDocument!.content
    await app.addAnnotation(path, { kind: 'comment', text: 'Keep this.', ...range(accepted, 'Later note') })
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
    const previews = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })
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
    const previews = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })
    expect(previews[0]?.text).toContain('-Agent line.')
    expect((await storedApplication(store, path)).state.shadow).toBe(original)

    await expect(app.redo(path)).resolves.toBe('redone')
    document = (await app.getState()).activeDocument!
    expect(document.content).toBe(proposal)
    expect(document.pendingHunks.map((hunk) => hunk.id)).toEqual([hunkId])
  })

  it('Save and Send end the application history', async () => {
    for (const boundary of ['save', 'send'] as const) {
      const value = await fixture()
      const { app, path, store } = value
      await app.openDocument(path)
      await attach(value, 't1')
      await store.writeBuffer(path, '# Plan\n\nOriginal.\n\nAgent line.\n')
      await app.recheckFocused()
      const hunkId = (await app.getState()).activeDocument!.pendingHunks[0]!.id
      await app.keepHunk(path, hunkId)
      if (boundary === 'save') await app.save(path)
      else await app.send(path, { recipients: ['t1'], note: '', includeExternal: false })
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
      ['rejectAllSuggestions', (app, path) => app.rejectAllSuggestions(path, 't1')],
      ['clearResolvedAnnotations', (app, path) => app.clearResolvedAnnotations(path)],
    ]
    for (const [name, mutate] of mutations) {
      const value = await keptFixture()
      const { app, path, store, hunkId } = value
      await post(value, 't1', [
        { verb: 'comment', anchor: { document: path, quote: 'Agent line' }, text: 'Why?' },
        { verb: 'suggest', anchor: { document: path, quote: 'Agent line' }, replacement: 'Agent sentence' },
      ])
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

describe('StrataApplication: send composer semantics', () => {
  async function revertedFixture() {
    const value = await fixture('# Plan\n\nOriginal.\n', twoThreads)
    await value.app.openDocument(value.path)
    await attach(value, 't_a')
    await attach(value, 't_b')
    // Agent A edits through its block; the owner reverts that hunk.
    await post(value, 't_a', [{ verb: 'edit', anchor: { document: value.path, quote: 'Original.' }, match: 'Original.', replace: 'Agent line.' }])
    const hunk = (await value.app.getState()).activeDocument!.pendingHunks[0]!
    expect(hunk.author).toMatchObject({ id: 't_a' })
    await value.app.revertHunk(value.path, hunk.id)
    return value
  }

  it('a reverted hunk reaches others as a user diff and its author as a verdict', async () => {
    const { app, path } = await revertedFixture()
    const previews = await app.previewSend(path, { recipients: ['t_a', 't_b'], note: '', includeExternal: false })

    const author = previews.find((preview) => preview.recipient.id === 't_a')!
    expect(author.text).toContain('Your change was reverted: Agent line.')
    expect(author.text).not.toContain('Changes by user:')

    const peer = previews.find((preview) => preview.recipient.id === 't_b')!
    expect(peer.text).toContain('Changes by user:')
    expect(peer.text).not.toContain('Your change was reverted')
  })

  it('undoing the Revert retracts the verdict before it is delivered', async () => {
    const { app, path } = await revertedFixture()
    await expect(app.undo(path)).resolves.toBe('undone')
    const [author] = await app.previewSend(path, { recipients: ['t_a'], note: '', includeExternal: false })
    expect(author!.text).not.toContain('Your change was reverted')
  })

  it('with only the author attached, Send delivers the verdict and no diff, then goes quiet', async () => {
    const value = await fixture('# Plan\n\nOriginal.\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'edit', anchor: { document: path, quote: 'Original.' }, match: 'Original.', replace: 'Agent line.' }])
    const hunk = (await app.getState()).activeDocument!.pendingHunks[0]!
    await app.revertHunk(path, hunk.id)

    // The pending verdict for the author is deliverable content, so Send stays enabled.
    expect((await app.getState()).activeDocument!.canSend).toBe(true)
    const [deliveryId] = await app.send(path, { recipients: ['t1'], note: '', includeExternal: false })
    const delivery = (await storedApplication(store, path)).attachments.t1!.deliveries[0]!
    expect(delivery.payload.segments).toEqual([])
    expect(delivery.payload.edits).toEqual([{ seq: delivery.payload.edits![0]!.seq, verdict: 'reverted', quote: 'Agent line.' }])

    value.engine.acknowledge('t1', deliveryId!)
    await settleDeliveries(value, 't1')
    expect((await app.getState()).activeDocument!.canSend).toBe(false)
  })

  it('a stale preview token fails the send; a fresh preview sends', async () => {
    const value = await fixture()
    const { app, path } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.updateBuffer(path, '# Plan\n\nOriginal. First edit.\n')
    const [preview] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })

    await app.updateBuffer(path, '# Plan\n\nOriginal. First edit. Second edit.\n')
    const stale = { recipients: ['t1'], note: '', includeExternal: false, token: preview!.token }
    await expect(app.send(path, stale)).rejects.toThrow('The document changed')

    const [fresh] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })
    await expect(app.send(path, { ...stale, token: fresh!.token })).resolves.toHaveLength(1)
  })

  it('a deselected hunk is skipped, marked partial, and never offered again', async () => {
    const value = await fixture('a\n\nb\n\nc\n')
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await app.updateBuffer(path, 'A\n\nb\n\nC\n')
    await app.flushPersistence(path)
    const segmentId = (await store.loadMeta(path)).segments.at(-1)!.id as string
    const [preview] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })

    const request = { recipients: ['t1'], note: '', includeExternal: false, excludedHunks: [`${segmentId}:0`], token: preview!.token }
    const [deliveryId] = await app.send(path, request)
    const delivery = (await storedApplication(store, path)).attachments.t1!.deliveries[0]!
    expect(delivery.payload.segments?.[0]?.hunks.map((hunk) => hunk.added[0])).toEqual(['C'])
    expect(delivery.payload.partial).toBe(true)
    expect(delivery.payload.text).toContain('Parts of the document changed that are not included here.')

    value.engine.acknowledge('t1', deliveryId!)
    await settleDeliveries(value, 't1')
    expect((await app.getState()).activeDocument!.canSend).toBe(false)
    const [after] = await app.previewSend(path, { recipients: ['t1'], note: '', includeExternal: false })
    expect(after!.text).not.toContain('Changes by user:')
  })
})

describe('StrataApplication: ghost seeding and save history', () => {
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

  it('seeds an untracked file from itself so outside edits show as discrete hunks', async () => {
    const content = '# Plan\n\nOriginal.\n'
    const { app, path, store } = await gitFixture(content)
    await app.openDocument(path)
    expect(await store.getObjectText((await store.loadMeta(path)).ghostBlob)).toBe(content)

    await store.writeBuffer(path, '# Plan, revised\n\nOriginal.\n')
    await app.recheckFocused()
    await store.writeBuffer(path, '# Plan, revised\n\nOriginal.\n\nAppendix.\n')
    await app.recheckFocused()

    const document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(2)
    // Without a turn diff to attribute them (§5.8), buffer writes from outside are external.
    for (const hunk of document.pendingHunks) expect(hunk.author).toBeNull()
  })

  it('re-seeds a stranded version-1 empty ghost from disk, keeping only unsaved work pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-application-'))
    const path = join(root, 'plan.md')
    const saved = '# Plan\n\nSaved version.\n'
    await writeFile(path, saved)
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    await store.initialize()
    const emptyGhost = await store.putObject('')
    await store.saveMeta({ formatVersion: 1, realpath: path, ghostBlob: emptyGhost, pendingHunks: [], segments: [], segmentOffset: 0, attachments: {}, annotationEvents: [] } as unknown as Parameters<typeof store.saveMeta>[0])
    await store.writeBuffer(path, `${saved}\nUnsaved agent work.\n`)

    const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
    const app = await createStrataApplication({ store, settingsStore, engine: new FakeEngine(), watch: false })
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
    const value = await fixture(original, { threads: [{ id: 't1', title: 'Claude' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'edit', anchor: { document: path, quote: 'Ship Friday.' }, match: 'Friday', replace: 'Thursday' }])
    // The user overwrites the agent's text before saving; the agent stays in the round's author list because the label means activity, not survival.
    await app.updateBuffer(path, '# Plan\n\nShip Wednesday.\n')
    await app.save(path)

    let meta = await store.loadMeta(path)
    expect(meta.saves).toHaveLength(1)
    expect(await store.getObjectText(meta.saves[0]!.beforeBlob)).toBe(original)
    expect(await store.getObjectText(meta.saves[0]!.afterBlob)).toBe('# Plan\n\nShip Wednesday.\n')
    expect(meta.saves[0]!.authors.map((author) => author.name).sort()).toEqual(['Claude', 'you'])

    await app.save(path)
    meta = await store.loadMeta(path)
    expect(meta.saves).toHaveLength(1)
  })

  it('back-to-back saves attribute each round to exactly its own contributors', async () => {
    const value = await fixture('# Plan\n\nOriginal.\n', { threads: [{ id: 't1', title: 'Claude' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nUser round.\n')
    await app.save(path)

    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'edit', anchor: { document: path, quote: 'User round.' }, match: 'User round.', replace: 'User round.\n\nAgent round.' }])
    await app.save(path)

    const meta = await store.loadMeta(path)
    expect(meta.saves).toHaveLength(2)
    expect(meta.saves[0]!.authors).toEqual([{ name: 'you', user: true }])
    expect(meta.saves[1]!.authors).toEqual([{ name: 'Claude', user: false }])
  })

  it('an upgraded store uses lastSavedAt as its first round threshold', async () => {
    const value = await fixture('# Plan\n\nOriginal.\n', { threads: [{ id: 't1', title: 'Claude' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await app.updateBuffer(path, '# Plan\n\nPre-upgrade user edit.\n')
    // The legacy threshold is a file mtime from the kernel's coarse clock; a person's edit precedes their Save by far more than a clock tick.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await app.save(path)
    await app.closeDocument(path)

    // Strip the history and drop the meta back to version 1, as a pre-upgrade store would be: lastSavedAt survives, saves does not.
    const meta = await store.loadMeta(path)
    const { saves: _saves, ...withoutSaves } = meta as unknown as Record<string, unknown>
    await store.saveMeta({ ...withoutSaves, formatVersion: 1 } as unknown as Parameters<typeof store.saveMeta>[0])

    await app.openDocument(path)
    await attach(value, 't1')
    await post(value, 't1', [{ verb: 'edit', anchor: { document: path, quote: 'Pre-upgrade user edit.' }, match: 'Pre-upgrade user edit.', replace: 'Pre-upgrade user edit.\n\nPost-upgrade agent edit.' }])
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

describe('StrataApplication: the agent surface, round 2', () => {
  it('ignores a block from a thread the document does not know', async () => {
    const value = await fixture('Body text.\n', { threads: [{ id: 't1', title: 'Reviewer' }, { id: 't_ghost', title: 'Ghost' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't1')
    value.engine.assistant('t_ghost', 'Sneaky.\n\n```strata\n' + JSON.stringify([
      { verb: 'comment', anchor: { document: path, quote: 'Body' }, text: 'x' },
      { verb: 'edit', anchor: { document: path, quote: 'Body' }, match: 'Body', replace: 'Text' },
    ]) + '\n```')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.flushPersistence()
    expect((await app.getState()).activeDocument?.content).toBe('Body text.\n')
    expect((await storedApplication(store, path)).annotations.annotations).toEqual({})
    expect((await store.loadMeta(path)).attachments.t_ghost).toBeUndefined()
  })
})

describe('StrataApplication: delivered hunks and timestamps', () => {
  it('delivers hunks with one context line each side and lines against the delivered buffer', async () => {
    const value = await fixture('# T\n\nline a\nline b\nline c\n', { threads: [{ id: 't_1', title: 'Agent' }, { id: 't_2', title: 'Other' }] })
    const { app, path, store } = value
    await app.openDocument(path)
    await attach(value, 't_1')
    await attach(value, 't_2')

    await app.updateBuffer(path, '# T\n\nline a\nline B\nline c\n')
    // A send to the other thread ends the first round; the next edit lands in a later segment.
    await app.send(path, { recipients: ['t_2'], note: '', includeExternal: false })
    await app.updateBuffer(path, 'intro\n# T\n\nline a\nline B\nline c\n')
    await app.send(path, { recipients: ['t_1'], note: '', includeExternal: false })

    const delivery = (await storedApplication(store, path)).attachments.t_1?.deliveries[0]
    const hunks = (delivery?.payload.segments ?? []).flatMap((segment) => segment.hunks)
    const changed = hunks.find((hunk) => hunk.added.includes('line B'))
    // Mapped through the later top insertion: line 5 of the buffer the recipient reads.
    expect(changed).toMatchObject({ removed: ['line b'], added: ['line B'], contextBefore: ['line a'], contextAfter: ['line c'], newStart: 4, line: 5 })
    const inserted = hunks.find((hunk) => hunk.added.includes('intro'))
    expect(inserted).toMatchObject({ contextBefore: [], contextAfter: ['# T'], line: 1 })
    expect(delivery?.payload.text).toContain(' line a\n-line b\n+line B\n line c')
    expect(value.engine.deliveries('t_1').at(-1)?.attachment?.text).toContain(' line a\n-line b\n+line B\n line c')
  })

  it('stamps hunks with when they were recorded and attachments with when they attached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-application-'))
    const path = join(root, 'plan.md')
    await writeFile(path, 'Original.\n')
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
    let clock = 1_000_000
    const engine = new FakeEngine()
    const app = await createStrataApplication({ store, settingsStore, engine, watch: false, now: () => clock })
    const value = { app, engine, path, store }

    await app.openDocument(path)
    await attach(value, 't1')
    expect((await app.getState()).activeDocument?.attachments[0]).toMatchObject({ attachedAt: 1_000_000 })

    // An edit that lands in the buffer is a change with its own time.
    clock = 2_000_000
    await store.writeBuffer(path, 'Agent edit.\n')
    await app.recheckFocused()
    let document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]?.changedAt).toBe(2_000_000)
    expect(document.attachments[0]?.attachedAt).toBe(1_000_000)

    // The stamp is written with the hunk and survives a close (saving keeps the hunk pending, PRD §6.9) and a reopen.
    clock = 3_000_000
    await app.flushPersistence()
    expect((await store.loadMeta(path)).pendingHunks[0]).toMatchObject({ changedAt: 2_000_000 })
    await expect(app.closeDocument(path, 'save')).resolves.toBe('closed')
    clock = 4_000_000
    await app.openDocument(path)
    document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]?.changedAt).toBe(2_000_000)
    expect(document.attachments[0]?.attachedAt).toBe(1_000_000)
  })
})
