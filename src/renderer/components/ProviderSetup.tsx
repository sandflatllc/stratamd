import { ProviderInstall } from './ProviderInstall'
import { ProviderEnvironmentEditor } from './ProviderEnvironmentEditor'
import { ProviderModels } from './ProviderModels'
import type { ProviderEnvironment } from '../../shared/engine-settings'
import { useEffect, useState } from 'react'
import type { AccountView, EngineSettings, EngineView, ProviderInstanceSettings } from '../../shared/contracts'
import { deriveInstanceId, validProviderInstanceId, providerConfigFields } from '../../core/provider-instance'
import { SetupDialog, SourceRow } from './SetupDialog'
import { Switch } from './Switch'
import { UserRoundIcon } from '../icons/lucide'
import { driverLabel, accountStateLine } from './AccountsDialog'

type Step = 'manage' | 'provider-pick' | 'identity' | 'config'
export function ProviderSetup({ engine, account, onBack, onClose }: { engine: EngineView; account: AccountView | null; onBack(): void; onClose(): void }) {
  const [step, setStep] = useState<Step>(account ? 'manage' : 'provider-pick')
  const [tab, setTab] = useState('Configuration')
  const [settings, setSettings] = useState<EngineSettings | null>(null)
  const [driver, setDriver] = useState(account?.driver ?? 'codex')
  const [name, setName] = useState(account?.name ?? '')
  const [customId, setCustomId] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [accentColor, setAccentColor] = useState('')
  const [environment, setEnvironment] = useState<ProviderEnvironment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const instanceId = account?.instanceId ?? customId ?? deriveInstanceId(driver, name)
  const fields = providerConfigFields(driver)
  const theme = getComputedStyle(document.querySelector('.app-shell') ?? document.documentElement)
  const accents = Array.from({ length: 6 }, (_, index) => theme.getPropertyValue(`--visuals-category-${index + 1}`).trim()).filter(Boolean)
  useEffect(() => {
    let current = true
    void window.strata.readEngineSettings().then(value => {
      if (!current) return
      setSettings(value)
      const existing = account ? value.providerInstances[account.instanceId] : null
      if (existing) { setName(existing.displayName ?? account!.name); setEnabled(existing.enabled !== false); setConfig(existing.config ?? {}); setAccentColor(existing.accentColor ?? ''); setEnvironment(existing.environment ?? []) }
    }).catch(failure => { if (current) setError(String(failure)) })
    return () => { current = false }
  }, [account?.instanceId])
  const valid = name.trim() && validProviderInstanceId(instanceId) && (account || !settings?.providerInstances[instanceId])
  const save = async () => {
    if (busy || !valid) return
    setBusy(true); setError('')
    try {
      if (!settings) return
      const base = account ? settings.providerInstances[instanceId] ?? null : null
      const patch: Partial<ProviderInstanceSettings> = base ? {} : { driver, displayName: name.trim(), enabled }
      if (base && name.trim() !== (base.displayName ?? account!.name)) patch.displayName = name.trim()
      if (base && enabled !== (base.enabled !== false)) patch.enabled = enabled
      if (accentColor !== (base?.accentColor ?? '')) patch.accentColor = accentColor
      if (JSON.stringify(environment) !== JSON.stringify(base?.environment ?? [])) {
        if (environment.some(row => row.sensitive && !row.valueRedacted && !row.value)) throw new Error('Enter a value for each new or replaced secret, or remove its entry.')
        patch.environment = environment
      }
      const changedConfig = Object.fromEntries(fields.filter(field => (config[field.key] ?? '') !== (base?.config?.[field.key] ?? '')).map(field => [field.key, config[field.key] ?? '']))
      if (Object.keys(changedConfig).length) patch.config = changedConfig
      await window.strata.editEngineProvider({ identity: settings.identity ?? null, instanceId, base, patch })
      onBack()
    } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }
  const configFields = <>{fields.map(field => <label className="setup-field" key={field.key}>{field.label}<input type={field.key === 'serverPassword' ? 'password' : 'text'} aria-label={field.label} value={typeof config[field.key] === 'string' ? config[field.key] as string : ''} placeholder={field.key === 'binaryPath' ? driver === 'claudeAgent' ? 'claude' : driver === 'cursor' ? 'cursor-agent' : driver : ''} onChange={event => setConfig(value => ({ ...value, [field.key]: event.target.value }))} />{field.key === 'autoCompactWindow' && <small>Blank uses Claude's default. Enter 100000 to 1000000 tokens.</small>}{field.key === 'serverPassword' && <small>T3 stores this optional password in plain text.</small>}{field.key === 'homePath' && <small>Provider configuration and sign-in for this account.</small>}{field.key === 'shadowHomePath' && <small>An isolated Codex account home. Existing credentials are not moved.</small>}</label>)}</>
  return <SetupDialog className="provider-setup" title={step === 'manage' ? account!.name : step === 'provider-pick' ? 'Add a provider' : step === 'identity' ? `Name this ${driverLabel(driver)} account` : `Configure ${driverLabel(driver)}`} subtitle={step === 'manage' ? `${driverLabel(driver)} · ${accountStateLine(account!)}` : 'Use the provider installed on your workstation.'} onClose={onClose} back={{ label: step === 'identity' ? 'Choose provider' : step === 'config' ? 'Account name' : 'Usage Limits', action: () => { if (!busy) { setError(''); step === 'identity' ? setStep('provider-pick') : step === 'config' ? setStep('identity') : onBack() } } }} footer={<><button type="button" className="quiet-button" onClick={onBack}>Cancel</button>{step === 'identity' && <button type="button" className="primary-button" disabled={!settings || !valid} onClick={() => setStep('config')}>Continue</button>}{(step === 'config' || step === 'manage' && tab === 'Configuration') && <button type="button" className="primary-button" disabled={busy || !settings || !valid} onClick={() => void save()}>{busy ? 'Saving…' : account ? 'Save changes' : 'Add provider'}</button>}{step === 'manage' && tab === 'Models' && <button type="button" className="primary-button" onClick={onBack}>Done</button>}</>}>
    {account && <ProviderInstall account={account} engine={engine} />}
    {error && <p className="send-error" role="alert">{error}</p>}
    <fieldset className="setup-fields" disabled={busy || step === 'manage' && !settings}>
      {step === 'provider-pick' && ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode'].map(value => <SourceRow key={value} icon={<UserRoundIcon />} title={driverLabel(value)} description="Configure an additional provider instance." onClick={() => { setDriver(value); setName(''); setCustomId(null); setConfig({}); setStep('identity') }} />)}
      {step === 'identity' && <><label className="setup-field">Display name<input aria-label="Display name" value={name} onChange={event => setName(event.target.value)} /></label><details className="setup-advanced"><summary>Instance identifier</summary><label className="setup-field">Instance ID<input aria-label="Instance ID" value={instanceId} onChange={event => setCustomId(event.target.value)} /><small>Start with a letter. Use up to 64 letters, digits, hyphens or underscores.</small></label></details>{instanceId && !validProviderInstanceId(instanceId) && <p role="alert">Choose a valid instance identifier.</p>}{settings?.providerInstances[instanceId] && <p role="alert">Provider {instanceId} already exists.</p>}</>}
      {step === 'config' && <>{configFields}<ProviderEnvironmentEditor rows={environment} onChange={setEnvironment} /></>}
      {step === 'manage' && <><div role="tablist" aria-label="Provider settings" className="setup-tabs">{['Configuration', 'Models'].map(value => <button key={value} type="button" role="tab" aria-selected={value === tab} onClick={() => setTab(value)}>{value}</button>)}</div>{tab === 'Configuration' ? <><label className="setup-field">Display name<input aria-label="Display name" value={name} onChange={event => setName(event.target.value)} /></label><div className="provider-accent" role="radiogroup" aria-label="Account accent choices"><span>Accent color</span>{accents.map(color => <button type="button" role="radio" key={color} data-color={color} aria-label={`Accent ${color}`} aria-checked={accentColor === color} style={{ '--swatch': color } as React.CSSProperties} onClick={() => setAccentColor(color)} />)}<button type="button" aria-pressed={!accentColor} className="quiet-button" onClick={() => setAccentColor('')}>Use default color</button><input aria-label="Accent color" type="color" value={accentColor || accents[0]} onChange={event => setAccentColor(event.target.value)} /></div><div className="provider-status"><span>{accountStateLine(account!)}</span><Switch label="Enabled" checked={enabled} onChange={setEnabled} /></div><p className="engine-hint">Enabled makes this provider available. Park excludes this login from automatic account selection.</p><details className="setup-advanced"><summary>Advanced configuration</summary>{configFields}<ProviderEnvironmentEditor rows={environment} onChange={setEnvironment} /></details></> : <ProviderModels engine={engine} instanceId={instanceId} settings={settings} onSaved={setSettings} />}</>}
    </fieldset>
  </SetupDialog>
}
