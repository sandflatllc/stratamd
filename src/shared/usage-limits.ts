import { z } from 'zod'
const id = z.string().trim().min(1)
const iso = z.string().datetime({ offset: true })
export const reportedUsageWindow = z.object({ id, kind: z.enum(['session', 'weekly', 'monthly', 'other']), label: id, usedPercent: z.number().min(0).max(100), resetsAt: iso.optional(), windowDurationMins: z.number().int().nonnegative().optional() })
export const usageLimits = z.object({ checkedAt: iso, windows: z.array(z.unknown()).transform(items => items.flatMap(item => { const result = reportedUsageWindow.safeParse(item); return result.success ? [result.data] : [] })), resetCredits: z.object({ availableCount: z.number().int().nonnegative(), nextExpiresAt: iso.optional(), nextCreditId: id.optional() }).optional(), unavailable: z.object({ reason: z.enum(['unsupported', 'probeFailed']), message: id.optional() }).optional() })
function forwardArray<T extends z.ZodType>(schema: T) {
  return z.array(z.unknown()).transform(items => items.flatMap(item => { const parsed = schema.safeParse(item); return parsed.success ? [parsed.data] : [] }))
}
export const usageLimitSources = forwardArray(z.object({
  id, kind: z.literal('cliproxy'), label: id, checkedAt: iso, error: id.optional(),
  accounts: forwardArray(z.object({ id, driver: id, email: id.optional(), plan: id.optional(), usageLimits })),
}))
export const consumeResetCreditInput = z.union([z.object({ instanceId: id }).strict(), z.object({ sourceId: id, accountId: id, creditId: id }).strict()])
export const consumeResetCreditResult = z.object({ outcome: z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']), warning: id.optional() })
export type UsageLimits = z.infer<typeof usageLimits>
export type UsageLimitSources = z.infer<typeof usageLimitSources>
export type ConsumeResetCreditInput = z.infer<typeof consumeResetCreditInput>
export type ConsumeResetCreditResult = z.infer<typeof consumeResetCreditResult>

/** Server snapshots are complete. Only failed probes carry prior measurements forward. */
export function mergeUsageLimits(previous: UsageLimits | undefined, next: UsageLimits): UsageLimits {
  if (next.unavailable?.reason === 'unsupported') return { ...next, windows: [] }
  if (next.unavailable?.reason === 'probeFailed' && previous) return { ...previous, unavailable: next.unavailable }
  return next
}

/** A failed source probe keeps the displayed accounts and their measurement ages. */
export function mergeUsageSources(previous: UsageLimitSources, next: UsageLimitSources): UsageLimitSources {
  return next.map(source => {
    const before = previous.find(item => item.id === source.id)
    if (source.error && before) return { ...source, accounts: before.accounts }
    return { ...source, accounts: source.accounts.map(account => {
      const old = before?.accounts.find(item => item.id === account.id && item.email === account.email)
      return { ...account, usageLimits: mergeUsageLimits(old?.usageLimits, account.usageLimits) }
    }) }
  })
}
