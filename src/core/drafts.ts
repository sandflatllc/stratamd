import type { AnnotationContext, CreateDraftRequest, DraftKind } from '../shared/contracts.js'
import { createStoredTextAnchor, relocateStoredTextAnchor, type StoredTextAnchor } from './anchors.js'

export const DRAFT_FORMAT_VERSION = 1 as const

export interface Draft {
  id: string
  kind: DraftKind
  text: string
  anchor: StoredTextAnchor
  context?: AnnotationContext
  createdAt: number
}

export interface DraftStore {
  formatVersion: typeof DRAFT_FORMAT_VERSION
  drafts: readonly Draft[]
}

export function createDraftStore(): DraftStore {
  return { formatVersion: DRAFT_FORMAT_VERSION, drafts: [] }
}

export function holdDraft(
  store: DraftStore,
  source: string,
  input: CreateDraftRequest & { id: string; createdAt: number },
): DraftStore {
  const text = input.text.trim()
  if (!text) return store
  if (!input.quote) throw new Error('A draft quote cannot be empty')
  const draft: Draft = {
    id: input.id,
    kind: input.kind,
    text,
    anchor: createStoredTextAnchor(source, { from: input.from, to: input.to }),
    ...(input.context ? { context: input.context } : {}),
    createdAt: input.createdAt,
  }
  return { ...store, drafts: [...store.drafts.filter((item) => item.id !== draft.id), draft] }
}

export function discardDraft(store: DraftStore, id: string): DraftStore {
  const drafts = store.drafts.filter((draft) => draft.id !== id)
  return drafts.length === store.drafts.length ? store : { ...store, drafts }
}

export function relocateDraft(draft: Draft, source: string) {
  const relocation = relocateStoredTextAnchor(draft.anchor, source)
  return relocation.range === null
    ? { status: 'orphaned' as const, from: null, to: null }
    : { status: 'attached' as const, ...relocation.range }
}
