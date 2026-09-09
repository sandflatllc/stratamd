import { expect, it } from 'vitest'
import { defaultOptions } from '../../src/renderer/conversationDrafts'
import { editCustomModel, customModelValues } from '../../src/shared/custom-models'
import { mergeProviderEdit } from '../../src/shared/engine-settings'
import type { ModelOptionDescriptor } from '../../src/shared/contracts'

const descriptor: ModelOptionDescriptor = { id: 'effort', label: 'Reasoning effort', type: 'select', options: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] }
it('preserves mixed entries and unknown model, capability, choice and configuration fields on rename and option edits', () => {
  const entry = { slug: 'reviewer', name: 'Old', future: { keep: true }, capabilities: { future: 9, optionDescriptors: [{ ...descriptor, currentValue: 'high', promptInjectedValues: ['high'], future: true }, { id: 'unknown', type: 'future', payload: 123 }] } }
  const base = { driver: 'codex', config: { future: 7, customModels: ['legacy', entry] } }
  const renamed = editCustomModel(entry, 'reviewer', 'Inspection reviewer', [descriptor], {})
  expect(renamed).toEqual({ ...entry, name: 'Inspection reviewer' })
  const edited = editCustomModel(renamed, 'reviewer', 'Inspection reviewer', [descriptor], { effort: 'low' })
  const settings = mergeProviderEdit({ providerInstances: { codex: base } }, { identity: null, instanceId: 'codex', base, patch: { config: { customModels: ['legacy', edited] } } })
  expect(settings.codex?.config).toEqual({ future: 7, customModels: ['legacy', { ...entry, name: 'Inspection reviewer', capabilities: { ...entry.capabilities, optionDescriptors: [{ ...entry.capabilities.optionDescriptors[0], currentValue: 'low' }, entry.capabilities.optionDescriptors[1]] } }] })
  expect(() => editCustomModel(entry, 'reviewer', 'Old', [descriptor], { effort: 'invented' })).toThrow('supported value')
  expect(() => editCustomModel(entry, 'reviewer', 'Old', [descriptor], { unsupported: true })).toThrow('supported value')
  expect(customModelValues(entry, [descriptor])).toEqual({ effort: 'high' })
  const concurrent = { ...base, config: { ...base.config, customModels: [...base.config.customModels, 'added-elsewhere'] } }
  expect(() => mergeProviderEdit({ providerInstances: { codex: concurrent } }, { identity: null, instanceId: 'codex', base, patch: { config: { customModels: ['legacy', edited] } } })).toThrow('changed in another client')
})

it('never uses an unsupported provider currentValue as a turn default', () => {
  const model = { instanceId: 'work', accountName: 'Work', driver: 'codex', slug: 'reviewer', name: 'Reviewer', options: [{ ...descriptor, currentValue: 'unknown', options: [{ id: 'high', label: 'High', isDefault: true }] }] }
  expect(defaultOptions(model)).toEqual([{ id: 'effort', value: 'high' }])
})
