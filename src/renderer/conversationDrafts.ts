import { supportsOption, validatedModelOptions } from '../shared/custom-models'
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
/** Durable writes owed for a draft key, coalesced so typing writes memory now and storage shortly after. */
const pending = new Map<string, { key: string; timer: ReturnType<typeof setTimeout> }>()
/** Draft keys whose last durable write was refused by storage. */
const refused = new Set<string>()
const storageListeners = new Set<(key: string, stored: boolean) => void>()
const presenceListeners = new Map<string, Set<() => void>>()
/** Only composer text and files count; model settings and held work do not. */
export function hasDraftContent(key: string): boolean {
  const draft = readDraft(key)
  return Boolean(draft.text.trim() || draft.attachments?.length)
}
export function onDraftPresence(key: string, listener: () => void): () => void {
  const scoped = engineStorageKey(key)
  const listeners = presenceListeners.get(scoped) ?? new Set<() => void>()
  presenceListeners.set(scoped, listeners)
  listeners.add(listener)
  return () => { listeners.delete(listener); if (!listeners.size) presenceListeners.delete(scoped) }
}
function notifyPresence(key: string, previous: boolean): void {
  if (previous !== hasDraftContent(key)) for (const listener of presenceListeners.get(engineStorageKey(key)) ?? []) listener()
}
export const DRAFT_WRITE_DELAY_MS = 300

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
function writeDurable(key: string, draft: ConversationDraft): boolean {
  const scoped = engineStorageKey(key)
  let stored = true
  try { engineStorage.setItem(prefix + key, JSON.stringify(draft)) } catch { stored = false }
  if (stored) refused.delete(scoped); else refused.add(scoped)
  return stored
}
function cancelPending(scoped: string): void {
  const entry = pending.get(scoped)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(scoped)
}
function flushOne(scoped: string): boolean {
  const entry = pending.get(scoped)
  if (!entry) return !refused.has(scoped)
  cancelPending(scoped)
  const draft = memory.get(scoped)
  const stored = draft ? writeDurable(entry.key, draft) : true
  for (const listener of storageListeners) listener(entry.key, stored)
  return stored
}
/**
 * Memory holds the draft at once; the durable copy follows after a short pause so a keystroke never pays
 * for serializing the whole draft and its inline attachments. Returns false while storage last refused
 * this draft; `onDraftStorage` reports the outcome of each coalesced write. Pass `immediate` when the
 * write must be durable before the caller continues, such as the message id a send is about to use.
 */
export function writeDraft(key: string, draft: ConversationDraft, options?: { immediate?: boolean }): boolean {
  const scoped = engineStorageKey(key)
  const previous = hasDraftContent(key)
  memory.set(scoped, draft)
  notifyPresence(key, previous)
  if (options?.immediate) { cancelPending(scoped); return writeDurable(key, draft) }
  if (!pending.has(scoped)) pending.set(scoped, { key, timer: setTimeout(() => flushOne(scoped), DRAFT_WRITE_DELAY_MS) })
  return !refused.has(scoped)
}
/** Writes every coalesced draft now; false when storage refused any of them. */
export function flushDrafts(): boolean {
  let stored = true
  for (const scoped of [...pending.keys()]) stored = flushOne(scoped) && stored
  return stored
}
/** Learns whether each coalesced write reached storage, keyed by the draft key it was written under. */
export function onDraftStorage(listener: (key: string, stored: boolean) => void): () => void {
  storageListeners.add(listener)
  return () => { storageListeners.delete(listener) }
}
if (typeof window !== 'undefined') {
  // A reload, a window close, or the app quitting must not lose the last few hundred milliseconds of typing.
  window.addEventListener('pagehide', () => { flushDrafts() })
  window.addEventListener('beforeunload', () => { flushDrafts() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushDrafts() })
}
/** Every staged image any saved draft still references, so the main process can delete the rest. */
export function draftAttachmentIds(): string[] {
  const ids = new Set<string>()
  const keys: string[] = []
  try { for (let index = 0; index < engineStorage.length; index += 1) { const key = engineStorage.key(index); if (key?.startsWith(prefix)) keys.push(key) } } catch { /* No storage means no saved drafts. */ }
  for (const key of keys) for (const attachment of parseDraft(engineStorage.getItem(key))?.attachments ?? []) if (attachment.kind !== 'text') ids.add(attachment.id)
  for (const draft of memory.values()) for (const attachment of draft.attachments ?? []) if (attachment.kind !== 'text') ids.add(attachment.id)
  return [...ids]
}
export function clearDraft(key: string): void {
  const previous = hasDraftContent(key)
  const scoped = engineStorageKey(key)
  cancelPending(scoped)
  memory.delete(scoped)
  refused.delete(scoped)
  try { engineStorage.removeItem(prefix + key) } catch { /* Storage may be unavailable. */ }
  notifyPresence(key, previous)
}
/** Sending consumes content and delivery IDs, but model settings outlive the message. */
export function clearDraftContent(key: string, selection: ComposerSelection, selectionBase?: ComposerSelection): boolean {
  return writeDraft(key, { text: '', selection, ...(selectionBase ? { selectionBase } : {}) }, { immediate: true })
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
    const value = supportsOption(descriptor, descriptor.currentValue) ? descriptor.currentValue : descriptor.options?.find(option => option.isDefault)?.id
    return supportsOption(descriptor, value) ? [{ id: descriptor.id, value }] : []
  })
}
export function selectionForModel(model: EngineModelView, access: ComposerSelection['access'], previous?: ComposerSelection): ComposerSelection {
  const options = defaultOptions(model)
  if (previous?.instanceId === model.instanceId) {
    for (const option of previous.options ?? []) {
      const descriptor = model.options.find(descriptor => descriptor.id === option.id)
      const supported = descriptor && supportsOption(descriptor, option.value)
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
export function initialSelection(engine: EngineView, projectId: string, useConfiguredDefaults = false): ComposerSelection {
  const models = availableModels(engine)
  const usable = (instanceId: string | null | undefined, model: string) => !engine.accounts.some((account) => account.instanceId === instanceId && !accountForModel(account, model).usable)
  try {
    const saved = JSON.parse(engineStorage.getItem(`stratamd.conversation-defaults.v1:${projectId}`) ?? 'null') as ComposerSelection | null
    if (!useConfiguredDefaults && saved && usable(saved.instanceId, saved.model) && models.some((model) => model.slug === saved.model && model.instanceId === saved.instanceId)) return saved
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
    result.options = selected ? validatedModelOptions(model, selected.options ?? result.options ?? []) : previous?.options ?? (previous?.effort ? [{ id: 'effort', value: previous.effort }] : result.options ?? [])
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
