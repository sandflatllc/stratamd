export const PROTOCOL_VERSION = 10 as const
export const MAX_REQUEST_BYTES = 1024 * 1024
/** Agent-to-agent message notes are capped far below the 64 KB Send note limit (PRD §6.7). */
export const MAX_MESSAGE_BYTES = 4 * 1024

export const COMMAND_NAMES = [
  'attach',
  'annotate',
  'reply',
  'state',
  'changes',
  'changed',
  'open',
  'checkpoint',
  'detach',
  'forget',
  'ack',
  'send',
  'lead',
  'accept',
  'reject',
  'resolve',
  'save',
  'docs',
  'edit'
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export interface AnnotationInput {
  kind: 'comment' | 'question' | 'suggestion'
  quote: string
  text?: string
  label?: string
  precededBy?: string
  followedBy?: string
}

export interface AttachArguments {
  file?: string
  agent: string
  name: string
  timeout: number
  /** Omit `document` from the returned payload; `text` carries the buffer. */
  textOnly?: boolean
}

export interface AnnotateArguments {
  file: string
  agent: string
  /** Display name recorded on the annotations; the attachment's name wins when the app knows it. */
  name?: string
  annotations: AnnotationInput[]
}

export interface ReplyArguments {
  file: string
  agent: string
  /** Display name recorded on the reply; the attachment's name wins when the app knows it. */
  name?: string
  annotation: string
  text: string
}

export interface StateArguments {
  file?: string
  /** Omit `document`, `text`, and `annotations`. */
  brief?: boolean
  /** Omit `document`; `text` carries the buffer. */
  textOnly?: boolean
  /** Omit `document`; `text` carries only the open questions. */
  annotationsOnly?: boolean
}

export interface EditInput {
  /** Exact buffer text; empty with `precededBy`/`followedBy` (a point) or `append`. */
  match: string
  replace: string
  precededBy?: string
  followedBy?: string
  /** Insert at the end of the buffer; `match` is empty. */
  append?: boolean
}

export interface EditArguments extends FileArguments {
  agent: string
  /** Display name for the tagged hunk; the attachment's name when absent. */
  name?: string
  edits: EditInput[]
  /** Locate every match and report where each would land without changing the buffer. */
  dryRun?: boolean
}

export interface FileArguments {
  file: string
}

export interface ChangedArguments extends FileArguments {
  agent: string
  name: string
}

export interface DetachArguments extends FileArguments {
  agent: string
}

export interface AckArguments extends FileArguments {
  agent: string
  deliveryId: string
}

export interface SendMessageArguments extends FileArguments {
  agent: string
  text: string
  /** Named recipients; omitted targets every other attached agent. */
  to?: string[]
}

export interface LeadArguments extends FileArguments {
  agent: string
}

export interface AnnotationActionArguments extends FileArguments {
  agent: string
  annotation: string
}

export interface CommandArguments {
  attach: AttachArguments
  annotate: AnnotateArguments
  reply: ReplyArguments
  state: StateArguments
  changes: FileArguments
  changed: ChangedArguments
  open: FileArguments
  checkpoint: FileArguments
  detach: DetachArguments
  forget: FileArguments
  ack: AckArguments
  send: SendMessageArguments
  lead: LeadArguments
  accept: AnnotationActionArguments
  reject: AnnotationActionArguments
  resolve: AnnotationActionArguments
  save: LeadArguments
  docs: Record<string, never>
  edit: EditArguments
}

export type CommandRequest<C extends CommandName = CommandName> = {
  [K in C]: {
    version: number
    id: string
    command: K
    args: CommandArguments[K]
  }
}[C]

export interface PayloadHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  removed: string[]
  added: string[]
}

export interface PayloadSegment {
  author: 'user' | 'external'
  tag?: { agent: string; name: string }
  hunks: PayloadHunk[]
}

