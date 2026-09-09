import { z } from 'zod'

const sentCommentSchema = z.object({ id: z.string(), selection: z.string(), text: z.string(), passage: z.string(), range: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).optional() })
export const sentCommentsSchema = z.object({ note: z.string(), comments: z.array(sentCommentSchema).min(1) })
export type SentComments = z.infer<typeof sentCommentsSchema>
export type SentComment = SentComments['comments'][number]

const endpoint = z.object({ block: z.string(), offset: z.number().int().nonnegative() })
const annotation = z.object({ id: z.string(), selection: z.string(), text: z.string(), anchor: z.object({ message: z.string(), start: endpoint, end: endpoint }) })
const block = z.object({ message: z.string(), block: z.string(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), text: z.string() })

/** Read only the context attachment belonging to this send, never today's editable comment state. */
export function sentCommentsFromDelivery(source: string, threadId: string, messageId: string, note: string): SentComments | null {
  if (!source.startsWith(`# Conversation context\n\nDelivery: ${messageId}\nThread: ${threadId}\n`)) return null
  const section = (title: string): unknown => {
    const match = source.match(new RegExp(`\\n## ${title}\\n\\n\x60\x60\x60json\\n([\\s\\S]*?)\\n\x60\x60\x60(?:\\n|$)`))
    return match ? JSON.parse(match[1]!) : []
  }
  try {
    const annotations = z.array(annotation).parse(section('New annotations'))
    if (!annotations.length) return null
    const blocks = z.array(block).parse(section('Message blocks'))
    const comments = annotations.map(comment => {
      const messageBlocks = blocks.filter(block => block.message === comment.anchor.message).sort((a, b) => a.from - b.from)
      const start = messageBlocks.findIndex(block => block.block === comment.anchor.start.block)
      const end = messageBlocks.findIndex(block => block.block === comment.anchor.end.block)
      const passage = start >= 0 && end >= start ? messageBlocks.slice(start, end + 1).map(block => block.text).join('\n\n') : ''
      const from = comment.anchor.start.offset
      const to = start >= 0 && end >= start ? messageBlocks.slice(start, end).reduce((length, block) => length + block.text.length + 2, 0) + comment.anchor.end.offset : 0
      return { id: comment.id, selection: comment.selection, text: comment.text, passage, ...(from < to && to <= passage.length ? { range: { from, to } } : {}) }
    })
    return { note, comments }
  } catch { return null }
}

/** Old versions stored a generated summary in place of the owner's empty note. */
export function legacyCommentNote(text: string, count: number): string {
  return text === `Comments on ${count} passages.` || text === `Comments on ${count} passage${count === 1 ? '' : 's'}.` ? '' : text
}
