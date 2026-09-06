import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { availableModels, clearDraft, draftAttachmentIds, initialSelection, readDraft, rememberSelection, selectionForModel, writeDraft } from '../../src/renderer/conversationDrafts'
import { setEngineStorageIdentity } from '../../src/renderer/engineStorage'
import { EMPTY_VIEW } from '../../src/renderer/model'
import type { EngineModelView, EngineView } from '../../src/shared/contracts'

const codex: EngineModelView = { instanceId: 'work', accountName: 'Work', driver: 'codex', slug: 'codex', name: 'Codex', isDefault: true, options: [{ id: 'effort', label: 'Reasoning', type: 'select', options: [{ id: 'high', label: 'High', isDefault: true }] }] }
const claude: EngineModelView = { ...codex, instanceId: 'personal', accountName: 'Personal', driver: 'claude', slug: 'claude', name: 'Claude', options: [{ id: 'effort', label: 'Reasoning', type: 'select', options: [{ id: 'max', label: 'Max', isDefault: true }] }, { id: 'contextWindow', label: 'Context', type: 'select', options: [{ id: '1m', label: '1M', isDefault: true }] }] }
function engine(): EngineView { return { ...EMPTY_VIEW.engine, state: 'connected', models: [codex, claude], projects: [{ id: 'a', title: 'A', workspaceRoot: '/a', threads: [] }, { id: 'b', title: 'B', workspaceRoot: '/b', defaultModelSelection: { instanceId: 'personal', model: 'claude', options: [{ id: 'effort', value: 'max' }, { id: 'contextWindow', value: '1m' }] }, threads: [] }] } }
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
})
afterEach(() => vi.unstubAllGlobals())
it('uses the selected project defaults, including context options and its account', () => {
  expect(initialSelection(engine(), 'b')).toMatchObject({ model: 'claude', instanceId: 'personal', effort: 'max', options: [{ id: 'effort', value: 'max' }, { id: 'contextWindow', value: '1m' }] })
})
it('remembers settings per project and does not change another project', () => {
  rememberSelection('a', selectionForModel(claude, 'full-access'))
  expect(initialSelection(engine(), 'a')).toMatchObject({ model: 'claude', access: 'full-access' })
  expect(initialSelection(engine(), 'b')).toMatchObject({ access: 'approval-required' })
})
it('does not route saved settings to a now parked account', () => {
  rememberSelection('a', selectionForModel(claude, 'full-access'))
  const view = engine()
  view.accounts = [{ instanceId: 'personal', usable: false } as EngineView['accounts'][number]]
  expect(initialSelection(view, 'a').instanceId).toBe('work')
})
it('a model change resets options to those of the new model', () => {
  const next = selectionForModel(codex, 'auto-accept-edits')
  expect(next.options).toEqual([{ id: 'effort', value: 'high' }])
  expect(next.access).toBe('auto-accept-edits')
})
it('keeps drafts and partial-creation IDs separately and removes successful drafts', () => {
  writeDraft('unit:a', { text: 'Keep me', threadId: 'created' })
  writeDraft('unit:b', { text: 'Independent' })
  expect(readDraft('unit:a')).toEqual({ text: 'Keep me', threadId: 'created' })
  clearDraft('unit:a')
  expect(readDraft('unit:a').text).toBe('')
  expect(readDraft('unit:b').text).toBe('Independent')
  clearDraft('unit:b')
})
it('invalid storage and missing catalogs do not prevent opening a draft', () => {
  localStorage.setItem('stratamd.conversation-defaults.v1:a', '{broken')
  expect(initialSelection(engine(), 'a').model).toBe('codex')
  expect(availableModels({ ...EMPTY_VIEW.engine })).toEqual([])
})

it('migrates a draft saved with one text attachment into the attachment list', () => {
  localStorage.setItem('stratamd.conversation-draft.v1:thread:old', JSON.stringify({ text: 'Keep', attachment: { name: 'notes.md', text: '# Notes' } }))
  expect(readDraft('thread:old')).toEqual({ text: 'Keep', attachments: [{ kind: 'text', name: 'notes.md', text: '# Notes' }] })
})
it('reports when local storage refuses a draft, and the draft still reads back from memory', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') }, removeItem: () => undefined })
  expect(writeDraft('thread:full', { text: 'Big', attachments: [{ kind: 'image', id: 'a_1', name: 'shot.png', mimeType: 'image/png', sizeBytes: 5 }] })).toBe(false)
  expect(readDraft('thread:full').attachments).toHaveLength(1)
  expect(draftAttachmentIds()).toEqual(['a_1'])
  clearDraft('thread:full')
})
it('collects the staged image ids across every saved draft for the startup sweep', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null })
  expect(writeDraft('thread:a', { text: '', attachments: [{ kind: 'image', id: 'a_1', name: 'one.png', mimeType: 'image/png', sizeBytes: 5 }, { kind: 'text', name: 'n.md', text: 'x' }] })).toBe(true)
  localStorage.setItem('stratamd.conversation-draft.v1:thread:b', JSON.stringify({ text: 'saved elsewhere', attachments: [{ kind: 'image', id: 'a_2', name: 'two.png', mimeType: 'image/png', sizeBytes: 5 }] }))
  localStorage.setItem('stratamd.conversation-defaults.v1:p', JSON.stringify({ model: 'x' }))
  localStorage.setItem('stratamd.conversation-draft.v1:thread:c', '{not json')
  expect(draftAttachmentIds().toSorted()).toEqual(['a_1', 'a_2'])
  clearDraft('thread:a')
  expect(draftAttachmentIds()).toEqual(['a_2'])
})

it('keeps matching thread drafts and project defaults with their engine', () => {
  setEngineStorageIdentity('first')
  writeDraft('thread:collision', { text: 'Only first', threadId: 'collision' })
  rememberSelection('a', selectionForModel(claude, 'full-access'))
  setEngineStorageIdentity('second')
  expect(readDraft('thread:collision').text).toBe('')
  expect(initialSelection(engine(), 'a').instanceId).toBe('work')
  writeDraft('thread:collision', { text: 'Only second' })
  setEngineStorageIdentity('first')
  expect(readDraft('thread:collision').text).toBe('Only first')
  expect(initialSelection(engine(), 'a').instanceId).toBe('personal')
  clearDraft('thread:collision')
  setEngineStorageIdentity('second')
  expect(readDraft('thread:collision').text).toBe('Only second')
  clearDraft('thread:collision')
  setEngineStorageIdentity(undefined)
})
