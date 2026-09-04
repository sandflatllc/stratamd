import { describe, expect, it } from 'vitest'
import {
  T3_HTTP, T3_RPC, dispatchResult, messageSentEvent,
  providerUsage, shellSnapshot, subscribeThreadInput, turnDiffCompletedEvent, turnStartCommand,
} from '../../src/main/engine/t3-contract'

const now = '2026-09-03T20:00:00.000Z'
const eventBase = { sequence: 4, eventId: 'event-4', aggregateKind: 'thread', aggregateId: 'thread-1', occurredAt: now, commandId: 'command-1', causationEventId: null, correlationId: 'command-1', metadata: {} }

describe('vendored T3 cockpit contract', () => {
  it('names the HTTP and RPC paths', () => {
    expect(T3_HTTP.thread('thread:a/b')).toBe('/api/orchestration/threads/thread%3Aa%2Fb')
    expect(T3_HTTP.dispatch).toBe('/api/orchestration/dispatch')
    expect(T3_RPC.subscribeThread).toBe('orchestration.subscribeThread')
  })

  it('keeps the client message id through turn start and message-sent', () => {
    const command = turnStartCommand.parse({ type: 'thread.turn.start', commandId: 'command-1', threadId: 'thread-1', message: { messageId: 'message-1', role: 'user', text: 'Continue', attachments: [] }, runtimeMode: 'full-access', interactionMode: 'default', createdAt: now })
    const event = messageSentEvent.parse({ ...eventBase, type: 'thread.message-sent', payload: { threadId: 'thread-1', messageId: 'message-1', role: 'user', text: 'Continue', turnId: 'turn-1', streaming: false, createdAt: now, updatedAt: now } })
    expect(event.payload.messageId).toBe(command.message.messageId)
    expect(dispatchResult.parse({ sequence: 7 }).sequence).toBe(7)
  })

  it('parses checkpoint file paths and resumable subscriptions', () => {
    const event = turnDiffCompletedEvent.parse({ ...eventBase, type: 'thread.turn-diff-completed', payload: { threadId: 'thread-1', turnId: 'turn-1', checkpointTurnCount: 1, checkpointRef: 'checkpoint-1', status: 'ready', files: [{ path: 'docs/plan.md', kind: 'modified', additions: 2, deletions: 1 }], assistantMessageId: 'message-2', completedAt: now } })
    expect(event.payload.files[0]?.path).toBe('docs/plan.md')
    expect(subscribeThreadInput.parse({ threadId: 'thread-1', afterSequence: 4, requestCompletionMarker: true })).toMatchObject({ afterSequence: 4 })
  })

  it('parses the shell projection returned by the exercised HTTP snapshot', () => {
    const snapshot = shellSnapshot.parse({
      snapshotSequence: 2,
      projects: [{
        id: 'project-1', title: 'Project', workspaceRoot: '/work/project',
        defaultModelSelection: null, scripts: [], createdAt: now, updatedAt: now,
      }],
      threads: [{
        id: 'thread-1', projectId: 'project-1', title: 'Thread',
        modelSelection: { instanceId: 'claudeAgent', model: 'default' },
        runtimeMode: 'full-access', interactionMode: 'default', branch: null,
        worktreePath: null, latestTurn: null, createdAt: now, updatedAt: now,
        session: null, latestUserMessageAt: null, hasPendingApprovals: false,
        hasPendingUserInput: false, hasActionableProposedPlan: false,
      }],
      updatedAt: now,
    })
    expect(snapshot.projects[0]?.workspaceRoot).toBe('/work/project')
    expect(snapshot.threads[0]?.id).toBe('thread-1')
  })

  it('parses the provider usage shape used by account routing', () => {
    expect(providerUsage.parse({ session: { usedPercent: 42, resetsAt: now, measuredAt: now, source: 'session' }, weekly: null, applicable: true }).session?.usedPercent).toBe(42)
  })
})
