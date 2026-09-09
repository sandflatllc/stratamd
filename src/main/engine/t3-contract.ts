import { z } from 'zod'

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
  refreshProviders: 'server.refreshProviders',
  subscribeServerConfig: 'subscribeServerConfig',
  browseFolder: 'filesystem.browse',
  lookupRepository: 'sourceControl.lookupRepository',
  cloneRepository: 'sourceControl.cloneRepository',
  readSettings: 'server.getSettings',
  createAttachmentUploadUrl: 'attachments.createUploadUrl',
  createAssetUrl: 'assets.createUrl',
  previewAutomationConnect: 'previewAutomation.connect',
  previewAutomationRespond: 'previewAutomation.respond',
} as const

const id = z.string().trim().min(1)
const isoDate = z.iso.datetime({ offset: true })
const nonNegativeInt = z.number().int().nonnegative()
const runtimeMode = z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
const interactionMode = z.enum(['default', 'plan'])
const messageRole = z.enum(['user', 'assistant', 'system'])
const checkpointStatus = z.enum(['ready', 'missing', 'error'])

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
export const assetUrlResult = z.object({ relativeUrl: id, expiresAt: z.number() }).passthrough()
export const attachmentUploadResult = z.object({ attachmentId: id, relativeUrl: id, expiresAt: z.number() }).passthrough()

export const modelOption = z.object({ id: z.string(), value: z.unknown() }).passthrough()
/** Canonical model options are an array of `{id, value}` (T3 migration 026); a legacy object form still appears on old rows, so accept both and normalize to the array. */
export const modelOptions = z.union([
  z.array(modelOption),
  z.record(z.string(), z.unknown()).transform((record) => Object.entries(record).map(([optionId, value]) => ({ id: optionId, value }))),
]).optional()
export const modelSelection = z.object({ instanceId: id, model: id, options: modelOptions }).passthrough()
export const chatAttachment = z.object({
  type: id,
  id,
  name: id,
  mimeType: id,
  sizeBytes: nonNegativeInt,
}).passthrough()
const orchestrationMessageBase = z.object({
  role: messageRole,
  text: z.string(),
  attachments: z.array(chatAttachment).optional(),
  turnId: id.nullable(),
  streaming: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).passthrough()
export const orchestrationMessage = orchestrationMessageBase.extend({ id })

export const checkpointFile = z.object({ path: id, kind: id, additions: nonNegativeInt, deletions: nonNegativeInt }).passthrough()
const checkpointSummaryBase = z.object({
  turnId: id,
  checkpointTurnCount: nonNegativeInt,
  checkpointRef: id,
  status: checkpointStatus,
  files: z.array(checkpointFile),
  assistantMessageId: id.nullable(),
  completedAt: isoDate,
}).passthrough()
export const checkpointSummary = checkpointSummaryBase

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
  runtimeMode,
  activeTurnId: id.nullable(),
  lastError: id.nullable(),
  updatedAt: isoDate,
}).passthrough()
export const orchestrationProject = z.object({
  id, title: id, workspaceRoot: id, defaultModelSelection: modelSelection.nullable(),
  scripts: z.array(z.unknown()), createdAt: isoDate, updatedAt: isoDate, deletedAt: isoDate.nullable(),
}).passthrough()
export const orchestrationProjectShell = orchestrationProject.omit({ deletedAt: true }).passthrough()
const orchestrationThreadBase = z.object({
  id, projectId: id, title: id, modelSelection,
  runtimeMode,
  interactionMode, branch: id.nullable(), worktreePath: id.nullable(),
  latestTurn: z.unknown().nullable(), createdAt: isoDate, updatedAt: isoDate,
  session: orchestrationSession.nullable(),
}).passthrough()
export const orchestrationThreadShell = orchestrationThreadBase.extend({
  latestUserMessageAt: isoDate.nullable(),
  hasPendingApprovals: z.boolean(), hasPendingUserInput: z.boolean(), hasActionableProposedPlan: z.boolean(),
  pinnedAt: isoDate.nullable().optional(), snoozedUntil: isoDate.nullable().optional(),
  archivedAt: isoDate.nullable().optional(), settledAt: isoDate.nullable().optional(),
  settledOverride: z.enum(['settled', 'unsettled']).nullable().optional(),
  backgroundLiveness: z.enum(['working', 'monitoring']).nullable().optional(),
})
export const orchestrationThread = orchestrationThreadBase.extend({
  deletedAt: isoDate.nullable(),
  messages: z.array(orchestrationMessage), activities: z.array(threadActivity),
  checkpoints: z.array(checkpointSummary),
})
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
  payload: orchestrationMessageBase.extend({ messageId: id }).extend({ threadId: id }),
})
export const turnDiffCompletedEvent = eventBase.extend({
  type: z.literal('thread.turn-diff-completed'),
  payload: checkpointSummaryBase.extend({ threadId: id }),
})

