import type { AccountView } from '../shared/contracts'

export type AccountState = 'ready' | 'stale' | 'limited' | 'no-subscription' | 'signed-out' | 'parked' | 'disabled' | 'unknown'
export interface UsageWindow { usedPercent: number; resetsAt: string | null; measuredAt: string }
export interface ModelUsageWindow extends UsageWindow { model: string }
export interface AccountUsage { session: UsageWindow | null; weekly: UsageWindow | null; modelWindows?: ModelUsageWindow[]; planLabel?: string; applicable: boolean }
export interface AccountProvider { instanceId: string; driver: string; enabled: boolean; status: string; availability?: string; unavailableReason?: string; message?: string; auth: { status: string; type?: string; label?: string }; usage?: AccountUsage }
export interface DerivedAccountState { state: AccountState; usable: boolean; tier: 0 | 1 | 2; limitedUntil: string | null; pressure: number | null; reason: string | null }
const capable = new Set(['claudeAgent', 'codex'])
const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/gu, '')
const unusable = (state: Exclude<AccountState, 'ready' | 'stale'>, reason: string, pressure: number | null = null, limitedUntil: string | null = null): DerivedAccountState => ({ state, usable: false, tier: 2, limitedUntil, pressure, reason })

export const USAGE_FRESH_MS = 10 * 60 * 1000
export function usageWindowStale(window: UsageWindow, nowMs: number): boolean {
  const measured = Date.parse(window.measuredAt)
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  return !Number.isFinite(measured) || nowMs - measured > USAGE_FRESH_MS || reset <= nowMs && measured <= reset
}
export function modelUsageWindows(windows: readonly ModelUsageWindow[] | undefined, model: string): ModelUsageWindow[] {
  const words = model.toLowerCase().split(/[^a-z0-9]+/)
  return windows?.filter(window => window.model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).every(word => words.includes(word))) ?? []
}

/** Shared limits always apply; a named model adds its own weekly limits. */
export function deriveAccountState({ provider, parked, nowMs, model = '' }: { provider: AccountProvider; parked: boolean; nowMs: number; model?: string }): DerivedAccountState {
  const windows = [provider.usage?.session, provider.usage?.weekly, ...modelUsageWindows(provider.usage?.modelWindows, model)].filter((value): value is UsageWindow => !!value)
  const pressure = windows.length ? Math.max(...windows.map((value) => value.usedPercent)) : null
  if (parked) return unusable('parked', 'Parked', pressure)
  if (provider.availability === 'unavailable') return unusable('unknown', provider.unavailableReason ?? 'Provider unavailable', pressure)
  if (!provider.enabled || provider.status === 'disabled') return unusable('disabled', 'Disabled', pressure)
  if (provider.auth.status === 'unauthenticated') return unusable('signed-out', 'Signed out', pressure)
  if (capable.has(provider.driver)) {
    if (provider.auth.status === 'unknown') return unusable('unknown', provider.message ?? 'Authentication status unknown', pressure)
    const rawPlan = provider.auth.type && normalize(provider.auth.type) !== 'chatgpt' ? provider.auth.type : provider.auth.label ?? provider.usage?.planLabel
    if (rawPlan && ['free', 'claudefreesubscription', 'chatgptfreesubscription'].includes(normalize(rawPlan))) return unusable('no-subscription', 'No subscription', pressure)
  }
  if (provider.status === 'error') return unusable('unknown', provider.message ?? 'Provider error', pressure)
  if (!provider.usage) return { state: 'ready', usable: true, tier: 1, limitedUntil: null, pressure: null, reason: null }
  if (!provider.usage.applicable) return { state: 'ready', usable: true, tier: 0, limitedUntil: null, pressure: 0, reason: 'No plan limits' }
  let stale = windows.some(window => usageWindowStale(window, nowMs))
  const resets: Array<string | null> = []
  for (const window of windows) {
    if (window.usedPercent < 100) continue
    if (!window.resetsAt) resets.push(null)
    else if (Date.parse(window.resetsAt) > nowMs) resets.push(window.resetsAt)
    else if (Date.parse(window.measuredAt) > Date.parse(window.resetsAt)) resets.push(null)
    else stale = true
  }
  if (resets.length) {
    const limitedUntil = resets.includes(null) ? null : resets.reduce<string | null>((latest, value) => !latest || Date.parse(value!) > Date.parse(latest) ? value : latest, null)
    return unusable('limited', limitedUntil ? `Limited until ${limitedUntil}` : 'Limited, reset time unknown', pressure, limitedUntil)
  }
  if (stale) return { state: 'stale', usable: true, tier: 2, limitedUntil: null, pressure, reason: 'Usage is out of date. Refresh to check the current limits.' }
  return { state: 'ready', usable: true, tier: 0, limitedUntil: null, pressure, reason: null }
}

/** Apply model limits to an account without changing its provider or parking status. */
export function accountForModel(account: AccountView, model: string, nowMs = Date.now()): AccountView {
  if (!['ready', 'stale', 'limited'].includes(account.state)) return account
  const windows = modelUsageWindows(account.modelWindows, model)
  if (!account.session && !account.weekly && !windows.length) return account
  const provider: AccountProvider = {
    instanceId: account.instanceId, driver: account.driver, enabled: true, status: 'ready',
    auth: { status: 'authenticated' },
    usage: { session: account.session, weekly: account.weekly, modelWindows: windows, applicable: true },
  }
  const derived = deriveAccountState({ provider, parked: false, nowMs, model })
  // A known shared total cannot establish how much Fable allowance remains.
  if (derived.state === 'ready' && /\bfable\b/i.test(model) && !windows.length) derived.pressure = null
  const limitedModel = windows.find(window => window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > nowMs || Date.parse(window.measuredAt) > Date.parse(window.resetsAt)))
  return { ...account, ...derived, ...(limitedModel ? { reason: `${limitedModel.model} limit reached` } : {}), ...(account.usageProblem && derived.state === 'ready' ? { state: 'stale', reason: account.usageProblem } : {}) }
}

export function chooseAutoInstance<T extends { instanceId: string; derived: DerivedAccountState }>(candidates: readonly T[], previous: string | null): T | null {
  const sticky = candidates.find((value) => value.instanceId === previous && value.derived.usable && value.derived.tier < 2)
  if (sticky) return sticky
  return candidates.filter((value) => value.derived.usable).sort((a, b) => a.derived.tier - b.derived.tier || (a.derived.pressure ?? Infinity) - (b.derived.pressure ?? Infinity))[0] ?? null
}

export function resolveNewThreadInstance(input: { candidates: readonly { instanceId: string; derived: DerivedAccountState }[]; startedThreadInstanceId: string | null; explicitInstanceId: string | null; projectDefaultInstanceId: string | null; newThreadDefault: 'auto' | string; stickyInstanceId: string | null }): string | null {
  if (input.startedThreadInstanceId) return input.startedThreadInstanceId
  if (input.explicitInstanceId) return input.explicitInstanceId
  const usable = (id: string | null) => id && input.candidates.find((value) => value.instanceId === id && value.derived.usable)?.instanceId
  return usable(input.projectDefaultInstanceId) || (input.newThreadDefault === 'auto' ? null : usable(input.newThreadDefault)) || chooseAutoInstance(input.candidates, input.stickyInstanceId)?.instanceId || null
}
