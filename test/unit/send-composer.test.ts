import { describe, expect, it } from 'vitest'
import type { DraftView, SendDocumentToken, SendPreview, SendPreviewRequest } from '../../src/shared/contracts'
import {
  buildPreviewRequest,
  clearComposerDraft,
  commitRequest,
  draftRecipients,
  EMPTY_DRAFT,
  IDLE_PREVIEW,
  IDLE_SEND,
  isEmptyDraft,
  mergePreviews,
  nextPreviewState,
  nextSendState,
  readComposerDraft,
  reconcileSelectedDrafts,
  saveComposerDraft,
} from '../../src/renderer/components/SendComposer'

const request: SendPreviewRequest = { recipients: ['agent-a'], note: 'Ready for review', includeExternal: true }
const token: SendDocumentToken = { snapshotId: 'snapshot-1', segmentIndex: 2, cursor: 3 }

function sendPreview(text: string, nextToken = token): SendPreview {
  return {
    recipient: { id: 'agent-a', name: 'Agent A', color: 'grape' },
    text,
    token: nextToken,
    items: {
      changes: [{ key: 'segment-1:0', author: 'user', oldStart: 1, newStart: 1, removed: ['old'], added: ['new'] }],
      events: [{ seq: 3, kind: 'annotation', author: 'user', text: 'Check this', quote: 'new' }],
    },
    dependentExternalHunks: 0,
  }
}

describe('send composer preview lifecycle', () => {
  it('distinguishes the first preview from a later refresh and keeps retained previews mounted', () => {
    const pending = nextPreviewState(IDLE_PREVIEW, { type: 'request-changed', requestId: 1 })
    expect(pending).toMatchObject({ hasPreview: false, pending: true, currentRequestId: 1, previews: [] })

    const first = nextPreviewState(pending, { type: 'preview-succeeded', requestId: 1, previews: [sendPreview('first')] })
    expect(first).toMatchObject({ hasPreview: true, pending: false, currentRequestId: 1 })

    const refreshing = nextPreviewState(first, { type: 'request-changed', requestId: 2 })
    expect(refreshing.pending).toBe(true)
    expect(refreshing.previews).toBe(first.previews)
  })

  it('ignores a result from a superseded request', () => {
    const first = nextPreviewState(IDLE_PREVIEW, { type: 'request-changed', requestId: 1 })
    const second = nextPreviewState(first, { type: 'request-changed', requestId: 2 })
    expect(nextPreviewState(second, { type: 'preview-succeeded', requestId: 1, previews: [sendPreview('stale')] })).toBe(second)
  })

  it('builds token-free requests and ignores an unused external-key universe', () => {
    const selection = {
      recipients: ['agent-a'],
      note: 'Review this',
      checkedExternal: new Set<string>(),
      uncheckedUser: new Set(['user:0']),
      uncheckedEvents: new Set([4]),
      externalKeys: ['external:0'],
      token,
    }
    const built = buildPreviewRequest(selection)
    expect(built).toEqual({
      recipients: ['agent-a'],
      note: 'Review this',
      includeExternal: false,
      excludedHunks: ['user:0'],
      excludedEvents: [4],
    })
    expect(buildPreviewRequest({ ...selection, token: { ...token, cursor: 99 } })).toEqual(built)
    expect(buildPreviewRequest({ ...selection, externalKeys: ['external:0', 'external:1'] })).toEqual(built)
  })

  it('keeps only the last preview from a rapid note burst', () => {
    let state = nextPreviewState(IDLE_PREVIEW, { type: 'request-changed', requestId: 1 })
    state = nextPreviewState(state, { type: 'request-changed', requestId: 2 })
    state = nextPreviewState(state, { type: 'request-changed', requestId: 3 })
    state = nextPreviewState(state, { type: 'preview-succeeded', requestId: 3, previews: [sendPreview('last note')] })
    expect(state.pending).toBe(false)
    expect(state.previews.map((preview) => preview.text)).toEqual(['last note'])
  })

  it('retains item identity when the token and item keys match but adopts the new exact text', () => {
    const previous = sendPreview('old text')
    const next = sendPreview('new text')
    const [merged] = mergePreviews([previous], [next])
    expect(merged?.text).toBe('new text')
    expect(merged?.items).toBe(previous.items)

    const changed = sendPreview('changed document', { ...token, snapshotId: 'snapshot-2' })
    expect(mergePreviews([previous], [changed])[0]?.items).toBe(changed.items)
  })
})

