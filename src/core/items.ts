import type { AnnotationView, AttachmentView, EngineMessageView, HunkView, ItemView } from '../shared/contracts'
import { mapMarkdownBlocks, parseStrataBlock, resolveBlock } from './blocks'

export interface ItemInputs {
  annotations: readonly AnnotationView[]
  hunks?: readonly HunkView[]
  attachments?: readonly AttachmentView[]
}

function annotationStatus(annotation: AnnotationView, cursors: ReadonlyMap<string, number>): ItemView['status'] {
  if (annotation.status === 'resolved') return 'done'
  const reply = annotation.replies.findLast((candidate) => candidate.author === 'user')
  if (!reply) return 'open'
  const source = annotation.source
  if (!source) return 'drafted'
  const raw = annotation as AnnotationView & { replySeqs?: readonly number[] }
  const seq = raw.replySeqs?.at(-1) ?? Number.MAX_SAFE_INTEGER
  return seq <= (cursors.get(source.threadId) ?? 0) ? 'done' : 'drafted'
}

/** Pure item projection. Decisions sort first, then anchors in document/message order. */
export function deriveItems(input: ItemInputs): ItemView[] {
  const cursors = new Map((input.attachments ?? []).map((attachment) => [attachment.agent.id, attachment.cursor ?? 0]))
  const annotations = input.annotations.map((annotation): ItemView => ({
    id: annotation.id,
    kind: annotation.kind,
    status: annotationStatus(annotation, cursors),
    review: annotation.review ?? 'unreviewed',
    text: annotation.text,
    quote: annotation.quote,
    order: (annotation.line ?? 0) * 1_000_000 + annotation.seq,
    threadId: annotation.source?.threadId ?? (annotation.author === 'user' ? null : annotation.author.id),
    turnId: annotation.source?.turnId ?? null,
    messageId: annotation.source?.messageId ?? null,
    annotationId: annotation.id,
    hunkId: null,
    inferred: false,
  }))
  const hunks = (input.hunks ?? []).map((hunk): ItemView => ({
    id: `hunk:${hunk.id}`,
    kind: 'edit',
    status: 'open',
    review: 'unreviewed',
    text: hunk.added.join('\n'),
    quote: hunk.removed.join('\n'),
    order: Number.MAX_SAFE_INTEGER / 2 + hunk.newStart,
    threadId: hunk.itemSource?.threadId ?? hunk.author?.id ?? null,
    turnId: hunk.itemSource?.turnId ?? null,
    messageId: hunk.itemSource?.messageId ?? null,
    annotationId: null,
    hunkId: hunk.id,
    inferred: false,
  }))
  return [...annotations, ...hunks].sort((left, right) =>
    Number(right.kind === 'decision') - Number(left.kind === 'decision') || left.order - right.order || left.id.localeCompare(right.id),
  )
}

export function turnItems(items: readonly ItemView[], threadId: string, turnId: string): ItemView[] {
  return items.filter((item) => item.threadId === threadId && item.turnId === turnId)
}

export function itemProgress(items: readonly ItemView[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === 'done').length, total: items.length }
}

/** Explicit message-anchored items posted in completed agent strata blocks. */
export function postedMessageItems(messages: readonly EngineMessageView[], threadId: string): ItemView[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const result: ItemView[] = []
  for (const source of messages) {
    if (source.role !== 'assistant' || source.streaming) continue
    const parsed = parseStrataBlock(source.text)
    if (!parsed) continue
    for (const entryResult of parsed.results) {
      const entry = entryResult.entry
      if (!entry || !(entry.verb === 'comment' || entry.verb === 'question' || entry.verb === 'decision' || entry.verb === 'suggest') || !('message' in entry.anchor)) continue
      const target = byId.get(entry.anchor.message)
      if (!target || target.streaming) continue
      const prose = parseStrataBlock(target.text)?.prose ?? target.text
      const blocks = target.blocks ?? mapMarkdownBlocks(`message:${target.id}`, prose).blocks
      const block = resolveBlock({ namespace: `message:${target.id}`, blocks }, entry.anchor.block)
      if (!block) continue
      const kind = entry.verb === 'suggest' ? 'suggestion' : entry.verb
      result.push({
        id: `m_${source.id}_${entryResult.index}`,
        kind,
        status: 'open',
        review: 'unreviewed',
        text: entry.verb === 'suggest' ? entry.replacement : entry.text,
        quote: block.text,
        order: block.from * 1_000 + entryResult.index,
        threadId,
        turnId: source.turnId,
        messageId: target.id,
        annotationId: null,
        hunkId: null,
        inferred: false,
      })
    }
  }
  return result.sort((left, right) => Number(right.kind === 'decision') - Number(left.kind === 'decision') || left.order - right.order)
}
