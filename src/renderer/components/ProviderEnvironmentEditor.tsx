import type { ProviderEnvironment } from '../../shared/engine-settings'
import { Switch } from './Switch'

export function ProviderEnvironmentEditor({ rows, onChange }: { rows: ProviderEnvironment[]; onChange(rows: ProviderEnvironment[]): void }) {
  const update = (index: number, patch: Partial<ProviderEnvironment>) => onChange(rows.map((row, current) => current === index ? { ...row, ...patch } : row))
  return <section aria-label="Environment variables" className="provider-environment">
    <h3>Environment variables</h3>
    <p className="engine-hint">Saved secrets stay hidden. Replace changes a secret; Remove deletes its entry.</p>
    {rows.map((row, index) => <fieldset key={index} className="setup-fields">
      <label className="setup-field">Name<input aria-label={`Variable ${index + 1} name`} value={row.name} disabled={row.valueRedacted === true} onChange={event => update(index, { name: event.target.value })} /></label>
      {row.valueRedacted ? <div><span>Saved secret</span> <button type="button" className="quiet-button" onClick={() => update(index, { value: '', valueRedacted: false })}>Replace {row.name}</button></div> : <label className="setup-field">Value<input aria-label={`Variable ${index + 1} value`} type={row.sensitive ? 'password' : 'text'} autoComplete="off" value={row.value} onChange={event => update(index, { value: event.target.value })} /></label>}
      <Switch label={`Secret ${row.name || index + 1}`} checked={row.sensitive} disabled={row.valueRedacted === true} onChange={sensitive => update(index, { sensitive })} />
      <button type="button" className="quiet-button" onClick={() => onChange(rows.filter((_, current) => current !== index))}>Remove {row.name || `variable ${index + 1}`}</button>
    </fieldset>)}
    <button type="button" className="quiet-button" onClick={() => onChange([...rows, { name: '', value: '', sensitive: false }])}>Add environment variable</button>
  </section>
}
