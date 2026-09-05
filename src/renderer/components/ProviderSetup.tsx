import { useEffect, useState } from 'react'
import type { AccountView, EngineSettings, EngineView, ProviderInstanceSettings } from '../../shared/contracts'
import { deriveInstanceId, validProviderInstanceId, providerConfigFields } from '../../core/provider-instance'
import { SetupDialog, SourceRow } from './SetupDialog'
import { Switch } from './Switch'
import { StarIcon, UserRoundIcon } from '../icons/lucide'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const instanceId = account?.instanceId ?? customId ?? deriveInstanceId(driver, name)
  const fields = providerConfigFields(driver)
  useEffect(() => {
    let current = true
    void window.strata.readEngineSettings().then(value => {
      if (!current) return
      setSettings(value)
      const existing = account ? value.providerInstances[account.instanceId] : null
      if (existing) { setEnabled(existing.enabled !== false); setConfig(existing.config ?? {}) }
    }).catch(failure => { if (current) setError(String(failure)) })
    return () => { current = false }
  }, [account?.instanceId])
  const valid = name.trim() && validProviderInstanceId(instanceId) && (account || !settings?.providerInstances[instanceId])
  const save = async () => {
    if (busy || !valid) return
    setBusy(true); setError('')
    try {
      const latest = await window.strata.readEngineSettings()
      if (!account && latest.providerInstances[instanceId]) throw new Error(`Provider ${instanceId} already exists. Choose another instance identifier.`)
      const prior = latest.providerInstances[instanceId]
      const changedConfig = Object.fromEntries(fields.filter(field => config[field.key] !== settings?.providerInstances[instanceId]?.config?.[field.key]).map(field => [field.key, config[field.key] ?? '']))
      const instance: ProviderInstanceSettings = { ...prior, driver, displayName: name.trim(), enabled, config: { ...prior?.config, ...changedConfig } }
      await window.strata.updateEngineProviderInstances({ ...latest.providerInstances, [instanceId]: instance })
      onBack()
    } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }
  const preference = async (slug: string, value: { favorite?: boolean; hidden?: boolean }) => {
    setError('')
    try { await window.strata.setModelPreference(instanceId, slug, value) } catch (failure) { setError(String(failure)) }
  }
  const configFields = <>{fields.map(field => <label className="setup-field" key={field.key}>{field.label}<input aria-label={field.label} value={typeof config[field.key] === 'string' ? config[field.key] as string : ''} placeholder={field.key === 'binaryPath' ? driver === 'claudeAgent' ? 'claude' : driver === 'cursor' ? 'cursor-agent' : driver : ''} onChange={event => setConfig(value => ({ ...value, [field.key]: event.target.value }))} /></label>)}</>
  return <SetupDialog className="provider-setup" title={step === 'manage' ? account!.name : step === 'provider-pick' ? 'Add a provider' : step === 'identity' ? `Name this ${driverLabel(driver)} account` : `Configure ${driverLabel(driver)}`} subtitle={step === 'manage' ? `${driverLabel(driver)} · ${accountStateLine(account!)}` : 'Use the provider installed on your workstation.'} onClose={onClose} back={{ label: step === 'identity' ? 'Choose provider' : step === 'config' ? 'Account name' : 'Accounts', action: () => { if (!busy) { setError(''); step === 'identity' ? setStep('provider-pick') : step === 'config' ? setStep('identity') : onBack() } } }} footer={<><button type="button" className="quiet-button" onClick={onBack}>Cancel</button>{step === 'identity' && <button type="button" className="primary-button" disabled={!settings || !valid} onClick={() => setStep('config')}>Continue</button>}{(step === 'config' || step === 'manage' && tab === 'Configuration') && <button type="button" className="primary-button" disabled={busy || !settings || !valid} onClick={() => void save()}>{busy ? 'Saving…' : account ? 'Save changes' : 'Add provider'}</button>}{step === 'manage' && tab === 'Models' && <button type="button" className="primary-button" onClick={onBack}>Done</button>}</>}>
    {error && <p className="send-error" role="alert">{error}</p>}
    <fieldset className="setup-fields" disabled={busy || step === 'manage' && !settings}>
      {step === 'provider-pick' && ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode'].map(value => <SourceRow key={value} icon={<UserRoundIcon />} title={driverLabel(value)} description="Configure an additional provider instance." onClick={() => { setDriver(value); setName(''); setCustomId(null); setConfig({}); setStep('identity') }} />)}
      {step === 'identity' && <><label className="setup-field">Display name<input aria-label="Display name" value={name} onChange={event => setName(event.target.value)} /></label><details className="setup-advanced"><summary>Instance identifier</summary><label className="setup-field">Instance ID<input aria-label="Instance ID" value={instanceId} onChange={event => setCustomId(event.target.value)} /><small>Start with a letter. Use up to 64 letters, digits, hyphens or underscores.</small></label></details>{instanceId && !validProviderInstanceId(instanceId) && <p role="alert">Choose a valid instance identifier.</p>}{settings?.providerInstances[instanceId] && <p role="alert">Provider {instanceId} already exists.</p>}</>}
      {step === 'config' && configFields}
      {step === 'manage' && <><div role="tablist" aria-label="Provider settings" className="setup-tabs">{['Configuration', 'Models'].map(value => <button key={value} type="button" role="tab" aria-selected={value === tab} onClick={() => setTab(value)}>{value}</button>)}</div>{tab === 'Configuration' ? <><label className="setup-field">Display name<input aria-label="Display name" value={name} onChange={event => setName(event.target.value)} /></label><div className="provider-status"><span>{accountStateLine(account!)}</span><Switch label="Enabled" checked={enabled} onChange={setEnabled} /></div><p className="engine-hint">Enabled makes this provider available. Park excludes this login from automatic account selection.</p><details className="setup-advanced"><summary>Advanced configuration</summary>{configFields}</details></> : <>{(engine.models ?? []).filter(model => model.instanceId === instanceId).map(model => <div key={model.slug} className="provider-model-row" data-hidden={model.hidden || undefined}><span>{model.name}</span><button type="button" className="quiet-button" aria-label={`Favorite ${model.name}`} aria-pressed={model.favorite ?? false} onClick={() => void preference(model.slug, { favorite: !model.favorite })}><StarIcon fill={model.favorite ? 'currentColor' : 'none'} /></button><button type="button" className="quiet-button" aria-label={`${model.hidden ? 'Show' : 'Hide'} ${model.name}`} onClick={() => void preference(model.slug, { hidden: !model.hidden })}>{model.hidden ? 'Show' : 'Hide'}</button></div>)}<p className="engine-hint">Favorites and visibility control this provider's model picker in Strata. Changes save immediately.</p></>}</>}
    </fieldset>
  </SetupDialog>
}
