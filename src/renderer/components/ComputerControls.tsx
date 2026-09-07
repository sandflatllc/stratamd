import { Switch } from './Switch'
import { useEffect, useRef, useState } from 'react'
import { accessScopes, type ComputerRequest, type ComputerView } from '../../shared/computer'

export function ComputerControls() {
  const [view, setView] = useState<ComputerView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<string[]>(accessScopes.slice(0, 5))
  const [endpoint, setEndpoint] = useState('')
  const [pairing, setPairing] = useState<ComputerView['createdLink']>()
  const [network, setNetwork] = useState<{ lan: boolean; tailscale: boolean; port: number } | null>(null)
  const opened = useRef('')
  const revision = useRef(0)
  const saving = useRef(false)
  const request = async (action: ComputerRequest) => {
    if (!window.strata.computer) return
    const currentRevision = ++revision.current
    saving.current = true
    const previous = view
    if (action.action === 'preferences') setView(current => current ? { ...current, preferences: { ...current.preferences, keepRunning: action.keepRunning, startAtLogin: action.startAtLogin } } : current)
    setBusy(true); setError('')
    try { const next = await window.strata.computer(action); setView(next); if (next.createdLink) setPairing(next.createdLink); if (action.action === 'network') setNetwork(null) } catch (error) { setView(previous); setError(String(error)) } finally { if (revision.current === currentRevision) { saving.current = false; setBusy(false) } }
  }
  useEffect(() => {
    let alive = true, pending = false
    const refresh = async (progress = false) => { if (pending || saving.current) return; pending = true; const currentRevision = revision.current; try { const next = await window.strata.computer?.({ action: progress ? 'progress' : 'status' }); if (alive && next && !saving.current && revision.current === currentRevision) setView(next) } catch (error) { if (alive) setError(String(error)) } finally { pending = false } }
    const focus = () => { void refresh() }
    void refresh(); window.addEventListener('focus', focus)
    const timer = view?.job.state === 'running' ? setInterval(() => { void refresh(true) }, 500) : undefined
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [view?.job.state === 'running'])
  useEffect(() => { const url = view?.job.url; if (url && opened.current !== url) { opened.current = url; void window.strata.openExternal?.(url).catch(error => setError(String(error))) } }, [view?.job.url])
  if (!view) return <p role="status">{error || 'Reading this computer…'}</p>
  const running = view.job.state === 'running'
  const disabled = busy || running
  const prefs = view.preferences
  const editedNetwork = network ?? prefs
  const connect = view.connect
  const chosenEndpoint = endpoint || view.endpoints[0] || ''
  const link = pairing && chosenEndpoint ? `${chosenEndpoint}/pair?token=${encodeURIComponent(pairing.credential)}` : ''
  return <div className="computer-controls">
    <section><h3>T3 Connect</h3><button type="button" className="text-action" disabled={busy} onClick={() => void request({ action: 'status' })}>Refresh connection status</button>
      <p>{!connect ? 'Status unavailable' : !connect.authenticated ? 'Signed out of T3' : connect.desired && !connect.linked ? 'Waiting for T3 authorization' : connect.linked ? 'Environment linked. Remote reachability is unverified.' : 'T3 sign-in saved. Authorization is checked when you connect.'}</p>
      <p>T3 uses this computer's name for the environment. Choose it in the original T3 mobile app. Sleep, offline periods and Quit make it unavailable.</p>
      <button className="quiet-button" disabled={disabled} onClick={() => void request({ action: 'login' })}>{connect?.authenticated ? 'Sign in to T3 again' : 'Sign in to T3'}</button>
      {connect?.authenticated && <button className="quiet-button" disabled={disabled} onClick={() => void request({ action: 'logout' })}>Sign out of T3</button>}
      <p className="engine-hint">Sign out disables remote access and activity publishing here. Your browser may stay signed in to the T3 website.</p>
      <Switch label="Remote access" disabled={disabled || !connect?.authenticated} checked={view.remoteEnabled === true} onChange={value => { void request({ action: 'remote', enabled: value }) }} />
      <p className="engine-hint">Relay client: {connect?.relayClient.status ?? 'unknown'}. If needed, T3 asks before downloading it. Applying remote access restarts an idle engine.</p>
      <Switch label="Publish agent activity" disabled={disabled || !connect?.authenticated} checked={!!connect?.publishAgentActivity} onChange={value => { void request({ action: 'publish', enabled: value }) }} />
      <p className="engine-hint">Sends activity to T3 for mobile notifications and Live Activities. It can work without remote access. Applying this choice restarts an idle engine.</p>
      {view.job.message && <p role="status">{view.job.message}</p>}
      {view.job.output && <pre className="provider-setup-output">{view.job.output}</pre>}
      {running && <><p className="engine-hint">Enter the browser authorization code when T3 asks for it. For a relay download prompt, answer yes or no.</p><label className="setup-field">Authorization code or answer to T3's prompt<input value={input} onChange={event => setInput(event.target.value)} autoComplete="off" /></label><button className="quiet-button" onClick={() => { void request({ action: 'input', text: input }); setInput('') }}>Send to T3</button><button className="quiet-button" onClick={() => void request({ action: 'cancel' })}>Cancel T3 Connect</button></>}
    </section>
    <section><h3>When the last window closes</h3>
      <Switch label="Keep running in the tray" disabled={disabled} checked={prefs.keepRunning} onChange={value => { void request({ action: 'preferences', keepRunning: value, startAtLogin: prefs.startAtLogin }) }} />
      <Switch label="Start at login" disabled={disabled} checked={prefs.startAtLogin} onChange={value => { void request({ action: 'preferences', keepRunning: prefs.keepRunning, startAtLogin: value }) }} />
      <p className="engine-hint">Quit stops the engine. Active work is shown before quitting.</p>
    </section>
    <details><summary>Advanced connections</summary>
      <Switch label="Allow network access" disabled={disabled} checked={editedNetwork.lan} onChange={value => { void setNetwork({ ...editedNetwork, lan: value }) }} />
      <p className="engine-hint">Off limits direct access to this machine. On listens on your network interfaces; pairing is still required.</p>
      <Switch label="Tailscale HTTPS" disabled={disabled} checked={editedNetwork.tailscale} onChange={value => { void setNetwork({ ...editedNetwork, tailscale: value }) }} />
      <label>Tailscale HTTPS port<input type="number" min="1" max="65535" value={editedNetwork.port} onChange={event => setNetwork({ ...editedNetwork, port: Number(event.target.value) })} /></label>
      <p className="engine-hint">{view.tailscaleStatus} A failed listener change restores the previous settings.</p>
      <button className="quiet-button" disabled={disabled || !network} onClick={() => void request({ action: 'network', ...editedNetwork })}>Apply network settings and restart</button>
      <h3>Pairing links</h3>
      <label>Endpoint<select value={chosenEndpoint} onChange={event => setEndpoint(event.target.value)}>{view.endpoints.map(url => <option key={url}>{url}</option>)}</select></label>
      <p className="engine-hint">A loopback link works only on this computer. Use an enabled network endpoint for another device. T3 sets each link's expiry.</p>
      <label>Link name<input value={label} onChange={event => setLabel(event.target.value)} /></label>
      {accessScopes.map(scope => <label className="settings-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter(value => value !== scope))} />{({ 'orchestration:read': 'Read conversations', 'orchestration:operate': 'Run conversations', 'terminal:operate': 'Use terminals', 'review:write': 'Write reviews', 'access:read': 'View access', 'access:write': 'Manage access', 'relay:read': 'View relay', 'relay:write': 'Manage relay' })[scope]}</label>)}
      <button className="quiet-button" disabled={disabled || !scopes.length} onClick={() => void request({ action: 'create-link', label, scopes: scopes as typeof accessScopes[number][] })}>Create pairing link</button>
      {pairing && <><label>New pairing link<input readOnly value={link} onFocus={event => event.target.select()} /></label><p>Expires {new Date(pairing.expiresAt).toLocaleString()}</p></>}
      {view.links.map(row => <p key={row.id}>{row.label || 'Pairing link'} · expires {new Date(row.expiresAt).toLocaleString()} <button className="quiet-button" disabled={disabled} onClick={() => { setPairing(undefined); void request({ action: 'revoke-link', id: row.id }) }}>Revoke link</button></p>)}
      <h3>Paired devices</h3>
      {view.devices.map(row => <p key={row.sessionId}>{row.label} · {row.current ? 'This Strata session' : row.connected ? 'Connected' : 'Offline'} <button className="quiet-button" disabled={disabled || row.current} onClick={() => void request({ action: 'revoke-device', id: row.sessionId })}>Revoke device</button></p>)}
    </details>
    {view.problems.map(problem => <p role="alert" key={problem}>{problem}</p>)}
    {error && <p role="alert">{error}</p>}
  </div>
}
