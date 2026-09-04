import type { EngineModelView } from './contracts'

export interface ModelIdentity { instanceId: string; model: string; driver?: string | undefined }
export interface ModelScope { family: string; instanceId: string | null }

/** Provider identity is authoritative; model names cover a temporarily missing account report. */
export function modelFamily(driver: string | undefined, model: string): string {
  const kind = driver?.toLowerCase()
  if (kind === 'codex' || kind === 'openai') return 'gpt'
  if (kind === 'claudeagent' || kind === 'claude') return 'claude'
  if (kind) return kind
  if (/^claude/i.test(model)) return 'claude'
  if (/^(gpt|codex|o[134](?:-|$))/i.test(model)) return 'gpt'
  return 'unknown'
}
export function familyLabel(family: string): string {
  return family === 'gpt' ? 'GPT' : family === 'claude' ? 'Claude' : family === 'unknown' ? 'Current provider' : family
}
export function continuationScope(current: ModelIdentity): ModelScope {
  const family = modelFamily(current.driver, current.model)
  return { family, instanceId: family === 'gpt' ? null : current.instanceId }
}
export function permitsSelection(scope: ModelScope | undefined, candidate: ModelIdentity): boolean {
  return !scope || (modelFamily(candidate.driver, candidate.model) === scope.family && (scope.instanceId === null || candidate.instanceId === scope.instanceId))
}
export function flagshipModel(models: readonly EngineModelView[]): EngineModelView | undefined {
  const preferred = models.filter(model => /(?:astra|fable)/i.test(model.slug))
    .toSorted((a, b) => b.slug.localeCompare(a.slug, undefined, { numeric: true }))
  return preferred[0] ?? models.find(model => model.isDefault) ?? models[0]
}
