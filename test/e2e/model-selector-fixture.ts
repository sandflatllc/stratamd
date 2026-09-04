import { DEFAULT_PROVIDERS } from './cockpit-engine-harness'

export function modelSelectorProviders() {
  const [gpt, claude] = DEFAULT_PROVIDERS as Array<Record<string, unknown>>
  const models = (base: Record<string, unknown>, entries: Array<[string, string]>) => {
    const original = (base.models as Array<Record<string, unknown>>)[0]!
    return entries.map(([slug, name], index) => ({ ...original, slug, name, isDefault: index === 0 }))
  }
  const gptModels = models(gpt!, [['gpt-6-astra', 'GPT-6-Astra'], ['gpt-5.6-sol', 'GPT-5.6-Sol'], ['gpt-5.6', 'GPT-5.6']])
  const claudeModels = models(claude!, [['claude-fable-5-1', 'Claude Fable 5.1'], ['claude-opus-5', 'Claude Opus 5'], ['claude-sonnet-5', 'Claude Sonnet 5'], ['claude-fable-5', 'Claude Fable 5']])
  return [
    { ...gpt, instanceId: 'codex', models: gptModels, displayName: 'GPT Work' },
    { ...gpt, instanceId: 'gpt-personal', models: gptModels, displayName: 'GPT Personal' },
    { ...claude, instanceId: 'claude-main', models: claudeModels, displayName: 'Claude Work' },
    { ...claude, instanceId: 'claude-personal', models: claudeModels, displayName: 'Claude Personal' },
  ]
}
