import { z } from 'zod'
import { worktreeRequest } from './t3-contract'
import { readFile } from 'node:fs/promises'
import { atomicWriteFile, isRecord, PRIVATE_FILE_MODE } from '../storage'
import { logWarn } from '../log'
import type { ItemView } from '../../shared/contracts'

/**
 * What Strata remembers about a conversation's items between runs (§5.4,
 * §5.12): replies queued for the next Send, replies in flight until their
 * delivery is acknowledged, replies answered, and inferred items dismissed
 * per message. Lives in the ghost store; T3 never sees it.
 */
export interface ConversationState {
  workspace?: import('../../shared/contracts').WorktreeRequest
  comments?: import("../../core/conversation-delivery").MessageComment[]
  outcomes?: import("../../core/conversation-delivery").ConversationOutcome[]
  receipts?: string[]
  /** Queued replies keyed by item id, each carrying what the item asked so the delivery can quote it. */
  replies: Record<string, QueuedReply>
  /** Replies delivered but not yet acknowledged by the engine's message-sent event. */
  pending: Array<{ deliveryId: string; itemIds: string[]; replies: Record<string, QueuedReply>; commentIds?: string[]; outcomeKeys?: string[] }>
  /** Commands and attachments saved before the first upload; image bytes stay in the staged store until uploaded. */
  prepared?: Array<{ messageId: string; command: unknown; attachments: PreparedAttachment[] }>
  /** Items whose reply the engine acknowledged. */
  answered: string[]
  /** Inferred items the owner dismissed; remembered for the message's lifetime. */
  dismissed: string[]
}

export interface QueuedReply {
  text: string
  kind: ItemView['kind']
  quote: string
  messageId: string | null
}

/** T3's reference to bytes it holds; `file` for Markdown, `image` for a picture the provider sees. */
export interface UploadedAttachment { type: 'file' | 'image'; id: string; name: string; mimeType: string; sizeBytes: number }

export type PreparedAttachment = (
  | { kind: 'text'; name: string; text: string }
  | { kind: 'image'; id: string; name: string; mimeType: string; sizeBytes: number }
) & { uploaded?: UploadedAttachment }

/**
 * Entries written before images existed have no `kind`; they were always
 * text. An uploaded reference is kept so a restart never uploads twice.
 */
export function normalizePreparedAttachment(value: unknown): PreparedAttachment | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null
  const uploaded = isRecord(value.uploaded) && typeof value.uploaded.id === 'string' && typeof value.uploaded.name === 'string' && typeof value.uploaded.mimeType === 'string' && typeof value.uploaded.sizeBytes === 'number'
    ? { uploaded: { type: value.uploaded.type === 'image' ? 'image' as const : 'file' as const, id: value.uploaded.id, name: value.uploaded.name, mimeType: value.uploaded.mimeType, sizeBytes: value.uploaded.sizeBytes } }
    : {}
  if (value.kind === 'image') {
    if (typeof value.id !== 'string' || typeof value.mimeType !== 'string' || typeof value.sizeBytes !== 'number') return null
    return { kind: 'image', id: value.id, name: value.name, mimeType: value.mimeType, sizeBytes: value.sizeBytes, ...uploaded }
  }
  if ((value.kind === 'text' || value.kind === undefined) && typeof value.text === 'string') return { kind: 'text', name: value.name, text: value.text, ...uploaded }
  return null
}

export interface ConversationsStore {
  formatVersion: 1
  threads: Record<string, ConversationState>
}

export function emptyConversationState(): ConversationState {
  return { replies: {}, pending: [], answered: [], dismissed: [] }
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function queuedReply(value: unknown): QueuedReply | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null
  const kind = typeof value.kind === 'string' && ['decision', 'question', 'suggestion', 'edit', 'comment'].includes(value.kind) ? value.kind as ItemView['kind'] : 'question'
  return { text: value.text, kind, quote: typeof value.quote === 'string' ? value.quote : '', messageId: typeof value.messageId === 'string' ? value.messageId : null }
}

function replies(value: unknown): Record<string, QueuedReply> {
  const result: Record<string, QueuedReply> = {}
  if (!isRecord(value)) return result
  for (const [itemId, raw] of Object.entries(value)) { const reply = queuedReply(raw); if (reply) result[itemId] = reply }
  return result
}

