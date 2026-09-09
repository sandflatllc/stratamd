import type { EngineActivityView } from '../shared/contracts'

export function inputPayload(activity: EngineActivityView): Record<string, unknown> {
  return activity.payload && typeof activity.payload === 'object' ? activity.payload as Record<string, unknown> : {}
}

export function userInputRetired(activity: EngineActivityView): boolean {
  if (activity.kind === 'user-input.resolved') return true
  const detail = inputPayload(activity).detail
  return activity.kind === 'provider.user-input.respond.failed' && typeof detail === 'string' &&
    ['stale pending user-input request', 'unknown pending user-input request', 'unknown pending user input request', 'unknown pending codex user input request'].some(reason => detail.toLowerCase().includes(reason))
}

/** Transient response failures keep requests pending; stale requests are retired by the engine. */
export function pendingUserInputs(activities: readonly EngineActivityView[]): EngineActivityView[] {
  const pending = new Map<string, EngineActivityView>()
  for (const activity of activities) {
    const { requestId } = inputPayload(activity)
    if (typeof requestId !== 'string') continue
    if (activity.kind === 'user-input.requested') pending.set(requestId, activity)
    if (userInputRetired(activity)) pending.delete(requestId)
  }
  return [...pending.values()]
}

export function nativeQuestionTexts(activities: readonly EngineActivityView[], turnId: string | null): string[] {
  return activities.filter(activity => activity.kind === 'user-input.requested' && activity.turnId === turnId).flatMap(activity => {
    const { questions } = inputPayload(activity)
    return Array.isArray(questions) ? questions.flatMap(question => question && typeof question === 'object' && typeof question.question === 'string' ? [question.question] : []) : []
  })
}

/** Long-running agents must not evict questions the owner can still answer. */
export function retainQuestionActivities<T extends EngineActivityView>(activities: T[]): T[] {
  const recentStart = activities.length - 500
  if (recentStart <= 0) return activities
  const pending = new Set(pendingUserInputs(activities).filter(activity => inputPayload(activity).responseMode === 'message'))
  return activities.filter((activity, index) => index >= recentStart || pending.has(activity))
}
