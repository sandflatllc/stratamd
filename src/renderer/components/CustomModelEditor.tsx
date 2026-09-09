import { useState } from 'react'
import type { EngineModelView } from '../../shared/contracts'
import { customModelSchema, customModelValues, editCustomModel, supportsOption, type CustomModel } from '../../shared/custom-models'
import { Switch } from './Switch'

export function CustomModelEditor({ model, entry, busy, onSave, onCancel }: { model: EngineModelView; entry: unknown; busy: boolean; onSave(value: CustomModel): void; onCancel(): void }) {
  const [name, setName] = useState(typeof entry === 'object' && entry !== null && 'name' in entry && typeof entry.name === 'string' ? entry.name : model.name)
  const [tab, setTab] = useState('Details')
  const [changes, setChanges] = useState<Record<string, string | boolean>>({})
  const parsed = customModelSchema.safeParse(entry)
  const storedOptions = parsed.success && typeof parsed.data !== 'string' ? parsed.data.capabilities?.optionDescriptors ?? [] : []
  const preserved = storedOptions.filter(value => !model.options.some(option => typeof value === 'object' && value !== null && 'id' in value && value.id === option.id)).length
  const values = { ...customModelValues(entry, model.options), ...changes }
  const invalid = model.options.find(option => values[option.id] !== undefined && !supportsOption(option, values[option.id]))
  return <section className="custom-model-editor" aria-label={`Edit ${model.name}`}>
    <h3>{name || model.slug}</h3>
    <div role="tablist" aria-label="Model details" className="setup-tabs">{['Details', 'Options'].map(value => <button key={value} type="button" role="tab" aria-selected={value === tab} onClick={() => setTab(value)}>{value}</button>)}</div>
    {tab === 'Details' ? <>
      <label className="setup-field">Display name<input aria-label="Model display name" maxLength={512} value={name} onChange={event => setName(event.target.value)} /><small>Shown in model lists and the composer.</small></label>
      <p className="custom-model-note">Provider ID: {model.slug}. Renaming does not change the model sent to the engine.</p>
    </> : <>
      {model.options.map(option => <div key={option.id} className="custom-model-option">
        {option.type === 'boolean' ? <Switch label={option.label} checked={values[option.id] === true} onChange={value => setChanges(current => ({ ...current, [option.id]: value }))} /> : <label className="setup-field">{option.label}<select aria-label={option.label} aria-invalid={values[option.id] !== undefined && !supportsOption(option, values[option.id])} value={typeof values[option.id] === 'string' ? values[option.id] as string : ''} onChange={event => setChanges(current => ({ ...current, [option.id]: event.target.value }))}>
          <option value="" disabled>Use provider default</option>
          {values[option.id] !== undefined && !supportsOption(option, values[option.id]) && <option value={String(values[option.id])} disabled>{String(values[option.id])} (unsupported)</option>}
          {option.options?.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
        </select><small>{option.description ?? 'Reported as supported by this provider.'}</small></label>}
      </div>)}
      {!model.options.length && <p className="engine-hint">This provider has not reported editable options for {model.slug}.</p>}
    </>}
    {invalid && <p role="alert" className="custom-model-invalid">Choose a supported value for {invalid.label} in Options.</p>}
      {tab === 'Options' && preserved > 0 && <p className="custom-model-note">{preserved === 1 ? 'One option from another client is preserved. This provider has not reported an editor for it.' : `${preserved} options from another client are preserved. This provider has not reported editors for them.`}</p>}
    <button type="button" className="primary-button" disabled={busy || !!invalid} onClick={() => onSave(editCustomModel(entry, model.slug, name, model.options, changes))}>Save model</button>
    <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>Back to models</button>
  </section>
}
