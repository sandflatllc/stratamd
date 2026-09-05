import { useRef, useState } from 'react'
import type { AccountView, EngineView } from '../../shared/contracts'
import { useDialogFocus } from '../useDialogFocus'
import { ProviderSetup } from './ProviderSetup'
import { EllipsisIcon, PlusIcon } from '../icons/lucide'
import { ProviderGlyph } from './ProviderGlyph'

interface AccountsDialogProps {
  engine: EngineView
  onPark(instanceId: string, parked: boolean): void
  onTerminalDefault(driver: string, selection: string | null): void
  onClose(): void
  onOpenUsage?(): void
  onOpenEngine?(): void
}

const DRIVER_LABELS: Record<string, string> = { claudeAgent: 'Claude', codex: 'Codex', cursor: 'Cursor', grok: 'Grok', opencode: 'OpenCode' }

export function driverLabel(driver: string): string {
  return DRIVER_LABELS[driver] ?? driver
}

/** The one-line verdict the fork's accounts page shows, in plain words (§5.13). */
export function accountStateLine(account: AccountView): string {
  switch (account.state) {
    case 'ready': return account.pressure === null ? 'Ready · not measured' : `Ready · ${Math.round(account.pressure)}% used`
    case 'stale': return 'Reset passed · waiting for a new measurement'
    case 'limited': return account.limitedUntil ? `Limited until ${shortResetLabel(account.limitedUntil, Date.now())}` : 'Limited · reset time unknown'
    case 'no-subscription': return 'No subscription'
    case 'signed-out': return 'Signed out'
    case 'parked': return 'Parked'
    case 'disabled': return 'Disabled'
    case 'unknown': return account.reason ?? 'Status unknown'
  }
}

/** Provider plan names without the vendor prefix and the word Subscription: "ChatGPT Pro 20x Subscription" reads "Pro 20x". */
export function shortPlan(plan: string): string {
  const short = plan.replace(/^(Claude|ChatGPT|OpenAI|Anthropic)\s+/i, '').replace(/\s+(subscription|plan)$/i, '').trim()
  return short || plan
}

const DAY_MS = 24 * 60 * 60 * 1000

function clockLabel(date: Date): string {
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return time.replace(/:00(?=\s?[AP]M$)/i, '')
}

/**
 * A reset time as short as the reader needs: the time of day when it lands today, the
 * weekday and time within the next six days, otherwise the month and day.
 */
