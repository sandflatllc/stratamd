import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  AnnotationAnchorError,
  closestAnnotationMatches,
  createAnnotation,
  createAnnotationLog,
  replyToAnnotation,
  toDeliveredAnnotation,
  type Annotation,
  type AnnotationEvent,
  type AnnotationLog,
} from '../core/annotations.js'
import { computeHunks } from '../core/diff.js'
import { createPayload, type PayloadInput, type StrataPayload } from '../core/payload.js'
import { EXTERNAL_TAG_TTL_MS } from '../core/state.js'
import {
  CommandFailure,
  type CommandArguments,
  type CommandRequest,
  type SocketCommandHandler,
} from '../cli/protocol.js'
import { readDocument, resolveDocumentPath, seedGhostFromGit } from './files.js'
import { scanExplorer } from './explorer.js'
import { GhostStore, type DocumentMeta } from './storage.js'
import { SettingsStore } from './settings.js'
import { BUILT_IN_THEME, describeTheme, ThemeBrokenError, ThemeStore, type LoadedTheme } from './themes.js'

const DEFAULT_LOCK_TIMEOUT_MS = 10_000

interface DurableAnnotationMeta extends DocumentMeta {
  readonly annotations?: Readonly<Record<string, Annotation>>
  readonly nextAnnotationSeq?: number
}

interface PendingTag {
  readonly agentId: string | null
  readonly name: string
  readonly setAt: number
  readonly expiresAt: number
}

interface CurrentDocument {
  readonly path: string
  readonly text: string
  readonly meta: DurableAnnotationMeta
  readonly bufferPath: string
}

interface ReadOnlyStateDocument {
  readonly path: string
  readonly text: string
  readonly meta?: DurableAnnotationMeta
  readonly bufferPath: string
}

export interface OfflineCommandHandlerOptions {
  readonly store?: GhostStore
  /** Config directory holding settings.json and themes/; defaults to the XDG location. */
  readonly configDirectory?: string
  readonly now?: () => number
  readonly createId?: (prefix: 'a' | 'r') => string
  readonly lockTimeoutMs?: number
}

interface QuoteFailureDetail {
  readonly index: number
  readonly quote: string
  readonly code: AnnotationAnchorError['code']
  readonly error: string
  readonly matches: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function commandFile(request: CommandRequest): string | undefined {
  return 'file' in request.args && typeof request.args.file === 'string'
    ? request.args.file
    : undefined
}

function requireFile(request: CommandRequest): string {
  const file = commandFile(request)
  if (!file) {
    throw new CommandFailure('No document is open and no file was supplied', 2, 'NOT_FOUND')
  }
  return file
}

function assertMarkdownFile(path: string): void {
  const extension = extname(path).toLowerCase()
  if (extension !== '.md' && extension !== '.markdown') {
    throw new CommandFailure(`StrataMD only handles Markdown files: ${path}`, 1, 'NOT_MARKDOWN')
  }
}

function documentError(error: unknown, path: string): never {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new CommandFailure(`Not found: ${path}`, 2, 'NOT_FOUND', { path })
  }
  if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
    throw new CommandFailure(`Document is locked: ${path}`, 4, 'DOCUMENT_LOCKED', { path })
  }
  throw error
}

function annotationLog(meta: DurableAnnotationMeta): AnnotationLog {
  const annotations = meta.annotations
  const nextSeq = meta.nextAnnotationSeq
  if (annotations === undefined && nextSeq === undefined && meta.annotationEvents.length === 0) {
    return createAnnotationLog()
  }
  if (
    !isRecord(annotations)
    || !Number.isInteger(nextSeq)
    || (nextSeq as number) < 1
    || !Array.isArray(meta.annotationEvents)
  ) {
    throw new Error('Invalid annotation metadata')
  }
  return {
    annotations: annotations as Readonly<Record<string, Annotation>>,
    nextSeq: nextSeq as number,
    events: meta.annotationEvents as readonly AnnotationEvent[],
  }
}

