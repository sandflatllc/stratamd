import { useEffect, useState } from 'react'
import type { AccountView, EngineView } from '../../shared/contracts'
import type { ProviderSetupView, ProviderSetupRequest } from '../../shared/provider-setup'

export function ProviderInstall({ account, engine }: { account: AccountView; engine: EngineView }) {
  const [job, setJob] = useState<ProviderSetupView | null>(null)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    if (!engine.managed || !window.strata.providerSetup) return
    let alive = true
    const refresh = () => void window.strata.providerSetup!({ identity: engine.identity ?? null, instanceId: account.instanceId, action: 'status' }).then(value => { if (alive) setJob(value) }).catch(() => undefined)
    refresh()
    const timer = job?.state === 'running' ? window.setInterval(refresh, 1000) : undefined
    return () => { alive = false; window.clearInterval(timer) }
  }, [account.instanceId, engine.identity, !!engine.managed, job?.state === 'running'])
  const act = async (action: ProviderSetupRequest['action']) => {
    if (!window.strata.providerSetup) return
    setError(''); setStarting(true)
    try { setJob(await window.strata.providerSetup({ identity: engine.identity ?? null, instanceId: account.instanceId, action, ...(action === 'input' ? { input: code } : {}) })); setCode('') } catch (error) { setError(String(error)) } finally { setStarting(false) }
  }
  const running = job?.state === 'running'
  const supported = ['codex', 'claudeAgent'].includes(account.driver)
  const needsSetup = !account.installed || account.state === 'signed-out' || !(account.providerReady ?? account.usable) && !account.parked && account.enabled !== false
  if (!needsSetup && (!job || job.state === 'idle')) return null
  const url = job?.output.match(/https:\/\/[^\s<>\x1b]+/)?.[0]
  return <div className="provider-install" aria-label={`Set up ${account.name}`}>
    {engine.managed && supported ? <>
      {!running && <button type="button" className="quiet-button" disabled={starting} onClick={() => void act(account.installed ? 'login' : 'install')}>{account.installed ? 'Sign in' : 'Install'} {account.name}</button>}
      {!running && account.installed && !(account.providerReady ?? account.usable) && <button type="button" className="quiet-button" disabled={starting} onClick={() => void act('install')}>Check or install {account.name}</button>}
      {!running && job?.installedBinary && <button type="button" className="quiet-button" disabled={starting} onClick={() => void act('use-installed')}>Use installed tool</button>}
      {job?.message && <p role="status">{job.message}</p>}
      {running && <><button type="button" className="quiet-button" onClick={() => void act('cancel')}>Cancel setup</button>{url && <button type="button" className="quiet-button" onClick={() => void window.strata.openExternal?.(url)}>Open provider sign-in</button>}</>}
      {job?.output && <pre className="provider-setup-output">{job.output}</pre>}
      {running && account.installed && <label className="setup-field">Sign-in code, if the provider asks<input aria-label="Provider sign-in code" value={code} autoComplete="off" onChange={event => setCode(event.target.value)} /><button type="button" className="quiet-button" disabled={!code.trim() || starting} onClick={() => void act('input')}>Submit code</button></label>}
    </> : <p className="engine-hint">{engine.managed ? `Install and sign in to ${account.name} with its own tool, then refresh Accounts.` : `Set up ${account.name} on the engine's computer, then refresh Accounts.`}</p>}
    {error && <p role="alert" className="send-error">{error}</p>}
  </div>
}
