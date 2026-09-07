import type { EngineActivityView, EngineMessageView } from '../shared/contracts'

export interface ConversationTurn {
  /** Display group identity; a provider turn can resume after another turn. */
  id: string
  turnId: string | null
  messages: EngineMessageView[]
  activities: EngineActivityView[]
}

/** Keep chronological neighbors together without moving messages across other turns. */
export function conversationTurns(messages: readonly EngineMessageView[], activities: readonly EngineActivityView[], activeTurnId: string | null): ConversationTurn[] {
  // When timestamps tie, keep the engine's message order and place work after
  // its own turn's messages, rather than after every turn at that timestamp.
  const messageOrder = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.turnId !== null) messageOrder.set(`${message.turnId}:${Date.parse(message.createdAt)}`, index)
  })
  const rows = [
    ...messages.map((message, index) => ({ kind: 'message' as const, value: message, order: index })),
    ...activities.map(activity => ({ kind: 'activity' as const, value: activity, order: (messageOrder.get(`${activity.turnId}:${Date.parse(activity.createdAt)}`) ?? messages.length) + 0.5 })),
  ].sort((a, b) => Date.parse(a.value.createdAt) - Date.parse(b.value.createdAt) || a.order - b.order)

  // T3 leaves user messages unassigned. A request belongs beside the next
  // response/work; steering between two rows of a turn stays inside that turn.
  // A trailing request stays separate unless a turn is still active.
  const assigned = new Map<string, string | null>()
  let nextTurn = activeTurnId
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    nextTurn = row.value.turnId ?? nextTurn
    assigned.set(row.value.id, nextTurn)
  }

  const turns: ConversationTurn[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const turnId = assigned.get(row.value.id) ?? null
    let turn = turns.at(-1)
    if (!turn || turn.turnId !== turnId) {
      const base = turnId ?? `pending:${row.value.id}`
      turn = { id: seen.has(base) ? `${base}:after:${row.value.id}` : base, turnId, messages: [], activities: [] }
      seen.add(base)
      turns.push(turn)
    }
    if (row.kind === 'message') turn.messages.push(row.value)
    else turn.activities.push(row.value)
  }
  return turns
}
