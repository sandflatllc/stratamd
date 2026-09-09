import type { ConversationAttachment, UserInputDraft } from '../shared/contracts'
import { engineStorage } from './engineStorage'

export const USER_INPUT_DRAFT_KEYS = ['held-user-inputs:', 'user-input-drafts:'] as const
export function readUserInputDrafts(key: string): Record<string, UserInputDraft> {
  try {
    const value: unknown = JSON.parse(engineStorage.getItem(key) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      if (Object.values(raw).every(answer => typeof answer === 'string' || Array.isArray(answer) && answer.every(value => typeof value === 'string'))) return [[id, { answers: raw, attachmentsByQuestionId: {} }]]
      const draft = raw as UserInputDraft
      if (!draft.answers || !Object.values(draft.answers).every(answer => typeof answer === 'string' || Array.isArray(answer) && answer.every(value => typeof value === 'string'))) return []
      const attachmentsByQuestionId = Object.fromEntries(Object.entries(draft.attachmentsByQuestionId ?? {}).map(([question, files]) => [question, Array.isArray(files) ? files.filter((file): file is ConversationAttachment => file && typeof file.name === 'string' && (file.kind === 'text' && typeof file.text === 'string' || (file.kind === 'image' || file.kind === 'binary') && typeof file.id === 'string' && typeof file.sizeBytes === 'number' && typeof file.mimeType === 'string')) : []]))
      return [[id, { answers: draft.answers, attachmentsByQuestionId }]]
    }))
  } catch { return {} }
}

/** Held and unheld answers both own their staged bytes through app restart. */
export function userInputAttachmentIds(): string[] {
  const ids = new Set<string>()
  for (let index = 0; index < engineStorage.length; index++) {
    const key = engineStorage.key(index)
    if (!key || !USER_INPUT_DRAFT_KEYS.some(prefix => key.startsWith(prefix))) continue
    for (const draft of Object.values(readUserInputDrafts(key))) for (const file of Object.values(draft.attachmentsByQuestionId).flat()) if (file.kind !== 'text') ids.add(file.id)
  }
  return [...ids]
}
