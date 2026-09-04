import { expect, it } from 'vitest'
import { continuationScope, flagshipModel, modelFamily, permitsSelection } from '../../src/shared/modelSelection'
import type { EngineModelView } from '../../src/shared/contracts'

const gpt = { instanceId: 'gpt-work', model: 'gpt-6-astra', driver: 'codex' }
const claude = { instanceId: 'claude-work', model: 'claude-fable-5-1', driver: 'claudeAgent' }
it('new drafts can choose either family and subscription', () => {
  expect(permitsSelection(undefined, gpt)).toBe(true)
  expect(permitsSelection(undefined, claude)).toBe(true)
})
it('GPT conversations permit another GPT subscription but never Claude', () => {
  const scope = continuationScope(gpt)
  expect(permitsSelection(scope, { ...gpt, instanceId: 'gpt-personal', model: 'gpt-5.6-sol' })).toBe(true)
  expect(permitsSelection(scope, claude)).toBe(false)
})
it('Claude conversations permit models only within their subscription', () => {
  const scope = continuationScope(claude)
  expect(permitsSelection(scope, { ...claude, model: 'claude-sonnet-5' })).toBe(true)
  expect(permitsSelection(scope, { ...claude, instanceId: 'claude-personal' })).toBe(false)
  expect(permitsSelection(scope, gpt)).toBe(false)
})
it('missing metadata still locks a known Claude model, and unknown providers keep their subscription', () => {
  expect(modelFamily(undefined, 'claude-fable-5-1')).toBe('claude')
  expect(continuationScope({ instanceId: 'private', model: 'custom' }).instanceId).toBe('private')
  expect(modelFamily('claudeAgent', 'custom-alias')).toBe('claude')
})
it('daily flagships win over catalog order and older defaults', () => {
  const model = (slug: string, isDefault = false): EngineModelView => ({ slug, name: slug, driver: 'claudeAgent', instanceId: 'work', accountName: 'Work', options: [], isDefault })
  expect(flagshipModel([model('claude-opus-5', true), model('claude-fable-5'), model('claude-fable-5-1')])?.slug).toBe('claude-fable-5-1')
  expect(flagshipModel([model('gpt-5.6-sol', true), model('gpt-6-astra')])?.slug).toBe('gpt-6-astra')
  expect(flagshipModel([model('custom-old'), model('custom-default', true)])?.slug).toBe('custom-default')
  expect(flagshipModel([])).toBeUndefined()
})
