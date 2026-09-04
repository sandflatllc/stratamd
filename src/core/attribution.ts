import { computeHunks, type TextHunk } from './diff'

export interface TurnWorkspace {
  threadId: string
  worktreePath: string | null
  projectRoot: string
  runningThreadIds: readonly string[]
  git: boolean
}

/** Attribution is deliberately conservative: a shared root with two writers is external. */
export function attributeTurnWrite(input: TurnWorkspace): { kind: 'thread'; threadId: string } | { kind: 'external' } {
  if (!input.git) return { kind: 'external' }
  if (input.worktreePath !== null) return { kind: 'thread', threadId: input.threadId }
  return input.runningThreadIds.length === 1 && input.runningThreadIds[0] === input.threadId
    ? { kind: 'thread', threadId: input.threadId }
    : { kind: 'external' }
}

export type FirstDeliveryDocument =
  | { kind: 'unchanged' }
  | { kind: 'diff'; hunks: readonly TextHunk[] }
  | { kind: 'full'; document: string }

export function firstDeliveryDocument(
  threadId: string,
  current: string,
  lastWrite: { threadId: string; content: string; certain: boolean } | null,
): FirstDeliveryDocument {
  if (!lastWrite || !lastWrite.certain || lastWrite.threadId !== threadId) return { kind: 'full', document: current }
  if (lastWrite.content === current) return { kind: 'unchanged' }
  return { kind: 'diff', hunks: computeHunks(lastWrite.content, current) }
}
