import { expect, it } from 'vitest'
import { deriveInstanceId, validProviderInstanceId, providerConfigFields } from '../../src/core/provider-instance'
import { normalizeAccountsStore } from '../../src/main/engine/accounts'

it('matches t3 instance naming and rejects invalid or oversized identifiers', () => {
  expect(deriveInstanceId('claudeAgent', ' My Work! ')).toBe('claudeAgent_my_work')
  expect(deriveInstanceId('codex', '---')).toBe('')
  expect(validProviderInstanceId('codex_work-2')).toBe(true)
  for (const id of ['', '2codex', 'codex.work', 'codex work', 'a'.repeat(65)]) expect(validProviderInstanceId(id)).toBe(false)
  expect(validProviderInstanceId(deriveInstanceId('claudeAgent', 'a'.repeat(90)))).toBe(true)
})
it('exposes only configuration supported by the driver', () => {
  expect(providerConfigFields('codex').map(field => field.key)).toEqual(['binaryPath', 'homePath', 'shadowHomePath', 'launchArgs'])
  expect(providerConfigFields('cursor').map(field => field.key)).toEqual(['binaryPath', 'apiEndpoint'])
})
it('reads legacy stores and filters damaged model preferences', () => {
  expect(normalizeAccountsStore({ formatVersion: 1 }).modelPreferences).toBeUndefined()
  expect(normalizeAccountsStore({ formatVersion: 1, modelPreferences: { codex: { favorites: ['model', 2], hidden: ['other'] }, broken: null } }).modelPreferences).toEqual({ codex: { favorites: ['model'], hidden: ['other'], order: [] } })
})
