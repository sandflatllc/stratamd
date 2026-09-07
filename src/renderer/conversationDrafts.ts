import { accountForModel } from '../core/accountState'
import { engineStorage, engineStorageKey } from './engineStorage'
import { flagshipModel } from '../shared/modelSelection'
import type { ConversationAttachment, ConversationInput, CreateDraftRequest, EngineModelView, EngineView, ModelOption } from '../shared/contracts'

export type ComposerSelection = Pick<ConversationInput, 'model' | 'effort' | 'access' | 'instanceId' | 'options'>
/** An image's bytes sit in the main process; the draft keeps only a small preview beside the reference (§6.0). */
export type DraftAttachment = ConversationAttachment & { thumbnail?: string }
export interface ConversationDraft {
  workspace?: import('./components/WorkspaceControls').WorkspaceChoice
  messageId?: string
  text: string
  attachments?: DraftAttachment[] | undefined
  selection?: ComposerSelection
  /** The thread's own saved selection when `selection` was written; a thread whose selection has since changed elsewhere wins over the draft. */
  selectionBase?: ComposerSelection
  threadId?: string
}
const memory = new Map<string, ConversationDraft>()
const prefix = 'stratamd.conversation-draft.v1:'

function parseDraft(raw: string | null): ConversationDraft | null {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (!value || typeof value.text !== 'string') return null
    // Drafts written before images carried one text attachment under `attachment`.
    if (value.attachment && !value.attachments) { const { attachment, ...rest } = value; return { ...rest, attachments: [{ kind: 'text', name: String(attachment.name), text: String(attachment.text) }] } }
    return value
  } catch { return null }
}

export function readDraft(key: string): ConversationDraft {
  if (memory.has(engineStorageKey(key))) return memory.get(engineStorageKey(key))!
  // A corrupt disposable draft cannot block conversation entry.
  return parseDraft(engineStorage.getItem(prefix + key)) ?? { text: '' }
}
/** False when local storage refused the draft; it then lives in memory only and will not survive reload. */
export function writeDraft(key: string, draft: ConversationDraft): boolean {
  memory.set(engineStorageKey(key), draft)
  try { engineStorage.setItem(prefix + key, JSON.stringify(draft)); return true } catch { return false }
}
/** Every staged image any saved draft still references, so the main process can delete the rest. */
export function draftAttachmentIds(): string[] {
  const ids = new Set<string>()
  const keys: string[] = []
  try { for (let index = 0; index < engineStorage.length; index += 1) { const key = engineStorage.key(index); if (key?.startsWith(prefix)) keys.push(key) } } catch { /* No storage means no saved drafts. */ }
  for (const key of keys) for (const attachment of parseDraft(engineStorage.getItem(key))?.attachments ?? []) if (attachment.kind === 'image') ids.add(attachment.id)
  for (const draft of memory.values()) for (const attachment of draft.attachments ?? []) if (attachment.kind === 'image') ids.add(attachment.id)
  return [...ids]
}
export function clearDraft(key: string): void {
  memory.delete(engineStorageKey(key))
  try { engineStorage.removeItem(prefix + key) } catch { /* Storage may be unavailable. */ }
}
/** Sending consumes content and delivery IDs, but model settings outlive the message. */
export function clearDraftContent(key: string, selection: ComposerSelection, selectionBase?: ComposerSelection): boolean {
  return writeDraft(key, { text: '', selection, ...(selectionBase ? { selectionBase } : {}) })
}
function canonicalSelection(selection: ComposerSelection): string {
  return JSON.stringify({ model: selection.model, instanceId: selection.instanceId ?? null, effort: selection.effort ?? null, access: selection.access, options: [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)) })
}
/**
 * The selection a composer opens with. A draft's selection is used only when it still names an available model on
 * a usable account; for a thread, only while the thread's own selection is the one the draft was written against,
 * so a change made outside Strata (or the settings a send saved) is not overwritten by a stale draft. Otherwise the
 * thread's or project's `initial` selection applies.
 */
