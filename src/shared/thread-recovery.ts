import { z } from 'zod'
export const threadRecoverySchema = z.object({
  priorTurnId: z.string().nullable(),
  state: z.enum(['reconnecting', 'waiting', 'resumed', 'continued', 'completed', 'failed']),
  source: z.enum(['engine', 'message']).optional(),
  messageId: z.string().optional(), commandId: z.string().optional(), createdAt: z.string().optional(),
  failure: z.string().optional(),
})
export type ThreadRecovery = z.infer<typeof threadRecoverySchema>
interface RecoveryThread {
  session: { status: string; activeTurnId: string | null; lastError: string | null } | null
  latestTurn: unknown
  messages?: readonly { id: string }[] | undefined
}
/** Connection alone is not evidence that a provider resumed or accepted a new turn. */
export function reconcileThreadRecovery(recovery: ThreadRecovery, thread: RecoveryThread, connected: boolean): ThreadRecovery {
  if (!connected || !['reconnecting', 'waiting', 'failed'].includes(recovery.state)) return recovery
  if (recovery.messageId && thread.messages?.some(message => message.id === recovery.messageId)) return { ...recovery, state: 'continued', source: 'message', failure: undefined }
  const session = thread.session
  if (session?.status === 'running' && session.activeTurnId) return { ...recovery, state: session.activeTurnId === recovery.priorTurnId ? 'resumed' : 'continued', source: 'engine', failure: undefined }
  const latest = thread.latestTurn as { turnId?: string; state?: string } | null
  if (latest?.turnId === recovery.priorTurnId && latest?.state === 'completed') return { ...recovery, state: 'completed', failure: undefined }
  if (session?.status === 'error' || session?.status === 'interrupted' || session?.status === 'stopped') return { ...recovery, state: 'failed', failure: session.lastError ?? 'The engine stopped this work. It has not confirmed a resumed turn.' }
  return { ...recovery, state: 'waiting' }
}
