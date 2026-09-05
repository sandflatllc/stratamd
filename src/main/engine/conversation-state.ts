import { readFile } from 'node:fs/promises'
import { atomicWriteFile, isRecord, PRIVATE_FILE_MODE } from '../storage'
import type { ItemView } from '../../shared/contracts'

/**
 * What Strata remembers about a conversation's items between runs (§5.4,
 * §5.12): replies queued for the next Send, replies in flight until their
 * delivery is acknowledged, replies answered, and inferred items dismissed
 * per message. Lives in the ghost store; T3 never sees it.
 */
export interface ConversationState {
  /** Queued replies keyed by item id, each carrying what the item asked so the delivery can quote it. */
  replies: Record<string, QueuedReply>
  /** Replies delivered but not yet acknowledged by the engine's message-sent event. */
  pending: Array<{ deliveryId: string; itemIds: string[]; replies: Record<string, QueuedReply> }>
  /** Commands and bytes saved before the first upload. */
  prepared?: Array<{ messageId: string; command: unknown; attachments: Array<{ name: string; text: string; uploaded?: { type: 'file'; id: string; name: string; mimeType: string; sizeBytes: number } }> }>
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

export function normalizeConversationsStore(value: unknown): ConversationsStore {
  const store: ConversationsStore = { formatVersion: 1, threads: {} }
  if (!isRecord(value) || value.formatVersion !== 1 || !isRecord(value.threads)) return store
  for (const [threadId, raw] of Object.entries(value.threads)) {
    if (!isRecord(raw)) continue
    store.threads[threadId] = {
      replies: replies(raw.replies),
      pending: Array.isArray(raw.pending) ? raw.pending.flatMap((entry) => isRecord(entry) && typeof entry.deliveryId === 'string' ? [{ deliveryId: entry.deliveryId, itemIds: strings(entry.itemIds), replies: replies(entry.replies) }] : []) : [],
      prepared: Array.isArray(raw.prepared) ? raw.prepared.filter((entry): entry is NonNullable<ConversationState['prepared']>[number] => isRecord(entry) && typeof entry.messageId === 'string' && isRecord(entry.command) && Array.isArray(entry.attachments)) : [],
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
    if (answered.has(item.id)) return { ...item, status: 'done' }
    const queued = state.replies[item.id]
    if (queued) return { ...item, status: 'drafted', draftReply: queued.text }
    if (inFlight.has(item.id)) return { ...item, status: 'drafted' }
    return item
  })
}

/**
 * The delivery attachment for message-anchored replies (§5.4): the same
 * `Replies:` section a document delivery uses, each line keyed by the item
 * id the agent posted or Strata inferred, then what the item asked.
 */
export function renderItemReplies(replies: Readonly<Record<string, QueuedReply>>): string {
  const lines = Object.entries(replies).map(([itemId, reply]) => {
    const head = `${itemId} ← user: ${reply.text.replace(/\s+/gu, ' ').trim()}`
    const about = reply.quote ? `\n  item: ${reply.kind}${reply.messageId ? ` in message ${reply.messageId}` : ''} about "${reply.quote.replace(/"/gu, '\\"').slice(0, 200)}"` : ''
    return head + about
  })
  return `# Replies\n\nReplies:\n${lines.join('\n')}\n`
}
