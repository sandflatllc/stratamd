import type { VisualAdjustmentView, VisualCommentView, VisualMarkView, VisualRevisionView, VisualStatus, VisualStrokeView } from '../shared/contracts'
import { MAX_ATTACHMENTS } from './composer-attachments'
import type { StrataBlockResult } from './blocks'

/**
 * Visual comments (docs/plans/open/visual-review): a private draft over an
 * image or a captured page until Send, then one frozen revision per Send.
 * They are owned by a project, delivered through the ordinary conversation
 * turn, and answered by the agent's structured reply naming the revision.
 * Everything the agent needs to act travels in the brief and the record;
 * nothing here names a file, selector, component, or property in a label
 * the owner reads.
 */

export const VISUAL_ID_PREFIX = 'v_'
export const VISUAL_EVIDENCE_PREFIX = 'e_'

export function isVisualCommentId(value: string): boolean {
  return value.startsWith(VISUAL_ID_PREFIX)
}

export interface VisualRect { x: number; y: number; width: number; height: number }
export interface VisualPoint { x: number; y: number }

/** What the agent needs to find the marked thing again; never shown in a control. */
export interface VisualMarkIdentity {
  role?: string | null
  name?: string | null
  text?: string | null
  testIds?: string[]
  selector?: string | null
  html?: string | null
  style?: Record<string, string>
  sources?: Array<{ file: string; line: number; column: number; role?: 'definition' | 'usage' | 'candidate' }>
  viewportRect?: VisualRect
  pageRect?: VisualRect
}

export interface VisualMark {
  id: string
  kind: 'element' | 'region'
  /** A plain name from the page (label, role, text, or title) or "Region n". */
  label: string
  captureId: string
  /** In capture pixels. */
  rect: VisualRect
  /** Whether Strata has a confident match right now; null when there is no page to ask. */
  found: boolean | null
  identity?: VisualMarkIdentity
}

export interface VisualStroke {
  id: string
  tool: 'draw' | 'arrow'
  captureId: string
  points: VisualPoint[]
}

/** A requested change on one mark, recorded as the exact property and value; the label is the owner's plain words. */
export interface VisualAdjustment {
  markId: string
  property: string
  value: string
  label: string
}

export interface VisualCapture {
  /** Evidence id of the clean capture. */
  id: string
  width: number
  height: number
  scroll?: VisualPoint
  /** Capture pixels per page pixel; absent means one. */
  scale?: number
  /** The requested appearance: the page with the owner's adjustments applied, a reference beside the marked captures. */
  requested?: boolean
  /** Evidence id of the same capture with the marks drawn on it; refreshed on every Hold. */
  markedId?: string
  takenAt: number
}

export type VisualAnchor =
  | { kind: 'image'; name: string; windowCapture?: import('../shared/window-capture').WindowCaptureContext }
  | {
      kind: 'page'
      url: string
      title: string
      /** The page instance the comment was made in; a tab id in the preview host. */
      instance: string
      /** The thread's working folder at the time, without asserting that it served the page. */
      workingFolder: string | null
      viewport: { width: number; height: number; preset: string | null }
      deviceScale: number
    }

/** The thread a revision goes to, with the engine identity reserved beside it. */
export interface VisualDestination { threadId: string; engine: string | null }

export interface VisualDraft {
  requestedCaptureId?: string
  text: string
  marks: VisualMark[]
  strokes: VisualStroke[]
  adjustments: VisualAdjustment[]
  destination: VisualDestination
  updatedAt: number
}

export interface VisualReply {
  agentId?: string
  agentName?: string
  comparison?: VisualComparison
  messageId: string
  text: string
  ready: boolean
  file?: string
  at: number
}

export interface VisualComparison {
  /** Evidence ids: the original crop and Strata's own "now" capture of the same target. */
  thenId: string
  nowId: string | null
  /** Plain words when the views differ or the mark was not found. */
  note: string | null
  takenAt: number
}

export interface VisualRevision {
  number: number
  text: string
  marks: VisualMark[]
  strokes: VisualStroke[]
  adjustments: VisualAdjustment[]
  destination: VisualDestination
  /** Capture ids this revision froze, in order. */
  captures: string[]
  /** Evidence ids the delivery carried, in attachment order. */
  evidence: string[]
  deliveryId: string
  sentAt: number
  state: 'sending' | 'sent' | 'failed'
  error?: string
  replies: VisualReply[]
  accepted?: boolean
  comparison?: VisualComparison
}

