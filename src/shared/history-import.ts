import { z } from 'zod'

// Pinned T3 agentSessions.ts. Discovery and transcript decoding stay in the engine.
export const historyCandidateSchema = z.object({
  path: z.string().trim().min(1), title: z.string().trim().min(1), projectId: z.string().optional(),
  sources: z.array(z.enum(['claudeAgent', 'codex'])), threadCount: z.number().int().nonnegative(),
  lastActiveAt: z.iso.datetime({ offset: true }).nullable(), alreadyImported: z.boolean(),
  git: z.object({ remoteKey: z.string().nullable(), repository: z.string().nullable() }).nullable().optional(),
})
export const historyScanSchema = z.object({ candidates: z.array(historyCandidateSchema), scannedAt: z.iso.datetime({ offset: true }), truncated: z.boolean().optional() })
export const historyImportResultSchema = z.object({ importedCount: z.number().int().nonnegative(), skippedCount: z.number().int().nonnegative() })
export type HistoryCandidate = z.infer<typeof historyCandidateSchema>
export type HistoryScan = z.infer<typeof historyScanSchema>
export type HistoryImportResult = z.infer<typeof historyImportResultSchema>

/** Pure lexical check. Never inspect personal assistant directories, even to resolve a path. */
export function isPrivateHistoryPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  const normalized: string[] = []
  for (const part of parts) { if (part === '..') normalized.pop(); else if (part !== '.') normalized.push(part) }
  return normalized.some(part => ['.openclaw', 'openclaw-private', 'openclaw_private_state'].includes(part)) || `/${normalized.join('/')}`.startsWith('/srv/openclaw/private/') || `/${normalized.join('/')}` === '/srv/openclaw/private'
}

/** The server imports whole projects. Recency bounds discovery display, not transcript contents. */
export function recentHistoryGroups(candidates: HistoryCandidate[], limit = 20): { key: string; title: string; candidates: HistoryCandidate[] }[] {
  const groups = new Map<string, { key: string; title: string; candidates: HistoryCandidate[] }>()
  const recent = candidates.filter(candidate => !isPrivateHistoryPath(candidate.path)).sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')).slice(0, limit)
  for (const candidate of recent) {
    const key = candidate.git?.remoteKey ?? candidate.path
    const group = groups.get(key) ?? { key, title: candidate.git?.repository ?? candidate.title, candidates: [] }
    group.candidates.push(candidate); groups.set(key, group)
  }
  return [...groups.values()]
}
