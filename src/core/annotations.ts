export type AnnotationKind = 'comment' | 'question' | 'suggestion'
export type AnnotationStatus = 'open' | 'resolved' | 'orphaned'
export type AnnotationAuthor = 'user' | 'agent'
export type AnnotationEventType =
  | 'created'
  | 'replied'
  | 'resolved'
  | 'accepted'
  | 'rejected'
  | 'orphaned'
  | 'reattached'
  | 'requoted'

export interface AnnotationAnchor {
  quote: string
  prefix: string
  suffix: string
  start: number
  end: number
}

export interface AnnotationReply {
  id: string
  seq: number
  author: AnnotationAuthor
  agent: string | null
  text: string
}

export interface Annotation {
  id: string
  seq: number
  kind: AnnotationKind
  author: AnnotationAuthor
  agent: string | null
  status: AnnotationStatus
  quote: string
  text: string
  label?: string
  line: number
  anchor: AnnotationAnchor
  replies: readonly AnnotationReply[]
  resolution?: 'accepted' | 'rejected'
}

export interface AnnotationEvent {
  seq: number
  type: AnnotationEventType
  annotationId: string
  replyId?: string
  author: AnnotationAuthor
  agent: string | null
}

export type HunkVerdictType = 'hunk-kept' | 'hunk-reverted'

/**
 * The verdict on a kept or reverted buffer edit, delivered only to the agent
 * that authored it. Not an annotation event: it has no annotation record, and
 * `targetAgentId` names the addressee where annotation events' `agent` names
 * the actor.
 */
export interface HunkVerdictEvent {
  seq: number
  type: HunkVerdictType
  targetAgentId: string
  quote: string
}

export type LogEvent = AnnotationEvent | HunkVerdictEvent

export function isHunkVerdict(event: LogEvent): event is HunkVerdictEvent {
  return event.type === 'hunk-kept' || event.type === 'hunk-reverted'
}

export interface AnnotationLog {
  nextSeq: number
  annotations: Readonly<Record<string, Annotation>>
  events: readonly LogEvent[]
}

export interface CreateAnnotationInput {
  id: string
  kind: AnnotationKind
  author: AnnotationAuthor
  agent?: string | null
  quote: string
  text: string
  label?: string
  precededBy?: string
  followedBy?: string
  start?: number
}

export interface AnnotationResult {
  log: AnnotationLog
  annotation: Annotation
  event: AnnotationEvent
}

export class AnnotationAnchorError extends Error {
  readonly code: 'quote_missing' | 'quote_ambiguous' | 'invalid_suggestion'
  readonly matches: readonly number[]

  constructor(
    code: 'quote_missing' | 'quote_ambiguous' | 'invalid_suggestion',
    message: string,
    matches: readonly number[] = [],
  ) {
    super(message)
    this.name = 'AnnotationAnchorError'
    this.code = code
    this.matches = matches
  }
}

const MAX_CONTEXT = 32
const MAX_ANNOTATION_BYTES = 64 * 1024

function lastAnnotationEvent(log: AnnotationLog, annotationId: string): AnnotationEvent {
  return log.events.findLast(
    (event): event is AnnotationEvent => !isHunkVerdict(event) && event.annotationId === annotationId,
  )!
}

export function createAnnotationLog(): AnnotationLog {
  return { nextSeq: 1, annotations: {}, events: [] }
}