export function shortResetLabel(iso: string, nowMs: number): string {
  const date = new Date(iso)
  const now = new Date(nowMs)
  if (Number.isNaN(date.getTime())) return iso
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS)
  if (days === 0) return clockLabel(date)
  if (days > 0 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clockLabel(date)}`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** How loud a usage bar should be: fine below 60, warning to 85, danger above. */
export function usageTone(usedPercent: number): 'ok' | 'warn' | 'hot' {
  if (usedPercent >= 85) return 'hot'
  if (usedPercent >= 60) return 'warn'
  return 'ok'
}

function UsageBar({ label, window, now }: { label: string; window: AccountView['session']; now: number }) {
  if (!window) return null
  const percent = Math.max(0, Math.min(100, window.usedPercent))
  return (
    <div className="account-usage" data-window={label.toLowerCase()} data-tone={usageTone(percent)}>
      <span>{label}</span>
      <span className="account-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={`${label} usage`}><i style={{ width: `${percent}%` }} /></span>
      <small><b>{Math.round(window.usedPercent)}%</b>{window.resetsAt && <span title={new Date(window.resetsAt).toLocaleString()}>{shortResetLabel(window.resetsAt, now)}</span>}</small>
    </div>
  )
}

function AccountRow({ account, auto, now, onPark, onManage }: { account: AccountView; auto: boolean; now: number; onPark: AccountsDialogProps['onPark']; onManage(): void }) {
  const quiet = account.state === 'ready'
  const chip = account.state === 'parked'
  const state = <span className="account-state" data-testid={`account-state-${account.instanceId}`} data-quiet={quiet || undefined} data-chip={chip || undefined}>{accountStateLine(account)}</span>
  return (
    <div className="account-row" data-instance={account.instanceId} data-state={account.state} data-usable={account.usable} data-parked={account.parked || undefined}>
      <span className="account-dot" aria-hidden="true" />
      <div className="account-identity">
        <div className="account-name">
          <strong>{account.name}</strong>
          {auto && <span className="account-chip" data-kind="auto" title="Auto picks this account now">Auto</span>}
          {chip && state}
          {account.homePath && <span className="account-chip" data-kind="home" title={account.homePath}>own home</span>}
        </div>
        {!chip && state}
        <div className="account-meta">
          {account.email && <span>{account.email}</span>}
          {account.plan && <span title={account.plan}>{shortPlan(account.plan)}</span>}
          {account.measuredAt && !account.live && <span className="account-measured">measured {shortResetLabel(account.measuredAt, now)}</span>}
        </div>
      </div>
      <div className="account-windows">
        <UsageBar label="Session" window={account.session} now={now} />
        <UsageBar label="Weekly" window={account.weekly} now={now} />
      </div>
      <button type="button" className="account-park" aria-pressed={account.parked} aria-label={`${account.parked ? 'Unpark' : 'Park'} ${account.name}`} onClick={() => onPark(account.instanceId, !account.parked)}>
        <span className="account-park-track" aria-hidden="true" />
        Park
      </button>
      <button type="button" className="quiet-button" aria-label={`Manage ${account.name}`} onClick={onManage}><EllipsisIcon /></button>
    </div>
  )
}

/**
 * Accounts (§5.13): provider logins, subscription limits and reset times,
 * parking, and terminal defaults, as a modal opened from the engine status.
 */
export function AccountsDialog({ engine, onPark, onTerminalDefault, onClose, onOpenEngine, onOpenUsage }: AccountsDialogProps) {
  const [manage, setManage] = useState<AccountView | 'new' | null>(null)
  return manage ? <ProviderSetup engine={engine} account={manage === 'new' ? null : manage} onBack={() => setManage(null)} onClose={onClose} /> : <AccountsOverview engine={engine} onPark={onPark} onTerminalDefault={onTerminalDefault} onClose={onClose} {...(onOpenEngine ? { onOpenEngine } : {})} {...(onOpenUsage ? { onOpenUsage } : {})} onManage={setManage} />
}

function AccountsOverview({ engine, onPark, onTerminalDefault, onClose, onOpenEngine, onOpenUsage, onManage }: AccountsDialogProps & { onManage(account: AccountView | 'new'): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const now = Date.now()
  const drivers = [...new Set(engine.accounts.map((account) => account.driver))]
  const active = drivers.filter((driver) => engine.accounts.some((account) => account.driver === driver && account.state !== 'disabled'))
  const inactive = engine.accounts.filter((account) => !active.includes(account.driver))
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} tabIndex={-1} className="modal accounts-dialog" role="dialog" aria-modal="true" aria-labelledby="accounts-title">
        <div className="accounts-body">
          <div className="parity-dialog-heading"><h2 id="accounts-title">Accounts</h2><button type="button" className="quiet-button" onClick={() => onManage('new')}><PlusIcon /> Add provider</button></div>
          <p className="modal-subtitle">Provider logins on {engine.server ? <code>{engine.server.replace(/^https?:\/\//, '')}</code> : 'the engine'}. Auto picks the least loaded account that can take a thread.</p>
          {engine.state !== 'connected' && <p className="engine-problem">The engine is {engine.state === 'unpaired' ? 'not paired' : engine.state}. Showing what Strata last measured.</p>}
          {engine.accounts.length === 0 && <div className="empty-subtle">No provider accounts reported yet.</div>}
          {active.map((driver) => {
            const accounts = engine.accounts.filter((account) => account.driver === driver)
            const ready = accounts.filter((account) => account.state === 'ready').length
            const terminal = engine.terminalDefaults[driver] ?? null
            const auto = engine.autoInstanceIds?.[driver] ?? null
            return (
              <section className="accounts-group" key={driver} aria-label={driverLabel(driver)}>
                <div className="accounts-group-head">
                  <h3><ProviderGlyph driver={driver} />{driverLabel(driver)}</h3>
                  <span className="accounts-count">{ready} of {accounts.length} ready</span>
                  <label className="account-terminal">Terminal
                    <select aria-label={`${driverLabel(driver)} terminal default`} value={terminal ?? ''} onChange={(event) => onTerminalDefault(driver, event.target.value || null)}>
                      <option value="">System default</option>
                      <option value="auto">Auto</option>
                      {accounts.map((account) => <option value={account.instanceId} key={account.instanceId}>{account.name}</option>)}
                    </select>
                    <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>
                  </label>
                </div>
                <div className="accounts-list">
                  {accounts.map((account) => <AccountRow account={account} auto={account.instanceId === auto} now={now} onPark={onPark} onManage={() => onManage(account)} key={account.instanceId} />)}
                </div>
              </section>
            )
          })}
          {inactive.length > 0 && (
            <section className="accounts-group" data-inactive aria-label="Not set up">
              <div className="accounts-group-head">
                <h3>Not set up</h3>
                <span className="accounts-count">no logins on this engine</span>
              </div>
              <div className="accounts-list">
                {inactive.map((account) => (
                  <div className="account-row" data-instance={account.instanceId} data-state={account.state} data-usable={account.usable} key={account.instanceId}>
                    <span className="account-dot" aria-hidden="true" />
                    <div className="account-identity"><div className="account-name"><strong>{account.name}</strong></div></div>
                    <span className="account-state" data-testid={`account-state-${account.instanceId}`}>{accountStateLine(account)}</span><button type="button" className="quiet-button" aria-label={`Manage ${account.name}`} onClick={() => onManage(account)}><EllipsisIcon /></button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="modal-actions accounts-actions">
          {engine.terminalShimDirectory && <p className="engine-hint">Terminal launchers live in <code>{engine.terminalShimDirectory}</code>. Put that directory on PATH before the provider binaries.</p>}
          {onOpenEngine && <button type="button" className="quiet-button" onClick={onOpenEngine}>Engine</button>}
          {onOpenUsage && <button type="button" className="quiet-button" onClick={onOpenUsage}>Usage</button>}
          <button type="button" className="primary-button" data-dialog-initial-focus onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  )
}
