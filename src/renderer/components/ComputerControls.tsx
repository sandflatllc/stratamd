import { Switch } from './Switch'
import { useEffect, useState } from 'react'
import { accessScopes, preferredPairingEndpoint, isLoopbackEndpoint, type ComputerView, type ComputerRequest } from '../../shared/computer'
import { useComputer } from '../useComputer'
import { ConnectSetup } from './ConnectSetup'
import { PairingQr } from './PairingQr'
const permissionPresets = { conversations: accessScopes.slice(0, 5), read: ['orchestration:read', 'access:read'], admin: [...accessScopes] } as const

export function ComputerControls() {
  const { view, error, busy, request } = useComputer()
  if (!view) return <p role="status">{error || 'Reading this computer…'}</p>
  return <div className="computer-controls"><ConnectSetup view={view} busy={busy} request={request} /><PrivateConnections view={view} busy={busy} request={request} />{view.problems.map(problem => <p role="alert" key={problem}>{problem}</p>)}{error && <p role="alert">{error}</p>}</div>
}
function PrivateConnections({ view, busy, request: send }: { view: ComputerView; busy: boolean; request(action: ComputerRequest): Promise<ComputerView | undefined> }) {
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<string[]>([...permissionPresets.conversations])
  const [preset, setPreset] = useState<keyof typeof permissionPresets>('conversations')
  const [endpoint, setEndpoint] = useState('')
  const [pairing, setPairing] = useState<ComputerView['createdLink']>()
  const [network, setNetwork] = useState<{ lan: boolean; tailscale: boolean; port: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    setExpired(false)
    if (!pairing) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now()))
    return () => clearTimeout(timer)
  }, [pairing])
  const request = async (action: ComputerRequest) => {
    const next = await send(action)
    if (next?.createdLink) setPairing(next.createdLink)
    if (next && action.action === 'network') { setNetwork(null); setEndpoint(''); setPairing(undefined) }
  }
  const disabled = busy || view.job.state === 'running'
  const prefs = view.preferences
  const editedNetwork = network ?? prefs
  const chosenEndpoint = view.endpoints.includes(endpoint) ? endpoint : preferredPairingEndpoint(view.endpoints)
  const link = pairing && chosenEndpoint ? `${chosenEndpoint}/pair?token=${encodeURIComponent(pairing.credential)}` : ''
  return <>
    <details><summary>Connect over a private network</summary>
      <Switch label="Allow network access" disabled={disabled} checked={editedNetwork.lan} onChange={value => { void setNetwork({ ...editedNetwork, lan: value }) }} />
      <p className="engine-hint">Off limits direct access to this machine. On listens on your network interfaces; pairing is still required.</p>
      <Switch label="Tailscale HTTPS" disabled={disabled} checked={editedNetwork.tailscale} onChange={value => { void setNetwork({ ...editedNetwork, tailscale: value }) }} />
      <label>Tailscale HTTPS port<input type="number" min="1" max="65535" value={editedNetwork.port} onChange={event => setNetwork({ ...editedNetwork, port: Number(event.target.value) })} /></label>
      <p className="engine-hint">{view.tailscaleStatus} A failed listener change restores the previous settings.</p>
      <button className="quiet-button" disabled={disabled || !network} onClick={() => void request({ action: 'network', ...editedNetwork })}>Apply network settings and restart</button>
      <h3>Pair another device</h3><p>Use this alternative when both devices can reach the same private network. T3 Connect above does not need a pairing link.</p>
      <label>Endpoint<select value={chosenEndpoint} onChange={event => setEndpoint(event.target.value)}>{view.endpoints.map(url => <option key={url}>{url}</option>)}</select></label>
      <p className="engine-hint">A loopback link works only on this computer. Use an enabled network endpoint for another device. T3 sets each link's expiry.</p>
      <label>Device access<select value={preset} onChange={event => { const value = event.target.value as keyof typeof permissionPresets; setPreset(value); setScopes([...permissionPresets[value]]) }}><option value="conversations">Conversations</option><option value="read">Read only</option><option value="admin">Full access</option></select></label><details><summary>Custom permissions</summary>{accessScopes.map(scope => <label className="settings-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter(value => value !== scope))} />{({ 'orchestration:read': 'Read conversations', 'orchestration:operate': 'Run conversations', 'terminal:operate': 'Use terminals', 'review:write': 'Write reviews', 'access:read': 'View access', 'access:write': 'Manage access', 'relay:read': 'View relay', 'relay:write': 'Manage relay' })[scope]}</label>)}</details><label>Link name<input value={label} onChange={event => setLabel(event.target.value)} /></label>

      <button className="quiet-button" disabled={disabled || !scopes.length} onClick={() => void request({ action: 'create-link', label, scopes: scopes as typeof accessScopes[number][] })}>Create pairing link</button>
      {pairing && !expired && <><label>New pairing link<input readOnly value={link} onFocus={event => event.target.select()} /></label><button className="quiet-button" onClick={() => { void window.strata.copyText(link).then(() => setNotice('Pairing link copied.')).catch(() => setNotice('The link could not be copied. Select and copy it above.')) }}>Copy pairing link</button>{!isLoopbackEndpoint(chosenEndpoint) && <PairingQr value={link} />}<p>Expires {new Date(pairing.expiresAt).toLocaleString()}. Use this link once on the other device.</p>{isLoopbackEndpoint(chosenEndpoint) && <p role="status">This address works only on this computer. Enable a private-network endpoint to pair your phone.</p>}</>}
      {pairing && expired && <p role="status">This pairing link has expired. Create a new link for your device.</p>}
      {view.links.map(row => <p key={row.id}>{row.label || 'Pairing link'} · expires {new Date(row.expiresAt).toLocaleString()} <button className="quiet-button" disabled={disabled} onClick={() => { setPairing(undefined); void request({ action: 'revoke-link', id: row.id }) }}>Revoke link</button></p>)}
      <h3>Paired devices</h3>
      {view.devices.map(row => <p key={row.sessionId}>{row.label} · {row.current ? 'This Strata session' : row.connected ? 'Connected' : 'Offline'} <button className="quiet-button" disabled={disabled || row.current} onClick={() => void request({ action: 'revoke-device', id: row.sessionId })}>Revoke device</button></p>)}
    </details>
    {notice && <p role="status">{notice}</p>}
  </>
}