describe('send composer commitment', () => {
  // docs/plans/open/performance-plan.md, "Send trace result": one run left the dialog open for
  // 30 seconds with no delivery and the button still reading `Send`, because toggling
  // the external option restarted the preview and disabled the button mid-click.
  it('holds a click made while a preview is still in flight and sends it once the preview settles', () => {
    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })
    expect(queued.phase).toBe('queued')
    expect(queued.request).toBe(request)

    expect(nextSendState(queued, { type: 'submit', request })).toBe(queued)

    const sending = nextSendState(queued, { type: 'preview-settled' })
    expect(sending.phase).toBe('sending')
    expect(sending.request).toBe(request)
    expect(nextSendState(sending, { type: 'preview-settled' })).toBe(sending)
    expect(commitRequest(sending.request!, token)).toEqual({ ...request, token })
  })

  it('returns the composer to a usable state and shows the reason when the send rejects', () => {
    const sending = nextSendState(nextSendState(IDLE_SEND, { type: 'submit', request }), { type: 'preview-settled' })

    const failed = nextSendState(sending, { type: 'send-failed', error: new Error('The delivery queue is locked.') })
    expect(failed.phase).toBe('idle')
    expect(failed.request).toBeNull()
    expect(failed.error).toBe('The delivery queue is locked.')
    expect(nextSendState(sending, { type: 'send-failed', error: 'socket closed' }).error).toBe('The send failed.')

    const retry = nextSendState(failed, { type: 'submit', request })
    expect(retry.phase).toBe('queued')
    expect(retry.error).toBe('')
  })

  it('reports a failed preview without dropping the click waiting on it', () => {
    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })

    const reported = nextSendState(queued, { type: 'preview-failed', error: new Error('Preview unavailable.') })
    expect(reported.phase).toBe('queued')
    expect(reported.error).toBe('Preview unavailable.')
    expect(nextSendState(reported, { type: 'preview-settled' }).phase).toBe('sending')
  })

  it('never yields a second dispatchable state for one committed send', () => {
    // The dispatch effect keys "this delivery already started" on state identity, so a
    // recipient toggle whose preview rejects mid-send must not mint a new sending state.
    const sending = nextSendState(nextSendState(IDLE_SEND, { type: 'submit', request }), { type: 'preview-settled' })
    expect(nextSendState(sending, { type: 'preview-failed', error: new Error('Preview unavailable.') })).toBe(sending)
  })

  it('leaves a queued click waiting while pending and releases it only after the preview settles', () => {
    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })
    const pending = nextPreviewState(IDLE_PREVIEW, { type: 'request-changed', requestId: 1 })
    expect(pending.pending).toBe(true)
    expect(queued.phase).toBe('queued')

    const settled = nextPreviewState(pending, { type: 'preview-succeeded', requestId: 1, previews: [sendPreview('settled')] })
    const sending = settled.pending ? queued : nextSendState(queued, { type: 'preview-settled' })
    expect(sending.phase).toBe('sending')
    expect(commitRequest(sending.request!, settled.previews[0]!.token).token).toBe(token)
  })

  it('keeps retained previews after a failed refresh and returns a failed send to idle', () => {
    const firstPending = nextPreviewState(IDLE_PREVIEW, { type: 'request-changed', requestId: 1 })
    const ready = nextPreviewState(firstPending, { type: 'preview-succeeded', requestId: 1, previews: [sendPreview('ready')] })
    const refreshing = nextPreviewState(ready, { type: 'request-changed', requestId: 2 })
    const failedPreview = nextPreviewState(refreshing, { type: 'preview-failed', requestId: 2 })
    expect(failedPreview.previews).toBe(ready.previews)

    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })
    const reported = nextSendState(queued, { type: 'preview-failed', error: new Error('Preview unavailable.') })
    const sending = nextSendState(reported, { type: 'preview-settled' })
    const failedSend = nextSendState(sending, { type: 'send-failed', error: new Error('The document changed.') })
    expect(failedSend).toEqual({ phase: 'idle', request: null, error: 'The document changed.' })
  })

  it('never strands a queued click in sending when the first preview fails without a token', () => {
    const pending = nextPreviewState(IDLE_PREVIEW, { type: 'request-changed', requestId: 1 })
    const previewFailed = nextPreviewState(pending, { type: 'preview-failed', requestId: 1 })
    const queued = nextSendState(IDLE_SEND, { type: 'submit', request })
    const reported = nextSendState(queued, { type: 'preview-failed', error: new Error('Preview unavailable.') })
    const sending = previewFailed.pending ? reported : nextSendState(reported, { type: 'preview-settled' })
    const idle = nextSendState(sending, { type: 'send-failed', error: new Error(reported.error) })
    expect(idle).toEqual({ phase: 'idle', request: null, error: 'Preview unavailable.' })
  })
})