function withAnnotationLog(meta: DurableAnnotationMeta, log: AnnotationLog): DurableAnnotationMeta {
  return {
    ...meta,
    annotations: log.annotations,
    nextAnnotationSeq: log.nextSeq,
    annotationEvents: log.events,
  }
}

async function ensureMeta(
  store: GhostStore,
  path: string,
  diskText: string,
): Promise<DurableAnnotationMeta> {
  if (await store.hasDocument(path)) {
    const meta = await store.loadMeta(path) as DurableAnnotationMeta
    return await store.consumeReseedMarker(meta, diskText) as DurableAnnotationMeta
  }
  return await store.createDocument(path, diskText) as DurableAnnotationMeta
}

/**
 * The offline shadow is a newer buffer when one exists. Otherwise disk wins and
 * refreshes the buffer so the path printed in a payload contains that same text.
 */
async function readCurrentDocument(store: GhostStore, requestedPath: string): Promise<CurrentDocument> {
  assertMarkdownFile(requestedPath)
  const path = await resolveDocumentPath(requestedPath)
  const disk = await readDocument(path)
  if (!disk.validUtf8) {
    throw new CommandFailure(`Invalid UTF-8: ${path}`, 1, 'INVALID_UTF8', { path })
  }

  const bufferPath = store.pathsForDocument(path).buffer
  const bufferStat = await stat(bufferPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const diskStat = await stat(path)
  const useBuffer = bufferStat !== undefined && bufferStat.mtimeMs > diskStat.mtimeMs
  const text = useBuffer ? await readFile(bufferPath, 'utf8') : disk.text
  const meta = await ensureMeta(store, path, disk.text)
  if (!useBuffer) await store.writeBuffer(path, text)
  return { path, text, meta, bufferPath }
}

async function readStateDocument(
  store: GhostStore,
  requestedPath: string,
): Promise<ReadOnlyStateDocument> {
  assertMarkdownFile(requestedPath)
  const path = await resolveDocumentPath(requestedPath)
  const disk = await readDocument(path)
  if (!disk.validUtf8) {
    throw new CommandFailure(`Invalid UTF-8: ${path}`, 1, 'INVALID_UTF8', { path })
  }

  const meta = await store.loadMetaReadOnly(path) as DurableAnnotationMeta | undefined
  const bufferPath = store.pathsForDocument(path).buffer
  const [bufferStat, diskStat] = await Promise.all([
    stat(bufferPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }),
    stat(path),
  ])
  const text = bufferStat !== undefined && bufferStat.mtimeMs > diskStat.mtimeMs
    ? await readFile(bufferPath, 'utf8')
    : disk.text
  return { path, text, ...(meta === undefined ? {} : { meta }), bufferPath }
}

function quoteFailure(
  document: string,
  quote: string,
  index: number,
  error: AnnotationAnchorError,
): QuoteFailureDetail {
  return {
    index,
    quote,
    code: error.code,
    error: error.message,
    matches: closestAnnotationMatches(document, quote, error.matches),
  }
}

function payloadWithoutSyntheticAgent(
  input: Omit<PayloadInput, 'agent'>,
): Omit<StrataPayload, 'agent'> {
  const { agent: _agent, ...payload } = createPayload({ ...input, agent: '' })
  return payload
}

function textLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

function pendingTag(meta: DurableAnnotationMeta, now: number): PendingTag | undefined {
  if (!isRecord(meta.pendingTag)) return undefined
  const value = meta.pendingTag
  if (
    (typeof value.agentId !== 'string' && value.agentId !== null)
    || typeof value.name !== 'string'
    || typeof value.setAt !== 'number'
    || typeof value.expiresAt !== 'number'
    || value.expiresAt < now
  ) return undefined
  return value as unknown as PendingTag
}

