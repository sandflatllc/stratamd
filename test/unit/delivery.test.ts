import { describe, expect, it } from 'vitest'
import {
  acknowledgeClipboardWrite,
  acknowledgeDelivery,
  attachmentDisplayState,
  collectOldest,
  createAttachment,
  createClipboardRecipient,
  createInitialPayload,
  deliveryStart,
  enqueueDelivery,
  expireIdleAttachments,
  freezeDelivery,
  freezeMessage,
  isMessageDelivery,
  mayExpireAttachment,
  noteAttachCall,
  prepareClipboardDelivery,
  queueClosed,
  sendToRecipients,
  type Attachment,
  type DeliverySnapshot,
  type DeliverySource,
  type IndexedSegment,
  type MessageSource,
} from '../../src/core/delivery'

const firstSnapshot: DeliverySnapshot = {
  snapshotId: 'snap_0', segmentIndex: 0, cursor: 0, document: 'before\n',
}

function attachment(id = 'ag_1'): Attachment {
  return createAttachment({ id, name: id, now: 10, snapshot: firstSnapshot })
}

function source(overrides: Partial<DeliverySource> = {}): DeliverySource {
  return {
    file: '/docs/a.md',
    buffer: '/data/buffer.md',
    snapshot: { snapshotId: 'snap_2', segmentIndex: 2, cursor: 4, document: 'after\n' },
    segments: [
      {
        index: 1,
        id: 'segment-1',
        author: 'external',
        tag: { agent: 'ag_other', name: 'Other' },
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, removed: ['before'], added: ['agent edit'] }],
      },
      {
        index: 2,
        id: 'segment-2',
        author: 'user',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, removed: ['agent edit'], added: ['after'] }],
      },
    ],
    annotations: [],
    resolved: [],
    note: 'Review this.',
    now: 20,
    id: 'd_1',
    ...overrides,
  }
}

