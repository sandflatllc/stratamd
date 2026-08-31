export const PAYLOAD_VERSION = 11 as const

export type PayloadEvent =
  | 'initial'
  | 'send'
  | 'message'
  | 'resync'
  | 'closed'
  | 'timeout'
  | 'superseded'
  | 'state'
  | 'changes'

export interface PayloadHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  removed: readonly string[]
  added: readonly string[]
}

export interface PayloadAgentTag {
  agent: string
  name: string
}

export interface PayloadSegment {
  author: 'user' | 'external'
  tag?: PayloadAgentTag
  hunks: readonly PayloadHunk[]
}

export interface PayloadReply {
  id: string
  seq: number
  author: 'user' | 'agent'
  agent?: string | null
  text: string
}

/** A reply to an annotation the recipient already holds, delivered without its thread. */
export interface PayloadThreadReply extends PayloadReply {
  annotation: string
}

export interface PayloadAnnotation {
  id: string
  seq: number
  kind: 'comment' | 'question' | 'suggestion'
  author: 'user' | 'agent'
  agent: string | null
  status: 'open' | 'resolved' | 'orphaned'
  quote: string
  text: string
  line: number
  replies: readonly PayloadReply[]
}

export interface PayloadResolution {
  id: string
  seq: number
  kind: 'comment' | 'question' | 'suggestion'
  resolution: 'accepted' | 'rejected' | 'resolved' | 'orphaned' | 'reattached' | 'requoted'
}

/** The verdict on the recipient's own kept or reverted buffer edit (PRD §6.3). */
export interface PayloadEditVerdict {
  seq: number
  verdict: 'kept' | 'reverted'
  quote: string
}

/** One attachment row in a `state` payload (PRD §8). */
export interface PayloadAttachment {
  agent: string
  name: string
  state: 'waiting' | 'working' | 'pending'
  lead: boolean
}

export interface StrataPayload {
  version: typeof PAYLOAD_VERSION
  file: string
  buffer: string
  agent: string
  event: PayloadEvent
  deliveryId?: string
  /** The sending attachment; present only on `message` events. */
  from?: PayloadAgentTag
  notes?: readonly string[]
  /** Every attachment, present only on `state` for an open document. */
  attachments?: readonly PayloadAttachment[]
  cursor?: number
  document?: string
  segments?: readonly PayloadSegment[]
  annotations?: readonly PayloadAnnotation[]
  replies?: readonly PayloadThreadReply[]
  resolved?: readonly PayloadResolution[]
  edits?: readonly PayloadEditVerdict[]
  /** Present when the user left parts of the changed document out of this delivery. */
  partial?: boolean
  text: string
}

export type PayloadInput = Omit<StrataPayload, 'version' | 'text'> & { text?: never }

export interface RenderContext {
  /** Current buffer text, used to give a new annotation its surrounding paragraph. */
  currentDocument?: string
}

/** Full guardrail for the agent's first look at a document. */
export const guardrailLine = (file: string, buffer: string): string =>
  `While attached, write only to the buffer file: ${buffer}. The document ${file} is the user's to save.`

/** Later events repeat only the part the agent must act on; it already knows the document. */
export const writeOnlyLine = (buffer: string): string => `Write only to ${buffer}.`

function openingLine(input: PayloadInput): string {
  return input.event === 'initial' || input.event === 'resync'
    ? guardrailLine(input.file, input.buffer)
    : writeOnlyLine(input.buffer)
}

function escapeAnnotationBrackets(value: string): string {
  return value.replaceAll('⟦', '\\⟦').replaceAll('⟧', '\\⟧')
}

function authorName(annotation: PayloadAnnotation): string {
  return annotation.author === 'user' ? 'user' : (annotation.agent ?? 'agent')
}

function marker(annotation: PayloadAnnotation, quote: string, withReplies = true): string {
  return openMarker(annotation) + quote + closeMarker(annotation, withReplies)
}

function openMarker(annotation: PayloadAnnotation): string {
  const heading = `${annotation.id} ${annotation.kind} (${authorName(annotation)}): ${annotation.text}`
  return `⟦${heading}⟧${annotation.kind === 'suggestion' ? '~~' : ''}`
}

function replyAuthor(reply: PayloadReply): string {
  return reply.author === 'user' ? 'user' : (reply.agent ?? 'agent')
}

function renderReplies(annotation: PayloadAnnotation): string {
  return annotation.replies
    .map((reply) => `\n  ↳ ${replyAuthor(reply)}: ${escapeAnnotationBrackets(reply.text)}`)
    .join('')
}

function closeMarker(annotation: PayloadAnnotation, withReplies = true): string {
  const replies = withReplies ? renderReplies(annotation) : ''
  if (annotation.kind === 'suggestion') {
    return `~~ ${annotation.text}⟦/${annotation.id}⟧${replies}`
  }
  return `⟦/${annotation.id}⟧${replies}`
}

