import { useState } from 'react'
import type { EngineSettings, EngineView, EngineModelView } from '../../shared/contracts'
import { customModelId, type CustomModel } from '../../shared/custom-models'
import { CustomModelEditor } from './CustomModelEditor'
import { StarIcon } from '../icons/lucide'

export function ProviderModels({ engine, instanceId, settings, onSaved }: { engine: EngineView; instanceId: string; settings: EngineSettings | null; onSaved(settings: EngineSettings): void }) {
  const [custom, setCustom] = useState('')
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const base = settings?.providerInstances[instanceId]
  const previous = Array.isArray(base?.config?.customModels) ? base.config.customModels : []
  const models: EngineModelView[] = (engine.models ?? []).filter(model => model.instanceId === instanceId)
  for (const entry of previous) {
    const slug = customModelId(entry)
    if (!slug || models.some(model => model.slug === slug)) continue
    const name = typeof entry === 'object' && entry !== null && 'name' in entry && typeof entry.name === 'string' ? entry.name : slug
    models.push({ instanceId, accountName: instanceId, driver: base?.driver ?? '', slug, name, options: [] })
  }
  const preference = async (slug: string, change: { favorite?: boolean; hidden?: boolean; order?: string[] }) => {
    try { setError(''); await window.strata.setModelPreference(instanceId, slug, change) } catch (error) { setError(String(error)) }
  }
  const move = (index: number, by: number) => {
    const order = models.map(model => model.slug)
    ;[order[index], order[index + by]] = [order[index + by]!, order[index]!]
    void preference(models[index]!.slug, { order })
  }
  const saveModel = async (value: CustomModel) => {
    if (!settings || !base || busy) return
    setBusy(true); setError('')
    try {
      const slug = customModelId(value)
      const found = previous.some(item => customModelId(item) === slug)
      const customModels = found ? previous.map(item => customModelId(item) === slug ? value : item) : [...previous, value]
      await window.strata.editEngineProvider({ identity: settings.identity ?? null, instanceId, base, patch: { config: { customModels } } })
      onSaved(await window.strata.readEngineSettings()); setEditing(null)
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  const add = async () => {
    if (!settings || !custom.trim() || busy) return
    setBusy(true); setError('')
    try {
      const base = settings.providerInstances[instanceId]!
      if (previous.some(value => customModelId(value) === custom.trim())) throw new Error(`Custom model ${custom.trim()} already exists. Use Edit to change it.`)
      await window.strata.editEngineProvider({ identity: settings.identity ?? null, instanceId, base, patch: { config: { customModels: [...previous, name.trim() ? { slug: custom.trim(), name: name.trim() } : custom.trim()] } } })
      onSaved(await window.strata.readEngineSettings()); setCustom(''); setName('')
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  const selected = models.find(model => model.slug === editing)
  if (selected) return <>{error && <p role="alert" className="send-error">{error}</p>}<CustomModelEditor key={selected.slug} model={selected} entry={previous.find(value => customModelId(value) === selected.slug)} busy={busy} onSave={value => void saveModel(value)} onCancel={() => { setEditing(null); setError('') }} /></>
  return <>
    {error && <p role="alert" className="send-error">{error}</p>}
    {models.map((model, index) => <div key={model.slug} className="provider-model-row" data-hidden={model.hidden || undefined}>
      <span>{model.name}</span>
      <button type="button" className="quiet-button" aria-label={`Move ${model.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
      <button type="button" className="quiet-button" aria-label={`Move ${model.name} down`} disabled={index === models.length - 1} onClick={() => move(index, 1)}>↓</button>
      <button type="button" className="quiet-button" aria-label={`Favorite ${model.name}`} aria-pressed={model.favorite ?? false} onClick={() => void preference(model.slug, { favorite: !model.favorite })}><StarIcon fill={model.favorite ? 'currentColor' : 'none'} /></button>
      <button type="button" className="quiet-button" aria-label={`${model.hidden ? 'Show' : 'Hide'} ${model.name}`} onClick={() => void preference(model.slug, { hidden: !model.hidden })}>{model.hidden ? 'Show' : 'Hide'}</button>
      <button type="button" className="quiet-button" aria-label={`Edit ${model.name}`} onClick={() => { setEditing(model.slug); setError('') }}>Edit</button>
    </div>)}
    <label className="setup-field">Custom model ID<input aria-label="Custom model ID" value={custom} onChange={event => setCustom(event.target.value)} /></label>
    <label className="setup-field">Display name<input aria-label="Custom model display name" maxLength={512} value={name} onChange={event => setName(event.target.value)} /><small>Shown in Strata. The provider still receives {custom.trim() || 'the model ID'}.</small></label>
    <button type="button" className="quiet-button" disabled={busy || !settings || !custom.trim()} onClick={() => void add()}>Add custom model</button>
    <p className="engine-hint">Favorites, order, and visibility save in Strata. Custom models save on the engine.</p>
  </>
}
