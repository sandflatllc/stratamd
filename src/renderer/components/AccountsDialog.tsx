import { useRef } from 'react'
import type { AccountView, EngineView } from '../../shared/contracts'
import { useDialogFocus } from '../useDialogFocus'

interface AccountsDialogProps {
  engine: EngineView
  onPark(instanceId: string, parked: boolean): void
  onTerminalDefault(driver: string, selection: string | null): void
  onClose(): void
  onOpenEngine?(): void
}

const DRIVER_LABELS: Record<string, string> = { claudeAgent: 'Claude', codex: 'Codex' }

export function driverLabel(driver: string): string {
  return DRIVER_LABELS[driver] ?? driver
}

/** The one-line verdict the fork's accounts page shows, in plain words (§5.13). */
export function accountStateLine(account: AccountView): string {
  switch (account.state) {
    case 'ready': return account.pressure === null ? 'Ready · not measured' : `Ready · ${Math.round(account.pressure)}% used`
    case 'stale': return 'Reset passed · waiting for a new measurement'
    case 'limited': return account.limitedUntil ? `Limited until ${new Date(account.limitedUntil).toLocaleString()}` : 'Limited · reset time unknown'
    case 'no-subscription': return 'No subscription'
    case 'signed-out': return 'Signed out'
    case 'parked': return 'Parked'
    case 'disabled': return 'Disabled'
    case 'unknown': return account.reason ?? 'Status unknown'
  }
}

function UsageBar({ label, window }: { label: string; window: AccountView['session'] }) {
  if (!window) return null
  return (
    <div className="account-usage" data-window={label.toLowerCase()}>
      <span>{label}</span>
      <meter min={0} max={100} value={window.usedPercent} aria-label={`${label} usage`} />
      <small>{Math.round(window.usedPercent)}%{window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : ''}</small>
    </div>
  )
}

/**
 * Accounts (§5.13): provider logins, subscription limits and reset times,
 * parking, and terminal defaults, as a modal opened from the engine status.
 */
export function AccountsDialog({ engine, onPark, onTerminalDefault, onClose, onOpenEngine }: AccountsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const drivers = [...new Set(engine.accounts.map((account) => account.driver))]
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} tabIndex={-1} className="modal accounts-dialog" role="dialog" aria-modal="true" aria-labelledby="accounts-title">
        <h2 id="accounts-title">Accounts</h2>
        <p className="modal-subtitle">Provider logins on {engine.server ?? 'the engine'}. Auto picks the least loaded account that can take a thread.</p>
        {engine.state !== 'connected' && engine.state !== 'mismatch' && <p className="engine-problem">The engine is {engine.state === 'unpaired' ? 'not paired' : engine.state}. Showing what Strata last measured.</p>}
        {engine.accounts.length === 0 && <div className="empty-subtle">No provider accounts reported yet.</div>}
        {drivers.map((driver) => {
          const accounts = engine.accounts.filter((account) => account.driver === driver)
          const terminal = engine.terminalDefaults[driver] ?? null
          return (
            <section className="accounts-group" key={driver} aria-label={driverLabel(driver)}>
              <h3>{driverLabel(driver)}</h3>
              {accounts.map((account) => (
                <div className="account-row" key={account.instanceId} data-instance={account.instanceId} data-state={account.state} data-usable={account.usable}>
                  <div className="account-head">
                    <strong>{account.name}</strong>
                    {account.email && <small>{account.email}</small>}
                    {account.plan && <small>{account.plan}</small>}
                    {account.homePath && <small title={account.homePath}>own home</small>}
                  </div>
                  <span className="account-state" data-testid={`account-state-${account.instanceId}`}>{accountStateLine(account)}</span>
                  <UsageBar label="Session" window={account.session} />
                  <UsageBar label="Weekly" window={account.weekly} />
                  {account.measuredAt && !account.live && <small className="account-measured">Last measured {new Date(account.measuredAt).toLocaleString()}</small>}
                  <div className="account-actions">
                    <button type="button" className="quiet-button" aria-label={`${account.parked ? 'Unpark' : 'Park'} ${account.name}`} onClick={() => onPark(account.instanceId, !account.parked)}>{account.parked ? 'Unpark' : 'Park'}</button>
                  </div>
                </div>
              ))}
              <label className="account-terminal">Use in terminal
                <select aria-label={`${driverLabel(driver)} terminal default`} value={terminal ?? ''} onChange={(event) => onTerminalDefault(driver, event.target.value || null)}>
                  <option value="">System default</option>
                  <option value="auto">Auto</option>
                  {accounts.map((account) => <option value={account.instanceId} key={account.instanceId}>{account.name}</option>)}
                </select>
              </label>
            </section>
          )
        })}
        {engine.terminalShimDirectory && <p className="engine-hint">Terminal launchers are written to {engine.terminalShimDirectory}. Put that directory on PATH before the provider binaries.</p>}
        <div className="modal-actions">
          {onOpenEngine && <button type="button" className="quiet-button" onClick={onOpenEngine}>Engine</button>}
          <button type="button" className="quiet-button" data-dialog-initial-focus onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  )
}
