import { accountForModel, usageWindowStale } from '../../core/accountState'
import { ProviderInstall } from './ProviderInstall'
import { generatedModelSchema } from '../../shared/engine-settings'
import { useEffect, useRef, useState } from 'react'
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
  onOpenSettings?(): void
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
    case 'stale': return account.usageProblem ? 'Refresh failed · showing last reading' : 'Usage out of date · refresh needed'
    case 'limited': if (account.reason?.endsWith('limit reached')) return `${account.reason}${account.limitedUntil ? ` · resets ${shortResetLabel(account.limitedUntil, Date.now())}` : ''}`; return account.limitedUntil ? `Limited until ${shortResetLabel(account.limitedUntil, Date.now())}` : 'Limited · reset time unknown'
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


export function measurementAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000))
  if (!Number.isFinite(minutes)) return 'at an unknown time'
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

const DAY_MS = 24 * 60 * 60 * 1000

function clockLabel(date: Date): string {
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return time.replace(/:00(?=\s?[AP]M$)/i, '')
}

/**
 * A reset time as short as the reader needs: the time of day when it lands today, the
 * weekday and time within the next six days, otherwise the month, day and time.
 */
export function shortResetLabel(iso: string, nowMs: number): string {
  // Provider reset timestamps can drift a fraction of a second around the minute.
  // Match the provider's minute label while keeping the exact timestamp on hover.
  const date = new Date(Math.round(Date.parse(iso) / 60000) * 60000)
  const now = new Date(nowMs)
  if (Number.isNaN(date.getTime())) return iso
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS)
  if (days === 0) return clockLabel(date)
  if (days > 0 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clockLabel(date)}`
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clockLabel(date)}`
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
  const stale = usageWindowStale(window, now)
  return (
    <div className="account-usage" data-window={label.toLowerCase()} data-stale={stale || undefined} title={stale ? 'Last reading is out of date' : undefined} data-tone={usageTone(percent)}>
      <span>{label}</span>
      <span className="account-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={`${label} usage`}><i style={{ width: `${percent}%` }} /></span>
      <small><b>{Math.round(window.usedPercent)}%</b>{window.resetsAt && <span title={new Date(window.resetsAt).toLocaleString()}>{Date.parse(window.resetsAt) <= now ? 'Reset passed' : shortResetLabel(window.resetsAt, now)}</span>}</small>
    </div>
  )
}

