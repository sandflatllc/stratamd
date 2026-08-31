import { describe, expect, it } from 'vitest'
import type { AppView, DocumentView } from '../../src/shared/contracts'
import { applyContentSplice, applyViewUpdate, encodeViewUpdate, isViewUpdate, sameJson, spliceContent, type SyncedView } from '../../src/shared/view-sync'
import { EMPTY_VIEW } from '../../src/renderer/model'

function makeDocument(content: string, overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    path: '/tmp/doc.md',
    bufferPath: '/tmp/buffer.md',
    leadAgentId: null,
    content,
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
    attachments: [],
    canSend: false,
    conflicts: [],
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
      settings: { ...synced.view.settings, zoom: { explorer: 1, editor: 1.5, rightRail: 1, composer: 1 } },
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
