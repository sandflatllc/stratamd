import type { AnnotationAnchorKind, AnnotationContext, DecisionAnswer, DecisionData } from '../shared/contracts'

export const PAYLOAD_VERSION = 13 as const

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
  | 'docs'

export interface PayloadHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  removed: readonly string[]
  added: readonly string[]
  /** One unchanged line before the change, when there is one. */
  contextBefore?: readonly string[]
  /** One unchanged line after the change, when there is one. */
  contextAfter?: readonly string[]
  /** 1-based line in the delivered document where the change begins. */
  line?: number
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
  /** The authoring attachment's display name, for agent replies. */
  name?: string
  text: string
}

/** What a reply delivered alone says about its thread, so the recipient need not look it up. */
export interface PayloadReplyParent {
  kind: 'comment' | 'question' | 'suggestion' | 'decision'
  quote: string
  line: number
  text: string
}

/** A reply to an annotation the recipient already holds, delivered without its thread. */
export interface PayloadThreadReply extends PayloadReply {
  annotation: string
  parent?: PayloadReplyParent
}

export interface PayloadAnnotation {
  id: string
  seq: number
  kind: 'comment' | 'question' | 'suggestion' | 'decision'
  author: 'user' | 'agent'
  agent: string | null
  /** The authoring attachment's display name, for agent-authored annotations. */
  name?: string
  status: 'open' | 'resolved' | 'orphaned'
  anchor?: AnnotationAnchorKind
  quote: string
  text: string
  label?: string
  context?: AnnotationContext
  decision?: DecisionData
  line: number
  replies: readonly PayloadReply[]
}

export interface PayloadResolution {
  id: string
  seq: number
  kind: 'comment' | 'question' | 'suggestion' | 'decision'
  resolution: 'accepted' | 'rejected' | 'resolved' | 'orphaned' | 'reattached' | 'requoted' | 'reopened'
}

export interface PayloadDecisionAnswer extends DecisionAnswer {
  annotation: string
  parent: {
    text: string
    options: readonly string[]
    anchor: AnnotationAnchorKind
    quote: string
    line: number
  }
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
  /** Present on `state`: whether the document is open in the app. */
  open?: boolean
  cursor?: number
  document?: string
  segments?: readonly PayloadSegment[]
  annotations?: readonly PayloadAnnotation[]
  replies?: readonly PayloadThreadReply[]
  answers?: readonly PayloadDecisionAnswer[]
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

/** `user`, or the agent's display name followed by its id: `(GPT ag_7f3k2a)`. */
function agentLabel(author: 'user' | 'agent', agent: string | null | undefined, name: string | undefined): string {
  if (author === 'user') return 'user'
  const id = agent ?? 'agent'
  return name !== undefined && name.length > 0 && name !== id ? `${name} ${id}` : id
}

function authorName(annotation: PayloadAnnotation): string {
  return agentLabel(annotation.author, annotation.agent, annotation.name)
}

/** Marker headings stay on one line: annotation text is escaped and its line breaks collapse to spaces. */
function headingText(value: string): string {
  return escapeAnnotationBrackets(value).replace(/\s*\r?\n\s*/g, ' ')
}

function marker(annotation: PayloadAnnotation, quote: string, withReplies = true): string {
  return openMarker(annotation) + quote + closeMarker(annotation, withReplies)
}

function markerLabel(annotation: PayloadAnnotation): string {
  const label = annotation.label === undefined || annotation.label.length === 0 ? '' : ` [${headingText(annotation.label)}]`
  const choices = annotation.decision === undefined
    ? ''
    : ` [Choices: ${annotation.decision.options.map(headingText).join(' | ')} | Other]`
  if (!annotation.context) return label + choices
  if (annotation.context.kind === 'screenshot-pin') {
    return `${label}${choices} [AnnotatedScreenshot line ${annotation.context.componentLine}; pin ${annotation.context.pin}; image ${headingText(annotation.context.image)}]`
  }
  const heading = annotation.context.heading ? ` under ${headingText(annotation.context.heading)}` : ''
  const columns = annotation.context.columns.map(headingText).join(', ')
  const column = annotation.context.column
    ? `; column ${annotation.context.column.index + 1} ${headingText(annotation.context.column.label)}`
    : ''
  return `${label}${choices} [Table${heading}; columns ${columns}${column}]`
}

/** A suggestion's heading names it only; its replacement is rendered once, after the struck quote. */
function openMarker(annotation: PayloadAnnotation): string {
  const who = `${annotation.id} ${annotation.kind} (${authorName(annotation)})${markerLabel(annotation)}`
  if (annotation.kind === 'suggestion') return `⟦${who}⟧~~`
  return `⟦${who}: ${headingText(annotation.text)}⟧`
}

function replyAuthor(reply: PayloadReply): string {
  return agentLabel(reply.author, reply.agent, reply.name)
}

function renderReplies(annotation: PayloadAnnotation): string {
  const replies = annotation.replies
    .map((reply) => `\n  ↳ ${replyAuthor(reply)}: ${escapeAnnotationBrackets(reply.text)}`)
    .join('')
  const answers = annotation.decision?.answers.map((answer) => `\n  ↳ ${renderDecisionAnswerChoice(answer)}`).join('') ?? ''
  return replies + answers
}

function renderDecisionAnswerChoice(answer: Pick<DecisionAnswer, 'option' | 'other'>): string {
  return answer.option === null
    ? `user answered Other: ${escapeAnnotationBrackets(answer.other ?? '')}`
    : `user chose "${escapeAnnotationBrackets(answer.option)}"`
}

function closeMarker(annotation: PayloadAnnotation, withReplies = true): string {
  const replies = withReplies ? renderReplies(annotation) : ''
  if (annotation.kind === 'suggestion') {
    return `~~ ${escapeAnnotationBrackets(annotation.text)}⟦/${annotation.id}⟧${replies}`
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
    .filter((annotation) => annotation.status !== 'resolved' && annotation.anchor !== 'document')
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
  const location = annotation.anchor === 'document'
    ? 'whole document'
    : annotation.status === 'orphaned'
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
      `- ${annotation.id} on line ${annotation.line}: ${headingText(annotation.text)}`,
    ),
  ]
}

