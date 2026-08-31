export const PROTOCOL_VERSION = 9 as const
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
  'save'
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
}

export interface AnnotateArguments {
  file: string
  agent: string
  annotations: AnnotationInput[]
}

export interface ReplyArguments {
  file: string
  agent: string
  annotation: string
  text: string
}

export interface StateArguments {
  file?: string
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
}

export type CommandRequest<C extends CommandName = CommandName> = {
  [K in C]: {
    version: typeof PROTOCOL_VERSION
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
}

export interface CommandErrorBody {
  error: string
  code: string
  detail?: unknown
}

export type CommandResponse =
  | {
      version: typeof PROTOCOL_VERSION
      id: string
      ok: true
      result?: unknown
    }
  | {
      version: typeof PROTOCOL_VERSION
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
        (args.timeout as number) <= 86_400
      )
    case 'annotate':
      return (
        file() &&
        string('agent') &&
        Array.isArray(args.annotations) &&
        args.annotations.length > 0 &&
        args.annotations.every(isAnnotationInput)
      )
    case 'reply':
      return file() && string('agent') && string('annotation') && stringWithinLimit(args.text)
    case 'state':
      return file(true)
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
