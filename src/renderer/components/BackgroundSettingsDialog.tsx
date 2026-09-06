import { useState } from 'react'
import { isSettingsRecord, type EngineSettingsPatch } from '../../shared/engine-settings'
import { SetupDialog } from './SetupDialog'
import { Switch } from './Switch'

const intervals = [['automaticGitFetchInterval', 'Git fetch interval'], ['providerHealthRefreshInterval', 'Provider health interval'], ['hostPowerMonitorActiveInterval', 'Active host power interval'], ['hostPowerMonitorIdleInterval', 'Idle host power interval']] as const
const pauses = [['pauseWhenHostLocked', 'Pause when locked'], ['pauseWhenHostLowPower', 'Pause when host is in low power mode'], ['pauseWhenClientLowPower', 'Pause when client is in low power mode'], ['pauseWhenOnBattery', 'Pause on battery']] as const
export function BackgroundSettingsDialog({ activity, onApply, onBack, onClose }: { activity: unknown; onApply(change: EngineSettingsPatch): void; onBack(): void; onClose(): void }) {
  const current = isSettingsRecord(activity) ? activity : {}
  const initialOverrides = isSettingsRecord(current.overrides) ? current.overrides : {}
  const [base, setBase] = useState(String(current.baseProfile ?? (current.profile === 'custom' ? 'balanced' : current.profile ?? 'balanced')))
  const [changes, setChanges] = useState<Record<string, unknown>>({})
  const overrides = { ...initialOverrides, ...changes }
  const change = (key: string, value: unknown) => setChanges(current => ({ ...current, [key]: value }))
  return <SetupDialog title="Background activity" subtitle="These settings control background checks. Active conversations keep running." onClose={onClose} back={{ label: 'Settings', action: onBack }} footer={<><button className="quiet-button" onClick={onBack}>Cancel</button><button className="primary-button" onClick={() => { onApply({ backgroundActivity: { schemaVersion: 1, profile: 'custom', baseProfile: base as 'balanced' | 'performance' | 'battery-saver', overrides: changes } }); onBack() }}>Apply to settings</button></>}>
    <label className="setup-field">Shared policy<select aria-label="Shared policy" value={base} onChange={event => setBase(event.target.value)}><option value="balanced">Balanced</option><option value="performance">Performance</option><option value="battery-saver">Battery saver</option></select></label>
    <p className="engine-hint">Blank intervals use the shared policy. Values are seconds.</p>
    {intervals.map(([key, label]) => <label className="setup-field" key={key}>{label}<input aria-label={label} type="number" min="0" placeholder="Inherited" value={typeof overrides[key] === 'number' ? overrides[key] / 1000 : ''} onChange={event => change(key, event.target.value === '' ? null : Number(event.target.value) * 1000)} /></label>)}
    {pauses.map(([key, label]) => <div key={key}>{typeof overrides[key] === 'boolean' ? <><Switch label={label} checked={overrides[key]} onChange={value => change(key, value)} /><button className="text-action" onClick={() => change(key, null)}>Use shared policy for {label.toLowerCase()}</button></> : <label className="setup-field">{label}<select aria-label={label} value="inherit" onChange={event => change(key, event.target.value === 'on')}><option value="inherit">Use shared policy</option><option value="on">On</option><option value="off">Off</option></select></label>}</div>)}
  </SetupDialog>
}
