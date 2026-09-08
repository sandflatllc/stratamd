import { describe, expect, it } from 'vitest'
import type { AppView, DocumentView } from '../../src/shared/contracts'
import { applyContentSplice, applyViewUpdate, encodeViewUpdate, isViewUpdate, sameJson, spliceContent, type SyncedView } from '../../src/shared/view-sync'
import type { EngineMessageView, EngineThreadView, EngineView } from '../../src/shared/contracts'
import { EMPTY_VIEW } from '../../src/renderer/model'

function makeDocument(content: string, overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    path: '/tmp/doc.md',
    bufferPath: '/tmp/buffer.md',
    leadAgentId: null,
    content,
    reading: { formatVersion: 4, navigationTab: 'contents', reviewTab: 'changes', walkthrough: { active: false, level: 'h2', current: null, excluded: [], markers: [] }, tables: [], foldedHeadings: [] },
    sourceMode: false,
    sourceOnly: false,
    readOnly: false,
    dirty: false,
    deleted: false,
    invalidUtf8: false,
    lastSavedAt: null,
    historyStep: 0,
    pendingHunks: [],
    saves: [],
    annotations: [],
    drafts: [],
    attachments: [],
    recipients: [],
    canSend: false,
    conflicts: [],
    problems: [],
    ...overrides,
  }
}

function makeView(overrides: Partial<AppView> = {}): AppView {
  return { ...structuredClone(EMPTY_VIEW), ...overrides }
}

function roundTrip(previous: SyncedView | null, next: AppView, seq: number): SyncedView {
  const update = encodeViewUpdate(previous, seq, next, true)
  expect(isViewUpdate(update)).toBe(true)
  const result = applyViewUpdate(previous, update)
  expect(result.status).toBe('applied')
  if (result.status !== 'applied') throw new Error('unreachable')
  expect(sameJson(result.synced.view, next), 'merged view must equal the published view').toBe(true)
  expect(sameJson(result.synced.view, update.verify)).toBe(true)
  return result.synced
}

