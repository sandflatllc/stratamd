import { useState } from 'react'
import { usageWindowStale } from '../../core/accountState'
import type { AccountView, EngineView, UsageWindowView } from '../../shared/contracts'
import type { ConsumeResetCreditInput, UsageLimitSources } from '../../shared/usage-limits'
import { measurementAge, shortResetLabel, usageTone } from './AccountsDialog'

export function quotaWindows(account: AccountView): UsageWindowView[] {
  return account.windows ?? [
    ...(account.session ? [{ ...account.session, id: 'session', label: 'Session' }] : []),
    ...(account.weekly ? [{ ...account.weekly, id: 'weekly', label: 'Weekly' }] : []),
    ...(account.modelWindows ?? []).map(window => ({ ...window, id: window.model, label: window.model })),
  ]
}

export function QuotaBar({ window, now, label }: { window: UsageWindowView; now: number; label?: string }) {
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent))
  const timeRemaining = window.resetsAt && window.windowDurationMins ? Math.max(0, Math.min(100, (Date.parse(window.resetsAt) - now) / (window.windowDurationMins * 60000) * 100)) : null
  const title = label ?? window.label ?? window.id ?? 'Reported limit'
  return <div className="account-quota" data-window={window.id} data-stale={usageWindowStale(window, now) || undefined} data-tone={usageTone(window.usedPercent)}>
    <div className="account-quota-label"><b>{title} · {Math.round(remaining)}% left</b><span>{window.resetsAt ? Date.parse(window.resetsAt) <= now ? 'Reset passed' : `Resets ${shortResetLabel(window.resetsAt, now)}` : 'Reset unknown'}</span></div>
    <span className="account-quota-bar" role="meter" aria-label={`${title} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}><i style={{ width: `${remaining}%` }} />{timeRemaining !== null && <em style={{ left: `${timeRemaining}%` }} title={`${Math.round(100 - timeRemaining)}% of this window has elapsed`} />}</span>
  </div>
}

export function CombinedQuota({ accounts, sources = [], now }: { accounts: AccountView[]; sources?: UsageLimitSources | undefined; now: number }) {
  const readings = accounts.map(account => ({ id: `provider:${account.instanceId}`, windows: quotaWindows(account), excluded: account.parked || !account.enabled || account.usageUnsupported || !!account.usageProblem }))
  for (const source of sources) for (const account of source.accounts) readings.push({ id: `source:${source.id}:${account.id}`, windows: account.usageLimits.windows.map(window => ({ ...window, resetsAt: window.resetsAt ?? null, measuredAt: account.usageLimits.checkedAt })), excluded: !!source.error || !!account.usageLimits.unavailable })
  const windowKey = (window: UsageWindowView) => `${(window.label ?? window.id ?? 'Reported limit').toLowerCase()}|${window.kind ?? ''}|${window.windowDurationMins ?? ''}`
  const ambiguous = new Set<string>()
  for (const account of readings) {
    const seen = new Set<string>()
    for (const window of account.windows) { const key = windowKey(window); if (seen.has(key)) ambiguous.add(key); seen.add(key) }
  }
  const groups = new Map<string, { label: string; windows: UsageWindowView[]; accounts: Set<string> }>()
  for (const account of readings) {
    if (account.excluded) continue
    for (const window of account.windows) {
      if (usageWindowStale(window, now)) continue
      const base = windowKey(window)
      const label = `${window.label ?? window.id ?? 'Reported limit'}${ambiguous.has(base) ? ` · ${window.id}` : ''}`
      // Ambiguous same-label windows stay separate by ID instead of losing a reading.
      const key = ambiguous.has(base) ? `${base}|${window.id}` : base
      const group = groups.get(key) ?? { label, windows: [], accounts: new Set<string>() }
      if (group.accounts.has(account.id)) continue
      group.accounts.add(account.id); group.windows.push(window); groups.set(key, group)
    }
  }
  return <div className="combined-quota">
    {[...groups].sort(([, left], [, right]) => ['session', 'weekly', 'monthly', 'other'].indexOf(left.windows[0]?.kind ?? 'other') - ['session', 'weekly', 'monthly', 'other'].indexOf(right.windows[0]?.kind ?? 'other')).map(([key, group]) => <QuotaBar key={key} now={now} label={`${group.label} · ${group.accounts.size} ${group.accounts.size === 1 ? 'account' : 'accounts'}`} window={{ usedPercent: group.windows.reduce((sum, window) => sum + window.usedPercent, 0) / group.windows.length, measuredAt: new Date(now).toISOString(), resetsAt: group.windows.map(window => window.resetsAt).filter((value): value is string => !!value).sort()[0] ?? null }} />)}
    {!groups.size && <p className="empty-subtle">No current usage reports to combine.</p>}
    <p className="engine-hint">Average of reported percentages for each matching window. Each account contributes equally. Includes current provider and usage-source reports. Disabled, parked, stale and failed accounts are excluded. This is not a shared token balance.</p>
  </div>
}

export function ResetCredits({ engine, now }: { engine: EngineView; now: number }) {
  const [selected, setSelected] = useState<{ label: string; input: ConsumeResetCreditInput } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const credits = engine.accounts.flatMap(account => account.resetCredits && account.resetCredits.availableCount > 0 && !account.usageProblem && !account.usageUnsupported && account.measuredAt && now - Date.parse(account.measuredAt) <= 600000 && (!account.resetCredits.nextExpiresAt || Date.parse(account.resetCredits.nextExpiresAt) > now) ? [{ label: account.name, input: { instanceId: account.instanceId } as ConsumeResetCreditInput }] : [])
  for (const source of engine.usageLimitSources ?? []) for (const account of source.accounts) {
    const credit = account.usageLimits.resetCredits
    if (!source.error && !account.usageLimits.unavailable && credit?.availableCount && credit.nextCreditId && now - Date.parse(account.usageLimits.checkedAt) <= 600000 && (!credit.nextExpiresAt || Date.parse(credit.nextExpiresAt) > now)) credits.push({ label: `${source.label} · ${account.email ?? account.id}`, input: { sourceId: source.id, accountId: account.id, creditId: credit.nextCreditId } })
  }
  const redeem = async () => {
    if (!selected || busy) return
    setBusy(true); setMessage(''); setFailed(false)
    try {
      const result = await window.strata.consumeResetCredit(selected.input)
      const outcomes = { reset: 'The provider reset the account limits.', nothingToReset: 'The provider reports nothing to reset.', noCredit: 'The provider reports no reset credit available.', alreadyRedeemed: 'This credit was already redeemed.' }
      setMessage(`${outcomes[result.outcome]}${result.warning ? ` ${result.warning}` : ''}`); setSelected(null)
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : 'The credit could not be used. Try again.') }
    finally { setBusy(false) }
  }
  const hasReading = engine.accounts.some(account => quotaWindows(account).length > 0)
  const stale = engine.accounts.some(account => account.state === 'stale' || account.usageProblem)
  return <div className="account-reset">
    {selected ? <div className="engine-hint account-reset-confirm" role="region" aria-label="Confirm reset credit"><p>Use one reset credit for {selected.label}? The provider will reset the eligible limits for this account.</p><button className="quiet-button" disabled={busy} onClick={() => { setSelected(null); setMessage('') }}>Cancel</button><button className="primary-button" disabled={busy || engine.state !== 'connected'} onClick={() => void redeem()}>{busy ? 'Using credit…' : 'Use reset credit'}</button></div> : <div className="quota-legend-row">{hasReading && !stale && <p className="engine-hint">Bar = quota left. Tick = time left in that window.</p>}<div>{credits.map(credit => <button key={JSON.stringify(credit.input)} className="quiet-button" disabled={engine.state !== 'connected'} onClick={() => { setSelected(credit); setMessage('') }}>Use reset credit for {credit.label}…</button>)}</div></div>}
    {message && <p className={failed ? 'engine-problem' : 'engine-hint'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </div>
}

export function SourceQuota({ engine, now }: { engine: EngineView; now: number }) {
  return (engine.usageLimitSources ?? []).map(source => <section className="accounts-group" key={source.id} aria-label={source.label}><div className="accounts-group-head"><h3>{source.label}</h3><span className="accounts-count">Usage source · cannot run conversations</span></div>{source.error && <p role="alert" className="engine-problem">{source.error}</p>}{source.accounts.map(account => <div className="account-row account-source-row" key={account.id}><div className="account-identity"><strong>{account.email ?? account.id}</strong><span className="account-meta">{account.plan}</span><span className="account-measured">Checked {measurementAge(account.usageLimits.checkedAt, now)}</span></div><div className="account-windows">{account.usageLimits.unavailable && <small>{account.usageLimits.unavailable.message ?? 'Usage unavailable'}</small>}{account.usageLimits.windows.map(window => <QuotaBar key={window.id} window={{ ...window, resetsAt: window.resetsAt ?? null, measuredAt: account.usageLimits.checkedAt }} now={now} />)}</div></div>)}</section>)
}
