import { EngineRecovery } from './EngineRecovery'
import { ComputerControls } from './ComputerControls'
import { useState, type ReactNode } from 'react'
import type { EngineView, PairEngineRequest } from '../../shared/contracts'
import { SetupDialog } from './SetupDialog'

interface EngineDialogProps {
  engine: EngineView
  onPair(request: PairEngineRequest): Promise<void>
  onReconnect(): void
  onClose(): void
  /** Opens the Accounts modal in place of this one (§5.13). */
  onOpenAccounts?(): void
  children?: ReactNode
}

/** The one-line connection state every engine surface agrees on (§5.1). */
export function engineStateLabel(engine: EngineView): string {
  switch (engine.state) {
    case 'unpaired': return 'No engine paired'
    case 'connecting': return 'Connecting'
    case 'connected': return 'Connected'
    case 'disconnected': return 'Disconnected'
  }
}

/**
 * Pairing and connection settings (§5.1): a pairing link or a host plus code,
 * the paired server, and Connected or Disconnected. Pairing again
 * replaces the stored credential.
 */
export function EngineDialog({ engine, onPair, onReconnect, onClose, onOpenAccounts, children }: EngineDialogProps) {
  const [link, setLink] = useState('')
  const [host, setHost] = useState('')
  const [code, setCode] = useState('')
  const [pairExpanded, setPairExpanded] = useState(!engine.managed && engine.state === 'unpaired')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const paired = engine.state !== 'unpaired'
  const request: PairEngineRequest | null = link.trim() ? { link } : host.trim() && code.trim() ? { host, code } : null
  const pair = async () => {
    if (!request || busy) return
    setBusy(true)
    setError('')
    try {
      await onPair(request)
      setLink(''); setHost(''); setCode(''); setPairExpanded(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pairing failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SetupDialog title={engine.managed ? 'Connections' : 'Engine'} subtitle={engine.managed ? 'This computer and access from your other devices.' : 'The T3 server that runs your agents.'} onClose={onClose} className="engine-dialog" footer={<>
      {onOpenAccounts && paired && <button type="button" className="quiet-button" onClick={onOpenAccounts}>Usage Limits</button>}
      <button type="button" className="primary-button" onClick={onClose}>Close</button>
    </>}>
        {engine.managed && <p className="local-engine-status" data-testid="local-engine-status">Local engine {engine.managed.state === 'running' ? 'running' : engine.managed.state === 'recovering' ? 'restarting' : engine.managed.state} · Remote access is managed below.</p>}
        {engine.managed && window.strata.computer && <ComputerControls />}
        <details className="connection-diagnostics" open={!engine.managed || undefined}><summary>Advanced engine details</summary>
        <dl className="engine-facts">
          {engine.managed && <div><dt>Engine</dt><dd>T3 {engine.managed.version?.match(/^t3-(.+?)-node-/)?.[1] ?? engine.managed.version ?? 'bundled'}</dd></div>}
          <div><dt>Address</dt><dd data-testid="engine-server">{engine.server ?? 'None'}</dd></div>
          <div><dt>Status</dt><dd data-testid="engine-status" data-state={engine.state}>{engine.managed?.state === 'recovering' ? 'Restarting' : engineStateLabel(engine)}</dd></div>
          {engine.managed && <div><dt>Data</dt><dd title={engine.managed.directory}>{engine.managed.directory}</dd></div>}
          {engine.credential && <div><dt>Session</dt><dd data-testid="engine-session">{engine.credential.renews ? 'Renews itself' : `Ends ${new Date(engine.credential.expiresAt).toLocaleDateString()}. Pair again with Manage access and it renews itself.`}</dd></div>}
        </dl>
        {engine.managed && <section>
          {engine.managed.problem && <p role="alert">{engine.managed.problem}</p>}
          {engine.managed.failure && <p className="engine-hint">Stopped at {new Date(engine.managed.failure.at).toLocaleTimeString()}{engine.managed.failure.signal ? ` with ${engine.managed.failure.signal}` : engine.managed.failure.exitCode !== null ? ` with exit code ${engine.managed.failure.exitCode}` : ''}.</p>}
          {['failed', 'stopped'].includes(engine.managed.state) && <button type="button" className="primary-button" onClick={() => { void window.strata.manageEngine?.('restart').catch(error => setError(String(error))) }}>Restart engine</button>}
          <button type="button" className="quiet-button" onClick={() => { void window.strata.manageEngine?.('show-log').catch(error => setError(String(error))) }}>Show log</button>
        </section>}
        {engine.managed && window.strata.engineRecovery && <EngineRecovery />}
        {!engine.managed?.problem && engine.problem && engine.state !== 'unpaired' && <p className="engine-problem">{engine.problem}</p>}
        {paired && <div className="engine-dialog-row">
          {(!engine.managed || engine.managed.state === 'running' && engine.state === 'disconnected') && <button type="button" className={engine.state === 'disconnected' ? 'primary-button' : 'quiet-button'} onClick={onReconnect}>Reconnect</button>}
          {engine.state !== 'disconnected' && engine.server && <button type="button" className="quiet-button" onClick={() => { void window.strata.openExternal?.(engine.server!).catch((failure) => setError(String(failure))) }}>Open T3 in a browser</button>}
        </div>}
        </details>
        {!engine.managed && window.strata.manageEngine && <details><summary>Use this computer</summary><p>Your current connection keeps its conversations, document links and unsent drafts. The bundled engine starts with its own projects and conversations.</p><button type="button" className="quiet-button" onClick={() => { setError(''); void window.strata.manageEngine?.('use-managed').catch(error => setError(String(error))) }}>Switch to this computer</button></details>}
        {error && <div className="send-error" role="alert">{error}</div>}
        <details className="engine-pairing" open={pairExpanded} onToggle={(event) => setPairExpanded(event.currentTarget.open)}>
          <summary>{engine.managed ? 'Use another computer to run agents' : paired ? 'Pair again' : 'Pair'}</summary>
        <form className="engine-pairing-form" onSubmit={(event) => { event.preventDefault(); void pair() }}>
          <p className="engine-hint">{paired ? 'Pairing again replaces the stored credential.' : 'Paste the pairing link from T3, or type the host and the code shown beside it. Give the link the Manage access permission so Strata can renew the session itself.'}</p>
          <label>Pairing link<input data-dialog-initial-focus={!paired || undefined} value={link} onChange={(event) => setLink(event.target.value)} placeholder="http://host:3774/pair?token=…" autoComplete="off" spellCheck={false} /></label>
          <div className="engine-or">or</div>
          <label>Host<input value={host} onChange={(event) => setHost(event.target.value)} placeholder="127.0.0.1:3774" autoComplete="off" spellCheck={false} /></label>
          <label>Code<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} /></label>
          <div className="modal-actions">
            <button type="submit" className="primary-button" disabled={!request || busy}>{busy ? 'Pairing…' : paired ? 'Pair again' : 'Pair'}</button>
          </div>
        </form>
        </details>
        {children}
    </SetupDialog>
  )
}
