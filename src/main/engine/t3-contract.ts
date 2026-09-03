import { z } from 'zod'

/** T3 contract revision verified for cockpit v1. See docs/internals/t3-engine-contract.md. */
export const T3_CONTRACT_REVISION = 'fe96f7f2b7cb07da4fc7585f5869d58d2e592fd3'

export const T3_HTTP = {
  pairingToken: '/api/auth/pairing-token',
  token: '/oauth/token',
  websocketTicket: '/api/auth/websocket-ticket',
  shell: '/api/orchestration/shell',
  thread: (threadId: string) => `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
  dispatch: '/api/orchestration/dispatch',
  websocket: '/ws',
} as const

export const T3_RPC = {
  dispatchCommand: 'orchestration.dispatchCommand',
  getTurnDiff: 'orchestration.getTurnDiff',
  getFullThreadDiff: 'orchestration.getFullThreadDiff',
  subscribeShell: 'orchestration.subscribeShell',
  subscribeThread: 'orchestration.subscribeThread',
  getServerConfig: 'server.getConfig',
  subscribeServerConfig: 'subscribeServerConfig',
} as const

const id = z.string().trim().min(1)
const isoDate = z.iso.datetime({ offset: true })
const nonNegativeInt = z.number().int().nonnegative()

export const authScopes = z.array(z.enum([
  'orchestration:read', 'orchestration:operate', 'terminal:operate', 'review:write',
  'access:read', 'access:write', 'relay:read', 'relay:write',
]))
export const pairingCredentialInput = z.object({ label: id.optional(), scopes: authScopes.optional() }).strict()
export const pairingCredentialResult = z.object({ id, credential: id, label: id.optional(), expiresAt: isoDate }).passthrough()
export const tokenExchangeResult = z.object({
  access_token: id,
  issued_token_type: z.literal('urn:ietf:params:oauth:token-type:access_token'),
  token_type: z.enum(['Bearer', 'DPoP']),
  expires_in: z.number(),
  scope: id,
}).passthrough()
export const websocketTicketResult = z.object({ ticket: id, expiresAt: isoDate }).passthrough()

export const modelSelection = z.object({ instanceId: id, model: id, options: z.record(z.string(), z.unknown()).optional() }).passthrough()
export const chatAttachment = z.object({
  type: id,
  id,
  name: id,
  mimeType: id,
  sizeBytes: nonNegativeInt,
}).passthrough()
export const orchestrationMessage = z.object({
  id,
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  attachments: z.array(chatAttachment).optional(),
  turnId: id.nullable(),
  streaming: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).passthrough()

export const checkpointFile = z.object({ path: id, kind: id, additions: nonNegativeInt, deletions: nonNegativeInt }).passthrough()
export const checkpointSummary = z.object({
  turnId: id,
  checkpointTurnCount: nonNegativeInt,
  checkpointRef: id,
  status: z.enum(['ready', 'missing', 'error']),
  files: z.array(checkpointFile),
  assistantMessageId: id.nullable(),
  completedAt: isoDate,
}).passthrough()

export const threadActivity = z.object({
  id,
  tone: z.enum(['info', 'tool', 'approval', 'error']),
  kind: id,
  summary: id,
  payload: z.unknown(),
  turnId: id.nullable(),
  sequence: nonNegativeInt.optional(),
  createdAt: isoDate,
}).passthrough()
export const orchestrationSession = z.object({
  threadId: id,
  status: z.enum(['idle', 'starting', 'running', 'ready', 'interrupted', 'stopped', 'error']),
  providerName: id.nullable(),
  providerInstanceId: id.optional(),
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  activeTurnId: id.nullable(),
  lastError: id.nullable(),
  updatedAt: isoDate,
}).passthrough()
export const orchestrationProject = z.object({
  id, title: id, workspaceRoot: id, defaultModelSelection: modelSelection.nullable(),
  scripts: z.array(z.unknown()), createdAt: isoDate, updatedAt: isoDate, deletedAt: isoDate.nullable(),
}).passthrough()
export const orchestrationProjectShell = orchestrationProject.omit({ deletedAt: true }).passthrough()
export const orchestrationThreadShell = z.object({
  id, projectId: id, title: id, modelSelection,
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']), branch: id.nullable(), worktreePath: id.nullable(),
  latestTurn: z.unknown().nullable(), createdAt: isoDate, updatedAt: isoDate,
  session: orchestrationSession.nullable(), latestUserMessageAt: isoDate.nullable(),
  hasPendingApprovals: z.boolean(), hasPendingUserInput: z.boolean(), hasActionableProposedPlan: z.boolean(),
}).passthrough()
export const orchestrationThread = z.object({
  id, projectId: id, title: id, modelSelection,
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']), branch: id.nullable(), worktreePath: id.nullable(),
  latestTurn: z.unknown().nullable(), createdAt: isoDate, updatedAt: isoDate, deletedAt: isoDate.nullable(),
  messages: z.array(orchestrationMessage), activities: z.array(threadActivity),
  checkpoints: z.array(checkpointSummary), session: orchestrationSession.nullable(),
}).passthrough()
export const shellSnapshot = z.object({
  snapshotSequence: nonNegativeInt,
  projects: z.array(orchestrationProjectShell),
  threads: z.array(orchestrationThreadShell),
  updatedAt: isoDate,
}).passthrough()
export const threadDetailSnapshot = z.object({
  snapshotSequence: nonNegativeInt,
  thread: orchestrationThread,
  page: z.object({ beforeCursor: id.nullable(), hasMore: z.boolean(), snapshotSequence: nonNegativeInt, threadSequence: nonNegativeInt.optional() }).passthrough().optional(),
}).passthrough()

export const subscribeShellInput = z.object({ afterSequence: nonNegativeInt.optional(), requestCompletionMarker: z.boolean().optional() }).strict()
export const subscribeThreadInput = z.object({ threadId: id, afterSequence: nonNegativeInt.optional(), requestCompletionMarker: z.boolean().optional(), turnLimit: z.number().int().positive().optional() }).strict()
export const shellStreamItem = z.union([
  z.object({ kind: z.literal('synchronized') }).passthrough(),
  z.object({ kind: z.literal('snapshot'), snapshot: shellSnapshot }).passthrough(),
  z.object({ kind: z.enum(['project-upserted', 'project-removed', 'thread-upserted', 'thread-removed']), sequence: nonNegativeInt }).passthrough(),
])

const eventBase = z.object({
  sequence: nonNegativeInt, eventId: id, aggregateKind: z.enum(['project', 'thread']), aggregateId: id,
  occurredAt: isoDate, commandId: id.nullable(), causationEventId: id.nullable(), correlationId: id.nullable(),
  metadata: z.record(z.string(), z.unknown()), type: id, payload: z.unknown(),
}).passthrough()
export const threadStreamItem = z.union([
  z.object({ kind: z.literal('synchronized') }).passthrough(),
  z.object({ kind: z.literal('snapshot'), snapshot: threadDetailSnapshot }).passthrough(),
  z.object({ kind: z.literal('event'), event: eventBase }).passthrough(),
])
export const messageSentEvent = eventBase.extend({
  type: z.literal('thread.message-sent'),
  payload: z.object({ threadId: id, messageId: id, role: z.enum(['user', 'assistant', 'system']), text: z.string(), attachments: z.array(chatAttachment).optional(), turnId: id.nullable(), streaming: z.boolean(), createdAt: isoDate, updatedAt: isoDate }).passthrough(),
})
export const turnDiffCompletedEvent = eventBase.extend({
  type: z.literal('thread.turn-diff-completed'),
  payload: z.object({ threadId: id, turnId: id, checkpointTurnCount: nonNegativeInt, checkpointRef: id, status: z.enum(['ready', 'missing', 'error']), files: z.array(checkpointFile), assistantMessageId: id.nullable(), completedAt: isoDate }).passthrough(),
})

const commandBase = { commandId: id, threadId: id, createdAt: isoDate } as const
export const turnStartCommand = z.object({
  type: z.literal('thread.turn.start'), ...commandBase,
  message: z.object({ messageId: id, role: z.literal('user'), text: z.string(), attachments: z.array(chatAttachment) }).passthrough(),
  modelSelection: modelSelection.optional(),
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']),
}).passthrough()
export const turnInterruptCommand = z.object({ type: z.literal('thread.turn.interrupt'), ...commandBase, turnId: id.optional() }).passthrough()
export const approvalRespondCommand = z.object({ type: z.literal('thread.approval.respond'), ...commandBase, requestId: id, decision: z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']) }).passthrough()
export const userInputRespondCommand = z.object({ type: z.literal('thread.user-input.respond'), ...commandBase, requestId: id, answers: z.record(z.string(), z.unknown()) }).passthrough()
export const dispatchResult = z.object({ sequence: nonNegativeInt }).passthrough()

export const providerUsageWindow = z.object({ usedPercent: z.number().min(0).max(100), resetsAt: isoDate.nullable(), measuredAt: isoDate, source: z.enum(['probe', 'session']) }).passthrough()
export const providerUsage = z.object({ session: providerUsageWindow.nullable(), weekly: providerUsageWindow.nullable(), planLabel: id.optional(), applicable: z.boolean() }).passthrough()
export const serverProvider = z.object({ instanceId: id, driver: id, enabled: z.boolean(), installed: z.boolean(), usage: providerUsage.optional() }).passthrough()

export type T3ShellSnapshot = z.infer<typeof shellSnapshot>
export type T3ThreadDetailSnapshot = z.infer<typeof threadDetailSnapshot>
export type T3ThreadStreamItem = z.infer<typeof threadStreamItem>
