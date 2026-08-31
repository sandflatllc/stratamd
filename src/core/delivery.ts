import {
  createPayload,
  type PayloadAgentTag,
  type PayloadAnnotation,
  type PayloadEditVerdict,
  type PayloadEvent,
  type PayloadResolution,
  type PayloadThreadReply,
  type PayloadSegment,
  type StrataPayload,
} from './payload'

export interface DeliveryBaseline {
  snapshotId: string
  segmentIndex: number
}

export interface DeliverySnapshot extends DeliveryBaseline {
  document: string
  cursor: number
}

export interface IndexedSegment extends PayloadSegment {
  index: number
  /** The segment's stable id; with a hunk index it forms the `segmentId:hunkIndex` item key. */
  id: string
}

export interface DeliveryEndpoint extends DeliveryBaseline {
  cursor: number
}

export interface FrozenDelivery {
  id: string
  createdAt: number
  includeExternal: boolean
  from: DeliveryEndpoint
  to: DeliveryEndpoint
  payload: StrataPayload
}

export interface Attachment {
  id: string
  name: string
  attachedAt: number
  lastCallAt: number
  /** True only while an attach call for this document/agent is blocked. */
  waiting?: boolean
  baseline: DeliveryBaseline
  cursor: number
  deliveries: readonly FrozenDelivery[]
}

export type AttachmentDisplayState = 'waiting' | 'working' | 'pending'

export interface CreateAttachmentInput {
  id: string
  name: string
  now: number
  snapshot: DeliverySnapshot
}

export interface DeliverySource {
  file: string
  buffer: string
  snapshot: DeliverySnapshot
  segments: readonly IndexedSegment[]
  annotations?: readonly PayloadAnnotation[]
  replies?: readonly PayloadThreadReply[]
  resolved?: readonly PayloadResolution[]
  edits?: readonly PayloadEditVerdict[]
  note?: string
  includeExternal?: boolean
  /** Hunk items the user unchecked, as `segmentId:hunkIndex` keys. */
  excludedHunks?: readonly string[]
  /** True when annotation events in range were unchecked; folds into `partial`. */
  eventsLeftOut?: boolean
  baselineAvailable?: boolean
  now: number
  id?: string
  event?: Extract<PayloadEvent, 'send' | 'closed'>
}

export interface SendResult {
  attachments: Readonly<Record<string, Attachment>>
  deliveries: readonly FrozenDelivery[]
}

export interface AcknowledgmentResult {
  attachment: Attachment
  acknowledged: boolean
}

export interface ClipboardRecipient {
  baseline: DeliveryBaseline | null
  cursor: number
  pending: FrozenDelivery | null
}

const MAX_NOTE_BYTES = 64 * 1024
const MAX_MESSAGE_NOTE_BYTES = 4 * 1024
export const DEFAULT_ATTACHMENT_IDLE_MS = 24 * 60 * 60 * 1000

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return
    Object.freeze(item)
    for (const child of Object.values(item)) freeze(child)
  }
  freeze(clone)
  return clone
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function assertNote(note: string | undefined): void {
  if (note !== undefined && byteLength(note) > MAX_NOTE_BYTES) {
    throw new RangeError('Delivery note exceeds the 64 KB limit')
  }
}

function assertMessageNote(note: string): void {
  if (byteLength(note) > MAX_MESSAGE_NOTE_BYTES) {
    throw new RangeError('Message note exceeds the 4 KB limit')
  }
}

export function createAttachment(input: CreateAttachmentInput): Attachment {
  return {
    id: input.id,
    name: input.name,
    attachedAt: input.now,
    lastCallAt: input.now,
    waiting: false,
    baseline: {
      snapshotId: input.snapshot.snapshotId,
      segmentIndex: input.snapshot.segmentIndex,
    },
    cursor: input.snapshot.cursor,
    deliveries: [],
  }
}