export function draftSelection(engine: EngineView, draft: ConversationDraft, initial: ComposerSelection, boundToThread: boolean): ComposerSelection {
  const selection = draft.selection
  if (!selection) return initial
  if (!availableModels(engine).some((model) => model.slug === selection.model && model.instanceId === selection.instanceId)) return initial
  if (engine.accounts.some((account) => account.instanceId === selection.instanceId && !accountForModel(account, selection.model).usable)) return initial
  if (boundToThread && (!draft.selectionBase || canonicalSelection(draft.selectionBase) !== canonicalSelection(initial))) return initial
  return selection
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
export function selectionForModel(model: EngineModelView, access: ComposerSelection['access'], previous?: ComposerSelection): ComposerSelection {
  const options = defaultOptions(model)
  if (previous?.instanceId === model.instanceId) {
    for (const option of previous.options ?? []) {
      const descriptor = model.options.find(descriptor => descriptor.id === option.id)
      const supported = descriptor?.type === 'boolean' ? typeof option.value === 'boolean' : descriptor?.options?.some(value => value.id === option.value)
      if (!supported) continue
      const index = options.findIndex(value => value.id === option.id)
      if (index === -1) options.push(option)
      else options[index] = option
    }
  }
  return { model: model.slug, instanceId: model.instanceId, options, effort: String(options.find((option) => option.id === 'effort' || option.id === 'reasoningEffort')?.value ?? '') || null, access }
}
export function rememberedSelection(projectId: string, instanceId: string): ComposerSelection | undefined {
  try { return JSON.parse(engineStorage.getItem(`stratamd.conversation-account-defaults.v1:${projectId}:${instanceId}`) ?? 'null') ?? undefined } catch { return undefined }
}
export function initialSelection(engine: EngineView, projectId: string): ComposerSelection {
  const models = availableModels(engine)
  const usable = (instanceId: string | null | undefined, model: string) => !engine.accounts.some((account) => account.instanceId === instanceId && !accountForModel(account, model).usable)
  try {
    const saved = JSON.parse(engineStorage.getItem(`stratamd.conversation-defaults.v1:${projectId}`) ?? 'null') as ComposerSelection | null
    if (saved && usable(saved.instanceId, saved.model) && models.some((model) => model.slug === saved.model && model.instanceId === saved.instanceId)) return saved
  } catch { /* Use the project's defaults. */ }
  const project = engine.projects.find((candidate) => candidate.id === projectId)
  const previous = project?.threads.filter((thread) => !thread.archived).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const selected = project?.defaultModelSelection
  const instanceId = selected?.instanceId ?? previous?.providerInstanceId
  const slug = selected?.model ?? previous?.model
  const model = (selected ? models.find((candidate) => candidate.instanceId === instanceId && candidate.slug === slug && usable(candidate.instanceId, candidate.slug)) : undefined) ?? flagshipModel(models.filter((candidate) => candidate.instanceId === instanceId && usable(candidate.instanceId, candidate.slug))) ?? flagshipModel(models.filter((candidate) => usable(candidate.instanceId, candidate.slug)))
  if (!model) return { model: '', instanceId: null, options: [], effort: null, access: 'approval-required' }
  const result = selectionForModel(model, previous?.access ?? 'approval-required')
  if (model.instanceId === instanceId && model.slug === slug) {
    result.options = selected?.options ?? previous?.options ?? (previous?.effort ? [{ id: 'effort', value: previous.effort }] : result.options ?? [])
    result.effort = String(result.options?.find((option) => option.id === 'effort' || option.id === 'reasoningEffort')?.value ?? '') || null
  }
  return result
}
export function rememberSelection(projectId: string, selection: ComposerSelection): void {
  try {
    engineStorage.setItem(`stratamd.conversation-defaults.v1:${projectId}`, JSON.stringify(selection))
    if (selection.instanceId) engineStorage.setItem(`stratamd.conversation-account-defaults.v1:${projectId}:${selection.instanceId}`, JSON.stringify(selection))
  } catch { /* Session selection still works. */ }
}

export interface NewConversationTarget { path: string | null; projectId?: string; comment?: CreateDraftRequest }
export function readNewConversationTarget(): NewConversationTarget | null {
  try { const value = JSON.parse(engineStorage.getItem('stratamd.new-conversation.v1') ?? 'null'); return value && (value.path === null || typeof value.path === 'string') ? value : null } catch { return null }
}
export function writeNewConversationTarget(value: NewConversationTarget | null): void {
  try { engineStorage.setItem('stratamd.new-conversation.v1', JSON.stringify(value)) } catch { /* Draft text still persists independently. */ }
}