export interface VisualCommentRecord {
  id: string
  projectId: string
  /** The engine identity the comment belongs to; reserved beside every thread reference. */
  engine: string | null
  anchor: VisualAnchor
  captures: VisualCapture[]
  draft: VisualDraft | null
  revisions: VisualRevision[]
  createdAt: number
  updatedAt: number
}

export function visualStatus(comment: Pick<VisualCommentRecord, 'draft' | 'revisions'>): VisualStatus {
  if (comment.draft) return 'held'
  const latest = comment.revisions.at(-1)
  if (!latest) return 'held'
  if (latest.accepted) return 'done'
  if (latest.state === 'failed') return 'failed'
  if (latest.state === 'sending') return 'sending'
  if (latest.replies.some((reply) => reply.ready)) return 'ready'
  return 'sent'
}

export const VISUAL_STATUS_LABELS: Record<VisualStatus, string> = {
  held: 'held',
  sending: 'sending',
  failed: 'send failed',
  sent: 'sent',
  ready: 'ready for review',
  done: 'done',
}

/** The card's second line: the page or image and the size, in plain words. */
export function visualPlace(anchor: VisualAnchor, captures: readonly Pick<VisualCapture, 'width' | 'height'>[]): string {
  if (anchor.kind === 'image') {
    const first = captures[0]
    const label = anchor.windowCapture ? anchor.windowCapture.selection === 'system-source' ? 'System capture' : 'Window capture' : 'Pasted image'
    return first ? `${label} · ${first.width} × ${first.height}` : label
  }
  const size = anchor.viewport.preset ? anchor.viewport.preset.toLowerCase() : 'window size'
  return `${anchor.title || 'Page'} · ${size}`
}

/** Capture pixels from page pixels and back; a capture may be scaled down to fit the window. */
export function toCaptureRect(rect: VisualRect, scale: number): VisualRect {
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale }
}

export function toPageRect(rect: VisualRect, scale: number): VisualRect {
  return scale > 0 ? { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale } : rect
}

export function toPagePoint(point: VisualPoint, scale: number): VisualPoint {
  return scale > 0 ? { x: point.x / scale, y: point.y / scale } : point
}

/**
 * The re-check before Send: refused only when navigation replaced the page or
 * a marked target is gone, in plain words that name the mark. Anything else,
 * a clock ticking or text moving, sends.
 */
export function visualSendRefusal(check: { pageReplaced: boolean; missing: string[] }): string | null {
  if (check.pageReplaced) return 'The page has moved on since you marked it. Your note and marks are kept; mark the page again to send.'
  if (check.missing.length === 1) return `${check.missing[0]} is no longer on the page. Your note and marks are kept; remove that mark or mark the page again to send.`
  if (check.missing.length > 1) return `${check.missing.slice(0, -1).join(', ')} and ${check.missing.at(-1)} are no longer on the page. Your note and marks are kept; remove those marks or mark the page again to send.`
  return null
}

/** "2 things marked, both found ✓ · 1 arrow · 2 adjustments" for a draft or revision. */
export function visualSummary(input: { marks: readonly Pick<VisualMark, 'found'>[]; strokes: readonly Pick<VisualStroke, 'tool'>[]; adjustments: readonly unknown[] }): string {
  const parts: string[] = []
  const marks = input.marks.length
  if (marks > 0) {
    const found = input.marks.filter((mark) => mark.found === true).length
    const asked = input.marks.filter((mark) => mark.found !== null).length
    let foundNote = ''
    if (asked > 0) foundNote = found === asked ? (asked === 1 ? ', found ✓' : ', all found ✓') : found === 0 ? ', not found' : `, ${found} of ${asked} found`
    parts.push(`${marks} ${marks === 1 ? 'thing' : 'things'} marked${foundNote}`)
  }
  const arrows = input.strokes.filter((stroke) => stroke.tool === 'arrow').length
  const drawings = input.strokes.length - arrows
  if (arrows > 0) parts.push(`${arrows} ${arrows === 1 ? 'arrow' : 'arrows'}`)
  if (drawings > 0) parts.push(`${drawings} ${drawings === 1 ? 'drawing' : 'drawings'}`)
  if (input.adjustments.length > 0) parts.push(`${input.adjustments.length} ${input.adjustments.length === 1 ? 'adjustment' : 'adjustments'}`)
  return parts.join(' · ')
}

