export type AccountState = 'ready' | 'stale' | 'limited' | 'no-subscription' | 'signed-out' | 'parked' | 'disabled' | 'unknown'
export interface UsageWindow { usedPercent: number; resetsAt: string | null; measuredAt: string }
export interface AccountProvider { instanceId: string; driver: string; enabled: boolean; status: string; availability?: string; unavailableReason?: string; message?: string; auth: { status: string; type?: string; label?: string }; usage?: { session: UsageWindow | null; weekly: UsageWindow | null; planLabel?: string; applicable: boolean } }
export interface DerivedAccountState { state: AccountState; usable: boolean; tier: 0 | 1 | 2; limitedUntil: string | null; pressure: number | null; reason: string | null }
const capable = new Set(['claudeAgent', 'codex'])
const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/gu, '')
const unusable = (state: Exclude<AccountState, 'ready' | 'stale'>, reason: string, pressure: number | null = null, limitedUntil: string | null = null): DerivedAccountState => ({ state, usable: false, tier: 2, limitedUntil, pressure, reason })

export function deriveAccountState({ provider, parked, nowMs }: { provider: AccountProvider; parked: boolean; nowMs: number }): DerivedAccountState {
  const windows = [provider.usage?.session, provider.usage?.weekly].filter((value): value is UsageWindow => !!value)
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
  let stale = false
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
  if (stale) return { state: 'stale', usable: true, tier: 2, limitedUntil: null, pressure, reason: 'Reset passed, waiting for a new measurement' }
  return { state: 'ready', usable: true, tier: 0, limitedUntil: null, pressure, reason: null }
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
