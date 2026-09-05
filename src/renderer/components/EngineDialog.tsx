import { useRef, useState, type ReactNode } from 'react'
import type { EngineView, PairEngineRequest } from '../../shared/contracts'
import { XIcon } from '../icons/lucide'
import { useDialogFocus } from '../useDialogFocus'

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
  const dialogRef = useRef<HTMLElement>(null)
  const [link, setLink] = useState('')
  const [host, setHost] = useState('')
  const [code, setCode] = useState('')
  const [pairExpanded, setPairExpanded] = useState(engine.state === 'unpaired')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useDialogFocus(dialogRef, onClose)
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
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} tabIndex={-1} className="modal engine-dialog" role="dialog" aria-modal="true" aria-labelledby="engine-title">
        <div className="parity-dialog-heading"><h2 id="engine-title">Engine</h2><button type="button" className="quiet-button icon-button" aria-label="Close dialog" onClick={onClose}><XIcon /></button></div>
        <p className="modal-subtitle">The T3 server that runs your agents.</p>
        <dl className="engine-facts">
          <div><dt>Server</dt><dd data-testid="engine-server">{engine.server ?? 'None'}</dd></div>
          <div><dt>Status</dt><dd data-testid="engine-status" data-state={engine.state}>{engineStateLabel(engine)}</dd></div>
          {engine.credential && <div><dt>Session</dt><dd data-testid="engine-session">{engine.credential.renews ? 'Renews itself' : `Ends ${new Date(engine.credential.expiresAt).toLocaleDateString()}. Pair again with Manage access and it renews itself.`}</dd></div>}
        </dl>
        {engine.problem && engine.state !== 'unpaired' && <p className="engine-problem">{engine.problem}</p>}
        {paired && <div className="engine-dialog-row">
          <button type="button" className={engine.state === 'disconnected' ? 'primary-button' : 'quiet-button'} onClick={onReconnect}>Reconnect</button>
          {engine.state !== 'disconnected' && engine.server && <button type="button" className="quiet-button" onClick={() => { void window.strata.openExternal?.(`${engine.server!.replace(/\/$/, '')}/settings/connections`).catch((failure) => setError(String(failure))) }}>Open t3 connection settings</button>}
        </div>}
        {error && <div className="send-error" role="alert">{error}</div>}
        <details className="engine-pairing" open={pairExpanded} onToggle={(event) => setPairExpanded(event.currentTarget.open)}>
          <summary>{paired ? 'Pair again' : 'Pair'}</summary>
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
        <footer className="modal-actions parity-dialog-footer">
          {onOpenAccounts && paired && <button type="button" className="quiet-button" onClick={onOpenAccounts}>Accounts</button>}
          <button type="button" className="primary-button" onClick={onClose}>Close</button>
        </footer>
        {children}
      </section>
    </div>
  )
}