/** The card's title: the mark names joined, or the first words of the text. */
export function visualTitle(input: { text: string; marks: readonly Pick<VisualMark, 'label'>[] }): string {
  const names = input.marks.map((mark) => mark.label).filter(Boolean)
  if (names.length) return names.length <= 3 ? names.join(' + ') : `${names.slice(0, 2).join(' + ')} + ${names.length - 2} more`
  const text = input.text.trim().replace(/\s+/g, ' ')
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || 'Visual comment'
}

export function nextRegionLabel(marks: readonly Pick<VisualMark, 'kind' | 'label'>[]): string {
  const used = new Set(marks.map((mark) => mark.label))
  let index = 1
  while (used.has(`Region ${index}`)) index += 1
  return `Region ${index}`
}

/** The attachment file name for a capture inside a delivery; keeps different marked versions of one screenshot apart. */
export function visualAttachmentName(commentId: string, revision: number, index: number): string {
  return `visual-${commentId.slice(VISUAL_ID_PREFIX.length, VISUAL_ID_PREFIX.length + 8)}-r${revision}-${index + 1}.png`
}

/** The one-line user message when a Send carries only visual comments. */
export function visualSendSummary(comments: ReadonlyArray<{ text: string; marks: readonly Pick<VisualMark, 'label'>[] }>): string {
  if (comments.length === 1) return `Visual comment: ${visualTitle(comments[0]!)}.`
  return `${comments.length} visual comments.`
}

/** Exact matching data accompanies the image as message text, never another file.
 * The owner sees the comment sheet; the transcript omits this generated appendix. */
const VISUAL_CONTEXT_MARKER = '\n\n<!-- strata-visual-context -->\n'
export function appendVisualContext(text: string, briefs: readonly VisualBrief[]): string {
  return briefs.length ? `${text}${VISUAL_CONTEXT_MARKER}## Visual comments\n\n\`\`\`json\n${JSON.stringify(briefs, null, 2)}\n\`\`\`\n` : text
}
export function visibleVisualMessage(text: string): string {
  const at = text.lastIndexOf(VISUAL_CONTEXT_MARKER)
  if (at < 0) return text
  const appendix = text.slice(at + VISUAL_CONTEXT_MARKER.length)
  const match = /^## Visual comments\n\n`{3}json\n([\s\S]*)\n`{3}\n$/.exec(appendix)
  if (!match) return text
  try {
    const briefs: unknown = JSON.parse(match[1]!)
    if (Array.isArray(briefs) && briefs.length && briefs.every(brief => typeof brief?.id === 'string' && brief.id.startsWith(VISUAL_ID_PREFIX) && typeof brief.revision === 'number' && Array.isArray(brief.captures))) return text.slice(0, at)
  } catch { /* Ordinary user text is never truncated when the appendix is invalid. */ }
  return text
}

/** Select the same capture set in the composer budget and the send path. */
export function visualCaptureIds(comment: {
  captures: readonly { id: string; requested?: boolean }[]
  draft?: { marks: readonly { captureId: string }[]; strokes: readonly { captureId: string }[]; adjustments: readonly unknown[]; requestedCaptureId?: string } | null
}): string[] {
  const draft = comment.draft
  if (!draft) return []
  const marked = [...new Set([...draft.marks, ...draft.strokes].map(mark => mark.captureId))]
  return [...new Set([
    ...(marked.length ? marked : comment.captures.filter(capture => !capture.requested).slice(0, 1).map(capture => capture.id)),
    ...(draft.adjustments.length && draft.requestedCaptureId ? [draft.requestedCaptureId] : []),
  ])]
}

// ---- Delivery budget

export interface SendCapacityInput {
  /** Ordinary composer attachments, text and image. */
  files: number
  /** Comment sheets the selected visual comments carry, one per capture per comment. */
  visualImages: number
  visualComments: number
  contextFile: boolean
}

