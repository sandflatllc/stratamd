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
/** Families whose provider has a glyph, with the word the glyph replaces at the front of engine model names. */
const GLYPH_FAMILIES: Record<string, { word: string; driver: string }> = { claude: { word: 'Claude', driver: 'claudeAgent' }, gpt: { word: 'GPT', driver: 'codex' } }
export function glyphFamilyDriver(family: string | undefined): string | undefined {
  return family ? GLYPH_FAMILIES[family]?.driver : undefined
}
/** GPT size and channel suffixes; a version followed only by one of these is a legacy model and keeps its number ("5.4 Mini"). */
const GPT_VARIANT_WORDS = /^(?:mini|nano|pro|codex|turbo|preview|latest|chat|instant|high|low|medium|max)$/i
/**
 * The model name as shown beside its provider glyph: the vendor word and its
 * separator come off the front, and the hyphens T3 keeps from Codex slugs
 * become spaces ("Claude Fable 5.1" reads "Fable 5.1"). Named GPT models drop
 * the version number the way ChatGPT does ("GPT-6-Astra" reads "Astra",
 * "GPT-5.6-Sol" reads "Sol"); legacy GPT models without a codename keep it
 * ("GPT-5.6" reads "5.6", "GPT-5.4-Mini" reads "5.4 Mini"). A name that is only
 * the raw slug, or a family without a glyph, stays as the engine sent it.
 */
export function modelDesignation(model: { name: string; slug: string; driver?: string | undefined }): string {
  const family = modelFamily(model.driver, model.slug)
  const glyph = GLYPH_FAMILIES[family]
  if (!glyph || model.name === model.slug) return model.name
  const stripped = model.name.replace(new RegExp(`^${glyph.word}(?:\\s*[.:/-]\\s*|\\s+)`, 'i'), '').replace(/-/g, ' ').trim()
  if (!stripped) return model.name
  if (family !== 'gpt') return stripped
  const named = /^\d+(?:\.\d+)*\s+(\S+)(.*)$/.exec(stripped)
  return named && !GPT_VARIANT_WORDS.test(named[1]!) ? `${named[1]}${named[2]}`.trim() : stripped
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