async function annotate(
  store: GhostStore,
  current: CurrentDocument,
  args: CommandArguments['annotate'],
  makeId: (prefix: 'a' | 'r') => string,
): Promise<void> {
  let log = annotationLog(current.meta)
  const failures: QuoteFailureDetail[] = []

  for (const [index, input] of args.annotations.entries()) {
    try {
      const result = createAnnotation(log, current.text, {
        id: makeId('a'),
        kind: input.kind,
        author: 'agent',
        agent: args.agent,
        quote: input.quote,
        text: input.text ?? '',
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.precededBy === undefined ? {} : { precededBy: input.precededBy }),
        ...(input.followedBy === undefined ? {} : { followedBy: input.followedBy }),
      })
      log = result.log
    } catch (error) {
      if (!(error instanceof AnnotationAnchorError)) throw error
      failures.push(quoteFailure(current.text, input.quote, index, error))
    }
  }

  if (failures.length > 0) {
    throw new CommandFailure(
      failures.length === 1 ? failures[0]!.error : 'One or more annotation quotes are invalid',
      3,
      'QUOTE_INVALID',
      failures,
    )
  }
  await store.saveMeta(withAnnotationLog(current.meta, log))
}

async function reply(
  store: GhostStore,
  current: CurrentDocument,
  args: CommandArguments['reply'],
  makeId: (prefix: 'a' | 'r') => string,
): Promise<void> {
  const log = annotationLog(current.meta)
  if (log.annotations[args.annotation] === undefined) {
    throw new CommandFailure(
      `Annotation ${args.annotation} was not found`,
      2,
      'ANNOTATION_NOT_FOUND',
      { annotation: args.annotation },
    )
  }
  const result = replyToAnnotation(log, args.annotation, {
    id: makeId('r'),
    author: 'agent',
    agent: args.agent,
    text: args.text,
  })
  await store.saveMeta(withAnnotationLog(current.meta, result.log))
}

/** The active theme without the app: settings.json names it, themes/<id>.json holds it. */
export async function loadActiveThemeOffline(configDirectory?: string, id?: string): Promise<LoadedTheme> {
  const settings = await new SettingsStore(configDirectory ? { configDirectory } : {}).load()
  const themes = new ThemeStore(configDirectory ? { configDirectory } : {})
  const wanted = id ?? settings.theme
  try {
    return await themes.load(wanted)
  } catch (error) {
    if (error instanceof ThemeBrokenError) {
      return { ...BUILT_IN_THEME, id: wanted, name: `${wanted}.json`, builtIn: false, path: themes.pathFor(wanted), problems: [{ key: 'file', reason: error.detail }] }
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (id !== undefined) throw new CommandFailure(`No theme named ${id}`, 3, 'THEME_NOT_FOUND')
      return BUILT_IN_THEME
    }
    throw error
  }
}

/** What `stratamd theme` prints. */
export async function describeThemeOffline(configDirectory?: string, id?: string): Promise<ReturnType<typeof describeTheme> & { directory: string }> {
  const themes = new ThemeStore(configDirectory ? { configDirectory } : {})
  return { ...describeTheme(await loadActiveThemeOffline(configDirectory, id)), directory: themes.directory }
}

async function statePayload(current: ReadOnlyStateDocument): Promise<Omit<StrataPayload, 'agent'>> {
  const log = current.meta === undefined ? createAnnotationLog() : annotationLog(current.meta)
  const annotations = Object.values(log.annotations)
    .sort((left, right) => left.seq - right.seq)
    .map(toDeliveredAnnotation)
  return payloadWithoutSyntheticAgent({
    file: current.path,
    buffer: current.bufferPath,
    event: 'state',
    cursor: log.nextSeq - 1,
    document: current.text,
    annotations,
  })
}

async function changesPayload(
  store: GhostStore,
  current: CurrentDocument,
  now: number,
): Promise<Omit<StrataPayload, 'agent'>> {
  const ghost = await store.getObjectText(current.meta.ghostBlob)
  const hunks = computeHunks(ghost, current.text).map((hunk) => ({
    oldStart: hunk.oldStartLine,
    oldLines: hunk.removedLines,
    newStart: hunk.newStartLine,
    newLines: hunk.addedLines,
    removed: textLines(hunk.removed),
    added: textLines(hunk.added),
  }))
  const tag = pendingTag(current.meta, now)
  return payloadWithoutSyntheticAgent({
    file: current.path,
    buffer: current.bufferPath,
    event: 'changes',
    segments: hunks.length === 0
      ? []
      : [{
          author: 'external',
          ...(tag?.agentId === null || tag === undefined
            ? {}
            : { tag: { agent: tag.agentId, name: tag.name } }),
          hunks,
        }],
  })
}