function renderOpenDecisions(annotations: readonly PayloadAnnotation[]): string[] {
  const decisions = annotations.filter(
    (annotation) => annotation.kind === 'decision' && annotation.status === 'open' && annotation.decision !== undefined,
  )
  if (decisions.length === 0) return []
  return [[
    'Open decisions:',
    ...decisions.map((annotation) => {
      const location = annotation.anchor === 'document' ? 'whole document' : `line ${annotation.line}`
      return `- ${annotation.id} (${location}): ${headingText(annotation.text)}\n  choices: ${annotation.decision!.options.map(headingText).join(' | ')} | Other`
    }),
  ].join('\n')]
}

/**
 * One side of a unified hunk header, widened by the context lines the hunk
 * carries. `start` follows jsdiff: the first line at or after the change, so
 * a zero-length side names the line the change lands before.
 */
function hunkRange(start: number, lines: number, before: number, after: number): string {
  const count = lines + before + after
  if (count === 0) return `${start},0`
  const first = start - before
  return count === 1 ? `${first}` : `${first},${count}`
}

function renderHunk(hunk: PayloadHunk): string {
  const before = hunk.contextBefore ?? []
  const after = hunk.contextAfter ?? []
  const lines = [
    `@@ -${hunkRange(hunk.oldStart, hunk.oldLines, before.length, after.length)} +${hunkRange(hunk.newStart, hunk.newLines, before.length, after.length)} @@`,
    ...before.map((line) => ` ${line}`),
    ...hunk.removed.map((line) => `-${line}`),
    ...hunk.added.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
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
  if (document !== undefined && annotation.anchor !== 'document') {
    const paragraph = surroundingParagraph(document, annotation)
    if (paragraph !== null) return paragraph
  }
  return marker(annotation, escapeAnnotationBrackets(annotation.quote))
}

function shortQuote(quote: string): string {
  const oneLine = quote.replace(/\s*\r?\n\s*/g, ' ')
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine
}

/** A reply on its own, then the thread it continues: kind, line, quote, and the opening text. */
function renderThreadReply(reply: PayloadThreadReply): string {
  const line = `${reply.annotation} ← ${replyAuthor(reply)}: ${escapeAnnotationBrackets(reply.text)}`
  if (reply.parent === undefined) return line
  const parent = reply.parent
  const opening = parent.text.length > 0 ? `: ${headingText(parent.text)}` : ''
  return `${line}\n  thread: ${parent.kind} on line ${parent.line} about "${headingText(shortQuote(parent.quote))}"${opening}`
}

function renderResolution(resolution: PayloadResolution): string {
  const verb: Record<PayloadResolution['resolution'], string> = {
    accepted: 'accepted',
    rejected: 'rejected',
    resolved: 'resolved',
    orphaned: 'orphaned',
    reattached: 'reattached',
    requoted: 'requoted; it is listed above with its new quote',
    reopened: 'reopened',
  }
  return `${resolution.id} (${resolution.kind}) was ${verb[resolution.resolution]}.`
}

function renderDecisionAnswer(answer: PayloadDecisionAnswer): string {
  const location = answer.parent.anchor === 'document' ? 'whole document' : `line ${answer.parent.line}`
  return `${answer.annotation} ← ${renderDecisionAnswerChoice(answer)}\n  decision: ${headingText(answer.parent.text)} (${location}); choices: ${answer.parent.options.map(headingText).join(' | ')} | Other`
}

/**
 * The fixed line after every message note. Both are open read commands any
 * agent may run unprompted (PRD §6.7), so the line adds a prompt, not authority.
 */
export const MESSAGE_GUIDANCE_LINE =
  'To catch up before acting, run stratamd state --brief (who is attached and who leads), stratamd state (the buffer and annotations), or stratamd changes (unreviewed edits).'

/** A timeout is not an action (PRD §7); the text says so where the agent reads it. */
export const TIMEOUT_GUIDANCE_LINE =
  'Nothing happened. Run stratamd attach again and say nothing in chat about this.'

export const SUPERSEDED_GUIDANCE_LINE =
  'A newer attach call for your id is listening. Do nothing and say nothing in chat.'

export interface PayloadTrimOptions {
  /** Drop `document`, `text`, and `annotations`: the attachment and Lead view of `state`. */
  brief?: boolean
  /** Drop `document`; `text` already carries the whole buffer with annotations inlined. */
  textOnly?: boolean
  /** Drop `document`; `text` becomes the open-question and open-decision lists. */
  annotationsOnly?: boolean
}

function isAnnotationList(value: unknown): value is readonly PayloadAnnotation[] {
  return Array.isArray(value)
}

/** The same payload with the fields the caller asked to leave out removed, never mutating the input. */
export function trimPayload<T extends { document?: unknown; text?: unknown; annotations?: unknown }>(
  payload: T,
  options: PayloadTrimOptions,
): T {
  if (!options.brief && !options.textOnly && !options.annotationsOnly) return payload
  const { document: _document, ...withoutDocument } = payload
  if (options.brief) {
    const { text: _text, annotations: _annotations, ...brief } = withoutDocument
    return brief as T
  }
  if (options.annotationsOnly) {
    const annotations = isAnnotationList(payload.annotations) ? payload.annotations : []
    return { ...withoutDocument, annotations, text: [...renderOpenQuestions(annotations), ...renderOpenDecisions(annotations)].join('\n') } as T
  }
  return withoutDocument as T
}

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

  if (input.event === 'timeout' || input.event === 'superseded') {
    sections.push(input.event === 'timeout' ? TIMEOUT_GUIDANCE_LINE : SUPERSEDED_GUIDANCE_LINE)
    return sections.join('\n\n')
  }

  if (input.event === 'initial' || input.event === 'resync' || input.event === 'state') {
    const document = input.document ?? ''
    const placements = annotationPlacements(document, annotations)
    sections.push(inlineAnnotations(document, placements))
    const fallbacks = renderAnnotationFallbacks(annotations, placements)
    if (fallbacks !== null) sections.push(fallbacks)
    sections.push(...renderOpenQuestions(annotations))
    sections.push(...renderOpenDecisions(annotations))
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
  if (input.answers !== undefined && input.answers.length > 0) {
    sections.push(['Decision answers:', ...input.answers.map(renderDecisionAnswer)].join('\n'))
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