function AccountRow({ account, engine, auto, now, onPark, onManage }: { account: AccountView; engine: EngineView; auto: boolean; now: number; onPark: AccountsDialogProps['onPark']; onManage(): void }) {
  const baseAccount = account
  if (account.driver === 'claudeAgent') account = accountForModel(account, 'fable', now)
  const quiet = account.state === 'ready'
  const chip = account.state === 'parked'
  const state = <span className="account-state" data-testid={`account-state-${account.instanceId}`} data-quiet={quiet || undefined} data-chip={chip || undefined}>{accountStateLine(account)}</span>
  return (
    <div className="account-row" data-instance={account.instanceId} data-state={account.state} data-usable={account.usable} data-parked={account.parked || undefined}>
      <span className="account-dot" aria-hidden="true" style={account.accentColor ? { backgroundColor: account.accentColor } : undefined} />
      <div className="account-identity">
        <div className="account-name">
          <strong>{account.name}</strong>
          {auto && <span className="account-chip" data-kind="auto" title="Auto picks this account now">Auto</span>}
          {chip && state}
          {account.homePath && <span className="account-chip" data-kind="home" title={account.homePath}>own home</span>}
        </div>
        {!chip && state}
        <ProviderInstall account={baseAccount} engine={engine} />
        <div className="account-meta">
          {account.email && <span>{account.email}</span>}
          {account.plan && <span title={account.plan}>{shortPlan(account.plan)}</span>}

        </div>
        {account.measuredAt && <span className="account-measured" title={new Date(account.measuredAt).toLocaleString()}>Checked {measurementAge(account.measuredAt, now)}</span>}
      </div>
      <div className="account-windows" title={account.driver === 'claudeAgent' ? 'Fable and All models are weekly limits. Session is the shared five-hour limit.' : undefined}>
        {account.usageAvailable === false && <small>Usage unavailable for this connection</small>}
        {(account.modelWindows ?? []).toSorted((a, b) => Number(b.model.toLowerCase() === 'fable') - Number(a.model.toLowerCase() === 'fable')).map(window => <UsageBar key={window.model} label={window.model} window={window} now={now} />)}
        {account.driver === 'claudeAgent' && account.usageAvailable !== false && !account.modelWindows?.some(window => window.model.toLowerCase() === 'fable') && <small>Fable usage not reported</small>}
        {account.usageRefreshing && <small role="status">Refreshing usage…</small>}
        {account.usageProblem && account.state !== 'stale' && <small title={account.usageProblem}>Refresh failed · showing last reading</small>}
        <UsageBar label="Session" window={account.session} now={now} />
        <UsageBar label={account.driver === 'claudeAgent' ? 'All models' : 'Weekly'} window={account.weekly} now={now} />
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
export function AccountsDialog({ engine, onPark, onTerminalDefault, onClose, onOpenEngine, onOpenUsage, onOpenSettings }: AccountsDialogProps) {
  const [manage, setManage] = useState<AccountView | 'new' | null>(null)
  return manage ? <ProviderSetup engine={engine} account={manage === 'new' ? null : manage} onBack={() => setManage(null)} onClose={onClose} /> : <AccountsOverview engine={engine} onPark={onPark} onTerminalDefault={onTerminalDefault} onClose={onClose} {...(onOpenEngine ? { onOpenEngine } : {})} {...(onOpenUsage ? { onOpenUsage } : {})} onManage={setManage} {...(onOpenSettings ? { onOpenSettings } : {})} />
}

function AccountsOverview({ engine, onPark, onTerminalDefault, onClose, onOpenEngine, onOpenUsage, onOpenSettings, onManage }: AccountsDialogProps & { onManage(account: AccountView | 'new'): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [generatedInstance, setGeneratedInstance] = useState<string | null>(null)
  useEffect(() => { let alive = true; void window.strata.readEngineSettings().then(settings => { const parsed = generatedModelSchema.safeParse(settings.textGenerationModelSelection); if (alive && parsed.success) setGeneratedInstance(parsed.data.instanceId) }).catch(() => undefined); return () => { alive = false } }, [engine.identity])
  const generatedAccount = engine.accounts.find(account => account.instanceId === generatedInstance)
  const generatedUnavailable = generatedInstance && (!generatedAccount?.installed || !(generatedAccount.providerReady ?? generatedAccount.usable))
  const [now, setNow] = useState(Date.now)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer) }, [])
  const refresh = async () => {
    setRefreshing(true); setRefreshError('')
    try { await window.strata.refreshAccounts() } catch (error) { setRefreshError(error instanceof Error ? error.message : 'Usage could not be refreshed.') } finally { setRefreshing(false) }
  }
  const drivers = [...new Set(engine.accounts.map((account) => account.driver))]
  const active = drivers.filter((driver) => engine.accounts.some((account) => account.driver === driver && account.state !== 'disabled'))
  const inactive = engine.accounts.filter((account) => !active.includes(account.driver))
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} tabIndex={-1} className="modal accounts-dialog" role="dialog" aria-modal="true" aria-labelledby="accounts-title">
        <div className="accounts-body">
          <div className="parity-dialog-heading"><h2 id="accounts-title">Accounts</h2><button type="button" className="quiet-button" onClick={() => onManage('new')}><PlusIcon /> Add provider</button></div>
          <p className="modal-subtitle">Provider logins on {engine.managed ? 'this computer' : engine.server ? <code>{engine.server.replace(/^https?:\/\//, '')}</code> : 'the engine'}. Auto keeps its account while usable, then chooses by usage. Claude Auto checks Fable and shared limits.</p>
          {engine.state !== 'connected' && <p className="engine-problem">The engine is {engine.state === 'unpaired' ? 'not paired' : engine.state}. Showing what Strata last measured.</p>}
          {refreshError && <p className="engine-problem" role="alert">{refreshError}</p>}
          {!engine.accounts.some(account => account.usable) && <p className="engine-hint">Documents keep working while you set up an account.</p>}
          {generatedUnavailable && <p className="engine-hint">The account for generated text is not ready. <button type="button" className="text-action" onClick={onOpenSettings}>Choose a model in Settings</button>.</p>}
          {engine.accounts.length === 0 && <div className="empty-subtle">No provider accounts reported yet.</div>}
          {active.map((driver) => {
            const accounts = engine.accounts.filter((account) => account.driver === driver)
            const fable = driver === 'claudeAgent' && accounts.some(account => account.modelWindows?.some(window => window.model.toLowerCase() === 'fable'))
            const ready = accounts.filter(account => fable ? account.modelWindows?.some(window => window.model.toLowerCase() === 'fable') && accountForModel(account, 'fable', now).state === 'ready' : account.state === 'ready').length
            const terminal = engine.terminalDefaults[driver] ?? null
            const auto = engine.autoInstanceIds?.[driver] ?? null
            return (
              <section className="accounts-group" key={driver} aria-label={driverLabel(driver)}>
                <div className="accounts-group-head">
                  <h3><ProviderGlyph driver={driver} />{driverLabel(driver)}</h3>
                  <span className="accounts-count">{ready} of {accounts.length} ready{fable ? ' for Fable' : ''}</span>
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
                  {accounts.map((account) => <AccountRow account={account} engine={engine} auto={account.instanceId === auto} now={now} onPark={onPark} onManage={() => onManage(account)} key={account.instanceId} />)}
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
                    <span className="account-dot" aria-hidden="true" style={account.accentColor ? { backgroundColor: account.accentColor } : undefined} />
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
          {onOpenEngine && <button type="button" className="quiet-button" onClick={onOpenEngine}>{engine.managed ? 'This computer' : 'Engine'}</button>}
          {onOpenUsage && <button type="button" className="quiet-button" onClick={onOpenUsage}>Usage</button>}
          <button type="button" className="quiet-button" disabled={refreshing || engine.accounts.some(account => account.usageRefreshing) || engine.state !== 'connected'} onClick={() => void refresh()}>{refreshing || engine.accounts.some(account => account.usageRefreshing) ? 'Refreshing…' : 'Refresh'}</button>
          <button type="button" className="primary-button" data-dialog-initial-focus onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  )
}