const commandBase = { commandId: id, threadId: id, createdAt: isoDate } as const
export const turnStartCommand = z.object({
  type: z.literal('thread.turn.start'), ...commandBase,
  bootstrap: z.object({ prepareWorktree: z.object({ projectCwd: id, baseBranch: id, branch: id, startFromOrigin: z.boolean() }).strict(), runSetupScript: z.literal(true) }).strict().optional(),
  message: z.object({ messageId: id, role: z.literal('user'), text: z.string(), attachments: z.array(chatAttachment) }).passthrough(),
  modelSelection: modelSelection.optional(),
  runtimeMode,
  interactionMode,
}).passthrough()
export const turnInterruptCommand = z.object({ type: z.literal('thread.turn.interrupt'), ...commandBase, turnId: id.optional() }).passthrough()
export const threadCreateCommand = z.object({
  type: z.literal('thread.create'), commandId: id, threadId: id, projectId: id, title: id, modelSelection,
  runtimeMode, interactionMode, branch: id.nullable(), worktreePath: id.nullable(), createdAt: isoDate,
}).passthrough()
export const projectCreateCommand = z.object({
  type: z.literal('project.create'), commandId: id, projectId: id, title: id, workspaceRoot: id,
  createWorkspaceRootIfMissing: z.boolean().optional(), defaultModelSelection: modelSelection.nullable().optional(), createdAt: isoDate,
}).passthrough()
export const threadActionCommand = z.object({ type: z.enum(['thread.delete', 'thread.archive', 'thread.settle', 'thread.unsettle']), commandId: id, threadId: id }).passthrough()
export const threadPinCommand = z.object({ type: z.literal('thread.pin'), commandId: id, threadId: id, orderKey: id.optional() }).strict()
export const threadUnpinCommand = z.object({ type: z.literal('thread.unpin'), commandId: id, threadId: id }).strict()
export const threadSnoozeCommand = z.object({ type: z.literal('thread.snooze'), commandId: id, threadId: id, snoozedUntil: isoDate }).strict()
export const threadUnsnoozeCommand = z.object({ type: z.literal('thread.unsnooze'), commandId: id, threadId: id, reason: z.literal('user') }).strict()
export const threadMetaUpdateCommand = z.object({ type: z.literal('thread.meta.update'), commandId: id, threadId: id, title: id.optional(), modelSelection: modelSelection.optional() }).strict()
export const approvalRespondCommand = z.object({ type: z.literal('thread.approval.respond'), ...commandBase, requestId: id, decision: z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']) }).passthrough()
export const userInputRespondCommand = z.object({ type: z.literal('thread.user-input.respond'), ...commandBase, requestId: id, answers: z.record(z.string(), z.unknown()) }).passthrough()
export const dispatchResult = z.object({ sequence: nonNegativeInt }).passthrough()

export const providerUsageWindow = z.object({ usedPercent: z.number().min(0).max(100), resetsAt: isoDate.nullable(), measuredAt: isoDate, source: z.enum(['probe', 'session']) }).passthrough()
export const providerUsage = z.object({ session: providerUsageWindow.nullable(), weekly: providerUsageWindow.nullable(), planLabel: id.optional(), applicable: z.boolean() }).passthrough()
export const serverProviderAuth = z.object({ status: z.enum(['authenticated', 'unauthenticated', 'unknown']), type: id.optional(), label: id.optional(), email: id.optional() }).passthrough()
const optionDescriptor = z.object({
  id, label: id, type: z.enum(['select', 'boolean']), currentValue: z.union([z.string(), z.boolean()]).optional(),
  options: z.array(z.object({ id, label: id, description: z.string().optional(), isDefault: z.boolean().optional() })).optional(),
})
const providerModel = z.object({ slug: id, name: id, isDefault: z.boolean().optional(), capabilities: z.object({ optionDescriptors: z.array(z.unknown()).transform((items) => items.flatMap((item) => { const parsed = optionDescriptor.safeParse(item); return parsed.success ? [parsed.data] : [] })).optional() }).nullable().optional() })
export const serverProvider = z.object({
  instanceId: id, driver: id, displayName: id.optional(), enabled: z.boolean(), installed: z.boolean(), version: id.nullable().optional(),
  status: z.string(), auth: serverProviderAuth, message: id.optional(), availability: z.string().optional(), unavailableReason: id.optional(),
  usage: providerUsage.optional(),
  models: z.array(z.unknown()).transform((items) => items.flatMap((item) => { const parsed = providerModel.safeParse(item); return parsed.success ? [parsed.data] : [] })).optional(),
}).passthrough()
/**
 * The slice of `server.getConfig` Accounts reads (§5.13). Providers decode one
 * by one so a provider this build cannot read drops out instead of failing the
 * whole config, the same forward-compatible rule T3's own clients follow.
 */
export const serverConfigSlice = z.object({
  providers: z.array(z.unknown()).transform((items) => items.flatMap((item) => { const parsed = serverProvider.safeParse(item); return parsed.success ? [parsed.data] : [] })),
  settings: z.object({
    providerInstances: z.record(z.string(), z.object({ config: z.object({ homePath: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough()

export type T3ShellSnapshot = z.infer<typeof shellSnapshot>
export type T3ThreadDetailSnapshot = z.infer<typeof threadDetailSnapshot>
export type T3ThreadStreamItem = z.infer<typeof threadStreamItem>
export type T3ServerProvider = z.infer<typeof serverProvider>
export type T3ServerConfigSlice = z.infer<typeof serverConfigSlice>

export const browseFolderInput = z.object({ partialPath: id.max(512) }).strict()
export const browseFolderResult = z.object({ parentPath: id, entries: z.array(z.object({ name: id, fullPath: id })) })
export const lookupRepositoryInput = z.object({ provider: z.literal('github'), repository: id }).strict()
export const repositoryResult = z.object({ provider: id, nameWithOwner: id, url: id, sshUrl: id })
export const cloneRepositoryInput = z.union([
  z.object({ destinationPath: id, remoteUrl: id }).strict(),
  z.object({ destinationPath: id, provider: z.literal('github'), repository: id }).strict(),
])
export const cloneRepositoryResult = z.object({ cwd: id, remoteUrl: id, repository: repositoryResult.nullable() })
export const providerInstanceSettings = z.object({ driver: id, displayName: id.optional(), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }).passthrough()
export const engineSettingsResult = z.object({ addProjectBaseDirectory: z.string().optional(), newWorktreesStartFromOrigin: z.boolean().optional(), providerInstances: z.record(z.string(), providerInstanceSettings).default({}) }).passthrough()

export const providerSlug = z.string().max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
export const updateProviderInstancesInput = z.object({ patch: z.object({ providerInstances: z.record(providerSlug, providerInstanceSettings.extend({ driver: providerSlug })) }).strict() }).strict()

export const worktreeRequest = z.object({ kind: z.literal('worktree'), baseBranch: id, startFromOrigin: z.boolean() }).strict()
export const listRefsInput = z.object({ cwd: id, query: id.max(256).optional(), cursor: nonNegativeInt.optional(), limit: z.number().int().positive().optional(), includeMatchingRemoteRefs: z.boolean().optional() }).strict()
export const listRefsResult = z.object({ refs: z.array(z.object({ name: id, current: z.boolean(), isDefault: z.boolean(), worktreePath: id.nullable(), isRemote: z.boolean().optional(), remoteName: id.optional() })), isRepo: z.boolean(), hasPrimaryRemote: z.boolean(), nextCursor: nonNegativeInt.nullable(), totalCount: nonNegativeInt })

export const terminalTarget = z.object({ threadId: id, terminalId: id.max(128) }).strict()
const terminalGrid = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }
export const terminalAttachInput = terminalTarget.extend({ cwd: id, ...terminalGrid, restartIfNotRunning: z.boolean() }).strict()
export const terminalWriteInput = terminalTarget.extend({ data: z.string().min(1).max(65_536) }).strict()
export const terminalResizeInput = terminalTarget.extend(terminalGrid).strict()
export const terminalVoidResult = z.union([z.void(), z.null()])
const terminalSnapshot = terminalTarget.extend({ cwd: id, worktreePath: id.nullable(), status: z.enum(['starting', 'running', 'exited', 'error']), history: z.string(), label: z.string().max(128), updatedAt: z.string(), sequence: nonNegativeInt.optional() }).passthrough()
const terminalEventBase = terminalTarget.extend({ sequence: nonNegativeInt.optional() })
export const terminalStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: terminalSnapshot }),
  terminalEventBase.extend({ type: z.literal('restarted'), snapshot: terminalSnapshot }),
  terminalEventBase.extend({ type: z.literal('output'), data: z.string() }),
  terminalEventBase.extend({ type: z.literal('activity'), hasRunningSubprocess: z.boolean(), label: z.string().max(128) }),
  terminalEventBase.extend({ type: z.literal('error'), message: id }),
  terminalEventBase.extend({ type: z.literal('exited'), exitCode: z.number().int().nullable(), exitSignal: z.number().int().nullable() }),
  terminalEventBase.extend({ type: z.literal('cleared') }),
  terminalEventBase.extend({ type: z.literal('closed') }),
])

export const usageWindow = z.enum(['24h', '7d', '30d', '90d'])
const usageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const usageProvider = z.enum(['claude', 'codex', 'grok'])
export const usageSummaryInput = z.object({ sinceDay: usageDay, untilDay: usageDay, timeZone: id, resolution: z.enum(['day', 'hour']).optional(), sinceTime: z.string().datetime().optional(), untilTime: z.string().datetime().optional() }).strict()
export const usageSummaryResult = z.object({
  contractVersion: z.union([z.literal(4), z.literal(5)]), readAt: z.string(), timeZone: id, sinceDay: usageDay, untilDay: usageDay,
  buckets: z.array(z.object({ day: usageDay, hourStart: z.string().datetime().optional(), provider: usageProvider, model: id,
    totals: z.object({ uncachedInputTokens: nonNegativeInt, cachedInputTokens: nonNegativeInt, cacheCreationTokens: nonNegativeInt, outputTokens: nonNegativeInt, reasoningTokens: nonNegativeInt }),
    costUsd: z.number().finite(), cacheSavingsUsd: z.number().finite(), costSource: z.enum(['providerReported', 'modelPriced', 'unpriced']), records: nonNegativeInt, unpricedRecords: nonNegativeInt, sessions: nonNegativeInt })),
  sources: z.array(z.object({ fingerprint: z.object({ hostId: id, provider: usageProvider, resolvedHomePath: id, volumeId: z.string() }), status: z.enum(['ok', 'missing', 'partial', 'failed']), scannedFiles: nonNegativeInt, skippedFiles: nonNegativeInt, malformedRecords: nonNegativeInt, distinctSessions: nonNegativeInt, message: id.nullable() })),
  pricing: z.object({ status: z.enum(['fresh', 'cached', 'unavailable']), source: id, fetchedAt: z.string().nullable(), knownModels: nonNegativeInt }), scanDurationMs: nonNegativeInt,
})
