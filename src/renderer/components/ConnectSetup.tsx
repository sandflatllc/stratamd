import { useEffect, useRef, useState } from 'react'
import type { ComputerRequest, ComputerView } from '../../shared/computer'
import { Switch } from './Switch'

export function ConnectSetup({ view, busy, request }: { view: ComputerView; busy: boolean; request(action: ComputerRequest): Promise<ComputerView | undefined> }) {
  const [choices, setChoices] = useState<{ remote: boolean; publish: boolean } | null>(null)
  const [input, setInput] = useState('')
  const [browserError, setBrowserError] = useState('')
  const [changeAccount, setChangeAccount] = useState(false)
  const opened = useRef('')
  const running = view.job.state === 'running'
  const signedIn = view.connect?.authenticated === true
  const selection = choices ?? { remote: view.remoteEnabled === true, publish: view.connect?.publishAgentActivity === true }
  const wasSignedIn = useRef(signedIn)
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) setChoices({ remote: true, publish: false })
    if (!signedIn) setChoices(null)
    wasSignedIn.current = signedIn
  }, [signedIn])
  const openBrowser = async (url: string) => {
    setBrowserError('')
    try { await window.strata.openExternal?.(url) } catch { setBrowserError('The browser could not open. Try Open browser again.') }
  }
  useEffect(() => {
    const url = view.job.url
    if (running && url && opened.current !== url) { opened.current = url; void openBrowser(url) }
  }, [view.job.url, running])
  const applying = useRef(false)
  const apply = async () => { applying.current = true; const next = await request({ action: 'configure', ...selection }); if (!next || next.job.state !== 'running') applying.current = false }
  useEffect(() => { if (applying.current && !running) { applying.current = false; if (view.job.state === 'done') setChoices(null) } }, [running, view.job.state])
  const phase = view.job.phase
  return <section className="connect-setup" aria-label="T3 Connect setup">
    <div className="connection-summary"><h3>Connect this computer</h3><p>Use T3 on your phone or another computer to access the agents running here.</p><p className="connection-computer">{view.environmentName}</p></div>
    <ol className="connection-steps" aria-label="Connection setup steps"><li aria-current={!signedIn ? 'step' : undefined}>Sign in</li><li aria-current={signedIn && !view.remoteEnabled ? 'step' : undefined}>Enable access</li><li aria-current={view.remoteEnabled ? 'step' : undefined}>Connect your device</li></ol>
    <p role="status" data-testid="remote-connection-status">{view.connectionMessage}</p>
    {signedIn && <p>{view.account ? `T3 account: ${view.account}` : 'T3 sign-in is saved on this computer. Use that same account on your other device.'}</p>}
    {!signedIn && !running && <><button className="primary-button" disabled={busy} onClick={() => void request({ action: 'login' })}>Sign in to T3</button><p className="engine-hint">A browser will open. Strata continues after you sign in.</p></>}
    {running && <div className="connection-progress"><p role="status">{view.job.message}</p>
      {phase === 'browser' && <><button className="quiet-button" disabled={busy} onClick={() => view.job.url && void openBrowser(view.job.url)}>Open browser again</button><button className="text-action" disabled={busy} onClick={() => void request({ action: 'use-code' })}>Use an authorization code instead</button></>}
      {phase === 'code' && <form onSubmit={event => { event.preventDefault(); void request({ action: 'input', text: input }); setInput('') }}><p>Finish signing in in your browser, then paste its code here.</p><label className="setup-field">Authorization code<input value={input} onChange={event => setInput(event.target.value)} autoComplete="off" spellCheck={false} /></label><button className="primary-button" disabled={busy || !input.trim()}>Continue</button>{view.job.url && <button type="button" className="quiet-button" onClick={() => void openBrowser(view.job.url!)}>Open browser again</button>}</form>}
      {phase === 'download' && <><p>Download the T3 relay client on this computer. Your local engine keeps running while it installs.</p><button className="primary-button" disabled={busy} onClick={() => void request({ action: 'download', accepted: true })}>Download and continue</button></>}
      <button className="quiet-button" disabled={busy} onClick={() => void request({ action: 'cancel' })}>Cancel setup</button>
    </div>}
    {!running && view.job.message && <p role={view.job.state === 'failed' ? 'alert' : 'status'}>{view.job.message}</p>}
    {browserError && <p role="alert">{browserError}</p>}
    {!signedIn && !running && view.job.state === 'failed' && <button className="quiet-button" disabled={busy} onClick={() => { void request({ action: 'login', method: 'code' }) }}>Retry with an authorization code</button>}
    {signedIn && <div className="connection-choices"><Switch label="Remote access" checked={selection.remote} disabled={busy || running} onChange={remote => setChoices({ ...selection, remote })} /><p className="engine-hint">Open and run conversations from your other devices.</p><Switch label="Mobile notifications" checked={selection.publish} disabled={busy || running} onChange={publish => setChoices({ ...selection, publish })} /><p className="engine-hint">Publish agent activity to T3 for notifications and Live Activities. This can work with remote access off.</p><button className="primary-button" disabled={busy || running} onClick={() => void apply()}>{view.connectionState === 'failed' ? 'Retry connection setup' : view.connect?.linked ? 'Apply connection choices' : 'Enable access and continue'}</button><p className="engine-hint">Applying these choices restarts the local engine once. Finish active conversations first.</p></div>}
    {signedIn && <section className="connection-handoff" aria-label="Connect your device"><h3>Connect your phone</h3><ol><li>Open T3 on your phone and sign in with the same T3 account.</li><li>Choose <strong>{view.environmentName}</strong> in the T3 Connect environment list. If needed, open Settings → Environments and refresh.</li><li>Open a conversation, send a message, and check that its reply arrives.</li></ol><p className="engine-hint">Your agents and files stay on this computer. Provider accounts must be ready here. This connects T3 conversations; it does not copy Strata's document editor to your phone.</p>{view.devices.filter(device => !device.current).map(device => <p key={device.sessionId}>{device.label} · {device.connected ? 'Connected' : 'Offline'}</p>)}<button className="quiet-button" disabled={busy || running} onClick={() => void request({ action: 'status' })}>Check device connection</button></section>}
    <section><h3>Keep this computer available</h3><Switch label="Keep running in the tray" disabled={busy || running} checked={view.preferences.keepRunning} onChange={keepRunning => void request({ action: 'preferences', keepRunning, startAtLogin: view.preferences.startAtLogin })} /><Switch label="Start at login" disabled={busy || running} checked={view.preferences.startAtLogin} onChange={startAtLogin => void request({ action: 'preferences', keepRunning: view.preferences.keepRunning, startAtLogin })} /><p className="engine-hint">Leave this computer awake and online. Closing the window keeps access available when tray mode is on. Quit and sleep stop access. Enable notifications in your phone's settings if you want alerts.</p></section>
    {signedIn && <details><summary>Account and recovery</summary><p>Reconnecting signs out the saved account, disables remote access and notifications, then opens a fresh sign-in. Your browser may remain signed in; choose the account you want there.</p><button className="quiet-button" disabled={busy || running} onClick={() => setChangeAccount(true)}>Reconnect or change account</button><button className="quiet-button" disabled={busy || running} onClick={() => void request({ action: 'logout' })}>Sign out of T3</button>{changeAccount && <div role="group" aria-label="Confirm account change"><p>Disconnect this computer and sign in again?</p><button className="primary-button" disabled={busy || running} onClick={() => { setChangeAccount(false); setChoices(null); void request({ action: 'change-account' }) }}>Disconnect and sign in</button><button className="quiet-button" onClick={() => setChangeAccount(false)}>Keep current account</button></div>}</details>}
  </section>
}