export interface SendCapacity {
  total: number
  limit: number
  /** What the Send carries, in plain words. */
  line: string
  /** Set when the selection is over capacity; names what to remove or send later. Nothing is trimmed. */
  refusal?: string
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function sendCapacity(input: SendCapacityInput): SendCapacity {
  const total = input.files + input.visualImages + (input.contextFile ? 1 : 0)
  const parts: string[] = []
  if (input.files > 0) parts.push(plural(input.files, 'file', 'files'))
  if (input.visualImages > 0) parts.push(`${plural(input.visualImages, 'marked screenshot', 'marked screenshots')}${input.visualComments > 1 ? ` from ${input.visualComments} visual comments` : ''}`)
  if (input.contextFile) parts.push('the context file')
  const listed = parts.length === 0 ? 'nothing' : parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts.at(-1)}`
  const line = `Send carries ${listed} · ${total} of ${MAX_ATTACHMENTS}`
  if (total <= MAX_ATTACHMENTS) return { total, limit: MAX_ATTACHMENTS, line }
  const over = total - MAX_ATTACHMENTS
  const advice = input.files > 0 && input.visualImages > 0
    ? 'Remove a file, or send a visual comment on its own first.'
    : input.visualImages > 0 ? 'Send fewer visual comments at once.' : 'Remove a file.'
  return { total, limit: MAX_ATTACHMENTS, line, refusal: `That send would carry ${total} attachments, ${over} over the limit of ${MAX_ATTACHMENTS}: ${listed}. ${advice}` }
}

// ---- The brief the agent reads

/** One visual comment carried in the message appendix. Selective: marked evidence, page context, identity, not every ancestor. */
export interface VisualBrief {
  id: string
  revision: number
  text: string
  place: string
  anchor: VisualAnchor
  captures: Array<{ name: string; width: number; height: number; scroll?: VisualPoint; requested?: boolean }>
  marks: Array<{ id: string; label: string; kind: VisualMark['kind']; capture: string; rect: VisualRect; found: boolean | null } & VisualMarkIdentity>
  strokes: Array<{ tool: VisualStroke['tool']; capture: string; from: VisualPoint; to: VisualPoint }>
  adjustments: Array<{ mark: string; property: string; value: string }>
}

export function visualBrief(comment: Pick<VisualCommentRecord, 'id' | 'anchor' | 'captures'>, revision: VisualRevision, names: ReadonlyMap<string, string>): VisualBrief {
  const captures = revision.captures.flatMap((captureId) => {
    const capture = comment.captures.find((candidate) => candidate.id === captureId)
    const name = names.get(captureId)
    if (!capture || !name) return []
    return [{ name, width: capture.width, height: capture.height, ...(capture.scroll ? { scroll: capture.scroll } : {}), ...(capture.requested ? { requested: true } : {}) }]
  })
  const nameOf = (captureId: string) => names.get(captureId) ?? captureId
  return {
    id: comment.id,
    revision: revision.number,
    text: revision.text,
    place: visualPlace(comment.anchor, comment.captures),
    anchor: comment.anchor,
    captures,
    marks: revision.marks.map((mark) => ({ id: mark.id, label: mark.label, kind: mark.kind, capture: nameOf(mark.captureId), rect: mark.rect, found: mark.found, ...(mark.identity ?? {}) })),
    strokes: revision.strokes.map((stroke) => ({ tool: stroke.tool, capture: nameOf(stroke.captureId), from: stroke.points[0] ?? { x: 0, y: 0 }, to: stroke.points.at(-1) ?? { x: 0, y: 0 } })),
    adjustments: revision.adjustments.map((adjustment) => ({ mark: adjustment.markId, property: adjustment.property, value: adjustment.value })),
  }
}

// ---- The renderer view

export function visualMarkView(mark: VisualMark): VisualMarkView {
  return { id: mark.id, kind: mark.kind, label: mark.label, captureId: mark.captureId, rect: mark.rect, found: mark.found, ...(mark.identity ? { identity: mark.identity } : {}) }
}

export function visualStrokeView(stroke: VisualStroke): VisualStrokeView {
  return { id: stroke.id, tool: stroke.tool, captureId: stroke.captureId, points: stroke.points }
}

export function visualAdjustmentView(adjustment: VisualAdjustment): VisualAdjustmentView {
  return { markId: adjustment.markId, property: adjustment.property, value: adjustment.value, label: adjustment.label }
}

export function visualCommentView(
  comment: VisualCommentRecord,
  options: { captureUrl(evidenceId: string): string; threadTitle(threadId: string): string },
): VisualCommentView {
  const status = visualStatus(comment)
  const destination = (value: VisualDestination) => ({ threadId: value.threadId, threadTitle: options.threadTitle(value.threadId) })
  const comparisonView = (value: VisualComparison) => ({ thenUrl: options.captureUrl(value.thenId), nowUrl: value.nowId ? options.captureUrl(value.nowId) : null, note: value.note, takenAt: value.takenAt })
  const revisions: VisualRevisionView[] = comment.revisions.map((revision) => ({
    number: revision.number,
    images: revision.evidence.map(options.captureUrl),
    text: revision.text,
    marks: revision.marks.map(visualMarkView),
    strokes: revision.strokes.map(visualStrokeView),
    adjustments: revision.adjustments.map(visualAdjustmentView),
    destination: destination(revision.destination),
    captures: revision.captures,
    deliveryId: revision.deliveryId,
    sentAt: revision.sentAt,
    state: revision.state,
    ...(revision.error ? { error: revision.error } : {}),
    replies: revision.replies.map((reply) => ({ ...(reply.agentId ? { agentId: reply.agentId } : {}), ...(reply.agentName ? { agentName: reply.agentName } : {}), ...(reply.comparison ? { comparison: comparisonView(reply.comparison) } : {}), messageId: reply.messageId, text: reply.text, ready: reply.ready, ...(reply.file ? { file: reply.file } : {}), at: reply.at })),
    accepted: revision.accepted === true,
    ...((revision.replies.at(-1)?.comparison ?? revision.comparison) ? { comparison: comparisonView((revision.replies.at(-1)?.comparison ?? revision.comparison)!) } : {}),
  }))
  const latest = comment.revisions.at(-1)
  const current = comment.draft ?? latest
  const thumbnailCapture = comment.captures.find((capture) => capture.markedId) ?? comment.captures[0]
  return {
    id: comment.id,
    projectId: comment.projectId,
    status,
    statusLabel: VISUAL_STATUS_LABELS[status],
    place: visualPlace(comment.anchor, comment.captures),
    anchor: comment.anchor.kind === 'image' ? { kind: 'image', name: comment.anchor.name, ...(comment.anchor.windowCapture ? { windowCapture: comment.anchor.windowCapture } : {}) } : { kind: 'page', url: comment.anchor.url, title: comment.anchor.title, instance: comment.anchor.instance, preset: comment.anchor.viewport.preset, viewport: { width: comment.anchor.viewport.width, height: comment.anchor.viewport.height } },
    title: current ? visualTitle(current) : 'Visual comment',
    summary: current ? visualSummary(current) : '',
    thumbnail: thumbnailCapture ? options.captureUrl(thumbnailCapture.markedId ?? thumbnailCapture.id) : null,
    captures: comment.captures.map((capture) => ({ id: capture.id, url: options.captureUrl(capture.id), width: capture.width, height: capture.height, ...(capture.scroll ? { scroll: capture.scroll } : {}), ...(capture.scale ? { scale: capture.scale } : {}), ...(capture.requested ? { requested: true } : {}) })),
    ...(comment.draft ? { draft: { ...(comment.draft.requestedCaptureId ? { requestedCaptureId: comment.draft.requestedCaptureId } : {}), text: comment.draft.text, marks: comment.draft.marks.map(visualMarkView), strokes: comment.draft.strokes.map(visualStrokeView), adjustments: comment.draft.adjustments.map(visualAdjustmentView), destination: destination(comment.draft.destination), updatedAt: comment.draft.updatedAt } } : {}),
    revisions,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  }
}

/** The visual comments an agent message replied to, from its strata block; the conversation shows a chip for each. */
export function visualRepliesIn(parsed: { results: StrataBlockResult[] } | null): Array<{ id: string; revision?: number; ready: boolean }> {
  if (!parsed) return []
  return parsed.results.flatMap((result) => {
    const entry = result.entry
    if (!entry || entry.verb !== 'reply' || !('item' in entry.anchor) || !isVisualCommentId(entry.anchor.item)) return []
    return [{ id: entry.anchor.item, ...(entry.revision !== undefined ? { revision: entry.revision } : {}), ready: entry.ready === true }]
  })
}

/** Visual replies must name the exact revision they answer. */
export function revisionForReply(comment: Pick<VisualCommentRecord, 'revisions'>, named: number | undefined): VisualRevision | null {
  if (named !== undefined) return comment.revisions.find((revision) => revision.number === named) ?? null
  return null
}
