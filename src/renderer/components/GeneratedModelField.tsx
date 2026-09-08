import type { EngineView } from '../../shared/contracts'
import type { GeneratedModel } from '../../shared/engine-settings'
import { selectionForModel } from '../conversationDrafts'
import { ModelPicker } from './ModelPicker'
import { Switch } from './Switch'

export function GeneratedModelField({ label, engine, value, onChange }: { label: string; engine: EngineView; value: GeneratedModel; onChange(value: GeneratedModel): void }) {
  const model = engine.models?.find(model => model.instanceId === value.instanceId && model.slug === value.model)
  const account = engine.accounts.find(account => account.instanceId === value.instanceId)
  const setOption = (id: string, selected: string | boolean) => onChange({ ...value, options: [...(value.options ?? []).filter(option => option.id !== id), { id, value: selected }] })
  return <section aria-label={label} className="settings-model">
    <details><summary>{label} <small>{account?.name ?? value.instanceId} · {model?.name ?? value.model}</small></summary>
      <ModelPicker models={engine.models ?? []} accounts={engine.accounts} selection={{ ...value, options: value.options ?? [], effort: null, access: 'approval-required' }} onSelect={next => {
        const selected = selectionForModel(next, 'approval-required')
        onChange({ instanceId: next.instanceId, model: next.slug, options: selected.options ?? [] })
      }} />
    </details>
    {model?.options.map(option => {
      const selected = value.options?.find(value => value.id === option.id)?.value ?? option.currentValue ?? option.options?.find(value => value.isDefault)?.id
      return option.type === 'boolean' ? <Switch key={option.id} label={`${label} ${option.label}`} checked={selected === true} onChange={value => setOption(option.id, value)} /> : <label key={option.id} className="setup-field">{option.label}<select aria-label={`${label} ${option.label}`} value={typeof selected === 'string' ? selected : ''} onChange={event => setOption(option.id, event.target.value)}><option value="" disabled>Choose {option.label.toLowerCase()}</option>{option.options?.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
    })}
    {account && !(account.providerReady ?? account.usable) && <p className="engine-hint">This account is not ready. Choose a ready account here or open Usage Limits to repair its sign-in.</p>}
  </section>
}
