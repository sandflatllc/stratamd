import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { availableModels, clearDraft, initialSelection, readDraft, rememberSelection, selectionForModel, writeDraft } from '../../src/renderer/conversationDrafts'
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