export interface AgentPayload {
  version: typeof PROTOCOL_VERSION
  file?: string
  buffer?: string
  agent?: string
  event:
    | 'initial'
    | 'send'
    | 'message'
    | 'resync'
    | 'closed'
    | 'timeout'
    | 'superseded'
    | 'state'
    | 'changes'
    | 'docs'
  deliveryId?: string
  /** With `event: 'message'`: the sending attachment (PRD §8). */
  from?: { agent: string; name: string }
  notes?: string[]
  /** With `event: 'state'` on an open document: every attachment (PRD §8). */
  attachments?: Array<{ agent: string; name: string; state: 'waiting' | 'working' | 'pending'; lead: boolean }>
  cursor?: number
  document?: string
  segments?: PayloadSegment[]
  annotations?: unknown[]
  resolved?: unknown[]
  text?: string
  /** With `event: 'state'`: the active theme (PRD §6.13). */
  theme?: { id: string; name: string; path: string | null }
  /** With `event: 'state'`: whether the document is open in the app (PRD §8). */
  open?: boolean
}

export interface CommandErrorBody {
  error: string
  code: string
  detail?: unknown
}

export type CommandResponse =
  | {
      version: number
      id: string
      ok: true
      result?: unknown
    }
  | {
      version: number
      id: string
      ok: false
      exitCode: 1 | 2 | 3 | 4
      error: CommandErrorBody
    }

export interface CommandContext {
  readonly connectionId: string
  readonly signal: AbortSignal
  readonly peerUid?: number
}

export type SocketCommandHandler = (
  request: CommandRequest,
  context: CommandContext
) => Promise<unknown> | unknown

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && (COMMAND_NAMES as readonly string[]).includes(value)
}

/**
 * A well-formed request whose `version` is not ours. The app answers this
 * before validating anything else, so a stale build on either side gets one
 * clear instruction instead of INVALID_REQUEST (PRD §6.8).
 */
export function protocolMismatch(value: unknown, local: number = PROTOCOL_VERSION): CommandFailure | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (typeof input.version !== 'number' || input.version === local) return undefined
  if (typeof input.id !== 'string' || !isCommandName(input.command)) return undefined
  return protocolMismatchFailure('app', local, input.version)
}

/**
 * The one PROTOCOL_MISMATCH message, built from whichever side noticed. The
 * older side is the one to refresh: an app older than the CLI needs a restart
 * to pick up the new build; a CLI older than the app needs updating.
 */
export function protocolMismatchFailure(local: 'app' | 'cli', localVersion: number, remoteVersion: number): CommandFailure {
  const app = local === 'app' ? localVersion : remoteVersion
  const cli = local === 'cli' ? localVersion : remoteVersion
  const instruction = app < cli
    ? 'restart StrataMD to pick up the new build'
    : 'update the stratamd command (run stratamd setup from the new build)'
  return new CommandFailure(
    `The running StrataMD speaks protocol ${app} and this stratamd command speaks protocol ${cli}: ${instruction}`,
    4,
    'PROTOCOL_MISMATCH',
    { app, cli, hint: 'Run stratamd doctor to see both versions and the log path' },
  )
}

