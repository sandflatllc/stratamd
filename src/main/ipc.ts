import { isLocalPage } from './local-link'
import { recoveryRequest } from '../shared/engine-recovery'
import { computerRequest } from '../shared/computer'
import { providerSetupRequest } from '../shared/provider-setup'
import { engineSettingsEditSchema, providerEditSchema } from '../shared/engine-settings'
import type { ContextMenuParams, IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { z } from 'zod'
import type { AppView, SpellingContext, StrataApi, BufferOrigin, BufferBlockRange } from '../shared/contracts'
import { encodeViewUpdate, sameJson, type SyncedView } from '../shared/view-sync'
import { IPC, type InvokeChannel } from '../preload/channels'
import { electronFileOps, type FileOps } from './file-ops'
import { logError, logRendererReport } from './log'
import { annotationContextSchema } from './validation'
import type { WindowController } from './window-controls'
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, SUPPORTED_IMAGE_TYPES } from '../core/composer-attachments'
import { usageWindow, terminalAttachInput, terminalWriteInput, terminalResizeInput, terminalTarget, worktreeRequest, cloneRepositoryInput } from './engine/t3-contract'
import { isStagedAttachmentId } from './engine/staged-attachments'
import { isVisualCommentId } from '../core/visual-comments'

type StrataIpcApi = Omit<StrataApi, 'subscribe'>