describe('view sync protocol', () => {
  it('sends a full view first, then round-trips every kind of change', () => {
    const first = makeView({ activeDocument: makeDocument('# One\n') })
    const firstUpdate = encodeViewUpdate(null, 1, first, false)
    expect(firstUpdate.full).toBe(first)
    let synced: SyncedView = { seq: 1, view: first }

    const contentChanged = makeView({ activeDocument: makeDocument('# One edited\n') })
    synced = roundTrip(synced, contentChanged, 2)

    const documentClosed = makeView({ activeDocument: null })
    synced = roundTrip(synced, documentClosed, 3)

    const reopened = makeView({ activeDocument: makeDocument('# Two\n') })
    synced = roundTrip(synced, reopened, 4)

    const settingsOnly = makeView({
      activeDocument: synced.view.activeDocument,
      settings: { ...synced.view.settings, zoom: { explorer: 1, editor: 1.5, rightRail: 1, composer: 1, themePanel: 1 } },
    })
    synced = roundTrip(synced, settingsOnly, 5)
  })

  it('elides unchanged document content from the wire', () => {
    const content = 'shared-content '.repeat(1_000)
    const before = makeView({ activeDocument: makeDocument(content) })
    const synced: SyncedView = { seq: 7, view: before }
    const after = makeView({ activeDocument: makeDocument(content, { dirty: true }) })
    const update = encodeViewUpdate(synced, 8, after, false)
    expect(JSON.stringify(update).length).toBeLessThan(content.length)
    const section = update.sections?.activeDocument
    expect(section && 'content' in section && section.content).toEqual({ unchanged: true })
    const applied = applyViewUpdate(synced, update)
    expect(applied.status).toBe('applied')
    if (applied.status === 'applied') {
      expect(applied.synced.view.activeDocument?.content).toBe(content)
      expect(applied.synced.view.activeDocument?.dirty).toBe(true)
    }
  })

  it('requests a resync on a sequence gap or missing base state', () => {
    const view = makeView({ activeDocument: makeDocument('# Doc\n') })
    const synced: SyncedView = { seq: 3, view }
    const next = makeView({ activeDocument: makeDocument('# Doc changed\n') })

    const gapped = encodeViewUpdate({ seq: 4, view }, 5, next, false)
    expect(applyViewUpdate(synced, gapped)).toEqual({ status: 'resync' })
    expect(applyViewUpdate(null, gapped)).toEqual({ status: 'resync' })

    const elided = encodeViewUpdate(
      { seq: 3, view },
      4,
      makeView({ activeDocument: makeDocument(view.activeDocument!.content, { dirty: true }) }),
      false,
    )
    const noDocument: SyncedView = { seq: 3, view: makeView({ activeDocument: null }) }
    expect(applyViewUpdate(noDocument, elided)).toEqual({ status: 'resync' })
  })

  it('detects a diverged merge through the verify payload', () => {
    const view = makeView({ activeDocument: makeDocument('# Doc\n') })
    const next = makeView({ activeDocument: makeDocument('# Doc\n', { dirty: true }) })
    const update = encodeViewUpdate({ seq: 1, view }, 2, next, true)
    const tamperedBase: SyncedView = {
      seq: 1,
      view: makeView({ activeDocument: makeDocument('# Tampered\n') }),
    }
    const applied = applyViewUpdate(tamperedBase, update)
    expect(applied.status).toBe('applied')
    if (applied.status === 'applied') {
      expect(sameJson(applied.synced.view, update.verify)).toBe(false)
    }
  })

  it('round-trips content splices for every edit shape', () => {
    const pairs: Array<[string, string]> = [
      ['# Doc\n\nOne two three.\n', '# Doc\n\nOne two-and-a-half three.\n'],
      ['abc', 'abc inserted at end'],
      ['prepended start abc', 'abc'],
      ['abc', ''],
      ['', 'fresh content'],
      ['aaa', 'aaaa'],
      ['aaaa', 'aaa'],
      ['same', 'same'],
      ['completely different', 'nothing shared here!'],
    ]
    for (const [previous, next] of pairs) {
      const splice = spliceContent(previous, next)
      expect(applyContentSplice(previous, splice), `${JSON.stringify(previous)} -> ${JSON.stringify(next)}`).toBe(next)
    }
  })

  it('sends a small splice for a small edit in a large document', () => {
    const content = `${'lead paragraph '.repeat(2_000)}MARKER${'tail paragraph '.repeat(2_000)}`
    const edited = content.replace('MARKER', 'MARKER plus one small insertion')
    const synced: SyncedView = { seq: 1, view: makeView({ activeDocument: makeDocument(content) }) }
    // Only the document changed; unchanged settings keep their reference, as the app's publisher does.
    const update = encodeViewUpdate(synced, 2, { ...synced.view, activeDocument: makeDocument(edited) }, false)
    expect(JSON.stringify(update).length).toBeLessThan(2_000)
    const applied = applyViewUpdate(synced, update)
    expect(applied.status).toBe('applied')
    if (applied.status === 'applied') expect(applied.synced.view.activeDocument?.content).toBe(edited)
  })

  it('resyncs instead of applying a splice against the wrong base', () => {
    const splice = spliceContent('the original text body', 'the original edited text body')
    expect(applyContentSplice('tiny', splice)).toBeNull()
    const wrongBase = applyContentSplice('a completely different but long enough base text!', splice)
    expect(wrongBase === null || wrongBase.length === splice.length).toBe(true)
  })

  it('rejects malformed updates', () => {
    expect(isViewUpdate(null)).toBe(false)
    expect(isViewUpdate({})).toBe(false)
    expect(isViewUpdate({ seq: 1 })).toBe(false)
    expect(isViewUpdate({ seq: 1, base: 0, sections: {} })).toBe(true)
    expect(isViewUpdate({ seq: 1, full: makeView() })).toBe(true)
  })
})

function makeMessage(id: string, text: string): EngineMessageView {
  return { id, role: 'assistant', text, turnId: 't1', streaming: false, createdAt: '2026-09-08T00:00:00Z', attachmentCount: 0 }
}