/** Human-readable excerpts used by both online and offline annotate failures. */
export function closestAnnotationMatches(
  document: string,
  quote: string,
  positions: readonly number[],
): string[] {
  if (positions.length > 0) {
    return positions.slice(0, 5).map((position) =>
      document.slice(Math.max(0, position - 32), Math.min(document.length, position + quote.length + 32)),
    )
  }

  const queryWords = new Set(quote.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
  return document.split(/\r?\n/)
    .map((line, index) => {
      const words = new Set(line.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
      let overlap = 0
      for (const word of queryWords) if (words.has(word)) overlap += 1
      const includes = line.toLowerCase().includes(quote.toLowerCase()) ? 2 : 0
      return { line, index, score: overlap + includes }
    })
    .filter((candidate) => candidate.line.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map((candidate) => candidate.line.slice(0, 256))
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function assertTextLimit(value: string, field: string): void {
  if (utf8Bytes(value) > MAX_ANNOTATION_BYTES) {
    throw new RangeError(`${field} exceeds the 64 KB limit`)
  }
}

function lineAt(document: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (document.charCodeAt(index) === 10) line += 1
  }
  return line
}

function allOccurrences(document: string, quote: string): number[] {
  if (quote.length === 0) return []
  const matches: number[] = []
  let from = 0
  while (from <= document.length - quote.length) {
    const match = document.indexOf(quote, from)
    if (match < 0) break
    matches.push(match)
    from = match + 1
  }
  return matches
}

/**
 * The start of the quote occurrence closest to `near`, or null when the quote
 * no longer occurs. Offsets captured in the renderer can go stale while a
 * concurrent edit lands (an agent editing while the composer is open); the
 * quote text is what the user selected, so it wins over the drifted offsets.
 */
export function nearestQuoteStart(document: string, quote: string, near: number): number | null {
  const occurrences = allOccurrences(document, quote)
  if (occurrences.length === 0) return null
  let best = occurrences[0]!
  for (const start of occurrences) {
    if (Math.abs(start - near) < Math.abs(best - near)) best = start
  }
  return best
}

function contextMatches(
  document: string,
  start: number,
  quote: string,
  precededBy?: string,
  followedBy?: string,
): boolean {
  if (precededBy !== undefined) {
    const context = precededBy.slice(-MAX_CONTEXT)
    if (document.slice(Math.max(0, start - context.length), start) !== context) return false
  }
  if (followedBy !== undefined) {
    const context = followedBy.slice(0, MAX_CONTEXT)
    const end = start + quote.length
    if (document.slice(end, end + context.length) !== context) return false
  }
  return true
}

export function locateQuote(
  document: string,
  quote: string,
  precededBy?: string,
  followedBy?: string,
): AnnotationAnchor {
  const exact = allOccurrences(document, quote)
  if (exact.length === 0) {
    throw new AnnotationAnchorError('quote_missing', 'The quote does not occur in the current buffer')
  }

  const contextual = exact.filter((start) =>
    contextMatches(document, start, quote, precededBy, followedBy),
  )
  const candidates = precededBy === undefined && followedBy === undefined ? exact : contextual
  if (candidates.length !== 1) {
    throw new AnnotationAnchorError(
      'quote_ambiguous',
      candidates.length === 0
        ? 'The supplied context does not identify an exact quote'
        : 'The quote is ambiguous in the current buffer',
      candidates.length === 0 ? exact : candidates,
    )
  }

  const start = candidates[0]!
  const end = start + quote.length
  return {
    quote,
    prefix: document.slice(Math.max(0, start - MAX_CONTEXT), start),
    suffix: document.slice(end, end + MAX_CONTEXT),
    start,
    end,
  }
}

function anchorAt(document: string, quote: string, start: number): AnnotationAnchor {
  if (start < 0 || document.slice(start, start + quote.length) !== quote) {
    throw new AnnotationAnchorError('quote_missing', 'The quote is not present at the supplied position')
  }
  const end = start + quote.length
  return {
    quote,
    prefix: document.slice(Math.max(0, start - MAX_CONTEXT), start),
    suffix: document.slice(end, end + MAX_CONTEXT),
    start,
    end,
  }
}

function topLevelBlockRange(document: string, offset: number): { start: number; end: number } {
  const before = document.lastIndexOf('\n\n', Math.max(0, offset - 1))
  const after = document.indexOf('\n\n', offset)
  return { start: before < 0 ? 0 : before + 2, end: after < 0 ? document.length : after }
}

function assertSuggestionInOneBlock(document: string, anchor: AnnotationAnchor): void {
  const block = topLevelBlockRange(document, anchor.start)
  if (anchor.end > block.end) {
    throw new AnnotationAnchorError(
      'invalid_suggestion',
      'A suggestion quote must stay within one top-level block',
      [anchor.start],
    )
  }
}

function withEvent(
  log: AnnotationLog,
  annotation: Annotation,
  type: AnnotationEventType,
  author: AnnotationAuthor,
  agent: string | null,
  replyId?: string,
): AnnotationResult {
  const event: AnnotationEvent = {
    seq: log.nextSeq,
    type,
    annotationId: annotation.id,
    author,
    agent,
    ...(replyId === undefined ? {} : { replyId }),
  }
  const stamped = { ...annotation, seq: event.seq }
  return {
    log: {
      nextSeq: event.seq + 1,
      annotations: { ...log.annotations, [stamped.id]: stamped },
      events: [...log.events, event],
    },
    annotation: stamped,
    event,
  }
}

export function createAnnotation(
  log: AnnotationLog,
  document: string,
  input: CreateAnnotationInput,
): AnnotationResult {
  if (log.annotations[input.id] !== undefined) throw new Error(`Annotation ${input.id} already exists`)
  assertTextLimit(input.text, 'Annotation text')
  const anchor = input.start === undefined
    ? locateQuote(document, input.quote, input.precededBy, input.followedBy)
    : anchorAt(document, input.quote, input.start)
  if (input.kind === 'suggestion') assertSuggestionInOneBlock(document, anchor)

  const annotation: Annotation = {
    id: input.id,
    seq: 0,
    kind: input.kind,
    author: input.author,
    agent: input.author === 'agent' ? (input.agent ?? null) : null,
    status: 'open',
    quote: input.quote,
    text: input.text,
    ...(input.label === undefined ? {} : { label: input.label }),
    line: lineAt(document, anchor.start),
    anchor,
    replies: [],
  }
  return withEvent(log, annotation, 'created', input.author, annotation.agent)
}

function requireAnnotation(log: AnnotationLog, id: string): Annotation {
  const annotation = log.annotations[id]
  if (annotation === undefined) throw new Error(`Annotation ${id} was not found`)
  return annotation
}

export function replyToAnnotation(
  log: AnnotationLog,
  annotationId: string,
  input: { id: string; author: AnnotationAuthor; agent?: string | null; text: string },
): AnnotationResult {
  assertTextLimit(input.text, 'Reply text')
  const annotation = requireAnnotation(log, annotationId)
  if (annotation.replies.some((reply) => reply.id === input.id)) {
    throw new Error(`Reply ${input.id} already exists`)
  }
  const agent = input.author === 'agent' ? (input.agent ?? null) : null
  const reply: AnnotationReply = {
    id: input.id,
    seq: log.nextSeq,
    author: input.author,
    agent,
    text: input.text,
  }
  return withEvent(
    log,
    { ...annotation, replies: [...annotation.replies, reply] },
    'replied',
    input.author,
    agent,
    reply.id,
  )
}

export function resolveAnnotation(
  log: AnnotationLog,
  annotationId: string,
  author: AnnotationAuthor = 'user',
  agent: string | null = null,
): AnnotationResult {
  const annotation = requireAnnotation(log, annotationId)
  if (annotation.status === 'resolved') {
    return { log, annotation, event: lastAnnotationEvent(log, annotationId) }
  }
  return withEvent(log, { ...annotation, status: 'resolved' }, 'resolved', author, agent)
}

export interface RequoteAnnotationInput {
  quote: string
  start: number
}

/**
 * Moves an annotation onto a different exact span chosen by the user. The
 * thread, kind, and author stay; only the anchor changes. Agents receive the
 * annotation again with its new quote plus a `requoted` resolution line.
 */
export function requoteAnnotation(
  log: AnnotationLog,
  document: string,
  annotationId: string,
  input: RequoteAnnotationInput,
): AnnotationResult {
  const annotation = requireAnnotation(log, annotationId)
  if (annotation.status === 'resolved') throw new Error('A resolved annotation cannot be requoted')
  if (input.quote.length === 0) throw new AnnotationAnchorError('quote_missing', 'An annotation quote cannot be empty')
  const anchor = anchorAt(document, input.quote, input.start)
  if (annotation.kind === 'suggestion') assertSuggestionInOneBlock(document, anchor)
  if (annotation.status === 'open' && anchor.start === annotation.anchor.start && anchor.end === annotation.anchor.end && input.quote === annotation.quote) {
    return { log, annotation, event: lastAnnotationEvent(log, annotationId) }
  }
  return withEvent(
    log,
    { ...annotation, status: 'open', quote: input.quote, anchor, line: lineAt(document, anchor.start) },
    'requoted',
    'user',
    null,
  )
}

export interface SuggestionDecisionResult extends AnnotationResult {
  shadow: string
  userChange?: { start: number; end: number; removed: string; added: string }
}

export function acceptSuggestion(
  log: AnnotationLog,
  shadow: string,
  annotationId: string,
  author: AnnotationAuthor = 'user',
  agent: string | null = null,
): SuggestionDecisionResult {
  const annotation = requireAnnotation(log, annotationId)
  if (annotation.kind !== 'suggestion') throw new Error(`${annotationId} is not a suggestion`)
  if (annotation.status === 'orphaned') throw new Error('An orphaned suggestion cannot be accepted')
  if (annotation.status === 'resolved') throw new Error('A resolved suggestion cannot be accepted')

  const start = annotation.anchor.start
  const end = start + annotation.quote.length
  if (shadow.slice(start, end) !== annotation.quote) {
    throw new AnnotationAnchorError('quote_missing', 'The suggestion quote no longer matches the buffer')
  }
  const result = withEvent(
    log,
    { ...annotation, status: 'resolved', resolution: 'accepted' },
    'accepted',
    author,
    agent,
  )
  return {
    ...result,
    shadow: shadow.slice(0, start) + annotation.text + shadow.slice(end),
    userChange: { start, end, removed: annotation.quote, added: annotation.text },
  }
}

export function rejectSuggestion(
  log: AnnotationLog,
  annotationId: string,
  author: AnnotationAuthor = 'user',
  agent: string | null = null,
): AnnotationResult {
  const annotation = requireAnnotation(log, annotationId)
  if (annotation.kind !== 'suggestion') throw new Error(`${annotationId} is not a suggestion`)
  if (annotation.status === 'resolved') throw new Error('A resolved suggestion cannot be rejected')
  const result = withEvent(
    log,
    { ...annotation, status: 'resolved', resolution: 'rejected' },
    'rejected',
    author,
    agent,
  )
  return result
}

/** Maps stored positions through one editor replacement without changing the exact quote. */
export function mapAnnotationsThroughEdit(
  log: AnnotationLog,
  edit: { start: number; deleteCount: number; insertText: string },
): AnnotationLog {
  if (edit.start < 0 || edit.deleteCount < 0) throw new RangeError('Invalid editor transaction range')
  const editEnd = edit.start + edit.deleteCount
  const delta = edit.insertText.length - edit.deleteCount
  const mapped = Object.fromEntries(Object.entries(log.annotations).map(([id, annotation]) => {
    const { start, end } = annotation.anchor
    let nextStart = start
    let nextEnd = end
    if (editEnd <= start) {
      nextStart += delta
      nextEnd += delta
    } else if (edit.start < end) {
      nextStart = Math.min(start, edit.start)
      nextEnd = Math.max(nextStart, end + delta)
    }
    return [id, {
      ...annotation,
      anchor: { ...annotation.anchor, start: nextStart, end: nextEnd },
    }]
  }))
  return { ...log, annotations: mapped }
}

function relocationCandidate(document: string, annotation: Annotation): AnnotationAnchor | null {
  const matches = allOccurrences(document, annotation.quote)
  if (matches.length === 1) return anchorAt(document, annotation.quote, matches[0]!)
  const contextual = matches.filter((start) =>
    contextMatches(document, start, annotation.quote, annotation.anchor.prefix, annotation.anchor.suffix),
  )
  return contextual.length === 1 ? anchorAt(document, annotation.quote, contextual[0]!) : null
}

export function relocateAnnotation(
  log: AnnotationLog,
  annotationId: string,
  document: string,
): AnnotationResult {
  const annotation = requireAnnotation(log, annotationId)
  if (annotation.status === 'resolved') {
    return { log, annotation, event: lastAnnotationEvent(log, annotationId) }
  }
  const anchor = relocationCandidate(document, annotation)
  if (anchor === null) {
    if (annotation.status === 'orphaned') {
      return { log, annotation, event: lastAnnotationEvent(log, annotationId) }
    }
    return withEvent(log, { ...annotation, status: 'orphaned' }, 'orphaned', 'user', null)
  }

  const relocated: Annotation = {
    ...annotation,
    status: 'open',
    anchor,
    line: lineAt(document, anchor.start),
  }
  if (annotation.status !== 'orphaned') {
    return { log: { ...log, annotations: { ...log.annotations, [annotation.id]: relocated } }, annotation: relocated, event: lastAnnotationEvent(log, annotationId) }
  }
  return withEvent(log, relocated, 'reattached', 'user', null)
}

export interface BatchSuggestionResult {
  log: AnnotationLog
  shadow: string
  accepted: readonly string[]
  skipped: readonly string[]
  changes: readonly NonNullable<SuggestionDecisionResult['userChange']>[]
}

export function acceptAllSuggestions(
  log: AnnotationLog,
  shadow: string,
  agent: string,
): BatchSuggestionResult {
  const suggestions = Object.values(log.annotations)
    .filter((item) => item.kind === 'suggestion' && item.agent === agent && item.status === 'open')
    .sort((left, right) => left.anchor.start - right.anchor.start)
  let nextLog = log
  let nextShadow = shadow
  let acceptedEnd = -1
  const accepted: string[] = []
  const skipped: string[] = []
  const changes: NonNullable<SuggestionDecisionResult['userChange']>[] = []

  for (const original of suggestions) {
    if (original.anchor.start < acceptedEnd) {
      skipped.push(original.id)
      continue
    }
    const current = nextLog.annotations[original.id]!
    try {
      const decision = acceptSuggestion(nextLog, nextShadow, current.id)
      const change = decision.userChange!
      nextLog = mapAnnotationsThroughEdit(decision.log, {
        start: change.start,
        deleteCount: change.end - change.start,
        insertText: change.added,
      })
      nextShadow = decision.shadow
      acceptedEnd = original.anchor.end
      accepted.push(original.id)
      changes.push(change)
    } catch {
      skipped.push(original.id)
    }
  }
  return { log: nextLog, shadow: nextShadow, accepted, skipped, changes }
}

export interface RejectAllSuggestionsResult {
  log: AnnotationLog
  rejected: readonly string[]
}

export function rejectAllSuggestions(
  log: AnnotationLog,
  agent: string,
): RejectAllSuggestionsResult {
  const suggestions = Object.values(log.annotations)
    .filter((item) => item.kind === 'suggestion' && item.agent === agent && item.status === 'open')
    .sort((left, right) => left.anchor.start - right.anchor.start || left.seq - right.seq)
  let nextLog = log
  const rejected: string[] = []
  for (const suggestion of suggestions) {
    nextLog = rejectSuggestion(nextLog, suggestion.id).log
    rejected.push(suggestion.id)
  }
  return { log: nextLog, rejected }
}

/**
 * Clearing resolved annotations also removes their historical events. Keeping
 * dangling events would make a recipient whose cursor predates the clear try
 * to serialize an annotation record that no longer exists.
 */
export function clearResolvedAnnotations(log: AnnotationLog): AnnotationLog {
  const removed = new Set(
    Object.values(log.annotations)
      .filter((annotation) => annotation.status === 'resolved')
      .map((annotation) => annotation.id),
  )
  if (removed.size === 0) return log
  return {
    ...log,
    annotations: Object.fromEntries(
      Object.entries(log.annotations).filter(([id]) => !removed.has(id)),
    ),
    events: log.events.filter((event) => isHunkVerdict(event) || !removed.has(event.annotationId)),
  }
}

/** Removes only resolved records whose resolution is known to be safely delivered. */
export function pruneResolvedAnnotations(
  log: AnnotationLog,
  annotationIds: ReadonlySet<string>,
): AnnotationLog {
  if (annotationIds.size === 0) return log
  const removed = new Set(
    [...annotationIds].filter((id) => log.annotations[id]?.status === 'resolved'),
  )
  if (removed.size === 0) return log
  return {
    ...log,
    annotations: Object.fromEntries(
      Object.entries(log.annotations).filter(([id]) => !removed.has(id)),
    ),
    events: log.events.filter((event) => isHunkVerdict(event) || !removed.has(event.annotationId)),
  }
}

export function eventsAfter(log: AnnotationLog, cursor: number): readonly LogEvent[] {
  return log.events.filter((event) => event.seq > cursor)
}

export function annotationsAfter(log: AnnotationLog, cursor: number): readonly Annotation[] {
  const ids = new Set(
    eventsAfter(log, cursor)
      .filter((event): event is AnnotationEvent => !isHunkVerdict(event))
      .map((event) => event.annotationId),
  )
  return [...ids].map((id) => log.annotations[id]!).sort((left, right) => left.seq - right.seq)
}

/** First non-blank line of the text the review acted on, capped without splitting a surrogate pair. */
export function verdictQuote(removed: string, added: string): string {
  const source = added.trim().length > 0 ? added : removed
  const line = source.split('\n').find((candidate) => candidate.trim().length > 0) ?? ''
  return [...line].slice(0, 120).join('')
}

export function recordHunkVerdict(
  log: AnnotationLog,
  type: HunkVerdictType,
  targetAgentId: string,
  quote: string,
): AnnotationLog {
  return {
    ...log,
    nextSeq: log.nextSeq + 1,
    events: [...log.events, { seq: log.nextSeq, type, targetAgentId, quote }],
  }
}

export interface AnnotationDeliveryResolution {
  id: string
  seq: number
  kind: AnnotationKind
  resolution: 'accepted' | 'rejected' | 'resolved' | 'orphaned' | 'reattached' | 'requoted'
}

export interface DeliveredAnnotation {
  id: string
  seq: number
  kind: AnnotationKind
  author: AnnotationAuthor
  agent: string | null
  status: AnnotationStatus
  quote: string
  text: string
  line: number
  replies: readonly AnnotationReply[]
}

export interface DeliveredReply {
  id: string
  seq: number
  annotation: string
  author: AnnotationAuthor
  agent: string | null
  text: string
}

export interface DeliveredEdit {
  seq: number
  verdict: 'kept' | 'reverted'
  quote: string
}

export interface AnnotationDeliverySlice {
  cursor: number
  annotations: readonly DeliveredAnnotation[]
  replies: readonly DeliveredReply[]
  resolved: readonly AnnotationDeliveryResolution[]
  edits: readonly DeliveredEdit[]
  /** Events the recipient would have received but the user unchecked; feeds the delivery's `partial` flag. */
  excluded: number
}

/** Removes editor-only anchor and label fields before JSON v9 serialization. */
export function toDeliveredAnnotation(annotation: Annotation): DeliveredAnnotation {
  return {
    id: annotation.id,
    seq: annotation.seq,
    kind: annotation.kind,
    author: annotation.author,
    agent: annotation.agent,
    status: annotation.status,
    quote: annotation.quote,
    text: annotation.text,
    line: annotation.line,
    replies: annotation.replies,
  }
}

/**
 * Builds the per-recipient event range used by a frozen delivery. Events the
 * recipient authored itself are skipped (it already knows them) but still count
 * toward the cursor. An annotation created in the range carries its whole thread;
 * a reply to an older annotation is delivered alone, keyed by annotation id.
 * Acceptance and rejection go only to the suggestion author. Other agents learn
 * the accepted text through the resulting user segment.
 */
export function annotationDeliverySlice(
  log: AnnotationLog,
  cursor: number,
  recipientAgent: string,
  excludedEvents: ReadonlySet<number> = new Set(),
): AnnotationDeliverySlice {
  const events = eventsAfter(log, cursor)
  const created = new Set<string>()
  const replies: DeliveredReply[] = []
  const resolved: AnnotationDeliveryResolution[] = []
  const edits: DeliveredEdit[] = []
  let excluded = 0
  for (const event of events) {
    if (isHunkVerdict(event)) {
      if (event.targetAgentId !== recipientAgent) continue
      if (excludedEvents.has(event.seq)) {
        excluded += 1
        continue
      }
      edits.push({ seq: event.seq, verdict: event.type === 'hunk-kept' ? 'kept' : 'reverted', quote: event.quote })
      continue
    }
    const annotation = log.annotations[event.annotationId]
    if (annotation === undefined) continue
    if (event.author === 'agent' && event.agent === recipientAgent) continue
    // Exclusion runs after the recipient-author guard, so the recipient's own
    // events never count as left out, and before thread grouping, so a reply
    // whose excluded creation stays behind delivers alone, keyed by id.
    if (excludedEvents.has(event.seq)) {
      excluded += 1
      continue
    }
    if (event.type === 'created') {
      created.add(annotation.id)
    } else if (event.type === 'replied') {
      if (created.has(annotation.id)) continue
      const reply = annotation.replies.find((candidate) => candidate.id === event.replyId)
      if (reply === undefined) continue
      replies.push({
        id: reply.id,
        seq: reply.seq,
        annotation: annotation.id,
        author: reply.author,
        agent: reply.agent,
        text: reply.text,
      })
    } else if (event.type === 'resolved') {
      resolved.push({ id: annotation.id, seq: event.seq, kind: annotation.kind, resolution: 'resolved' })
    } else if (event.type === 'accepted' || event.type === 'rejected') {
      if (annotation.agent === recipientAgent) {
        resolved.push({ id: annotation.id, seq: event.seq, kind: annotation.kind, resolution: event.type })
      }
    } else if (event.type === 'orphaned' || event.type === 'reattached') {
      resolved.push({ id: annotation.id, seq: event.seq, kind: annotation.kind, resolution: event.type })
    } else if (event.type === 'requoted') {
      // The recipient sees the annotation again with its new quote and a line saying why.
      created.add(annotation.id)
      resolved.push({ id: annotation.id, seq: event.seq, kind: annotation.kind, resolution: 'requoted' })
    }
  }
  return {
    cursor: log.nextSeq - 1,
    annotations: [...created]
      .map((id) => toDeliveredAnnotation(log.annotations[id]!))
      .sort((left, right) => left.seq - right.seq),
    replies,
    resolved,
    edits,
    excluded,
  }
}

/** The annotation records and events one application step changed. */
export interface AnnotationStepChanges {
  before: Readonly<Record<string, Annotation | null>>
  after: Readonly<Record<string, Annotation | null>>
  events: readonly LogEvent[]
}

export function annotationStepChanges(before: AnnotationLog, after: AnnotationLog): AnnotationStepChanges {
  const beforeRecords: Record<string, Annotation | null> = {}
  const afterRecords: Record<string, Annotation | null> = {}
  for (const id of new Set([...Object.keys(before.annotations), ...Object.keys(after.annotations)])) {
    const previous = before.annotations[id] ?? null
    const next = after.annotations[id] ?? null
    if (previous === next) continue
    beforeRecords[id] = previous
    afterRecords[id] = next
  }
  const known = new Set(before.events.map((event) => event.seq))
  return {
    before: beforeRecords,
    after: afterRecords,
    events: after.events.filter((event) => !known.has(event.seq)),
  }
}

function withRecords(log: AnnotationLog, records: Readonly<Record<string, Annotation | null>>): Record<string, Annotation> {
  const annotations: Record<string, Annotation> = { ...log.annotations }
  for (const [id, record] of Object.entries(records)) {
    if (record === null) delete annotations[id]
    else annotations[id] = record
  }
  return annotations
}

/** Put back the records a step changed and drop the events it appended. nextSeq never decreases. */
export function undoAnnotationStep(log: AnnotationLog, changes: AnnotationStepChanges): AnnotationLog {
  const removed = new Set(changes.events.map((event) => event.seq))
  return {
    nextSeq: log.nextSeq,
    annotations: withRecords(log, changes.before),
    events: log.events.filter((event) => !removed.has(event.seq)),
  }
}

export function redoAnnotationStep(log: AnnotationLog, changes: AnnotationStepChanges): AnnotationLog {
  const present = new Set(log.events.map((event) => event.seq))
  return {
    nextSeq: Math.max(log.nextSeq, ...changes.events.map((event) => event.seq + 1)),
    annotations: withRecords(log, changes.after),
    events: [...log.events, ...changes.events.filter((event) => !present.has(event.seq))]
      .sort((left, right) => left.seq - right.seq),
  }
}