describe('immutable delivery queue', () => {
  it('derives attachment panel state and updates last-call time immutably', () => {
    const current = attachment()
    expect(attachmentDisplayState(current)).toBe('working')
    expect(attachmentDisplayState(current, true)).toBe('waiting')
    const touched = noteAttachCall(current, 30)
    expect(touched.lastCallAt).toBe(30)
    expect(current.lastCallAt).toBe(10)
    expect(mayExpireAttachment(current, 10 + 24 * 60 * 60 * 1000)).toBe(true)
  })

  it('freezes Send-time content so later edits never enter a collected delivery', () => {
    const current = attachment()
    const mutableSegments: IndexedSegment[] = [...source().segments]
    const delivery = freezeDelivery(current, source({ segments: mutableSegments }))
    const queued = { ...current, deliveries: [delivery] }

    mutableSegments.push({
      index: 3,
      id: 'segment-3',
      author: 'user',
      hunks: [{ oldStart: 2, oldLines: 0, newStart: 2, newLines: 1, removed: [], added: ['later'] }],
    })

    expect(delivery.payload.segments).toHaveLength(1)
    expect(delivery.payload.segments?.[0]?.hunks[0]?.added).toEqual(['after'])
    expect(Object.isFrozen(delivery)).toBe(true)
    expect(Object.isFrozen(delivery.payload.segments?.[0]?.hunks[0]?.added)).toBe(true)
    expect(collectOldest(queued)).toBe(delivery)
    expect(JSON.parse(JSON.stringify(queued))).toMatchObject({
      id: 'ag_1',
      deliveries: [{ id: 'd_1', payload: { version: 11, event: 'send' } }],
    })
  })

  it('freezes replies in the recipient’s seq range alongside annotations and resolutions', () => {
    const delivery = freezeDelivery(attachment(), source({
      replies: [
        { id: 'r_old', seq: 0, annotation: 'a0', author: 'user', text: 'already delivered' },
        { id: 'r_new', seq: 3, annotation: 'a0', author: 'user', text: 'new reply' },
      ],
    }))
    expect(delivery.payload.replies).toEqual([
      { id: 'r_new', seq: 3, annotation: 'a0', author: 'user', text: 'new reply' },
    ])
    expect(delivery.payload.text).toContain('Replies:\na0 ← user: new reply')
    expect(delivery.payload.text).not.toContain('already delivered')
  })

  it('redelivers the oldest item with the same id until ack, then advances baseline and cursor', () => {
    const sent = sendToRecipients({ ag_1: attachment() }, source())
    const queued = sent.attachments.ag_1!
    const first = collectOldest(queued)
    const afterKilledCli = collectOldest(queued)

    expect(first).toBe(afterKilledCli)
    expect(first?.id).toBe('d_1')
    expect(queued.baseline).toEqual({ snapshotId: 'snap_0', segmentIndex: 0 })
    expect(queued.cursor).toBe(0)

    const wrongAck = acknowledgeDelivery(queued, 'different')
    expect(wrongAck).toEqual({ attachment: queued, acknowledged: false })
    const ack = acknowledgeDelivery(queued, 'd_1')
    expect(ack.acknowledged).toBe(true)
    expect(ack.attachment.baseline).toEqual({ snapshotId: 'snap_2', segmentIndex: 2 })
    expect(ack.attachment.cursor).toBe(4)
    expect(ack.attachment.deliveries).toEqual([])
  })

  it('excludes external changes by default, including another attached agent’s edit', () => {
    const excluded = freezeDelivery(attachment(), source())
    expect(excluded.payload.segments?.map((segment) => segment.author)).toEqual(['user'])
    expect(excluded.includeExternal).toBe(false)
    expect(excluded.payload.text).not.toContain('Other')
    expect(excluded.payload.text).not.toContain('+agent edit')

    const included = freezeDelivery(attachment(), source({ includeExternal: true }))
    expect(included.includeExternal).toBe(true)
    expect(included.payload.segments?.map((segment) => segment.author)).toEqual(['external', 'user'])
    expect(included.payload.text).toContain('Changes by Other (ag_other):')
  })

  it('defaults Send recipients to every attachment and freezes per-recipient ranges', () => {
    const ag1 = attachment('ag_1')
    const ag2 = {
      ...attachment('ag_2'),
      baseline: { snapshotId: 'snap_1', segmentIndex: 1 },
      cursor: 2,
    }
    const sent = sendToRecipients({ ag_1: ag1, ag_2: ag2 }, source({ id: 'round' }))

    expect(sent.deliveries.map((delivery) => delivery.payload.agent)).toEqual(['ag_1', 'ag_2'])
    expect(sent.deliveries[0]?.payload.segments).toHaveLength(1)
    expect(sent.deliveries[1]?.payload.segments).toHaveLength(1)
    expect(sent.deliveries.map((delivery) => delivery.id)).toEqual(['round_ag_1', 'round_ag_2'])
  })

  it('chains a later queued Send after the frozen queue tail', () => {
    const first = sendToRecipients({ ag_1: attachment() }, source()).attachments.ag_1!
    const second = sendToRecipients({ ag_1: first }, source({
      id: 'd_2',
      snapshot: { snapshotId: 'snap_3', segmentIndex: 3, cursor: 5, document: 'latest\n' },
      segments: [{
        index: 3,
        id: 'segment-3',
        author: 'user',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, removed: ['after'], added: ['latest'] }],
      }],
    })).attachments.ag_1!

    expect(second.deliveries).toHaveLength(2)
    expect(second.deliveries[1]?.from).toEqual({ snapshotId: 'snap_2', segmentIndex: 2, cursor: 4 })
    expect(second.deliveries[1]?.payload.segments?.[0]?.hunks[0]?.added).toEqual(['latest'])
  })

  it('never expires an attachment with an unacknowledged delivery and queues closed after it', () => {
    const sent = sendToRecipients({ ag_1: attachment() }, source()).attachments.ag_1!
    expect(mayExpireAttachment(sent, 1_000_000, 100)).toBe(false)
    expect(expireIdleAttachments({ ag_1: sent }, 1_000_000, 100)).toHaveProperty('ag_1')

    const closed = queueClosed({ ag_1: sent }, {
      ...source({ id: 'd_closed' }),
      snapshot: { snapshotId: 'snap_2', segmentIndex: 2, cursor: 4, document: 'after\n' },
    }).attachments.ag_1!
    expect(attachmentDisplayState(closed, true)).toBe('pending')
    expect(closed.deliveries.map((delivery) => delivery.payload.event)).toEqual(['send', 'closed'])
    expect(collectOldest(closed)?.id).toBe('d_1')

    const afterSendAck = acknowledgeDelivery(closed, 'd_1').attachment
    expect(collectOldest(afterSendAck)?.payload.event).toBe('closed')
  })

  it('falls back to a full resync when the baseline is unavailable', () => {
    const delivery = freezeDelivery(attachment(), source({ baselineAvailable: false }))
    expect(delivery.payload.event).toBe('resync')
    expect(delivery.payload.document).toBe('after\n')
    expect(delivery.payload.deliveryId).toBe('d_1')
  })

  it('creates the first attach payload and rejects notes over 64 KB', () => {
    const initial = createInitialPayload(
      attachment(), '/docs/a.md', '/data/buffer.md', firstSnapshot,
    )
    expect(initial).toMatchObject({ version: 11, event: 'initial', document: 'before\n' })
    expect(() => freezeDelivery(attachment(), source({ note: 'x'.repeat(65_537) }))).toThrow('64 KB')
  })

  it('keeps deliveries incremental when their serialized content exceeds 2 MB', () => {
    const largeAddition = 'x'.repeat(2 * 1024 * 1024 + 1)
    const delivery = freezeDelivery(attachment(), source({
      segments: [{
        index: 2,
        id: 'segment-2',
        author: 'user',
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, removed: [], added: [largeAddition] }],
      }],
    }))
    expect(delivery.payload.event).toBe('send')
    expect(Buffer.byteLength(JSON.stringify(delivery.payload))).toBeGreaterThan(2 * 1024 * 1024)
    expect(delivery.payload.document).toBeUndefined()
  })
})