export function isCommandRequest(value: unknown): value is CommandRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  if (!(
    input.version === PROTOCOL_VERSION &&
    typeof input.id === 'string' &&
    input.id.length > 0 &&
    input.id.length <= 128 &&
    isCommandName(input.command) &&
    !!input.args &&
    typeof input.args === 'object' &&
    !Array.isArray(input.args)
  )) return false

  const args = input.args as Record<string, unknown>
  const file = (optional = false): boolean =>
    (optional && args.file === undefined) ||
    (typeof args.file === 'string' && args.file.startsWith('/') && args.file.length > 1)
  const string = (name: string, optional = false): boolean =>
    (optional && args[name] === undefined) ||
    (typeof args[name] === 'string' && (args[name] as string).length > 0)

  switch (input.command) {
    case 'attach':
      return (
        file(true) &&
        string('agent') &&
        string('name') &&
        Number.isSafeInteger(args.timeout) &&
        (args.timeout as number) >= 0 &&
        (args.timeout as number) <= 86_400 &&
        optionalBoolean(args.textOnly)
      )
    case 'annotate':
      return (
        file() &&
        string('agent') &&
        string('name', true) &&
        Array.isArray(args.annotations) &&
        args.annotations.length > 0 &&
        args.annotations.every(isAnnotationInput)
      )
    case 'reply':
      return file() && string('agent') && string('name', true) && string('annotation') && stringWithinLimit(args.text)
    case 'state':
      return (
        file(true) &&
        optionalBoolean(args.brief) &&
        optionalBoolean(args.textOnly) &&
        optionalBoolean(args.annotationsOnly)
      )
    case 'docs':
      return Object.keys(args).length === 0
    case 'edit':
      return (
        file() &&
        string('agent') &&
        string('name', true) &&
        Array.isArray(args.edits) &&
        args.edits.length > 0 &&
        args.edits.every(isEditInput) &&
        optionalBoolean(args.dryRun)
      )
    case 'changes':
    case 'open':
    case 'checkpoint':
    case 'forget':
      return file()
    case 'changed':
      return file() && string('agent') && string('name')
    case 'detach':
      return file() && string('agent')
    case 'ack':
      return file() && string('agent') && string('deliveryId')
    case 'send':
      return (
        file() &&
        string('agent') &&
        messageWithinLimit(args.text) &&
        (args.to === undefined ||
          (Array.isArray(args.to) &&
            args.to.length > 0 &&
            args.to.every((id) => typeof id === 'string' && id.length > 0)))
      )
    case 'lead':
    case 'save':
      return file() && string('agent')
    case 'accept':
    case 'reject':
    case 'resolve':
      return file() && string('agent') && string('annotation')
  }
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isEditInput(value: unknown): value is EditInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const anchored =
    input.append === true || input.precededBy !== undefined || input.followedBy !== undefined
  return (
    typeof input.match === 'string' &&
    (input.match.length > 0 || anchored) &&
    (input.append === undefined || (input.append === true && input.match === '')) &&
    stringWithinLimit(input.replace) &&
    (input.precededBy === undefined || typeof input.precededBy === 'string') &&
    (input.followedBy === undefined || typeof input.followedBy === 'string')
  )
}

function stringWithinLimit(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 64 * 1024
}

function messageWithinLimit(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_MESSAGE_BYTES
}

function isAnnotationInput(value: unknown): value is AnnotationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return (
    (input.kind === 'comment' || input.kind === 'question' || input.kind === 'suggestion') &&
    typeof input.quote === 'string' &&
    input.quote.length > 0 &&
    (input.text === undefined || stringWithinLimit(input.text)) &&
    (input.label === undefined || typeof input.label === 'string') &&
    (input.precededBy === undefined || typeof input.precededBy === 'string') &&
    (input.followedBy === undefined || typeof input.followedBy === 'string')
  )
}

export class CommandFailure extends Error {
  readonly exitCode: 1 | 2 | 3 | 4
  readonly code: string
  readonly detail?: unknown

  constructor(
    message: string,
    exitCode: 1 | 2 | 3 | 4,
    code: string,
    detail?: unknown
  ) {
    super(message)
    this.name = 'CommandFailure'
    this.exitCode = exitCode
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export function errorResponse(id: string, error: unknown): CommandResponse {
  if (error instanceof CommandFailure) {
    const body: CommandErrorBody = { error: error.message, code: error.code }
    if (error.detail !== undefined) body.detail = error.detail
    return {
      version: PROTOCOL_VERSION,
      id,
      ok: false,
      exitCode: error.exitCode,
      error: body
    }
  }

  const message = error instanceof Error ? error.message : 'Internal command error'
  return {
    version: PROTOCOL_VERSION,
    id,
    ok: false,
    exitCode: 4,
    error: { error: message, code: 'COMMAND_FAILED' }
  }
}
