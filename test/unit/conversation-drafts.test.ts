import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { availableModels, clearDraft, clearDraftContent, draftAttachmentIds, draftSelection, flushDrafts, initialSelection, onDraftStorage, readDraft, rememberedSelection, rememberSelection, selectionForModel, writeDraft } from '../../src/renderer/conversationDrafts'
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
it('sending clears content and delivery IDs but keeps settings through storage reload', () => {
  const selection = { ...selectionForModel(codex, 'full-access'), options: [{ id: 'reasoningEffort', value: 'high' }] }
  writeDraft('thread:sent', { text: 'Send this', selection, messageId: 'old-message', threadId: 'old-thread', attachments: [{ kind: 'text', name: 'note', text: 'bytes' }] })
  expect(clearDraftContent('thread:sent', selection)).toBe(true)
  const persisted = localStorage.getItem('stratamd.conversation-draft.v1:thread:sent')!
  clearDraft('thread:sent')
  localStorage.setItem('stratamd.conversation-draft.v1:thread:sent', persisted)
  expect(readDraft('thread:sent')).toEqual({ text: '', selection })
  localStorage.removeItem('stratamd.conversation-draft.v1:thread:sent')
})
it('opens a composer on the draft selection only while it is available, usable, and still the thread\'s own', () => {
  const view = engine()
  const draftPick = selectionForModel(codex, 'full-access')
  const threadPick = selectionForModel(claude, 'approval-required')
  // A new-conversation draft keeps its selection while the model is available on a usable account.
  expect(draftSelection(view, { text: '', selection: draftPick }, threadPick, false)).toEqual(draftPick)
  // A thread draft with no record of the thread's selection cannot prove it is current: the thread wins.
  expect(draftSelection(view, { text: '', selection: draftPick }, threadPick, true)).toEqual(threadPick)
  // Written against the thread's current selection, the owner's unsent change survives; option order does not matter.
  expect(draftSelection(view, { text: '', selection: draftPick, selectionBase: threadPick }, threadPick, true)).toEqual(draftPick)
  const reordered = { ...threadPick, options: [{ id: 'b', value: true }, { id: 'a', value: 'x' }] }
  expect(draftSelection(view, { text: '', selection: draftPick, selectionBase: { ...threadPick, options: [{ id: 'a', value: 'x' }, { id: 'b', value: true }] } }, reordered, true)).toEqual(draftPick)
  // The thread's selection changed since the draft was written: the thread wins.
  expect(draftSelection(view, { text: '', selection: draftPick, selectionBase: threadPick }, { ...threadPick, effort: 'low' }, true)).toEqual({ ...threadPick, effort: 'low' })
  // A parked account or a model the engine no longer lists falls back to the thread or project selection.
  const parked = engine()
  parked.accounts = [{ instanceId: 'work', usable: false } as EngineView['accounts'][number]]
  expect(draftSelection(parked, { text: '', selection: draftPick }, threadPick, false)).toEqual(threadPick)
  expect(draftSelection({ ...view, models: [claude] }, { text: '', selection: draftPick }, threadPick, false)).toEqual(threadPick)
})
it('preserves compatible model options and restores each account independently', () => {
  const model: EngineModelView = { ...codex, options: [{ id: 'reasoningEffort', label: 'Reasoning', type: 'select', options: [{ id: 'medium', label: 'Medium', isDefault: true }, { id: 'high', label: 'High' }] }] }
  const high = { ...selectionForModel(model, 'full-access'), effort: 'high', options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'unsupported', value: true }] }
  rememberSelection('a', high)
  rememberSelection('a', selectionForModel({ ...model, instanceId: 'other' }, 'full-access'))
  const same = selectionForModel(model, 'full-access', high)
  expect(same).toMatchObject({ effort: 'high', options: [{ id: 'reasoningEffort', value: 'high' }] })
  expect(selectionForModel({ ...model, slug: 'another-model' }, 'full-access', high).effort).toBe('high')
  expect(selectionForModel(model, 'full-access', rememberedSelection('a', model.instanceId)).effort).toBe('high')
  expect(selectionForModel({ ...model, instanceId: 'other' }, 'full-access', high).effort).toBe('medium')
  expect(selectionForModel({ ...model, options: [{ ...model.options[0]!, options: [{ id: 'medium', label: 'Medium', isDefault: true }] }] }, 'full-access', high).effort).toBe('medium')
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
  const outcomes: Array<[string, boolean]> = []
  const stop = onDraftStorage((key, stored) => outcomes.push([key, stored]))
  writeDraft('thread:full', { text: 'Big', attachments: [{ kind: 'image', id: 'a_1', name: 'shot.png', mimeType: 'image/png', sizeBytes: 5 }] })
  expect(flushDrafts()).toBe(false)
  expect(outcomes).toEqual([['thread:full', false]])
  expect(writeDraft('thread:full', { text: 'Bigger' })).toBe(false)
  expect(readDraft('thread:full').text).toBe('Bigger')
  clearDraft('thread:full')
  stop()
  expect(writeDraft('thread:full', { text: 'Big', attachments: [{ kind: 'image', id: 'a_1', name: 'shot.png', mimeType: 'image/png', sizeBytes: 5 }] }, { immediate: true })).toBe(false)
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
it('coalesces durable writes while typing and flushes them on demand', () => {
  const written: string[] = []
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: (_key: string, value: string) => { written.push(value) }, removeItem: () => undefined })
  writeDraft('thread:typing', { text: 'a' })
  writeDraft('thread:typing', { text: 'ab' })
  writeDraft('thread:typing', { text: 'abc' })
  expect(readDraft('thread:typing').text).toBe('abc')
  expect(written).toEqual([])
  expect(flushDrafts()).toBe(true)
  expect(written.map((value) => JSON.parse(value).text)).toEqual(['abc'])
  expect(flushDrafts()).toBe(true)
  expect(written).toHaveLength(1)
  clearDraft('thread:typing')
})
