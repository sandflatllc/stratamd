import type { EngineActivityView } from '../shared/contracts'

export function inputPayload(activity: EngineActivityView): Record<string, unknown> {
  return activity.payload && typeof activity.payload === 'object' ? activity.payload as Record<string, unknown> : {}
}

/** Requests remain pending across turns. Only the engine's resolved activity retires them. */
export function pendingUserInputs(activities: readonly EngineActivityView[]): EngineActivityView[] {
  const pending = new Map<string, EngineActivityView>()
  for (const activity of activities) {
    const { requestId } = inputPayload(activity)
    if (typeof requestId !== 'string') continue
    if (activity.kind === 'user-input.requested') pending.set(requestId, activity)
    if (activity.kind === 'user-input.resolved') pending.delete(requestId)
  }
  return [...pending.values()]
}

export function nativeQuestionTexts(activities: readonly EngineActivityView[], turnId: string | null): string[] {
  return activities.filter(activity => activity.kind === 'user-input.requested' && activity.turnId === turnId).flatMap(activity => {
    const { questions } = inputPayload(activity)
    return Array.isArray(questions) ? questions.flatMap(question => question && typeof question === 'object' && typeof question.question === 'string' ? [question.question] : []) : []
  })
}