const endpointSchema = z.object({ block: z.string().min(1), offset: z.number().int().nonnegative() })
const commentSchema = z.object({ id: z.string(), kind: z.enum(['comment', 'question', 'suggestion', 'decision']), anchor: z.object({ message: z.string(), start: endpointSchema, end: endpointSchema }), source: z.string(), selection: z.string(), text: z.string(), revision: z.number().int().positive(), state: z.enum(['held', 'pending', 'open', 'resolved']), options: z.array(z.string()).optional(), replies: z.array(z.object({ author: z.enum(['user', 'agent']), text: z.string() })) })
const outcomeSchema = z.object({ message: z.string(), index: z.number().int().nonnegative(), status: z.enum(['applied', 'failed']), itemId: z.string().optional(), reason: z.string().optional() })

export function normalizeConversationsStore(value: unknown): ConversationsStore {
  const store: ConversationsStore = { formatVersion: 1, threads: {} }
  if (!isRecord(value) || value.formatVersion !== 1 || !isRecord(value.threads)) return store
  for (const [threadId, raw] of Object.entries(value.threads)) {
    if (!isRecord(raw)) continue
    const workspace = worktreeRequest.safeParse(raw.workspace)
    store.threads[threadId] = {
      ...(workspace.success ? { workspace: workspace.data } : {}),
      comments: Array.isArray(raw.comments) ? raw.comments.flatMap(entry => { const parsed = commentSchema.safeParse(entry); return parsed.success ? [parsed.data as import('../../core/conversation-delivery').MessageComment] : [] }) : [],
      outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.flatMap(entry => { const parsed = outcomeSchema.safeParse(entry); return parsed.success ? [parsed.data as import('../../core/conversation-delivery').ConversationOutcome] : [] }) : [],
      receipts: strings(raw.receipts),
      replies: replies(raw.replies),
      pending: Array.isArray(raw.pending) ? raw.pending.flatMap((entry) => isRecord(entry) && typeof entry.deliveryId === 'string' ? [{ deliveryId: entry.deliveryId, itemIds: strings(entry.itemIds), replies: replies(entry.replies), commentIds: strings(entry.commentIds), outcomeKeys: strings(entry.outcomeKeys) }] : []) : [],
      prepared: Array.isArray(raw.prepared) ? raw.prepared.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.messageId !== 'string' || !isRecord(entry.command) || !Array.isArray(entry.attachments)) return []
        const attachments = entry.attachments.map(normalizePreparedAttachment)
        // A preparation with an unreadable attachment cannot be uploaded; dropping it lets the retry logic restore its replies.
        if (attachments.some((attachment) => attachment === null)) { logWarn('engine', `Delivery ${entry.messageId} had an unreadable attachment and was dropped`); return [] }
        return [{ messageId: entry.messageId, command: entry.command, attachments: attachments as PreparedAttachment[] }]
      }) : [],
      answered: strings(raw.answered),
      dismissed: strings(raw.dismissed),
    }
  }
  return store
}

export async function readConversationsStore(path: string): Promise<ConversationsStore> {
  try { return normalizeConversationsStore(JSON.parse(await readFile(path, 'utf8'))) } catch { return { formatVersion: 1, threads: {} } }
}

export async function writeConversationsStore(path: string, store: ConversationsStore): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
}

/** How the engine's items look once Strata's memory is applied: dismissed hidden, queued or in flight Drafted, acknowledged done. */
export function applyConversationState(items: readonly ItemView[], state: ConversationState | undefined): ItemView[] {
  if (!state) return [...items]
  const dismissed = new Set(state.dismissed)
  const answered = new Set(state.answered)
  const inFlight = new Set(state.pending.flatMap((entry) => entry.itemIds))
  return items.filter((item) => !dismissed.has(item.id)).map((item) => {
    const queued = state.replies[item.id]
    if (queued) return { ...item, status: 'drafted', draftReply: queued.text }
    if (answered.has(item.id)) return { ...item, status: 'done' }
    if (inFlight.has(item.id)) return { ...item, status: 'drafted' }
    return item
  })
}