const pathSchema = z.string().min(1).max(16_384)
const idSchema = z.string().min(1).max(512)
const textSchema = z.string().max(64 * 1_024)
const stagedAttachmentIdSchema = z.string().refine(isStagedAttachmentId, 'Not a staged attachment id')
const visualCommentIdSchema = z.string().max(64).refine(isVisualCommentId, 'Not a visual comment id')
const previewTabIdSchema = z.string().regex(/^tab_[0-9a-f-]{36}$/u)
const visualPointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()
const visualRectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict()
const visualIdentitySchema = z.object({
  role: z.string().max(64).nullable().optional(), name: z.string().max(512).nullable().optional(), text: z.string().max(512).nullable().optional(),
  testIds: z.array(z.string().max(256)).max(16).optional(), selector: z.string().max(2_048).nullable().optional(), html: z.string().max(512).nullable().optional(),
  style: z.record(z.string().max(64), z.string().max(256)).optional(),
  sources: z.array(z.object({ file: z.string().max(1_024), line: z.number().int().nonnegative(), column: z.number().int().nonnegative(), role: z.enum(['definition', 'usage', 'candidate']).optional() }).strict()).max(16).optional(),
  viewportRect: visualRectSchema.optional(), pageRect: visualRectSchema.optional(),
}).strict()
const visualMarkSchema = z.object({ id: idSchema, kind: z.enum(['element', 'region']), label: z.string().max(512), captureId: idSchema, rect: visualRectSchema, found: z.boolean().nullable(), identity: visualIdentitySchema.optional() }).strict()
const visualStrokeSchema = z.object({ id: idSchema, tool: z.enum(['draw', 'arrow']), captureId: idSchema, points: z.array(visualPointSchema).max(20_000) }).strict()
const visualAdjustmentSchema = z.object({ markId: idSchema, property: z.string().max(128), value: z.string().max(512), label: z.string().max(512) }).strict()
const holdVisualCommentSchema = z.object({
  id: visualCommentIdSchema.optional(),
  projectId: idSchema,
  threadId: idSchema,
  source: z.object({ staged: stagedAttachmentIdSchema, name: idSchema, width: z.number().int().positive().max(32_768), height: z.number().int().positive().max(32_768) }).strict().optional(),
  page: z.object({
    tabId: previewTabIdSchema,
    captures: z.array(z.object({ id: z.string().regex(/^e_/u).max(64), width: z.number().int().positive().max(32_768), height: z.number().int().positive().max(32_768), scroll: visualPointSchema, scale: z.number().positive().max(16), requested: z.boolean().optional() }).strict()).min(1).max(32),
    url: z.string().max(2_048), title: z.string().max(1_024), viewport: z.object({ width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384) }).strict(), preset: z.string().max(64).nullable(), deviceScale: z.number().positive().max(16),
  }).strict().optional(),
  text: z.string().max(20_000),
  marks: z.array(visualMarkSchema).max(200),
  strokes: z.array(visualStrokeSchema).max(500),
  adjustments: z.array(visualAdjustmentSchema).max(200),
  marked: z.array(z.object({ captureId: idSchema, bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength >= 1 && bytes.byteLength <= MAX_IMAGE_BYTES * 4, 'Image size out of range') }).strict()).max(32),
}).strict()
const modelOptionsSchema = z.array(z.object({ id: idSchema, value: z.union([idSchema, z.boolean()]) }).strict()).max(64)
const conversationTurnSchema = z.object({
  workspace: worktreeRequest.optional(),
  comments: z.record(idSchema, z.number().int().positive()).optional(),
  replies: z.record(idSchema, textSchema).optional(),
  messageId: idSchema.optional(),
  commandId: idSchema.optional(),
  // Empty text is allowed: queued item replies alone make a Send (§5.4); the client refuses a turn with neither.
  text: textSchema,
  instanceId: idSchema.nullable().optional(),
  model: idSchema,
  effort: idSchema.nullable(),
  options: modelOptionsSchema.optional(),
  access: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  visual: z.array(visualCommentIdSchema).max(64).optional(),
  attachments: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), name: idSchema, text: z.string().max(MAX_TEXT_BYTES) }).strict(),
    // Image bytes never cross this channel; the renderer staged them and names the id (§6.0).
    z.object({ kind: z.literal('image'), id: stagedAttachmentIdSchema, name: idSchema, mimeType: z.enum(SUPPORTED_IMAGE_TYPES), sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES) }).strict(),
  ])).max(MAX_ATTACHMENTS).optional(),
}).strict()
const stageAttachmentSchema = z.object({
  name: idSchema,
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength >= 1 && bytes.byteLength <= MAX_IMAGE_BYTES, 'Image size out of range'),
}).strict()
const sendRequestSchema = z.object({
  conversation: z.record(idSchema, z.object({ deliveryId: idSchema, comments: z.record(idSchema, z.number().int().positive()), replies: z.record(idSchema, textSchema) }).strict()).optional(),
  recipients: z.array(idSchema).max(128),
  note: textSchema,
  includeExternal: z.boolean(),
  excludedHunks: z.array(z.string().max(256)).max(4_096).optional(),
  excludedEvents: z.array(z.number().int().nonnegative()).max(4_096).optional(),
  draftIds: z.array(idSchema).max(4_096).optional(),
  token: z.object({
    snapshotId: z.string().max(128),
    segmentIndex: z.number().int().min(-1),
    cursor: z.number().int().nonnegative()
  }).strict().optional()
}).strict()
const themeIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)
const readingStatePatchSchema = z.object({
  navigationTab: z.enum(['projects', 'conversation', 'contents']).optional(),
  reviewTab: z.enum(['changes', 'annotations']).optional(),
}).strict()
const headingReferenceSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  text: z.string().trim().min(1).max(512),
  parentText: z.string().max(512).nullable(),
  previousText: z.string().max(512).nullable(),
  nextText: z.string().max(512).nullable(),
}).strict()
const walkthroughActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('leave') }).strict(),
  z.object({ type: z.literal('set-level'), level: z.enum(['h2', 'h2-h3']) }).strict(),
  z.object({ type: z.literal('set-current'), heading: headingReferenceSchema }).strict(),
  z.object({ type: z.literal('set-included'), heading: headingReferenceSchema, included: z.boolean() }).strict(),
  z.object({ type: z.literal('mark'), heading: headingReferenceSchema, status: z.enum(['reviewed', 'revisit']) }).strict(),
])
const tableReferenceSchema = z.object({
  headingLevel: z.number().int().min(1).max(6).nullable(),
  headingText: z.string().max(512).nullable(),
  headers: z.array(z.string().max(512)).min(1).max(100),
  occurrence: z.number().int().nonnegative().max(10_000),
}).strict()
const tableViewSchema = z.object({
  table: tableReferenceSchema,
  presentation: z.enum(['table', 'focus-row', 'compare']),
  sort: z.object({ column: z.number().int().nonnegative().max(99), direction: z.enum(['ascending', 'descending']) }).strict().nullable(),
  filter: z.object({ column: z.number().int().nonnegative().max(99), query: z.string().max(1_000) }).strict().nullable(),
  hiddenColumns: z.array(z.number().int().nonnegative().max(99)).max(100),
  selectedRows: z.array(z.number().int().nonnegative().max(100_000)).max(10_000),
  focusedRow: z.number().int().nonnegative().max(100_000).nullable(),
  focusedColumn: z.number().int().nonnegative().max(99).nullable(),
  density: z.enum(['comfortable', 'compact']),
  columnWidths: z.array(z.number().int().min(80).max(640)).max(100),
}).strict()
const draftRequestSchema = z.object({
  kind: z.enum(['comment', 'question', 'suggestion']),
  quote: z.string().min(1),
  text: textSchema.refine((value) => value.trim().length > 0),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  context: annotationContextSchema.optional(),
}).strict()
const quickSendRequestSchema = draftRequestSchema.extend({
  recipients: z.array(idSchema).max(128),
}).strict()
const startThreadSchema = z.object({
  workspace: worktreeRequest.optional(),
  branch: idSchema.nullable().optional(),
  worktreePath: pathSchema.nullable().optional(),
  threadId: idSchema.optional(),
  projectId: idSchema,
  title: idSchema,
  model: idSchema,
  effort: idSchema.nullable(),
  options: modelOptionsSchema.optional(),
  access: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  instanceId: idSchema.nullable().optional(),
}).strict()
const settingsSchema = z.object({
  animatedBackground: z.boolean().optional(),
  panelSizes: z.object({
    explorerWidth: z.number().positive().finite(),
    rightRailWidth: z.number().positive().finite(),
    upperReviewHeight: z.number().positive().finite(),
    documentMeasure: z.number().positive().finite(),
    themePanel: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().positive().finite(),
      height: z.number().positive().finite()
    }).strict(),
    annotationComposer: z.object({
      width: z.number().positive().finite(),
      height: z.number().finite().min(-1)
    }).strict(),
    sendComposer: z.object({
      width: z.number().positive().finite(),
      height: z.number().finite().min(-1)
    }).strict()
  }).strict().optional(),
  zoom: z.object({
    explorer: z.number().positive().finite(),
    editor: z.number().positive().finite(),
    rightRail: z.number().positive().finite(),
    composer: z.number().positive().finite(),
    themePanel: z.number().positive().finite().optional()
  }).strict().optional()
}).strict()