export function attachmentDisplayState(
  attachment: Attachment,
  waiting = attachment.waiting ?? false,
): AttachmentDisplayState {
  if (attachment.deliveries.length > 0) return 'pending'
  return waiting ? 'waiting' : 'working'
}

/**
 * A queued tail is the logical starting point for the next Send. The acknowledged
 * baseline stays unchanged until ack, while sequential queued Sends do not repeat
 * already-frozen changes.
 */
export function deliveryStart(attachment: Attachment): DeliveryEndpoint {
  const tail = attachment.deliveries.at(-1)
  return tail?.to ?? {
    snapshotId: attachment.baseline.snapshotId,
    segmentIndex: attachment.baseline.segmentIndex,
    cursor: attachment.cursor,
  }
}

function eventsInRange<T extends { seq: number }>(
  values: readonly T[] | undefined,
  after: number,
  through: number,
): readonly T[] {
  return (values ?? []).filter((value) => value.seq > after && value.seq <= through)
}

function selectedSegments(
  segments: readonly IndexedSegment[],
  after: number,
  through: number,
  includeExternal: boolean,
  recipient: string,
  excludedHunks: ReadonlySet<string>,
): { segments: readonly PayloadSegment[]; leftOut: boolean } {
  const delivered: PayloadSegment[] = []
  let leftOut = false
  for (const segment of segments) {
    if (segment.index <= after || segment.index > through) continue
    // A recipient never receives a change it authored, whichever author
    // recorded it — its own external writes, or an Accept/Revert of its work.
    if (segment.tag?.agent === recipient) continue
    if (segment.author !== 'user' && !includeExternal) {
      leftOut = true
      continue
    }
    const hunks = segment.hunks.filter((_, index) => !excludedHunks.has(`${segment.id}:${index}`))
    if (hunks.length < segment.hunks.length) leftOut = true
    if (hunks.length === 0) continue
    // The payload keeps `tag` only on external segments: an accepted suggestion
    // reaches other agents as a plain user hunk (PRD §6.5).
    delivered.push(
      segment.author === 'user' || segment.tag === undefined
        ? { author: segment.author, hunks }
        : { author: segment.author, tag: segment.tag, hunks },
    )
  }
  return { segments: delivered, leftOut }
}

function endpoint(snapshot: DeliverySnapshot): DeliveryEndpoint {
  return {
    snapshotId: snapshot.snapshotId,
    segmentIndex: snapshot.segmentIndex,
    cursor: snapshot.cursor,
  }
}

function makeResyncPayload(
  attachment: Attachment,
  source: DeliverySource,
  deliveryId: string,
): StrataPayload {
  return createPayload({
    file: source.file,
    buffer: source.buffer,
    agent: attachment.id,
    event: 'resync',
    deliveryId,
    cursor: source.snapshot.cursor,
    document: source.snapshot.document,
    annotations: eventsInRange(source.annotations, 0, source.snapshot.cursor),
  })
}

export function freezeDelivery(attachment: Attachment, source: DeliverySource): FrozenDelivery {
  assertNote(source.note)
  const id = source.id ?? makeId('d')
  const from = deliveryStart(attachment)
  const to = endpoint(source.snapshot)
  const unavailable = source.baselineAvailable === false
  const selected = unavailable
    ? { segments: [], leftOut: false }
    : selectedSegments(
        source.segments,
        from.segmentIndex,
        source.snapshot.segmentIndex,
        source.includeExternal ?? false,
        attachment.id,
        new Set(source.excludedHunks ?? []),
      )
  const partial = selected.leftOut || source.eventsLeftOut === true
  const payload = unavailable
    ? makeResyncPayload(attachment, source, id)
    : createPayload(
        {
          file: source.file,
          buffer: source.buffer,
          agent: attachment.id,
          event: source.event ?? 'send',
          deliveryId: id,
          ...(source.note === undefined || source.note.length === 0 ? {} : { notes: [source.note] }),
          cursor: source.snapshot.cursor,
          segments: selected.segments,
          annotations: eventsInRange(source.annotations, from.cursor, source.snapshot.cursor),
          replies: eventsInRange(source.replies, from.cursor, source.snapshot.cursor),
          resolved: eventsInRange(source.resolved, from.cursor, source.snapshot.cursor),
          edits: eventsInRange(source.edits, from.cursor, source.snapshot.cursor),
          ...(partial ? { partial: true } : {}),
        },
        { currentDocument: source.snapshot.document },
      )

  return cloneAndFreeze({
    id,
    createdAt: source.now,
    includeExternal: source.includeExternal ?? false,
    from,
    to,
    payload,
  })
}

