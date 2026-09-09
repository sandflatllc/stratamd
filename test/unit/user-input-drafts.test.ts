import { afterEach, expect, it, vi } from 'vitest'
import { engineStorage, setEngineStorageIdentity } from '../../src/renderer/engineStorage'
import { readUserInputDrafts } from '../../src/renderer/userInputDrafts'
import { draftAttachmentIds } from '../../src/renderer/conversationDrafts'

afterEach(() => { setEngineStorageIdentity(undefined); vi.unstubAllGlobals() })
it('migrates old text-only answers and keeps files from held and unheld questions scoped to their engine', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  setEngineStorageIdentity('first')
  engineStorage.setItem('held-user-inputs:t', JSON.stringify({ old: { release: 'One' } }))
  expect(readUserInputDrafts('held-user-inputs:t').old).toEqual({ answers: { release: 'One' }, attachmentsByQuestionId: {} })
  const file = (id: string) => ({ kind: 'binary', id, name: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 10 })
  engineStorage.setItem('held-user-inputs:t', JSON.stringify({ request: { answers: { first: '' }, attachmentsByQuestionId: { first: [file('held')] } } }))
  engineStorage.setItem('user-input-drafts:t', JSON.stringify({ request: { answers: { second: '' }, attachmentsByQuestionId: { second: [file('draft')] } } }))
  expect(draftAttachmentIds()).toEqual(expect.arrayContaining(['held', 'draft']))
  setEngineStorageIdentity('other')
  expect(draftAttachmentIds()).not.toContain('held')
})
