import { useEffect, useState } from 'react'
import type { ConversationAttachment, UserInputDraft } from '../shared/contracts'
import { engineStorage } from './engineStorage'
import { readUserInputDrafts } from './userInputDrafts'

const changed = 'strata-held-user-inputs'
/** Provider question drafts are atomic and private, scoped to this engine, thread and request. */
export function useHeldUserInputs(threadId: string | undefined, kind = 'held-user-inputs') {
  const key = `${kind}:${threadId ?? ''}`
  const [snapshot, setSnapshot] = useState(() => ({ key, drafts: readUserInputDrafts(key) }))
  useEffect(() => {
    const refresh = () => setSnapshot({ key, drafts: readUserInputDrafts(key) })
    refresh()
    window.addEventListener(changed, refresh)
    return () => window.removeEventListener(changed, refresh)
  }, [key])
  const write = (requestId: string, value: UserInputDraft | null) => {
    const drafts = readUserInputDrafts(key)
    if (value) drafts[requestId] = value
    else delete drafts[requestId]
    engineStorage.setItem(key, JSON.stringify(drafts))
    setSnapshot({ key, drafts })
    window.dispatchEvent(new Event(changed))
  }
  const drafts = snapshot.key === key ? snapshot.drafts : readUserInputDrafts(key)
  return { drafts, answers: Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, draft.answers])), hold: (id: string, answers: Record<string, string>, attachmentsByQuestionId: Record<string, ConversationAttachment[]> = {}) => write(id, { answers, attachmentsByQuestionId }), remove: (id: string) => write(id, null) }
}