export interface MessageSource {
  file: string
  buffer: string
  sender: PayloadAgentTag
  note: string
  now: number
  id?: string
}

/**
 * Freezes an agent-to-agent message as a delivery whose endpoints both equal
 * the recipient's next delivery start, so acknowledging it writes the baseline
 * and cursor values they would hold anyway (PRD §6.7): nothing advances,
 * nothing is skipped, in either queue order.
 */
export function freezeMessage(attachment: Attachment, source: MessageSource): FrozenDelivery {
  assertMessageNote(source.note)
  const id = source.id ?? makeId('d')
  const endpoint = deliveryStart(attachment)
  return cloneAndFreeze({
    id,
    createdAt: source.now,
    includeExternal: false,
    from: endpoint,
    to: endpoint,
    payload: createPayload({
      file: source.file,
      buffer: source.buffer,
      agent: attachment.id,
      event: 'message',
      deliveryId: id,
      from: source.sender,
      notes: [source.note],
    }),
  })
}

/** A queued message is a note, not the user's data; it never defers expiry. */
export function isMessageDelivery(delivery: FrozenDelivery): boolean {
  return delivery.payload.event === 'message'
}

export function enqueueDelivery(
  attachment: Attachment,
  delivery: FrozenDelivery,
): Attachment {
  if (attachment.deliveries.some((queued) => queued.id === delivery.id)) return attachment
  return { ...attachment, deliveries: [...attachment.deliveries, delivery] }
}

/** Creates one immutable, recipient-specific delivery. Recipients default to every attachment. */
export function sendToRecipients(
  attachments: Readonly<Record<string, Attachment>>,
  source: DeliverySource,
  recipientIds?: readonly string[],
): SendResult {
  const selected = recipientIds ?? Object.keys(attachments)
  const next = { ...attachments }
  const deliveries: FrozenDelivery[] = []
  for (const id of selected) {
    const attachment = attachments[id]
    if (attachment === undefined) throw new Error(`Attachment ${id} was not found`)
    const perRecipientId = source.id === undefined
      ? undefined
      : selected.length === 1
        ? source.id
        : `${source.id}_${id}`
    const delivery = freezeDelivery(
      attachment,
      perRecipientId === undefined ? source : { ...source, id: perRecipientId },
    )
    next[id] = enqueueDelivery(attachment, delivery)
    deliveries.push(delivery)
  }
  return { attachments: next, deliveries }
}

/** Collection is intentionally read-only. Until ack, every call returns the same object and id. */
export function collectOldest(attachment: Attachment): FrozenDelivery | null {
  return attachment.deliveries[0] ?? null
}

export function noteAttachCall(attachment: Attachment, now: number): Attachment {
  return { ...attachment, lastCallAt: now, waiting: true }
}

export function finishAttachCall(attachment: Attachment, now: number): Attachment {
  return { ...attachment, lastCallAt: now, waiting: false }
}

export function acknowledgeDelivery(
  attachment: Attachment,
  deliveryId: string,
): AcknowledgmentResult {
  const oldest = attachment.deliveries[0]
  if (oldest === undefined || oldest.id !== deliveryId) {
    return { attachment, acknowledged: false }
  }
  return {
    acknowledged: true,
    attachment: {
      ...attachment,
      baseline: {
        snapshotId: oldest.to.snapshotId,
        segmentIndex: oldest.to.segmentIndex,
      },
      cursor: oldest.to.cursor,
      deliveries: attachment.deliveries.slice(1),
    },
  }
}