function occurrenceAtLine(document: string, annotation: PayloadAnnotation): number {
  const lineStart = annotation.line <= 1
    ? 0
    : document.split('\n', annotation.line - 1).reduce((total, part) => total + part.length + 1, 0)
  const onLine = document.indexOf(annotation.quote, lineStart)
  if (onLine >= 0) return onLine
  const first = document.indexOf(annotation.quote)
  return first
}

interface AnnotationPlacement {
  annotation: PayloadAnnotation
  start: number
}

function annotationPlacements(
  document: string,
  annotations: readonly PayloadAnnotation[],
): AnnotationPlacement[] {
  const placements = annotations
    .filter((annotation) => annotation.status !== 'resolved')
    .map((annotation) => ({ annotation, start: occurrenceAtLine(document, annotation) }))
    .filter((placement) => placement.start >= 0)
    .sort((left, right) => left.start - right.start || right.annotation.quote.length - left.annotation.quote.length)
  return placements.filter((placement, index) => {
    const end = placement.start + placement.annotation.quote.length
    return placements.slice(0, index).every((prior) => {
      const priorEnd = prior.start + prior.annotation.quote.length
      return placement.start >= priorEnd || end <= priorEnd
    })
  })
}

function inlineAnnotations(document: string, placements: readonly AnnotationPlacement[]): string {
  if (placements.length === 0) return escapeAnnotationBrackets(document)
  const opens = new Map<number, PayloadAnnotation[]>()
  const closes = new Map<number, PayloadAnnotation[]>()
  for (const placement of placements) {
    const end = placement.start + placement.annotation.quote.length
    opens.set(placement.start, [...(opens.get(placement.start) ?? []), placement.annotation])
    closes.set(end, [...(closes.get(end) ?? []), placement.annotation])
  }
  let output = ''
  for (let position = 0; position <= document.length; position += 1) {
    const ending = closes.get(position)
    if (ending !== undefined) {
      for (const annotation of ending.toSorted((a, b) => a.quote.length - b.quote.length)) {
        output += closeMarker(annotation)
      }
    }
    const starting = opens.get(position)
    if (starting !== undefined) {
      for (const annotation of starting.toSorted((a, b) => b.quote.length - a.quote.length)) {
        output += openMarker(annotation)
      }
    }
    if (position < document.length) output += escapeAnnotationBrackets(document[position]!)
  }
  return output
}

function renderAnnotationFallback(annotation: PayloadAnnotation): string {
  const replies = renderReplies(annotation)
  const location = annotation.status === 'orphaned'
    ? 'orphaned'
    : `${annotation.status}, line ${annotation.line}`
  return `- ${annotation.id} ${annotation.kind} (${authorName(annotation)}) [${location}]: ${escapeAnnotationBrackets(annotation.text)}\n  quote: ${escapeAnnotationBrackets(annotation.quote)}${replies}`
}

function renderAnnotationFallbacks(
  annotations: readonly PayloadAnnotation[],
  placements: readonly AnnotationPlacement[],
): string | null {
  const placed = new Set(placements.map((placement) => placement.annotation.id))
  const fallback = annotations.filter((annotation) => !placed.has(annotation.id))
  if (fallback.length === 0) return null
  return ['Annotations not shown inline:', ...fallback.map(renderAnnotationFallback)].join('\n')
}

function renderOpenQuestions(annotations: readonly PayloadAnnotation[]): string[] {
  const questions = annotations.filter(
    (annotation) => annotation.kind === 'question' && annotation.status === 'open',
  )
  if (questions.length === 0) return []
  return [
    'Open questions:',
    ...questions.map((annotation) =>
      `- ${annotation.id} on line ${annotation.line}: ${annotation.text}`,
    ),
  ]
}

function rangeCount(lines: number): string {
  return lines === 1 ? '' : `,${lines}`
}

function renderHunk(hunk: PayloadHunk): string {
  const lines = [
    `@@ -${hunk.oldStart}${rangeCount(hunk.oldLines)} +${hunk.newStart}${rangeCount(hunk.newLines)} @@`,
    ...hunk.removed.map((line) => `-${line}`),
    ...hunk.added.map((line) => `+${line}`),
  ]
  return lines.join('\n')
}

function renderSegment(segment: PayloadSegment): string {
  const attribution = segment.author === 'user'
    ? 'user'
    : segment.tag === undefined
      ? 'external'
      : `${segment.tag.name} (${segment.tag.agent})`
  return [`Changes by ${attribution}:`, ...segment.hunks.map(renderHunk)].join('\n')
}

