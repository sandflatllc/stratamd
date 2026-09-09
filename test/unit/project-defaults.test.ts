import { expect, it } from 'vitest'
import { checkedInEnvironment, effectiveDefaults, mergeProjectDefaults, type ProjectDefaults } from '../../src/shared/project-defaults'
const base: ProjectDefaults = { identity: 'engine', projectId: 'p1', defaultModelSelection: null, defaultThreadEnvMode: null, checkedIn: 'worktree', computerModel: { instanceId: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'high' }] }, computerEnvironment: 'local' }
it('resolves project, checked-in and computer defaults and resets back to inheritance', () => {
  expect(effectiveDefaults(base)).toMatchObject({ environment: 'worktree', environmentSource: 'Inherited from t3.json', model: base.computerModel })
  expect(effectiveDefaults({ ...base, defaultThreadEnvMode: 'local' })).toMatchObject({ environment: 'local', environmentSource: 'Project override' })
  expect(effectiveDefaults({ ...base, checkedIn: null })).toMatchObject({ environment: 'local', environmentSource: 'Inherited from computer' })
  const override = { defaultModelSelection: { instanceId: 'claude', model: 'opus' }, defaultThreadEnvMode: 'local' as const }
  const reset = mergeProjectDefaults(override, { identity: 'engine', projectId: 'p1', base: override, patch: { defaultModelSelection: null, defaultThreadEnvMode: null } })
  expect(effectiveDefaults({ ...base, ...reset })).toEqual(effectiveDefaults(base))
})
it('treats malformed, truncated and schema-invalid project files as absent and accepts upstream JSONC', () => {
  for (const contents of ['{', '{"defaultThreadEnvMode":"remote"}', '{"defaultThreadEnvMode":"worktree","scripts":false}', '{"defaultThreadEnvMode":"worktree","scripts":[{"name":"bad"}]}']) expect(checkedInEnvironment(contents)).toBeNull()
  expect(checkedInEnvironment('{"defaultThreadEnvMode":"worktree"}', true)).toBeNull()
  expect(checkedInEnvironment('// repository defaults\n{"defaultThreadEnvMode":"worktree", "unknown":"https://example.com",}')).toBe('worktree')
})
it('refuses changed edited values and sends only edited fields while retaining unknown model metadata', () => {
  expect(() => mergeProjectDefaults({ defaultThreadEnvMode: 'worktree' }, { identity: 'engine', projectId: 'p1', base: { defaultThreadEnvMode: null }, patch: { defaultThreadEnvMode: 'local' } })).toThrow('changed in another client')
  const current = { defaultModelSelection: { instanceId: 'codex', model: 'gpt', options: [], future: 'preserved' }, defaultThreadEnvMode: 'worktree' as const }
  expect(mergeProjectDefaults(current, { identity: 'engine', projectId: 'p1', base: current, patch: { defaultModelSelection: { instanceId: 'codex', model: 'gpt', options: [{ id: 'effort', value: 'high' }] } } })).toEqual({ defaultModelSelection: { ...current.defaultModelSelection, options: [{ id: 'effort', value: 'high' }] } })
})
