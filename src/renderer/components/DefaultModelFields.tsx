import type { EngineView } from '../../shared/contracts'
import type { GeneratedModel } from '../../shared/engine-settings'
import { selectionForModel } from '../conversationDrafts'
import { Switch } from './Switch'

export function DefaultModelFields({ engine, value, onChange, project = false }: { engine: EngineView; value: GeneratedModel; onChange(value: GeneratedModel): void; project?: boolean }) {
  const models = engine.models ?? []
  const model = models.find(model => model.instanceId === value.instanceId && model.slug === value.model)
  const choose = (instanceId: string, slug?: string) => {
    const next = models.find(model => model.instanceId === instanceId && (!slug || model.slug === slug))
    if (!next) return
    const selected = selectionForModel(next, 'approval-required')
    onChange({ instanceId, model: next.slug, options: selected.options ?? [] })
  }
  const fields = <><label className="setup-field defaults-field">Default account<select aria-label={project ? 'Project account' : 'Default account'} value={value.instanceId} onChange={event => choose(event.target.value)}>{engine.accounts.filter(account => models.some(model => model.instanceId === account.instanceId)).map(account => <option key={account.instanceId} value={account.instanceId}>{account.name}</option>)}</select></label><label className="setup-field defaults-field">Default model<select aria-label={project ? 'Project model' : 'Default model'} value={value.model} onChange={event => choose(value.instanceId, event.target.value)}>{models.filter(model => model.instanceId === value.instanceId).map(model => <option key={model.slug} value={model.slug}>{model.name}</option>)}</select></label></>
  return <>{project ? <details className="defaults-model-change"><summary>Change account and model</summary>{fields}</details> : fields}{model?.options.map(option => {
    const selected = value.options?.find(value => value.id === option.id)?.value ?? option.currentValue ?? option.options?.find(value => value.isDefault)?.id
    const label = ['effort', 'reasoningEffort'].includes(option.id) ? 'Thinking' : option.label
    const change = (selected: string | boolean) => onChange({ ...value, options: [...(value.options ?? []).filter(value => value.id !== option.id), { id: option.id, value: selected }] })
    return option.type === 'boolean' ? <Switch key={option.id} label={label} checked={selected === true} onChange={change} /> : <label className="setup-field defaults-field" key={option.id}>{label}<select aria-label={project ? `Project ${label.toLowerCase()}` : label} value={typeof selected === 'string' ? selected : ''} onChange={event => change(event.target.value)}><option value="" disabled>Model default</option>{option.options?.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
  })}</>
}
