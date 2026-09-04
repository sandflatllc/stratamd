import { flagshipModel } from '../shared/modelSelection'
import type { ConversationInput, CreateDraftRequest, EngineModelView, EngineView, ModelOption } from '../shared/contracts'

export type ComposerSelection = Pick<ConversationInput, 'model' | 'effort' | 'access' | 'instanceId' | 'options'>
export interface ConversationDraft { messageId?: string; text: string; attachment?: { name: string; text: string } | undefined; selection?: ComposerSelection; threadId?: string }
const memory = new Map<string, ConversationDraft>()
const prefix = 'stratamd.conversation-draft.v1:'

export function readDraft(key: string): ConversationDraft {
  if (memory.has(key)) return memory.get(key)!
  try { const value = JSON.parse(localStorage.getItem(prefix + key) ?? 'null'); if (value && typeof value.text === 'string') return value } catch { /* A corrupt disposable draft cannot block conversation entry. */ }
  return { text: '' }
}
export function writeDraft(key: string, draft: ConversationDraft): void {
  memory.set(key, draft)
  try { localStorage.setItem(prefix + key, JSON.stringify(draft)) } catch { /* Keep the in-memory draft when storage is full. */ }
}
export function clearDraft(key: string): void {
  memory.delete(key)
  try { localStorage.removeItem(prefix + key) } catch { /* Storage may be unavailable. */ }
}
export function availableModels(engine: EngineView): EngineModelView[] {
  if (engine.models?.length) return engine.models
  const seen = new Set<string>()
  return engine.projects.flatMap((project) => project.threads.flatMap((thread) => {
    const key = `${thread.providerInstanceId}:${thread.model}`
    if (seen.has(key)) return []
    seen.add(key)
    const account = engine.accounts.find((candidate) => candidate.instanceId === thread.providerInstanceId)
    return [{ instanceId: thread.providerInstanceId, accountName: account?.name ?? thread.providerInstanceId, driver: account?.driver ?? '', slug: thread.model, name: thread.model, options: [] }]
  }))
}
export function defaultOptions(model?: EngineModelView): ModelOption[] {
  return (model?.options ?? []).flatMap((descriptor) => {
    const value = descriptor.currentValue ?? descriptor.options?.find((option) => option.isDefault)?.id
    return value === undefined ? [] : [{ id: descriptor.id, value }]
  })
}
export function selectionForModel(model: EngineModelView, access: ComposerSelection['access']): ComposerSelection {
  const options = defaultOptions(model)
  return { model: model.slug, instanceId: model.instanceId, options, effort: String(options.find((option) => option.id === 'effort')?.value ?? '') || null, access }
}
export function initialSelection(engine: EngineView, projectId: string): ComposerSelection {
  const models = availableModels(engine)
  const usable = (instanceId?: string | null) => !engine.accounts.some((account) => account.instanceId === instanceId && !account.usable)
  try {
    const saved = JSON.parse(localStorage.getItem(`stratamd.conversation-defaults.v1:${projectId}`) ?? 'null') as ComposerSelection | null
    if (saved && usable(saved.instanceId) && models.some((model) => model.slug === saved.model && model.instanceId === saved.instanceId)) return saved
  } catch { /* Use the project's defaults. */ }
  const project = engine.projects.find((candidate) => candidate.id === projectId)
  const previous = project?.threads.filter((thread) => !thread.archived).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const selected = project?.defaultModelSelection
  const instanceId = selected?.instanceId ?? previous?.providerInstanceId
  const slug = selected?.model ?? previous?.model
  const model = (selected ? models.find((candidate) => candidate.instanceId === instanceId && candidate.slug === slug && usable(candidate.instanceId)) : undefined) ?? flagshipModel(models.filter((candidate) => candidate.instanceId === instanceId && usable(candidate.instanceId))) ?? flagshipModel(models.filter((candidate) => usable(candidate.instanceId)))
  if (!model) return { model: '', instanceId: null, options: [], effort: null, access: 'approval-required' }
  const result = selectionForModel(model, previous?.access ?? 'approval-required')
  if (model.instanceId === instanceId && model.slug === slug) {
    result.options = selected?.options ?? previous?.options ?? (previous?.effort ? [{ id: 'effort', value: previous.effort }] : result.options ?? [])
    result.effort = String(result.options?.find((option) => option.id === 'effort')?.value ?? '') || null
  }
  return result
}
export function rememberSelection(projectId: string, selection: ComposerSelection): void {
  try { localStorage.setItem(`stratamd.conversation-defaults.v1:${projectId}`, JSON.stringify(selection)) } catch { /* Session selection still works. */ }
}

export interface NewConversationTarget { path: string | null; projectId?: string; comment?: CreateDraftRequest }
export function readNewConversationTarget(): NewConversationTarget | null {
  try { const value = JSON.parse(localStorage.getItem('stratamd.new-conversation.v1') ?? 'null'); return value && (value.path === null || typeof value.path === 'string') ? value : null } catch { return null }
}
export function writeNewConversationTarget(value: NewConversationTarget | null): void {
  try { localStorage.setItem('stratamd.new-conversation.v1', JSON.stringify(value)) } catch { /* Draft text still persists independently. */ }
}