export function mayExpireAttachment(
  attachment: Attachment,
  now: number,
  idleMs = DEFAULT_ATTACHMENT_IDLE_MS,
): boolean {
  return !attachment.waiting
    && attachment.deliveries.every(isMessageDelivery)
    && now - attachment.lastCallAt >= idleMs
}

export function expireIdleAttachments(
  attachments: Readonly<Record<string, Attachment>>,
  now: number,
  idleMs = DEFAULT_ATTACHMENT_IDLE_MS,
): Readonly<Record<string, Attachment>> {
  return Object.fromEntries(
    Object.entries(attachments).filter(([, attachment]) =>
      !mayExpireAttachment(attachment, now, idleMs),
    ),
  )
}

export function queueClosed(
  attachments: Readonly<Record<string, Attachment>>,
  source: Omit<DeliverySource, 'event' | 'segments'> & { segments?: readonly IndexedSegment[] },
): SendResult {
  return sendToRecipients(
    attachments,
    { ...source, segments: source.segments ?? [], event: 'closed' },
  )
}

export function createInitialPayload(
  attachment: Attachment,
  file: string,
  buffer: string,
  snapshot: DeliverySnapshot,
  annotations: readonly PayloadAnnotation[] = [],
): StrataPayload {
  return createPayload({
    file,
    buffer,
    agent: attachment.id,
    event: 'initial',
    cursor: snapshot.cursor,
    document: snapshot.document,
    annotations: eventsInRange(annotations, 0, snapshot.cursor),
  })
}

export function createClipboardRecipient(): ClipboardRecipient {
  return { baseline: null, cursor: 0, pending: null }
}

export function prepareClipboardDelivery(
  recipient: ClipboardRecipient,
  source: DeliverySource,
): { recipient: ClipboardRecipient; delivery: FrozenDelivery } {
  if (recipient.pending !== null) return { recipient, delivery: recipient.pending }

  const synthetic = recipient.baseline === null
    ? createAttachment({
        id: 'clipboard',
        name: 'Clipboard',
        now: source.now,
        snapshot: { snapshotId: '', segmentIndex: -1, cursor: 0, document: '' },
      })
    : {
        id: 'clipboard',
        name: 'Clipboard',
        attachedAt: source.now,
        lastCallAt: source.now,
        baseline: recipient.baseline,
        cursor: recipient.cursor,
        deliveries: [],
      }

  let delivery: FrozenDelivery
  if (recipient.baseline === null) {
    const id = source.id ?? makeId('d')
    const from: DeliveryEndpoint = { snapshotId: '', segmentIndex: -1, cursor: 0 }
    delivery = cloneAndFreeze({
      id,
      createdAt: source.now,
      includeExternal: false,
      from,
      to: endpoint(source.snapshot),
      payload: createPayload({
        file: source.file,
        buffer: source.buffer,
        agent: 'clipboard',
        event: 'initial',
        cursor: source.snapshot.cursor,
        document: source.snapshot.document,
        annotations: eventsInRange(source.annotations, 0, source.snapshot.cursor),
      }),
    })
  } else {
    delivery = freezeDelivery(synthetic, source)
  }
  const next = { ...recipient, pending: delivery }
  return { recipient: next, delivery }
}

/** Call only after attempting the system clipboard write. Failure keeps the frozen retry pending. */
export function acknowledgeClipboardWrite(
  recipient: ClipboardRecipient,
  deliveryId: string,
  succeeded: boolean,
): ClipboardRecipient {
  if (!succeeded || recipient.pending?.id !== deliveryId) return recipient
  return {
    baseline: {
      snapshotId: recipient.pending.to.snapshotId,
      segmentIndex: recipient.pending.to.segmentIndex,
    },
    cursor: recipient.pending.to.cursor,
    pending: null,
  }
}
