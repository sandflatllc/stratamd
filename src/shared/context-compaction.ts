import type { ConversationInput, EngineActivityView } from './contracts'
export type CompactContextInput = Pick<ConversationInput, 'model' | 'instanceId' | 'effort' | 'options' | 'access'>
export interface ContextCompactionView { state: 'working' | 'done' | 'failed'; beforeTokens?: number; afterTokens?: number; error?: string }
export interface ContextCompactionRequest { messageId: string; previousActivityIds: string[]; error?: string }
const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
/** Dispatch acceptance is not completion. T3 publishes the result independently. */
export function contextCompactionResult(request: ContextCompactionRequest, activities: readonly EngineActivityView[]): ContextCompactionView {
  const previous = new Set(request.previousActivityIds)
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index]!
    if (previous.has(activity.id)) continue
    const payload = activity.payload as Record<string, unknown> | null
    if (payload?.requestId && payload.requestId !== request.messageId) continue
    if (activity.kind === 'context-compaction' && payload?.state === 'compacted') return { state: 'done', ...(tokens(payload.beforeTokens) ? { beforeTokens: payload.beforeTokens } : {}), ...(tokens(payload.afterTokens) ? { afterTokens: payload.afterTokens } : {}) }
    if (activity.kind === 'provider.turn.start.failed' && (payload?.requestId === request.messageId || activity.summary === 'Context compaction failed')) return { state: 'failed', error: typeof payload?.detail === 'string' ? payload.detail : activity.summary }
  }
  return request.error ? { state: 'failed', error: request.error } : { state: 'working' }
}