describe('send composer drafts (PRD §6.9)', () => {
  const attachments = [
    { agent: { id: 'agent-a', name: 'Agent A', color: 'grape' as const }, attachedAt: 0, state: 'idle' as const, queuedDeliveries: [], queuedSendCount: 0 },
    { agent: { id: 'agent-b', name: 'Agent B', color: 'sky' as const }, attachedAt: 0, state: 'idle' as const, queuedDeliveries: [], queuedSendCount: 0 },
  ]

  it('keeps the note and item choices per document until the send goes through', () => {
    const draft = { note: 'Please review', checkedExternal: ['s1:0'], uncheckedUser: ['s2:1'], uncheckedEvents: [4] }
    saveComposerDraft('/one.md', draft)
    expect(readComposerDraft('/one.md')).toEqual(draft)
    expect(readComposerDraft('/two.md')).toBe(EMPTY_DRAFT)
    clearComposerDraft('/one.md')
    expect(readComposerDraft('/one.md')).toBe(EMPTY_DRAFT)
  })

  it('forgets a draft the user emptied out instead of keeping a blank one', () => {
    saveComposerDraft('/blank.md', { ...EMPTY_DRAFT, note: 'x' })
    saveComposerDraft('/blank.md', { ...EMPTY_DRAFT })
    expect(readComposerDraft('/blank.md')).toBe(EMPTY_DRAFT)
    expect(isEmptyDraft(EMPTY_DRAFT)).toBe(true)
    expect(isEmptyDraft({ ...EMPTY_DRAFT, uncheckedEvents: [1] })).toBe(false)
  })

  it('preselects only the active conversation, with the Lead taking priority', () => {
    expect(draftRecipients(attachments, null, 'agent-a')).toEqual(['agent-a'])
    expect(draftRecipients(attachments, 'agent-b', 'agent-a')).toEqual(['agent-b'])
    expect(draftRecipients(attachments, null, null)).toEqual([])
  })

  it('checks a newly attached draft without rechecking one the user unchecked', () => {
    const view = (id: string): DraftView => ({
      id, kind: 'comment', quote: id, prefix: '', suffix: '', text: id,
      from: 0, to: id.length, status: 'attached', createdAt: 1,
    })
    const existing = view('existing')
    const incoming = view('incoming')
    const selected = reconcileSelectedDrafts(
      new Set(),
      new Map([[existing.id, existing.status]]),
      new Set([existing.id]),
      [existing, incoming],
    )

    expect([...selected]).toEqual(['incoming'])
  })
})