describe('agent-to-agent messages', () => {
  function messageSource(overrides: Partial<MessageSource> = {}): MessageSource {
    return {
      file: '/docs/a.md',
      buffer: '/data/buffer.md',
      sender: { agent: 'ag_2', name: 'Peer' },
      note: 'Round done. Ring when reviewed.',
      now: 30,
      id: 'm_1',
      ...overrides,
    }
  }

  it('freezes both endpoints at the next delivery start with an empty queue', () => {
    const current = attachment()
    const message = freezeMessage(current, messageSource())
    expect(message.from).toEqual(deliveryStart(current))
    expect(message.to).toEqual(deliveryStart(current))
    expect(message.payload).toMatchObject({ event: 'message', from: { agent: 'ag_2', name: 'Peer' } })
    expect(isMessageDelivery(message)).toBe(true)
  })

  it('freezes both endpoints at the queued tail when a Send delivery is ahead', () => {
    const queued = sendToRecipients({ ag_1: attachment() }, source()).attachments.ag_1!
    const message = freezeMessage(queued, messageSource())
    expect(message.from).toEqual({ snapshotId: 'snap_2', segmentIndex: 2, cursor: 4 })
    expect(message.to).toEqual(message.from)
  })

  it('acknowledging a message leaves the baseline and cursor bit-identical in both queue orders', () => {
    // Message first, Send after.
    let current = enqueueDelivery(attachment(), freezeMessage(attachment(), messageSource()))
    current = sendToRecipients({ ag_1: current }, source()).attachments.ag_1!
    const before = { baseline: current.baseline, cursor: current.cursor }
    const messageAck = acknowledgeDelivery(current, 'm_1')
    expect(messageAck.acknowledged).toBe(true)
    expect(messageAck.attachment.baseline).toEqual(before.baseline)
    expect(messageAck.attachment.cursor).toBe(before.cursor)
    const sendAck = acknowledgeDelivery(messageAck.attachment, 'd_1')
    expect(sendAck.attachment.baseline).toEqual({ snapshotId: 'snap_2', segmentIndex: 2 })
    expect(sendAck.attachment.cursor).toBe(4)

    // Send first, message after: acking both in order lands on the same state.
    let other = sendToRecipients({ ag_1: attachment() }, source()).attachments.ag_1!
    other = enqueueDelivery(other, freezeMessage(other, messageSource({ id: 'm_2' })))
    const afterSend = acknowledgeDelivery(other, 'd_1')
    expect(afterSend.attachment.baseline).toEqual({ snapshotId: 'snap_2', segmentIndex: 2 })
    const afterMessage = acknowledgeDelivery(afterSend.attachment, 'm_2')
    expect(afterMessage.attachment.baseline).toEqual(sendAck.attachment.baseline)
    expect(afterMessage.attachment.cursor).toBe(sendAck.attachment.cursor)
    expect(afterMessage.attachment.deliveries).toEqual([])
  })

  it('never blocks expiry with a queued message while a Send delivery still does', () => {
    const idle = 100
    const late = 1_000_000
    const messageOnly = enqueueDelivery(attachment(), freezeMessage(attachment(), messageSource()))
    expect(mayExpireAttachment(messageOnly, late, idle)).toBe(true)
    expect(expireIdleAttachments({ ag_1: messageOnly }, late, idle)).toEqual({})

    const withSend = sendToRecipients({ ag_1: messageOnly }, source()).attachments.ag_1!
    expect(mayExpireAttachment(withSend, late, idle)).toBe(false)
    expect(expireIdleAttachments({ ag_1: withSend }, late, idle)).toHaveProperty('ag_1')
  })

  it('accepts a 4096-byte note and rejects 4097 bytes', () => {
    expect(freezeMessage(attachment(), messageSource({ note: 'x'.repeat(4096) })).payload.notes).toEqual(['x'.repeat(4096)])
    expect(() => freezeMessage(attachment(), messageSource({ note: 'x'.repeat(4097) }))).toThrow('4 KB')
  })
})