function makeThread(id: string, messages: EngineMessageView[], status: EngineThreadView['status'] = 'idle'): EngineThreadView {
  return {
    id, projectId: 'p1', title: `Thread ${id}`, model: 'm', providerInstanceId: 'i', effort: null, access: 'auto', status,
    updatedAt: '2026-09-08T00:00:00Z', lastExchangeAt: '2026-09-08T00:00:00Z', unread: false, pendingApprovals: false, pendingUserInput: false,
    activeTurnId: null, turnStartedAt: null, latestTurn: null, messages, activities: [], pinnedAt: null, snoozedUntil: null, lifecycle: 'active', archived: false, attention: 0, pendingWork: 0,
  }
}

function makeEngine(threads: EngineThreadView[]): EngineView {
  return { state: 'connected', server: 'http://engine', problem: null, credential: null, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/tmp/p1', threads }], activeThreadId: threads[0]?.id ?? null, accounts: [], terminalDefaults: {}, terminalShimDirectory: null }
}

describe('engine deltas', () => {
  it('sends only changed threads and messages and keeps unchanged objects by identity', () => {
    const messages = [makeMessage('m1', 'one'), makeMessage('m2', 'two')]
    const first = makeView({ engine: makeEngine([makeThread('a', messages), makeThread('b', [makeMessage('m3', 'three')])]) })
    const synced: SyncedView = { seq: 1, view: first }
    const next = makeView({ engine: makeEngine([makeThread('a', [...messages, makeMessage('m4', 'four')], 'running'), makeThread('b', [makeMessage('m3', 'three')])]) })
    const update = encodeViewUpdate(synced, 2, next, true)
    const delta = update.sections!.engineDelta!
    expect(update.sections!.engine).toBeUndefined()
    expect(delta.projects[0]!.threads.map((thread) => ({ id: thread.id, body: !!thread.thread, messages: thread.messages?.changed.map((message) => message.id) }))).toEqual([
      { id: 'a', body: true, messages: ['m4'] },
      { id: 'b', body: false, messages: undefined },
    ])
    const applied = applyViewUpdate(synced, update)
    expect(applied.status).toBe('applied')
    if (applied.status !== 'applied') return
    expect(sameJson(applied.synced.view, next)).toBe(true)
    const [threadA, threadB] = applied.synced.view.engine.projects[0]!.threads
    expect(threadB).toBe(synced.view.engine.projects[0]!.threads[1])
    expect(threadA!.messages[0]).toBe(synced.view.engine.projects[0]!.threads[0]!.messages[0])
    expect(threadA!.messages[1]).toBe(synced.view.engine.projects[0]!.threads[0]!.messages[1])
    expect(threadA!.status).toBe('running')
  })

  it('carries edited, reordered, and removed messages and resyncs when the base lacks a referenced message', () => {
    const first = makeView({ engine: makeEngine([makeThread('a', [makeMessage('m1', 'one'), makeMessage('m2', 'two'), makeMessage('m3', 'three')])]) })
    const synced: SyncedView = { seq: 1, view: first }
    const next = makeView({ engine: makeEngine([makeThread('a', [makeMessage('m3', 'three'), makeMessage('m1', 'one edited')])]) })
    const update = encodeViewUpdate(synced, 2, next, true)
    const list = update.sections!.engineDelta!.projects[0]!.threads[0]!.messages!
    expect(list.ids).toEqual(['m3', 'm1'])
    expect(list.changed.map((message) => message.id)).toEqual(['m1'])
    const applied = applyViewUpdate(synced, update)
    expect(applied.status === 'applied' && sameJson(applied.synced.view, next)).toBe(true)
    const stale: SyncedView = { seq: 1, view: makeView({ engine: makeEngine([makeThread('a', [makeMessage('m1', 'one')])]) }) }
    expect(applyViewUpdate(stale, update).status).toBe('resync')
  })

  it('reuses an unchanged project and adds and removes threads', () => {
    const first = makeView({ engine: makeEngine([makeThread('a', [makeMessage('m1', 'one')])]) })
    const synced: SyncedView = { seq: 1, view: first }
    const unchanged = roundTrip(synced, makeView({ engine: { ...first.engine, activeThreadId: 'zzz' } }), 2)
    expect(unchanged.view.engine.projects[0]).toBe(synced.view.engine.projects[0])
    const next = makeView({ engine: makeEngine([makeThread('c', [])]) })
    const replaced = roundTrip(unchanged, next, 3)
    expect(replaced.view.engine.projects[0]!.threads.map((thread) => thread.id)).toEqual(['c'])
  })
})
