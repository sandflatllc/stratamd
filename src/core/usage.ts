import type { UsageBucket, UsageProvider, UsageSummary, UsageTokens, UsageWindow } from '../shared/usage'
import { makeWindow } from './usage-format'
export { formatTokens, formatUsd, formatPercent, formatCount, formatDayShort, formatHourShort, enumerateDays, enumerateHourStarts } from './usage-format'

export function makeUsageWindow(window: UsageWindow, now = new Date()) {
  return makeWindow(window === '24h' ? 1 : Number.parseInt(window), now, window === '24h' ? 'hour' : 'day')
}

export function processedTokens(totals: UsageTokens): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens
}
export interface UsageRow { key: string; label: string; provider?: UsageProvider; tokens: number; costUsd: number }
export function usageRows(buckets: UsageBucket[], group: 'model' | 'day' | 'hour'): UsageRow[] {
  const rows = new Map<string, UsageRow>()
  for (const bucket of buckets) {
    const label = group === 'model' ? bucket.model : group === 'hour' ? bucket.hourStart ?? bucket.day : bucket.day
    const key = group === 'model' ? `${bucket.provider}:${label}` : label
    const row = rows.get(key) ?? { key, label, ...(group === 'model' ? { provider: bucket.provider } : {}), tokens: 0, costUsd: 0 }
    row.tokens += processedTokens(bucket.totals); row.costUsd += bucket.costUsd; rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => group === 'model' ? b.tokens - a.tokens || a.key.localeCompare(b.key) : a.key.localeCompare(b.key))
}

/** Single-engine equivalent of T3's usage merge. Sessions come from sources, never bucket sums. */
export function summarizeUsage(summary: UsageSummary) {
  const totals: UsageTokens = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  let costUsd = 0
  let cacheSavingsUsd = 0
  let unpricedRecords = 0
  for (const bucket of summary.buckets) {
    for (const key of Object.keys(totals) as (keyof UsageTokens)[]) totals[key] += bucket.totals[key]
    costUsd += bucket.costUsd; cacheSavingsUsd += bucket.cacheSavingsUsd; unpricedRecords += bucket.unpricedRecords
  }
  const providers = (['claude', 'codex', 'grok'] as const).map(provider => {
    const buckets = summary.buckets.filter(bucket => bucket.provider === provider)
    return { provider, tokens: buckets.reduce((sum, bucket) => sum + processedTokens(bucket.totals), 0), costUsd: buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0), sessions: summary.sources.filter(source => source.fingerprint.provider === provider && source.status !== 'missing').reduce((sum, source) => sum + source.distinctSessions, 0) }
  }).filter(provider => provider.tokens > 0 || provider.sessions > 0)
  return { ...totals, tokens: processedTokens(totals), costUsd, cacheSavingsUsd, unpricedRecords, sessions: providers.reduce((sum, provider) => sum + provider.sessions, 0), providers }
}