function surroundingParagraph(document: string, annotation: PayloadAnnotation): string | null {
  const position = occurrenceAtLine(document, annotation)
  if (position < 0) return null
  const startBreak = document.lastIndexOf('\n\n', Math.max(0, position - 1))
  const endBreak = document.indexOf('\n\n', position + annotation.quote.length)
  const start = startBreak < 0 ? 0 : startBreak + 2
  const end = endBreak < 0 ? document.length : endBreak
  const paragraph = document.slice(start, end)
  const localStart = position - start
  const localEnd = localStart + annotation.quote.length
  return escapeAnnotationBrackets(paragraph.slice(0, localStart))
    + marker(annotation, escapeAnnotationBrackets(paragraph.slice(localStart, localEnd)), false)
    + escapeAnnotationBrackets(paragraph.slice(localEnd))
    + renderReplies(annotation)
}

function renderAnnotation(annotation: PayloadAnnotation, document?: string): string {
  if (document !== undefined) {
    const paragraph = surroundingParagraph(document, annotation)
    if (paragraph !== null) return paragraph
  }
  return marker(annotation, escapeAnnotationBrackets(annotation.quote))
}

function renderThreadReply(reply: PayloadThreadReply): string {
  return `${reply.annotation} ← ${replyAuthor(reply)}: ${escapeAnnotationBrackets(reply.text)}`
}

function renderResolution(resolution: PayloadResolution): string {
  const verb: Record<PayloadResolution['resolution'], string> = {
    accepted: 'accepted',
    rejected: 'rejected',
    resolved: 'resolved',
    orphaned: 'orphaned',
    reattached: 'reattached',
    requoted: 'requoted; it is listed above with its new quote',
  }
  return `${resolution.id} (${resolution.kind}) was ${verb[resolution.resolution]}.`
}

/**
 * The fixed line after every message note. Both are open read commands any
 * agent may run unprompted (PRD §6.7), so the line adds a prompt, not authority.
 */
export const MESSAGE_GUIDANCE_LINE =
  'To catch up before acting, run stratamd state (the buffer and annotations) or stratamd changes (unreviewed edits).'

export function renderPayloadText(input: PayloadInput, context: RenderContext = {}): string {
  const sections: string[] = [openingLine(input)]
  const annotations = input.annotations ?? []

  if (input.event === 'message') {
    const heading = input.from === undefined
      ? 'Message:'
      : `Message from ${input.from.name} (${input.from.agent}):`
    sections.push(`${heading}\n${(input.notes ?? []).join('\n\n')}`)
    sections.push(MESSAGE_GUIDANCE_LINE)
    return sections.join('\n\n')
  }

  if (input.event === 'initial' || input.event === 'resync' || input.event === 'state') {
    const document = input.document ?? ''
    const placements = annotationPlacements(document, annotations)
    sections.push(inlineAnnotations(document, placements))
    const fallbacks = renderAnnotationFallbacks(annotations, placements)
    if (fallbacks !== null) sections.push(fallbacks)
    sections.push(...renderOpenQuestions(annotations))
    return sections.filter((section) => section.length > 0).join('\n\n')
  }

  if (input.notes !== undefined && input.notes.length > 0) {
    sections.push(['Notes:', ...input.notes.map((note) => `- ${note}`)].join('\n'))
  }
  if (input.segments !== undefined) {
    sections.push(...input.segments.map(renderSegment))
  }
  if (annotations.length > 0) {
    sections.push(
      'Annotations:\n' + annotations
        .map((annotation) => renderAnnotation(annotation, context.currentDocument))
        .join('\n\n'),
    )
  }
  if (input.replies !== undefined && input.replies.length > 0) {
    sections.push(['Replies:', ...input.replies.map(renderThreadReply)].join('\n'))
  }
  if (input.resolved !== undefined && input.resolved.length > 0) {
    sections.push(['Resolutions:', ...input.resolved.map(renderResolution)].join('\n'))
  }
  if (input.edits !== undefined && input.edits.length > 0) {
    sections.push(input.edits.map((edit) => `Your change was ${edit.verdict}: ${edit.quote}`).join('\n'))
  }
  if (input.partial === true) {
    sections.push('Parts of the document changed that are not included here.')
  }
  return sections.join('\n\n')
}

export function createPayload(input: PayloadInput, context: RenderContext = {}): StrataPayload {
  const normalized: PayloadInput = input.event === 'changes' && input.segments !== undefined
    ? { ...input, segments: input.segments.filter((segment) => segment.author === 'external') }
    : input
  const text = renderPayloadText(normalized, context)
  return { ...normalized, version: PAYLOAD_VERSION, text }
}

/** JSON output with absent fields omitted rather than serialized as null. */
export function serializePayload(payload: StrataPayload): string {
  if (payload.version !== PAYLOAD_VERSION) throw new Error(`Unsupported payload version ${payload.version}`)
  return JSON.stringify(payload)
}
