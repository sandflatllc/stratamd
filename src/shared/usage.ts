export type UsageWindow = '24h' | '7d' | '30d' | '90d'
export type UsageProvider = 'claude' | 'codex' | 'grok'
export type UsageResolution = 'day' | 'hour'
export interface UsageSummaryInput { sinceDay: string; untilDay: string; timeZone: string; resolution?: UsageResolution; sinceTime?: string; untilTime?: string }
export interface UsageTokens { uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number }
export interface UsageBucket { day: string; hourStart?: string | undefined; provider: UsageProvider; model: string; totals: UsageTokens; costUsd: number; cacheSavingsUsd: number; costSource: 'providerReported' | 'modelPriced' | 'unpriced'; records: number; unpricedRecords: number; sessions: number }
export interface UsageSource { fingerprint: { hostId: string; provider: UsageProvider; resolvedHomePath: string; volumeId: string }; status: 'ok' | 'missing' | 'partial' | 'failed'; scannedFiles: number; skippedFiles: number; malformedRecords: number; distinctSessions: number; message: string | null }
export interface UsageSummary { sinceTime?: string; untilTime?: string; contractVersion: number; readAt: string; timeZone: string; sinceDay: string; untilDay: string; buckets: UsageBucket[]; sources: UsageSource[]; pricing: { status: 'fresh' | 'cached' | 'unavailable'; source: string; fetchedAt: string | null; knownModels: number }; scanDurationMs: number }
