import type { EngineThreadView } from '../../shared/contracts'

export type AttentionReason = 'turn-finished' | 'item-posted' | 'approval'

export interface AttentionEvent {
  threadId: string
  title: string
  reason: AttentionReason
}

export interface AttentionDecision {
  /** Threads that gain a badge on Projects and on their tab (§5.2). */
  badges: AttentionEvent[]
  /** What the OS notification says, only when the window is not focused. */
  notifications: Array<{ title: string; body: string; threadId: string }>
}

const FINISHED: ReadonlySet<EngineThreadView['status']> = new Set(['ready', 'idle', 'stopped', 'interrupted', 'error'])

function reasonLine(event: AttentionEvent): string {
  switch (event.reason) {
    case 'turn-finished': return 'Turn finished'
    case 'item-posted': return 'Posted an item for you'
    case 'approval': return 'Waiting for your approval'
  }
}

/**
 * The notification rule (§5.2), pure so a unit test proves it without
 * Electron: a turn finishing, an item posting, or an approval arriving counts
 * when the owner is elsewhere, meaning the thread is not the one open in
 * front of them or the window is not focused. The OS notification is added
 * only while the window is unfocused; a badge is enough when it is.
 */
export function decideAttention(input: { previous: readonly EngineThreadView[]; next: readonly EngineThreadView[]; activeThreadId: string | null; focused: boolean }): AttentionDecision {
  const before = new Map(input.previous.map((thread) => [thread.id, thread]))
  const badges: AttentionEvent[] = []
  for (const thread of input.next) {
    const earlier = before.get(thread.id)
    if (!earlier) continue
    const elsewhere = !input.focused || thread.id !== input.activeThreadId
    if (!elsewhere) continue
    if (earlier.status === 'running' && FINISHED.has(thread.status)) badges.push({ threadId: thread.id, title: thread.title, reason: 'turn-finished' })
    if ((thread.items?.length ?? 0) > (earlier.items?.length ?? 0)) badges.push({ threadId: thread.id, title: thread.title, reason: 'item-posted' })
    if (!earlier.pendingApprovals && thread.pendingApprovals) badges.push({ threadId: thread.id, title: thread.title, reason: 'approval' })
  }
  return {
    badges,
    notifications: input.focused ? [] : badges.map((event) => ({ threadId: event.threadId, title: event.title, body: reasonLine(event) })),
  }
}
