import { useState } from 'react'
import type { EngineSettings, EngineView } from '../../shared/contracts'
import { StarIcon } from '../icons/lucide'

export function ProviderModels({ engine, instanceId, settings, onSaved }: { engine: EngineView; instanceId: string; settings: EngineSettings | null; onSaved(settings: EngineSettings): void }) {
  const [custom, setCustom] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const models = (engine.models ?? []).filter(model => model.instanceId === instanceId)
  const preference = async (slug: string, change: { favorite?: boolean; hidden?: boolean; order?: string[] }) => {
    try { setError(''); await window.strata.setModelPreference(instanceId, slug, change) } catch (error) { setError(String(error)) }
  }
  const move = (index: number, by: number) => {
    const order = models.map(model => model.slug)
    ;[order[index], order[index + by]] = [order[index + by]!, order[index]!]
    void preference(models[index]!.slug, { order })
  }
  const add = async () => {
    if (!settings || !custom.trim() || busy) return
    setBusy(true); setError('')
    try {
      const base = settings.providerInstances[instanceId]!
      const previous = Array.isArray(base.config?.customModels) ? base.config.customModels.filter((value): value is string => typeof value === 'string') : []
      await window.strata.editEngineProvider({ identity: settings.identity ?? null, instanceId, base, patch: { config: { customModels: [...new Set([...previous, custom.trim()])] } } })
      onSaved(await window.strata.readEngineSettings()); setCustom('')
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <>
    {error && <p role="alert" className="send-error">{error}</p>}
    {models.map((model, index) => <div key={model.slug} className="provider-model-row" data-hidden={model.hidden || undefined}>
      <span>{model.name}</span>
      <button type="button" className="quiet-button" aria-label={`Move ${model.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
      <button type="button" className="quiet-button" aria-label={`Move ${model.name} down`} disabled={index === models.length - 1} onClick={() => move(index, 1)}>↓</button>
      <button type="button" className="quiet-button" aria-label={`Favorite ${model.name}`} aria-pressed={model.favorite ?? false} onClick={() => void preference(model.slug, { favorite: !model.favorite })}><StarIcon fill={model.favorite ? 'currentColor' : 'none'} /></button>
      <button type="button" className="quiet-button" aria-label={`${model.hidden ? 'Show' : 'Hide'} ${model.name}`} onClick={() => void preference(model.slug, { hidden: !model.hidden })}>{model.hidden ? 'Show' : 'Hide'}</button>
    </div>)}
    <label className="setup-field">Custom model ID<input aria-label="Custom model ID" value={custom} onChange={event => setCustom(event.target.value)} /></label>
    <button type="button" className="quiet-button" disabled={busy || !settings || !custom.trim()} onClick={() => void add()}>Add custom model</button>
    <p className="engine-hint">Favorites, order, and visibility save in Strata. Custom models save on the engine.</p>
  </>
}