const argumentSchemas: Record<InvokeChannel, z.ZodType> = {
  [IPC.state]: z.tuple([]),
  [IPC.windowState]: z.tuple([]),
  [IPC.minimizeWindow]: z.tuple([]),
  [IPC.toggleMaximizeWindow]: z.tuple([]),
  [IPC.closeWindow]: z.tuple([]),
  [IPC.pairEngine]: z.tuple([z.union([
    z.object({ link: z.string().trim().min(1).max(4_096) }).strict(),
    z.object({ host: z.string().trim().min(1).max(2_048), code: idSchema }).strict(),
  ])]),
  [IPC.manageEngine]: z.tuple([z.enum(['restart', 'use-managed', 'show-log'])]),
  [IPC.reconnectEngine]: z.tuple([]),
  [IPC.openConversation]: z.tuple([idSchema]),
  [IPC.createEngineThread]: z.tuple([startThreadSchema]),
  [IPC.createEngineProject]: z.tuple([z.object({ title: z.string().trim().min(1).max(512), workspaceRoot: pathSchema, createWorkspaceRootIfMissing: z.boolean().optional() }).strict()]),
  [IPC.startThreadFromDocument]: z.tuple([pathSchema, startThreadSchema.extend({ threadId: idSchema.optional(), note: textSchema.optional(), comment: draftRequestSchema.optional(), draftIds: z.array(idSchema).max(4_096).optional() }).strict()]),
  [IPC.actOnEngineThread]: z.tuple([idSchema, z.enum(['archive', 'settle', 'unsettle', 'delete'])]),
  [IPC.parkAccount]: z.tuple([idSchema, z.boolean()]),
  [IPC.updateEngineThread]: z.tuple([idSchema, z.object({ pinned: z.boolean().optional(), snoozedUntil: z.iso.datetime({ offset: true }).nullable().optional(), title: z.string().trim().min(1).max(512).optional(), unread: z.boolean().optional() }).strict()]),
  [IPC.setTerminalDefault]: z.tuple([idSchema, idSchema.nullable()]),
  [IPC.readEngineUsage]: z.tuple([usageWindow]),
  [IPC.engineRecovery]: z.tuple([recoveryRequest]),
  [IPC.computer]: z.tuple([computerRequest]),
  [IPC.providerSetup]: z.tuple([providerSetupRequest]),
  [IPC.readEngineSupport]: z.tuple([]),
  [IPC.readEngineSettings]: z.tuple([]),
  [IPC.editEngineSettings]: z.tuple([engineSettingsEditSchema]),
  [IPC.editEngineProvider]: z.tuple([providerEditSchema]),
  [IPC.browseEngineFolder]: z.tuple([z.string().trim().min(1).max(512)]),
  [IPC.lookupEngineRepository]: z.tuple([idSchema]),
  [IPC.cloneEngineRepository]: z.tuple([cloneRepositoryInput]),
  [IPC.setModelPreference]: z.tuple([idSchema, idSchema, z.object({ favorite: z.boolean().optional(), hidden: z.boolean().optional(), order: z.array(idSchema).max(1024).optional() }).strict()]),
  [IPC.listEngineRefs]: z.tuple([pathSchema, z.string().max(256).optional()]),
  [IPC.attachEngineTerminal]: z.tuple([terminalAttachInput.omit({ restartIfNotRunning: true }).extend({ attachmentId: idSchema }).strict()]),
  [IPC.detachEngineTerminal]: z.tuple([idSchema]),
  [IPC.writeEngineTerminal]: z.tuple([terminalWriteInput]),
  [IPC.resizeEngineTerminal]: z.tuple([terminalResizeInput]),
  [IPC.closeEngineTerminal]: z.tuple([terminalTarget]),
  [IPC.refreshAccounts]: z.tuple([]),
  [IPC.holdMessageComment]: z.tuple([idSchema, z.object({ id: idSchema.optional(), messageId: idSchema, from: z.number().int().nonnegative(), to: z.number().int().positive(), kind: z.enum(['comment', 'question', 'suggestion']), text: z.string().min(1).max(20000) }).strict()]),
  [IPC.actMessageComment]: z.tuple([idSchema, idSchema, z.enum(['resolve', 'reopen', 'discard'])]),
  [IPC.runAskScan]: z.tuple([z.string().nullable(), idSchema, idSchema]),
  [IPC.cancelAskScan]: z.tuple([z.string().nullable(), idSchema]),
  [IPC.saveAskDraft]: z.tuple([z.string().nullable(), idSchema, idSchema, z.string().max(20_000)]),
  [IPC.queueItemReply]: z.tuple([idSchema, idSchema, z.string().max(20_000)]),
  [IPC.discardItemReply]: z.tuple([idSchema, idSchema]),
  [IPC.dismissItem]: z.tuple([idSchema, idSchema]),
  [IPC.retainVisualEvidence]: z.tuple([idSchema, z.array(z.string().regex(/^e_[0-9a-f-]{36}$/)).max(128)]),
  [IPC.holdVisualComment]: z.tuple([holdVisualCommentSchema]),
  [IPC.actVisualComment]: z.tuple([visualCommentIdSchema, z.enum(['accept', 'reopen', 'discard', 'retry', 'compare'])]),
  [IPC.openPreviewTab]: z.tuple([z.object({ projectId: idSchema, url: z.string().max(2_048).optional() }).strict()]),
  [IPC.closePreviewTab]: z.tuple([previewTabIdSchema]),
  [IPC.navigatePreview]: z.tuple([previewTabIdSchema, z.union([z.object({ url: z.string().max(2_048) }).strict(), z.object({ action: z.enum(['back', 'forward', 'reload', 'stop']) }).strict()])]),
  [IPC.resizePreview]: z.tuple([previewTabIdSchema, z.discriminatedUnion('mode', [z.object({ mode: z.literal('fill') }).strict(), z.object({ mode: z.literal('preset'), preset: z.string().max(64) }).strict(), z.object({ mode: z.literal('freeform'), width: z.number().int().positive().max(8_192), height: z.number().int().positive().max(8_192) }).strict()])]),
  [IPC.resumePreviewTab]: z.tuple([previewTabIdSchema]),
  [IPC.reportPreviewBounds]: z.tuple([z.object({ tabId: previewTabIdSchema.nullable(), bounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict().nullable() }).strict()]),
  [IPC.reportOverlay]: z.tuple([z.boolean()]),
  [IPC.previewProbe]: z.tuple([previewTabIdSchema, z.object({ x: z.number().finite(), y: z.number().finite() }).strict()]),
  [IPC.capturePreviewFrame]: z.tuple([previewTabIdSchema]),
  [IPC.describePreview]: z.tuple([previewTabIdSchema, z.union([z.object({ point: visualPointSchema }).strict(), z.object({ rect: visualRectSchema }).strict()])]),
  [IPC.scrollPreview]: z.tuple([previewTabIdSchema, z.union([z.object({ by: visualPointSchema }).strict(), z.object({ to: visualPointSchema }).strict()])]),
  [IPC.showVisualComment]: z.tuple([visualCommentIdSchema]),
  [IPC.adjustPreview]: z.tuple([previewTabIdSchema, z.array(z.object({ markId: idSchema, identity: visualIdentitySchema, declarations: z.record(z.string().regex(/^[a-z-]{1,64}$/u), z.string().max(256)) }).strict()).max(64)]),
  [IPC.clearPreviewOverrides]: z.tuple([previewTabIdSchema]),
  [IPC.startConversationTurn]: z.tuple([idSchema, conversationTurnSchema]),
  [IPC.stageConversationAttachment]: z.tuple([stageAttachmentSchema]),
  [IPC.discardConversationAttachment]: z.tuple([stagedAttachmentIdSchema]),
  [IPC.retainConversationAttachments]: z.tuple([z.array(stagedAttachmentIdSchema).max(4_096)]),
  [IPC.stopConversationTurn]: z.tuple([idSchema]),
  [IPC.answerEngineApproval]: z.tuple([idSchema, idSchema, z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'])]),
  [IPC.answerEngineUserInput]: z.tuple([idSchema, idSchema, z.record(z.string(), z.unknown())]),
  [IPC.openDocument]: z.tuple([pathSchema.optional()]),
  [IPC.closeDocument]: z.tuple([pathSchema, z.enum(['save', 'discard', 'cancel']).optional()]),
  [IPC.updateBuffer]: z.tuple([
    pathSchema, z.string(), z.enum(['edit', 'history']),
    z.array(z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict()).optional(),
  ]).refine(([, content, , ranges]) => ranges === undefined || ranges.every((range, index) =>
    range.from < range.to && range.to <= content.length && (index === 0 || ranges[index - 1]!.to <= range.from)),
  'Block ranges must be ordered, nonempty, and within the buffer text'),
  [IPC.undo]: z.tuple([pathSchema]),
  [IPC.redo]: z.tuple([pathSchema]),
  [IPC.save]: z.tuple([pathSchema]),
  [IPC.setSourceMode]: z.tuple([pathSchema, z.boolean()]),
  [IPC.updateReadingState]: z.tuple([pathSchema, readingStatePatchSchema]),
  [IPC.updateWalkthrough]: z.tuple([pathSchema, walkthroughActionSchema]),
  [IPC.updateTableView]: z.tuple([pathSchema, tableViewSchema]),
  [IPC.updateFold]: z.tuple([pathSchema, headingReferenceSchema, z.boolean()]),
  [IPC.keepHunk]: z.tuple([pathSchema, idSchema]),
  [IPC.revertHunk]: z.tuple([pathSchema, idSchema, z.boolean().optional()]),
  [IPC.markReviewed]: z.tuple([pathSchema]),
  [IPC.saveRound]: z.tuple([pathSchema, z.number().int().nonnegative()]),
  [IPC.addAnnotation]: z.tuple([pathSchema, z.union([
    z.object({
      kind: z.enum(['comment', 'question', 'suggestion']),
      quote: z.string().min(1),
      text: textSchema,
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      context: annotationContextSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('decision'),
      quote: z.string().min(1),
      text: textSchema.refine((value) => value.trim().length > 0),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      anchor: z.enum(['quote', 'heading']),
      options: z.array(textSchema.refine((value) => value.trim().length > 0)).min(2).max(50)
        .refine((values) => new Set(values.map((value) => value.trim())).size === values.length),
    }).strict(),
    z.object({
      kind: z.literal('decision'),
      quote: z.literal(''),
      text: textSchema.refine((value) => value.trim().length > 0),
      from: z.literal(0),
      to: z.literal(0),
      anchor: z.literal('document'),
      options: z.array(textSchema.refine((value) => value.trim().length > 0)).min(2).max(50)
        .refine((values) => new Set(values.map((value) => value.trim())).size === values.length),
    }).strict(),
  ])]),
  [IPC.holdDraft]: z.tuple([pathSchema, draftRequestSchema]),
  [IPC.discardDraft]: z.tuple([pathSchema, idSchema]),
  [IPC.quickSend]: z.tuple([pathSchema, quickSendRequestSchema]),
  [IPC.requoteAnnotation]: z.tuple([pathSchema, idSchema, z.object({
    quote: z.string().min(1),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative()
  }).strict()]),
  [IPC.reply]: z.tuple([pathSchema, idSchema, textSchema]),
  [IPC.resolveAnnotation]: z.tuple([pathSchema, idSchema]),
  [IPC.answerDecision]: z.tuple([pathSchema, idSchema, z.union([
    z.object({ option: textSchema.refine((value) => value.trim().length > 0) }).strict(),
    z.object({ option: z.null(), other: textSchema.refine((value) => value.trim().length > 0) }).strict(),
  ])]),
  [IPC.reopenDecision]: z.tuple([pathSchema, idSchema]),
  [IPC.acceptSuggestion]: z.tuple([pathSchema, idSchema]),
  [IPC.rejectSuggestion]: z.tuple([pathSchema, idSchema]),
  [IPC.acceptAllSuggestions]: z.tuple([pathSchema, idSchema]),
  [IPC.rejectAllSuggestions]: z.tuple([pathSchema, idSchema]),
  [IPC.clearResolvedAnnotations]: z.tuple([pathSchema]),
  [IPC.resolveRecovery]: z.tuple([pathSchema, z.enum(['recover', 'discard'])]),
  [IPC.resolveConflict]: z.tuple([pathSchema, idSchema, z.enum(['mine', 'incoming'])]),
  [IPC.previewSend]: z.tuple([pathSchema, sendRequestSchema]),
  [IPC.send]: z.tuple([pathSchema, sendRequestSchema]),
  [IPC.copyText]: z.tuple([textSchema]),
  [IPC.setLead]: z.tuple([pathSchema, idSchema.nullable()]),
  [IPC.detachThread]: z.tuple([pathSchema, idSchema]),
  [IPC.addFolder]: z.tuple([]),
  [IPC.removeFolder]: z.tuple([pathSchema]),
  [IPC.scanFolder]: z.tuple([pathSchema]),
  [IPC.refreshExplorer]: z.tuple([]),
  [IPC.forgetDocument]: z.tuple([pathSchema]),
  [IPC.updateSettings]: z.tuple([settingsSchema]),
  [IPC.selectTheme]: z.tuple([themeIdSchema]),
  [IPC.createTheme]: z.tuple([z.string().trim().min(1).max(120), themeIdSchema]),
  [IPC.setThemeValue]: z.tuple([z.string().regex(/^[a-z]+\.[a-z0-9-]+$/), z.union([z.string().max(256), z.number().finite(), z.null()])]),
  [IPC.renameTheme]: z.tuple([z.string().trim().min(1).max(120)]),
  [IPC.revertTheme]: z.tuple([z.record(z.string(), z.unknown())]),
  [IPC.deleteTheme]: z.tuple([themeIdSchema]),
  [IPC.listFonts]: z.tuple([]),
  [IPC.openThemeSample]: z.tuple([]),
  [IPC.resolveLocalImage]: z.tuple([pathSchema, z.string().min(1).max(16_384)]),
  [IPC.resolveLocalMarkdown]: z.tuple([pathSchema, z.string().min(1).max(16_384)]),
  [IPC.openExternal]: z.tuple([z.string().url().max(16_384)]),
  [IPC.resolveLocalLink]: z.tuple([z.object({ projectId: idSchema.nullable(), href: z.string().min(1).max(16_384), documentPath: pathSchema.optional() }).strict()]),
  [IPC.addDictionaryWord]: z.tuple([z.string().min(1).max(512)]),
  [IPC.flashWindow]: z.tuple([]),
  [IPC.createFile]: z.tuple([pathSchema, z.string().min(1).max(255).optional()]),
  [IPC.renameFile]: z.tuple([pathSchema, z.string().min(1).max(255)]),
  [IPC.trashFile]: z.tuple([pathSchema]),
  [IPC.revealFile]: z.tuple([pathSchema]),
  [IPC.openFileDialog]: z.tuple([]),
  [IPC.pasteFromClipboard]: z.tuple([])
}

/**
 * The context-menu params that qualify for the annotate menu's spelling column,
 * or null (docs/plans/completed/spellcheck-plan.md). Suggestions keep Electron's order.
 * A non-empty misspelledWord is itself the proof the spellchecker ran; the
 * params' spellcheckEnabled flag reads false even then, so it gates nothing.
 */
export function spellingContext(
  params: Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions'>
): SpellingContext | null {
  if (!params.isEditable || !params.misspelledWord) return null
  return { word: params.misspelledWord, suggestions: [...params.dictionarySuggestions] }
}

// Field caps mirror the log contract (docs/plans/completed/crash-hardening-plan.md §5).
const errorReportSchema = z.object({
  scope: z.string().min(1).max(100),
  message: z.string().min(1).max(2_000),
  stack: z.string().max(4_000).optional(),
  componentStack: z.string().max(4_000).optional()
}).strict()

export interface RegisterIpcOptions {
  ipcMain: IpcMain
  api: StrataIpcApi
  renderer: WebContents
  allowedRendererUrls?: readonly string[]
  openExternal?: (url: string) => Promise<void>
  /** Explorer file operations; the default wires Electron's shell and dialog lazily. */
  fileOps?: () => Promise<FileOps>
  /** Attention request for the unfocused window; the default flashes the renderer's BrowserWindow. */
  flashWindow?: () => Promise<void>
  windowControls?: WindowController
}

export interface RegisteredIpc {
  publish(state: AppView): void
  dispose(): void
}

export function registerStrataIpc(options: RegisterIpcOptions): RegisteredIpc {
  const allowedRendererUrls = options.allowedRendererUrls ?? ['app://stratamd/']
  const openExternal = options.openExternal ?? openExternalUrl
  const openTabPaths = async (): Promise<readonly string[]> => (await options.api.getState()).tabs.map((tab) => tab.path)
  let fileOps: Promise<FileOps> | null = null
  const files = (): Promise<FileOps> => {
    fileOps ??= options.fileOps ? options.fileOps() : electronFileOps(openTabPaths)
    return fileOps
  }
  const flashWindow = options.flashWindow ?? (async () => {
    const { BrowserWindow } = await import('electron')
    const window = BrowserWindow.fromWebContents(options.renderer)
    if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true)
  })
  const controls = (): WindowController => {
    if (!options.windowControls) throw new Error('Window controls are unavailable')
    return options.windowControls
  }
  const stopWindowEvents = options.windowControls?.subscribe(state => {
    if (!options.renderer.isDestroyed()) options.renderer.send(IPC.windowStateChanged, state)
  })
  const verify = process.env.STRATAMD_VIEW_VERIFY === '1'
  let lastSent: SyncedView | null = null
  let nextSeq = 0
  const record = (view: AppView): SyncedView => {
    nextSeq += 1
    lastSent = { seq: nextSeq, view }
    return lastSent
  }
  const handlers: Record<InvokeChannel, (...args: never[]) => unknown> = {
    [IPC.windowState]: () => controls().getState(),
    [IPC.minimizeWindow]: () => controls().minimize(),
    [IPC.toggleMaximizeWindow]: () => controls().toggleMaximize(),
    [IPC.closeWindow]: () => controls().close(),
    [IPC.state]: async () => {
      // A publish during the await is at least as fresh as this view (every
      // engine mutation publishes synchronously), so never rewind lastSent.
      const before = nextSeq
      const view = await options.api.getState()
      if (before !== nextSeq) return lastSent!
      // Repeated reads must not create an unseen sequence between the
      // renderer's current state and the next pushed patch.
      return lastSent && sameJson(lastSent.view, view) ? lastSent : record(view)
    },
    [IPC.pairEngine]: (request: Parameters<StrataApi['pairEngine']>[0]) => options.api.pairEngine(request),
    [IPC.manageEngine]: (action: 'restart' | 'use-managed' | 'show-log') => { if (!options.api.manageEngine) throw new Error('Local engine controls are unavailable'); return options.api.manageEngine(action) },
    [IPC.reconnectEngine]: () => options.api.reconnectEngine(),
    [IPC.openConversation]: (threadId: string) => options.api.openConversation(threadId),
    [IPC.createEngineThread]: (input: Parameters<StrataApi['createEngineThread']>[0]) => options.api.createEngineThread(input),
    [IPC.createEngineProject]: (input: Parameters<StrataApi['createEngineProject']>[0]) => options.api.createEngineProject(input),
    [IPC.startThreadFromDocument]: (path: string, input: Parameters<StrataApi['startThreadFromDocument']>[1]) => options.api.startThreadFromDocument(path, input),
    [IPC.actOnEngineThread]: (threadId: string, action: Parameters<StrataApi['actOnEngineThread']>[1]) => options.api.actOnEngineThread(threadId, action),
    [IPC.parkAccount]: (instanceId: string, parked: boolean) => options.api.parkAccount(instanceId, parked),
    [IPC.updateEngineThread]: (threadId: string, change: Parameters<StrataApi['updateEngineThread']>[1]) => options.api.updateEngineThread(threadId, change),
    [IPC.setTerminalDefault]: (driver: string, selection: string | null) => options.api.setTerminalDefault(driver, selection),
    [IPC.readEngineUsage]: (window: import('../shared/usage').UsageWindow) => options.api.readEngineUsage(window),
    [IPC.engineRecovery]: (request: import('../shared/engine-recovery').RecoveryRequest) => { if (!options.api.engineRecovery) throw new Error('Recovery is unavailable'); return options.api.engineRecovery(request) },
    [IPC.computer]: (request: import('../shared/computer').ComputerRequest) => { if (!options.api.computer) throw new Error('Computer controls are unavailable'); return options.api.computer(request) },
    [IPC.providerSetup]: (request: import('../shared/provider-setup').ProviderSetupRequest) => { if (!options.api.providerSetup) throw new Error('Provider setup is unavailable'); return options.api.providerSetup(request) },
    [IPC.readEngineSupport]: () => options.api.readEngineSupport(),
    [IPC.readEngineSettings]: () => options.api.readEngineSettings(),
    [IPC.editEngineSettings]: (edit: Parameters<StrataApi['editEngineSettings']>[0]) => options.api.editEngineSettings(edit),
    [IPC.editEngineProvider]: (edit: Parameters<StrataApi['editEngineProvider']>[0]) => options.api.editEngineProvider(edit),
    [IPC.browseEngineFolder]: (path: string) => options.api.browseEngineFolder(path),
    [IPC.lookupEngineRepository]: (repository: string) => options.api.lookupEngineRepository(repository),
    [IPC.cloneEngineRepository]: (input: Parameters<StrataApi['cloneEngineRepository']>[0]) => options.api.cloneEngineRepository(input),
    [IPC.setModelPreference]: (instanceId: string, slug: string, preference: Parameters<StrataApi['setModelPreference']>[2]) => options.api.setModelPreference(instanceId, slug, preference),
    [IPC.listEngineRefs]: (cwd: string, query?: string) => options.api.listEngineRefs(cwd, query),
    [IPC.attachEngineTerminal]: (input: Parameters<StrataApi['attachEngineTerminal']>[0]) => options.api.attachEngineTerminal(input),
    [IPC.detachEngineTerminal]: (attachmentId: string) => options.api.detachEngineTerminal(attachmentId),
    [IPC.writeEngineTerminal]: (input: Parameters<StrataApi['writeEngineTerminal']>[0]) => options.api.writeEngineTerminal(input),
    [IPC.resizeEngineTerminal]: (input: Parameters<StrataApi['resizeEngineTerminal']>[0]) => options.api.resizeEngineTerminal(input),
    [IPC.closeEngineTerminal]: (input: Parameters<StrataApi['closeEngineTerminal']>[0]) => options.api.closeEngineTerminal(input),
    [IPC.refreshAccounts]: () => options.api.refreshAccounts(),
    [IPC.holdMessageComment]: (threadId: string, input: Parameters<StrataApi['holdMessageComment']>[1]) => options.api.holdMessageComment(threadId, input),
    [IPC.actMessageComment]: (threadId: string, itemId: string, action: 'resolve' | 'reopen' | 'discard') => options.api.actMessageComment(threadId, itemId, action),
    [IPC.runAskScan]: (identity: string | null, threadId: string, messageId: string) => options.api.runAskScan(identity, threadId, messageId),
    [IPC.cancelAskScan]: (identity: string | null, threadId: string) => options.api.cancelAskScan(identity, threadId),
    [IPC.saveAskDraft]: (identity: string | null, threadId: string, itemId: string, text: string) => options.api.saveAskDraft(identity, threadId, itemId, text),
    [IPC.queueItemReply]: (threadId: string, itemId: string, text: string) => options.api.queueItemReply(threadId, itemId, text),
    [IPC.discardItemReply]: (threadId: string, itemId: string) => options.api.discardItemReply(threadId, itemId),
    [IPC.dismissItem]: (threadId: string, itemId: string) => options.api.dismissItem(threadId, itemId),
    [IPC.retainVisualEvidence]: (owner: string, ids: string[]) => options.api.retainVisualEvidence?.(owner, ids),
    [IPC.holdVisualComment]: (input: Parameters<StrataApi['holdVisualComment']>[0]) => options.api.holdVisualComment(input),
    [IPC.actVisualComment]: (id: string, action: Parameters<StrataApi['actVisualComment']>[1]) => options.api.actVisualComment(id, action),
    [IPC.openPreviewTab]: (input: Parameters<StrataApi['openPreviewTab']>[0]) => options.api.openPreviewTab(input),
    [IPC.closePreviewTab]: (tabId: string) => options.api.closePreviewTab(tabId),
    [IPC.navigatePreview]: (tabId: string, navigation: Parameters<StrataApi['navigatePreview']>[1]) => options.api.navigatePreview(tabId, navigation),
    [IPC.resizePreview]: (tabId: string, viewport: Parameters<StrataApi['resizePreview']>[1]) => options.api.resizePreview(tabId, viewport),
    [IPC.resumePreviewTab]: (tabId: string) => options.api.resumePreviewTab(tabId),
    [IPC.reportPreviewBounds]: (report: Parameters<StrataApi['reportPreviewBounds']>[0]) => options.api.reportPreviewBounds(report),
    [IPC.reportOverlay]: (open: boolean) => options.api.reportOverlay(open),
    // The probe answers only when the harness asked for it; otherwise the channel refuses.
    [IPC.previewProbe]: (tabId: string, point: { x: number; y: number }) => { if (process.env.STRATAMD_PREVIEW_PROBE !== '1') throw new Error('The preview probe is off'); const probe = (options.api as { previewHumanInput?(tabId: string, point: { x: number; y: number }): void }).previewHumanInput; if (!probe) throw new Error('No preview host'); probe.call(options.api, tabId, point) },
    [IPC.capturePreviewFrame]: (tabId: string) => options.api.capturePreviewFrame(tabId),
    [IPC.describePreview]: (tabId: string, target: Parameters<StrataApi['describePreview']>[1]) => options.api.describePreview(tabId, target),
    [IPC.scrollPreview]: (tabId: string, move: Parameters<StrataApi['scrollPreview']>[1]) => options.api.scrollPreview(tabId, move),
    [IPC.showVisualComment]: (id: string) => options.api.showVisualComment(id),
    [IPC.adjustPreview]: (tabId: string, targets: Parameters<StrataApi['adjustPreview']>[1]) => options.api.adjustPreview(tabId, targets),
    [IPC.clearPreviewOverrides]: (tabId: string) => options.api.clearPreviewOverrides(tabId),
    [IPC.startConversationTurn]: (threadId: string, input: Parameters<StrataApi['startConversationTurn']>[1]) => options.api.startConversationTurn(threadId, input),
    [IPC.stageConversationAttachment]: (input: Parameters<StrataApi['stageConversationAttachment']>[0]) => options.api.stageConversationAttachment(input),
    [IPC.discardConversationAttachment]: (id: string) => options.api.discardConversationAttachment(id),
    [IPC.retainConversationAttachments]: (ids: string[]) => options.api.retainConversationAttachments(ids),
    [IPC.stopConversationTurn]: (threadId: string) => options.api.stopConversationTurn(threadId),
    [IPC.answerEngineApproval]: (threadId: string, requestId: string, decision: Parameters<StrataApi['answerEngineApproval']>[2]) => options.api.answerEngineApproval(threadId, requestId, decision),
    [IPC.answerEngineUserInput]: (threadId: string, requestId: string, answers: Record<string, unknown>) => options.api.answerEngineUserInput(threadId, requestId, answers),
    [IPC.openDocument]: (path?: string) => options.api.openDocument(path),
    [IPC.closeDocument]: (path: string, decision?: 'save' | 'discard' | 'cancel') => options.api.closeDocument(path, decision),
    [IPC.updateBuffer]: (path: string, content: string, origin: BufferOrigin, blockRanges?: readonly BufferBlockRange[]) => options.api.updateBuffer(path, content, origin, blockRanges),
    [IPC.undo]: (path: string) => options.api.undo(path),
    [IPC.redo]: (path: string) => options.api.redo(path),
    [IPC.save]: (path: string) => options.api.save(path),
    [IPC.setSourceMode]: (path: string, source: boolean) => options.api.setSourceMode(path, source),
    [IPC.updateReadingState]: (path: string, state: Parameters<StrataApi['updateReadingState']>[1]) => options.api.updateReadingState(path, state),
    [IPC.updateWalkthrough]: (path: string, action: Parameters<StrataApi['updateWalkthrough']>[1]) => options.api.updateWalkthrough(path, action),
    [IPC.updateTableView]: (path: string, state: Parameters<StrataApi['updateTableView']>[1]) => options.api.updateTableView(path, state),
    [IPC.updateFold]: (path: string, heading: Parameters<StrataApi['updateFold']>[1], folded: boolean) => options.api.updateFold(path, heading, folded),
    [IPC.keepHunk]: (path: string, hunkId: string) => options.api.keepHunk(path, hunkId),
    [IPC.revertHunk]: (path: string, hunkId: string, confirmMixed?: boolean) => options.api.revertHunk(path, hunkId, confirmMixed),
    [IPC.markReviewed]: (path: string) => options.api.markReviewed(path),
    [IPC.saveRound]: (path: string, index: number) => options.api.saveRound(path, index),
    [IPC.addAnnotation]: (path: string, annotation: Parameters<StrataApi['addAnnotation']>[1]) => options.api.addAnnotation(path, annotation),
    [IPC.holdDraft]: (path: string, draft: Parameters<StrataApi['holdDraft']>[1]) => options.api.holdDraft(path, draft),
    [IPC.discardDraft]: (path: string, draftId: string) => options.api.discardDraft(path, draftId),
    [IPC.quickSend]: (path: string, draft: Parameters<StrataApi['quickSend']>[1]) => options.api.quickSend(path, draft),
    [IPC.requoteAnnotation]: (path: string, annotationId: string, range: Parameters<StrataApi['requoteAnnotation']>[2]) => options.api.requoteAnnotation(path, annotationId, range),
    [IPC.reply]: (path: string, annotationId: string, text: string) => options.api.reply(path, annotationId, text),
    [IPC.resolveAnnotation]: (path: string, annotationId: string) => options.api.resolveAnnotation(path, annotationId),
    [IPC.answerDecision]: (path: string, annotationId: string, answer: Parameters<StrataApi['answerDecision']>[2]) => options.api.answerDecision(path, annotationId, answer),
    [IPC.reopenDecision]: (path: string, annotationId: string) => options.api.reopenDecision(path, annotationId),
    [IPC.acceptSuggestion]: (path: string, annotationId: string) => options.api.acceptSuggestion(path, annotationId),
    [IPC.rejectSuggestion]: (path: string, annotationId: string) => options.api.rejectSuggestion(path, annotationId),
    [IPC.acceptAllSuggestions]: (path: string, agentId: string) => options.api.acceptAllSuggestions(path, agentId),
    [IPC.rejectAllSuggestions]: (path: string, agentId: string) => options.api.rejectAllSuggestions(path, agentId),
    [IPC.clearResolvedAnnotations]: (path: string) => options.api.clearResolvedAnnotations(path),
    [IPC.resolveRecovery]: (path: string, decision: 'recover' | 'discard') => options.api.resolveRecovery(path, decision),
    [IPC.resolveConflict]: (path: string, conflictId: string, decision: 'mine' | 'incoming') => options.api.resolveConflict(path, conflictId, decision),
    [IPC.previewSend]: (path: string, request: Parameters<StrataApi['previewSend']>[1]) => options.api.previewSend(path, request),
    [IPC.send]: (path: string, request: Parameters<StrataApi['send']>[1]) => options.api.send(path, request),
    [IPC.copyText]: (text: string) => options.api.copyText(text),
    [IPC.setLead]: (path: string, agentId: string | null) => options.api.setLead(path, agentId),
    [IPC.detachThread]: (path: string, threadId: string) => options.api.detachThread(path, threadId),
    [IPC.addFolder]: () => options.api.addFolder(),
    [IPC.removeFolder]: (path: string) => options.api.removeFolder(path),
    [IPC.scanFolder]: (path: string) => options.api.scanFolder(path),
    [IPC.refreshExplorer]: () => options.api.refreshExplorer(),
    [IPC.forgetDocument]: (path: string) => options.api.forgetDocument(path),
    [IPC.updateSettings]: (settings: Parameters<StrataApi['updateSettings']>[0]) => options.api.updateSettings(settings),
    [IPC.selectTheme]: (id: string) => options.api.selectTheme(id),
    [IPC.createTheme]: (name: string, fromId: string) => options.api.createTheme(name, fromId),
    [IPC.setThemeValue]: (key: string, value: string | number | null) => options.api.setThemeValue(key, value),
    [IPC.renameTheme]: (name: string) => options.api.renameTheme(name),
    [IPC.revertTheme]: (sparse: Record<string, unknown>) => options.api.revertTheme(sparse),
    [IPC.deleteTheme]: (id: string) => options.api.deleteTheme(id),
    [IPC.listFonts]: () => options.api.listFonts(),
    [IPC.openThemeSample]: () => options.api.openThemeSample(),
    [IPC.resolveLocalImage]: (documentPath: string, source: string) => options.api.resolveLocalImage(documentPath, source),
    [IPC.resolveLocalMarkdown]: (documentPath: string, source: string) => options.api.resolveLocalMarkdown(documentPath, source),
    [IPC.openExternal]: (url: string) => openExternal(url),
    [IPC.resolveLocalLink]: (input: { projectId: string | null; href: string; documentPath?: string }) => options.api.resolveLocalLink(input),
    [IPC.addDictionaryWord]: (word: string) => { options.renderer.session.addWordToSpellCheckerDictionary(word) },
    [IPC.flashWindow]: () => flashWindow(),
    [IPC.createFile]: async (directory: string, name?: string) => {
      const path = await (await files()).createFile(directory, name)
      await options.api.refreshExplorer()
      await options.api.openDocument(path)
      return path
    },
    [IPC.renameFile]: async (path: string, name: string) => {
      const renamed = await (await files()).renameFile(path, name)
      await options.api.refreshExplorer()
      return renamed
    },
    [IPC.trashFile]: async (path: string) => {
      await (await files()).trashFile(path)
      await options.api.refreshExplorer()
    },
    [IPC.revealFile]: async (path: string) => (await files()).revealFile(path),
    [IPC.openFileDialog]: async () => {
      const chosen = await (await files()).chooseFile()
      if (chosen) await options.api.openDocument(chosen)
    },
    // A native paste, not a clipboard read: reading the clipboard from main can
    // block while this process owns the selection, and the paste event lets the
    // editor's own handling (markdown parsing) run.
    [IPC.pasteFromClipboard]: () => { options.renderer.paste() }
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    options.ipcMain.handle(channel, async (event, ...untrustedArguments: unknown[]) => {
      assertTrustedSender(event, options.renderer, allowedRendererUrls)
      const parsed = argumentSchemas[channel].parse(untrustedArguments) as never[]
      try { return await handlers[channel](...parsed) }
      catch (error) { logError('ipc', `Request ${channel} failed`, error); throw error }
    })
  }

  // Fire-and-forget failure reports (docs/plans/completed/crash-hardening-plan.md §7). A
  // malformed or untrusted report is dropped: reporting must not throw.
  const onReportError = (event: IpcMainEvent, report: unknown): void => {
    try {
      assertTrustedSender(event, options.renderer, allowedRendererUrls)
      logRendererReport(errorReportSchema.parse(report))
    } catch {
      // Dropped.
    }
  }
  options.ipcMain.on(IPC.reportError, onReportError)

  const stopTerminalEvents = options.api.onTerminalEvent?.(push => {
    if (!options.renderer.isDestroyed()) options.renderer.send(IPC.terminalEvent, push)
  })
  return {
    publish(state) {
      if (options.renderer.isDestroyed()) return
      const update = encodeViewUpdate(lastSent, nextSeq + 1, state, verify)
      record(state)
      options.renderer.send(IPC.stateChanged, update)
    },
    dispose() {
      stopTerminalEvents?.()
      stopWindowEvents?.()
      for (const channel of Object.keys(handlers) as InvokeChannel[]) options.ipcMain.removeHandler(channel)
      options.ipcMain.removeListener(IPC.reportError, onReportError)
    }
  }
}

export function assertTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  renderer: WebContents,
  allowedRendererUrls: readonly string[]
): void {
  if (event.sender !== renderer) throw new Error('Rejected IPC from an unknown renderer')
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
  if (!allowedRendererUrls.some((prefix) => senderUrl.startsWith(prefix))) {
    throw new Error(`Rejected IPC from untrusted URL: ${senderUrl}`)
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  // A local page from a reply opens in the default browser too, once main has seen the file.
  if (!isAllowedExternalUrl(url) && !(await isLocalPage(url))) throw new Error('Only http, https, mailto, and local .html links can be opened externally')
  // Imported lazily: this module also loads under vitest, where the electron
  // runtime is unavailable and tests inject their own openExternal.
  const { shell } = await import('electron')
  await shell.openExternal(url)
}