describe('clipboard recipient', () => {
  it('copies the whole buffer first and advances only after a successful clipboard write', () => {
    const state = createClipboardRecipient()
    const prepared = prepareClipboardDelivery(state, source())
    expect(prepared.delivery.payload.event).toBe('initial')
    expect(prepared.delivery.payload.document).toBe('after\n')

    const retryState = acknowledgeClipboardWrite(prepared.recipient, prepared.delivery.id, false)
    const retry = prepareClipboardDelivery(retryState, source({
      id: 'd_later',
      snapshot: { snapshotId: 'snap_3', segmentIndex: 3, cursor: 5, document: 'later\n' },
    }))
    expect(retry.delivery).toBe(prepared.delivery)

    const acknowledged = acknowledgeClipboardWrite(retry.recipient, prepared.delivery.id, true)
    expect(acknowledged.baseline).toEqual({ snapshotId: 'snap_2', segmentIndex: 2 })
    expect(acknowledged.pending).toBeNull()
  })

  it('includes edits saved since the previous copy because Save does not move its baseline', () => {
    const first = prepareClipboardDelivery(createClipboardRecipient(), source())
    const afterCopy = acknowledgeClipboardWrite(first.recipient, first.delivery.id, true)

    // A Save has no delivery-state transition. The next copy still starts at snap_2.
    const next = prepareClipboardDelivery(afterCopy, source({
      id: 'd_2',
      snapshot: { snapshotId: 'snap_3', segmentIndex: 3, cursor: 5, document: 'saved edit\n' },
      segments: [{
        index: 3,
        id: 'segment-3',
        author: 'user',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, removed: ['after'], added: ['saved edit'] }],
      }],
    }))
    expect(next.delivery.payload.event).toBe('send')
    expect(next.delivery.payload.segments?.[0]?.hunks[0]?.added).toEqual(['saved edit'])
  })
})

