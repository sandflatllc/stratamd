import { expect, it } from 'vitest'
import { makeUsageWindow, processedTokens, summarizeUsage, usageRows, enumerateDays, enumerateHourStarts } from '../../src/core/usage'
import { usageFixture } from '../support/usage-fixture'

it('counts disjoint inputs once, includes cache creation, and never adds reasoning to output', () => {
  expect(processedTokens({ uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 8, reasoningTokens: 6 })).toBe(43)
  const summary = usageFixture({ sinceDay: '2026-09-01', untilDay: '2026-09-03', timeZone: 'UTC' })
  const totals = summarizeUsage(summary)
  expect(totals.sessions).toBe(4)
  expect(summary.buckets.reduce((sum, bucket) => sum + bucket.sessions, 0)).toBe(12)
  expect(totals.tokens).toBe(summary.buckets.reduce((sum, bucket) => sum + processedTokens(bucket.totals), 0))
  expect(usageRows([...summary.buckets].reverse(), 'day').map(row => row.label)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
  expect(usageRows(summary.buckets, 'model').map(row => row.label)).toEqual(['Claude Fable 5', 'GPT-5.6 Sol'])
})
it('uses calendar-day windows and exact 24-hour rolling bounds across DST', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const days = makeUsageWindow('7d', new Date('2026-03-09T04:30:42Z'))
    expect(days).toMatchObject({ sinceDay: '2026-03-03', untilDay: '2026-03-09', timeZone: 'America/New_York' })
    expect(enumerateDays(days.sinceDay, days.untilDay)).toHaveLength(7)
    const hours = makeUsageWindow('24h', new Date('2026-03-08T12:30:42Z'))
    expect(hours).toMatchObject({ sinceTime: '2026-03-07T12:30:00.000Z', untilTime: '2026-03-08T12:30:00.000Z' })
    expect(enumerateHourStarts(hours.sinceTime!, hours.untilTime!)).toHaveLength(24)
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
it('keeps empty and unpriced usage honest', () => {
  const summary = usageFixture({ sinceDay: '2026-09-05', untilDay: '2026-09-05', timeZone: 'UTC' })
  summary.buckets[0]!.unpricedRecords = 2
  expect(summarizeUsage(summary).unpricedRecords).toBe(2)
  summary.buckets = []; summary.sources = []
  expect(summarizeUsage(summary)).toMatchObject({ tokens: 0, costUsd: 0, sessions: 0, providers: [] })
})