async function checkpoint(
  store: GhostStore,
  requestedPath: string,
  lockTimeoutMs: number,
): Promise<void> {
  const path = await resolveDocumentPath(requestedPath)
  const entry = await stat(path).catch((error) => documentError(error, requestedPath))
  if (entry.isFile()) {
    assertMarkdownFile(path)
    await store.withLock(path, async () => {
      const current = await readCurrentDocument(store, path)
      const seed = await seedGhostFromGit(path, current.text)
      const ghostBlob = await store.putObject(seed.content)
      await store.saveMeta({ ...current.meta, ghostBlob, pendingHunks: [] })
    }, lockTimeoutMs)
    return
  }
  if (!entry.isDirectory()) {
    throw new CommandFailure(`Not a file or directory: ${path}`, 2, 'NOT_FOUND', { path })
  }

  const scan = await scanExplorer([path], { includeMissing: false })
  for (const file of scan.files) {
    await store.withLock(file.path, async () => {
      // Directory checkpoint matches Scan (PRD §6.4): a new store seeds from the
      // document's own content. readCurrentDocument creates it via ensureMeta.
      if (await store.hasDocument(file.path)) return
      await readCurrentDocument(store, file.path)
    }, lockTimeoutMs)
  }
}

export function createOfflineCommandHandler(
  options: OfflineCommandHandlerOptions = {},
): SocketCommandHandler {
  const store = options.store ?? new GhostStore()
  const now = options.now ?? Date.now
  const makeId = options.createId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`)
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const configDirectory = options.configDirectory

  return async (request): Promise<unknown> => {
    const requestedPath = requireFile(request)
    if (request.command === 'state') {
      try {
        const theme = await loadActiveThemeOffline(configDirectory)
        return { ...(await statePayload(await readStateDocument(store, requestedPath))), theme: { id: theme.id, name: theme.name, path: theme.path } }
      } catch (error) {
        return documentError(error, requestedPath)
      }
    }
    if (request.command === 'checkpoint') {
      try {
        await checkpoint(store, requestedPath, lockTimeoutMs)
        return undefined
      } catch (error) {
        return documentError(error, requestedPath)
      }
    }

    let path: string
    try {
      path = await resolveDocumentPath(requestedPath)
      assertMarkdownFile(path)
      return await store.withLock(path, async () => {
        if (request.command === 'forget') {
          if (!await store.hasDocument(path)) {
            throw new CommandFailure(`Not found: ${path}`, 2, 'NOT_FOUND', { path })
          }
          await store.forgetDocument(path)
          return undefined
        }

        const current = await readCurrentDocument(store, path)
        switch (request.command) {
          case 'annotate':
            await annotate(store, current, request.args, makeId)
            return undefined
          case 'reply':
            await reply(store, current, request.args, makeId)
            return undefined
          case 'changes':
            return changesPayload(store, current, now())
          case 'changed': {
            const pendingTagValue: PendingTag = {
              agentId: request.args.agent,
              name: request.args.name,
              setAt: now(),
              expiresAt: now() + EXTERNAL_TAG_TTL_MS,
            }
            await store.saveMeta({ ...current.meta, pendingTag: pendingTagValue })
            return undefined
          }
          default:
            throw new CommandFailure(
              `Command ${request.command} is unavailable offline`,
              4,
              'INSTANCE_UNREACHABLE',
            )
        }
      }, lockTimeoutMs)
    } catch (error) {
      return documentError(error, requestedPath)
    }
  }
}

export const handleOfflineCommand: SocketCommandHandler = createOfflineCommandHandler()
