import { z } from 'zod'
export const recoveryRequest = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'update']) }).strict(),
  z.object({ action: z.literal('restore'), backupId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), acknowledgeNewerWork: z.literal(true) }).strict(),
])
export type RecoveryRequest = z.infer<typeof recoveryRequest>
export interface RecoveryView { bundledVersion: string | null; currentVersion: string | null; backups: { id: string; createdAt: string; version: string; kind: string }[]; message: string | null }