describe('recipient filtering and item selection', () => {
  const hunk = (added: string) => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, removed: ['x'], added: [added] })
  const authored: IndexedSegment[] = [
    { index: 1, id: 'segment-1', author: 'external', tag: { agent: 'ag_other', name: 'Other' }, hunks: [hunk('their write')] },
    { index: 2, id: 'segment-2', author: 'user', tag: { agent: 'ag_other', name: 'Other' }, hunks: [hunk('their accepted text')] },
    { index: 2, id: 'segment-3', author: 'user', hunks: [hunk('your edit')] },
  ]

  it('never delivers a segment to its author, whichever author recorded it', () => {
    const toAuthor = freezeDelivery(attachment('ag_other'), source({ segments: authored, includeExternal: true }))
    expect(toAuthor.payload.segments?.map((segment) => segment.hunks[0]?.added[0])).toEqual(['your edit'])

    const toOther = freezeDelivery(attachment('ag_1'), source({ segments: authored, includeExternal: true }))
    expect(toOther.payload.segments?.map((segment) => segment.hunks[0]?.added[0]))
      .toEqual(['their write', 'their accepted text', 'your edit'])
    // An accepted suggestion reaches other agents as a plain user hunk: no tag on user segments.
    expect(toOther.payload.segments?.[1]).toEqual({ author: 'user', hunks: [hunk('their accepted text')] })
    expect(toOther.payload.partial).toBeUndefined()
  })

  it('leaves the clipboard recipient unfiltered', () => {
    const clipboard = freezeDelivery(attachment('clipboard'), source({ segments: authored, includeExternal: true }))
    expect(clipboard.payload.segments).toHaveLength(3)
  })

  it('drops excluded hunks, marks the delivery partial, and still advances to the snapshot', () => {
    const twoHunks: IndexedSegment[] = [{
      index: 2, id: 'segment-2', author: 'user',
      hunks: [hunk('first'), { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, removed: ['y'], added: ['second'] }],
    }]
    const delivery = freezeDelivery(attachment(), source({ segments: twoHunks, excludedHunks: ['segment-2:0'] }))
    expect(delivery.payload.segments?.[0]?.hunks.map((entry) => entry.added[0])).toEqual(['second'])
    expect(delivery.payload.partial).toBe(true)
    expect(delivery.payload.text).toContain('Parts of the document changed that are not included here.')
    expect(delivery.to).toEqual({ snapshotId: 'snap_2', segmentIndex: 2, cursor: 4 })
  })

  it('marks partial when external changes stay unchecked, but not for author-filtered segments', () => {
    const unchecked = freezeDelivery(attachment('ag_1'), source({ segments: authored }))
    expect(unchecked.payload.partial).toBe(true)

    const onlyOwnWork = freezeDelivery(attachment('ag_other'), source({
      segments: [authored[0]!],
    }))
    expect(onlyOwnWork.payload.partial).toBeUndefined()
  })

  it('folds unchecked annotation events into partial', () => {
    const delivery = freezeDelivery(attachment(), source({ segments: [], eventsLeftOut: true }))
    expect(delivery.payload.partial).toBe(true)
  })

  it('a resync recipient ignores selection and carries the full document', () => {
    const delivery = freezeDelivery(attachment(), source({
      baselineAvailable: false,
      excludedHunks: ['segment-2:0'],
      eventsLeftOut: true,
    }))
    expect(delivery.payload.event).toBe('resync')
    expect(delivery.payload.document).toBe('after\n')
    expect(delivery.payload.segments).toBeUndefined()
    expect(delivery.payload.partial).toBeUndefined()
  })
})
