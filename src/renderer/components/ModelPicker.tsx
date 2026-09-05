import type { AccountView, EngineModelView } from '../../shared/contracts'
import { familyLabel, flagshipModel, modelDesignation, modelFamily, type ModelScope } from '../../shared/modelSelection'
import { hasProviderGlyph, ProviderGlyph } from './ProviderGlyph'
import type { ComposerSelection } from '../conversationDrafts'

interface ModelPickerProps {
  models: EngineModelView[]
  accounts: AccountView[]
  selection: ComposerSelection
  scope?: ModelScope | undefined
  onSelect(model: EngineModelView, close: boolean): void
}

/** Families and subscriptions narrow the catalog before any model choices are rendered. */
export function ModelPicker({ models, accounts, selection, scope, onSelect }: ModelPickerProps) {
  models = models.filter(model => !model.hidden || model.instanceId === selection.instanceId && model.slug === selection.model).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite))
  const current = models.find(model => model.instanceId === selection.instanceId && model.slug === selection.model)
  const family = scope?.family ?? modelFamily(current?.driver, selection.model)
  const families = [...new Set(models.map(model => modelFamily(model.driver, model.slug)))]
  const familyModels = models.filter(model => modelFamily(model.driver, model.slug) === family)
  const subscriptions = [...new Map(familyModels.map(model => [model.instanceId, { id: model.instanceId, name: model.accountName }])).values()]
  const subscriptionModels = familyModels.filter(model => model.instanceId === selection.instanceId)
  const flagship = flagshipModel(subscriptionModels)
  const favorites = subscriptionModels.filter(model => model.favorite && model !== flagship)
  const others = subscriptionModels.filter(model => model !== flagship && !model.favorite)
  const usable = (id: string) => accounts.find(account => account.instanceId === id)?.usable !== false
  const accountName = accounts.find(account => account.instanceId === selection.instanceId)?.name ?? current?.accountName ?? selection.instanceId
  const chooseFamily = (nextFamily: string) => {
    const candidates = models.filter(model => modelFamily(model.driver, model.slug) === nextFamily && usable(model.instanceId))
    const next = flagshipModel(candidates)
    if (next) onSelect(next, false)
  }
  const chooseSubscription = (instanceId: string) => {
    const candidates = familyModels.filter(model => model.instanceId === instanceId)
    const next = candidates.find(model => model.slug === selection.model) ?? flagshipModel(candidates)
    if (next) onSelect(next, false)
  }
  return <div className="model-picker">
    {scope ? <div className="model-picker-fixed"><span>Model family</span><strong>{hasProviderGlyph(undefined, family) ? <ProviderGlyph family={family} label={familyLabel(family)} /> : familyLabel(family)}</strong></div> :
      <fieldset className="model-picker-families"><legend>Model family</legend><div>{families.map(value =>
        <button type="button" key={value} aria-pressed={family === value} disabled={!models.some(model => modelFamily(model.driver, model.slug) === value && usable(model.instanceId))} onClick={() => chooseFamily(value)} aria-label={familyLabel(value)} title={familyLabel(value)}>{hasProviderGlyph(undefined, value) ? <ProviderGlyph family={value} /> : familyLabel(value)}</button>
      )}</div></fieldset>}
    {scope?.instanceId ? <div className="model-picker-fixed"><span>Subscription</span><strong>{accountName}</strong></div> :
      <label className="model-picker-subscription">Subscription<select aria-label="Subscription" value={selection.instanceId ?? ''} onChange={event => chooseSubscription(event.target.value)}>
        {!subscriptions.some(subscription => subscription.id === selection.instanceId) && <option value={selection.instanceId ?? ''}>{accountName ?? 'Choose subscription'}</option>}
        {subscriptions.map(subscription => <option key={subscription.id} value={subscription.id} disabled={!usable(subscription.id)}>{subscription.name}{usable(subscription.id) ? '' : ' · Unavailable'}</option>)}
      </select></label>}
    <div className="model-picker-models"><span className="model-picker-label">Model</span>
      {favorites.map(model => <button type="button" key={model.slug} className="model-picker-flagship" aria-label={`Use ${model.name}`} aria-pressed={current === model} disabled={!usable(model.instanceId)} onClick={() => onSelect(model, true)}><strong><ProviderGlyph driver={model.driver} />{modelDesignation(model)}</strong><small>Favorite</small></button>)}
      {flagship && <button type="button" className="model-picker-flagship" aria-label={`Use ${flagship.name}`} aria-pressed={current === flagship} disabled={!usable(flagship.instanceId)} onClick={() => onSelect(flagship, true)}><strong><ProviderGlyph driver={flagship.driver} />{modelDesignation(flagship)}</strong><small>Daily model</small></button>}
      {others.length > 0 && <details className="model-picker-others" key={selection.instanceId}><summary>Other models <small>{current && current !== flagship ? modelDesignation(current) : `${others.length} available`}</small></summary><div role="group" aria-label="Other models">{others.map(model =>
        <button type="button" key={model.slug} aria-label={model.name} aria-pressed={current === model} disabled={!usable(model.instanceId)} onClick={() => onSelect(model, true)}><ProviderGlyph driver={model.driver} />{modelDesignation(model)}</button>
      )}</div></details>}
      {!flagship && <p>No models are available for this subscription.</p>}
    </div>
  </div>
}
