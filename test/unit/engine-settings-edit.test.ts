import { expect, it } from 'vitest'
import { effectiveProviderInstances, mergeEngineSettings, mergeProviderEdit } from '../../src/shared/engine-settings'
import type { EngineSettings } from '../../src/shared/contracts'

it('preserves other clients changes and unknown nested fields, while rejecting an edited-field conflict', () => {
  const base: EngineSettings = { providerInstances: {}, sourceControlWritingStyle: { mode: 'repo_conventions', customInstructions: '', future: 'keep' } }
  const current = { ...base, sourceControlWritingStyle: { ...base.sourceControlWritingStyle as object, customInstructions: 'From phone' } }
  expect(mergeEngineSettings(current, { identity: 'one', base, patch: { sourceControlWritingStyle: { mode: 'custom' } } })).toEqual({ sourceControlWritingStyle: { mode: 'custom', customInstructions: 'From phone', future: 'keep' } })
  expect(() => mergeEngineSettings(current, { identity: 'one', base, patch: { sourceControlWritingStyle: { customInstructions: 'Mine' } } })).toThrow('changed in another client')
  expect(() => mergeEngineSettings(base, { identity: 'one', base, patch: { sidebarAutoSettleOnMerge: false } })).toThrow('does not support')
})

it('materializes every legacy provider and preserves masked secrets on unrelated edits', () => {
  const legacy: EngineSettings = { providerInstances: {}, providers: { codex: { enabled: true, binaryPath: '', unknown: 12 }, claudeAgent: { enabled: false, homePath: '/isolated' } } }
  const base = effectiveProviderInstances(legacy).codex!
  const next = mergeProviderEdit(legacy, { identity: 'one', instanceId: 'codex', base, patch: { displayName: 'Work' } })
  expect(next.claudeAgent).toMatchObject({ driver: 'claudeAgent', enabled: false, config: { homePath: '/isolated' } })
  expect(next.codex?.config).toEqual({ binaryPath: '', unknown: 12 })
  const secret = { name: 'API_KEY', value: '', sensitive: true, valueRedacted: true }
  const saved = { driver: 'codex', environment: [secret], config: { future: 'kept' } }
  const settings = { providerInstances: { work: saved } }
  const renamed = mergeProviderEdit(settings, { identity: 'one', instanceId: 'work', base: saved, patch: { displayName: 'Renamed' } })
  expect(renamed.work?.environment).toEqual([secret])
  const replaced = mergeProviderEdit(settings, { identity: 'one', instanceId: 'work', base: saved, patch: { environment: [{ ...secret, value: 'new test value', valueRedacted: false }] } })
  expect(replaced.work?.environment?.[0]).toMatchObject({ valueRedacted: false, value: 'new test value' })
  expect(mergeProviderEdit(settings, { identity: 'one', instanceId: 'work', base: saved, patch: { environment: [] } }).work?.environment).toEqual([])
  expect(() => mergeProviderEdit(settings, { identity: 'one', instanceId: 'work', base: null, patch: { driver: 'codex' } })).toThrow('already exists')
})

it('clears only the requested inherited override and preserves future fields', () => {
  const base: EngineSettings = { providerInstances: {}, backgroundActivity: { schemaVersion: 1, profile: 'custom', overrides: { providerHealthRefreshInterval: 1000, futureNullable: null, futureSetting: 12 } } }
  const patch = mergeEngineSettings(base, { identity: null, base, patch: { backgroundActivity: { overrides: { providerHealthRefreshInterval: null } } } })
  expect(patch.backgroundActivity?.overrides).toEqual({ futureNullable: null, futureSetting: 12 })
})
