import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PAYLOAD_VERSION } from '../core/payload.js'
import {
  COMPONENT_NAMES,
  COMPONENT_REGISTRY,
  validateComponentMarkdown,
  type ComponentSchema,
  type ComponentValidationReport,
} from '../core/markdown/components.js'
import { getConfigDirectory, getDataDirectory } from '../platform/paths.js'
import { AGENT_HELP } from './agent-help.js'
import {
  CommandFailure,
  PROTOCOL_VERSION,
  protocolMismatchFailure,
  type AgentPayload,
  type AnnotationInput,
  type CommandArguments,
  type EditInput,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
  type SocketCommandHandler
} from './protocol.js'
import {
  requestOverSocket,
  SocketTimeoutError,
  SocketUnavailableError,
  socketPathForEnvironment
} from './socket-client.js'
import { setup } from './setup.js'

const MAX_TEXT_BYTES = 64 * 1024
const MAX_MESSAGE_TEXT_BYTES = 4 * 1024
// Most collaboration authority verbs are online-only. Answer and resolve may
// inspect a closed decision only to return the owner-required refusal.
const OFFLINE_COMMANDS = new Set<CommandName>([
  'annotate',
  'reply',
  'answer',
  'resolve',
  'state',
  'changes',
  'changed',
  'checkpoint',
  'forget'
])
const IDENTITY_USAGE = 'Pass --as <the agent id your first attach returned>'
/**
 * Below the 120 s command limit common to agent harnesses, with the 15 s
 * socket margin on top; a call the harness kills is safe, the delivery repeats.
 */
const DEFAULT_ATTACH_TIMEOUT_SECONDS = 90

const GENERAL_USAGE =
  'Usage: stratamd <attach|annotate|edit|pin|reply|answer|send|lead|accept|reject|resolve|save|state|docs|theme|components|validate|changes|changed|open|checkpoint|detach|forget|setup|doctor> [options], stratamd --help, stratamd --agent-help, stratamd --version'

const HELP_TEXT = `${GENERAL_USAGE}

  attach [file] [--as <id>] [--name <who>] [--timeout <seconds>] [--text-only]
  annotate <file> --kind <comment|question|suggestion|decision> --quote <text>
           [--text <text> | --text -] [--option <choice> ...] [--label <text>] [--as <id>]
  edit <file> --match <text> --replace <text> [--preceded-by <text>]
       [--followed-by <text>] [--append] [--dry-run] [--as <id>]
  pin <file> --component <line> --x <0..100> --y <0..100> --note <text> [--as <id>]
  reply <file> --to <annotation id> --text <text> [--as <id>]
  answer <file> --decision <id> (--choice <choice> | --other <text>) [--as <id>]
  send <file> --as <id> --text <note> [--to <id,id>]
  lead | accept | reject | resolve | save <file> --as <id> [--annotation <id>]
  state [file] [--brief | --text-only | --annotations | --raw]
  docs
  changes <file> | changed <file> --as <id> | open <file> | forget <file>
  checkpoint <file or directory> | detach <file> --as <id>
  theme [id] [--json]
  components [name] [--json] | validate <file> [--json]
  setup [--skill <claude|codex|agents|dir>] [--default] [--remove]
  doctor              checks the socket, directories, log, and lock files
  --version           app, protocol, and payload versions; CLI and app paths
  --agent-help        the full command reference, written for agents

Every command prints one JSON object on stdout; errors go to stderr as
{error, code, detail}. Exit codes: 0 done, 1 usage, 2 not found, 3 refused
by the document's state, 4 the app is not reachable or its build differs.
`

interface ParsedOptions {
  positionals: string[]
  options: Map<string, string | string[] | true>
}

interface OptionDefinition {
  value: boolean
  repeat?: boolean
}

type OptionDefinitions = Record<string, OptionDefinition>

export interface CliIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export interface CliRuntime {
  environment?: NodeJS.ProcessEnv
  io?: Partial<CliIo>
  socketPath?: string
  request?: typeof requestOverSocket
  offlineHandler?: SocketCommandHandler
  launchApp?: () => Promise<void>
  now?: () => number
}

function usage(message: string, detail?: unknown): never {
  throw new CommandFailure(message, 1, 'USAGE', detail)
}

function parseOptions(tokens: string[], definitions: OptionDefinitions): ParsedOptions {
  const positionals: string[] = []
  const options = new Map<string, string | string[] | true>()
  let positionalOnly = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (positionalOnly || token === '-' || !token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      positionalOnly = true
      continue
    }

    const equals = token.indexOf('=')
    const name = token.slice(2, equals === -1 ? undefined : equals)
    const definition = definitions[name]
    if (!definition) {
      usage(`Unknown option --${name}`, { valid: Object.keys(definitions).map((known) => `--${known}`) })
    }
    if (options.has(name) && definition.repeat !== true) usage(`Option --${name} may only be given once`)

    if (!definition.value) {
      if (equals !== -1) usage(`Option --${name} does not take a value`)
      options.set(name, true)
      continue
    }

    const value = equals === -1 ? tokens[++index] : token.slice(equals + 1)
    if (value === undefined) usage(`Option --${name} needs a value`)
    if (definition.repeat === true) {
      const previous = options.get(name)
      options.set(name, [...(Array.isArray(previous) ? previous : []), value])
    } else {
      options.set(name, value)
    }
  }

  return { positionals, options }
}

function option(parsed: ParsedOptions, name: string): string | undefined {
  const value = parsed.options.get(name)
  return typeof value === 'string' ? value : undefined
}

function repeatedOption(parsed: ParsedOptions, name: string): string[] {
  const value = parsed.options.get(name)
  return Array.isArray(value) ? value : []
}

function requireOption(parsed: ParsedOptions, name: string): string {
  const value = option(parsed, name)
  if (value === undefined || value.length === 0) usage(`Missing --${name}`)
  return value
}

function exactPositionals(parsed: ParsedOptions, count: number, command: string, expected = '<file>'): void {
  if (parsed.positionals.length !== count) {
    usage(`${command} takes ${count === 0 ? 'no arguments' : `exactly ${expected}`}; got ${parsed.positionals.length}`, {
      positionals: parsed.positionals,
    })
  }
}

function atMostPositionals(parsed: ParsedOptions, count: number, command: string, expected = '[file]'): void {
  if (parsed.positionals.length > count) {
    usage(`${command} takes at most ${expected}; got ${parsed.positionals.length}`, { positionals: parsed.positionals })
  }
}

function byteLengthWithin(value: string, label: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    usage(`${label} exceeds 64 KB`)
  }
  return value
}

async function readStandardInput(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding('utf8')
  let input = ''
  for await (const chunk of stream) {
    input += chunk
    if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) usage('Standard input is too large')
  }
  return input
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A deleted document may still be open or ghosted. Its last realpath is
      // still the session key, so let the owning handler decide whether it is
      // known and return exit 2 only when it is not.
      return absolute
    }
    throw error
  }
}

/**
 * The stable id a harness session implies, or undefined outside any known
 * harness. A Claude Code subagent shares the session id with its parent and
 * marks itself with CLAUDE_CODE_CHILD_SESSION, so that mark is mixed in: a
 * subagent never silently acts under the parent's attachment. Sibling
 * subagents are not told apart by the environment, so they pass --as.
 */
export function sessionAgentId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const session =
    environment.CLAUDE_CODE_SESSION_ID ??
    environment.CODEX_THREAD_ID ??
    environment.CODEX_SESSION_ID ??
    environment.T3_CODE_SESSION_ID ??
    environment.CURSOR_AGENT_SESSION_ID
  if (!session) return undefined
  const child = environment.CLAUDE_CODE_CHILD_SESSION
  const identity = child ? `${session}\0child:${child}` : session
  return `ag_${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`
}

/** A first attach may mint a fresh id; every other command needs one it can prove (PRD §7). */
export function deriveAgentId(environment: NodeJS.ProcessEnv = process.env): string {
  return sessionAgentId(environment) ?? `ag_${randomBytes(9).toString('base64url')}`
}

function requireAgent(parsed: ParsedOptions, environment: NodeJS.ProcessEnv): string {
  const agent = option(parsed, 'as') || sessionAgentId(environment)
  if (!agent) usage(IDENTITY_USAGE)
  return agent
}

function agentName(agent: string, specified: string | undefined, environment: NodeJS.ProcessEnv): string {
  return specified || environment.AI_AGENT || agent
}

function annotationInput(value: unknown, index?: number): AnnotationInput {
  const prefix = index === undefined ? 'Annotation' : `Annotation ${index + 1}`
  if (!value || typeof value !== 'object' || Array.isArray(value)) usage(`${prefix} must be an object`)
  const input = value as Record<string, unknown>
  const allowed = new Set(['kind', 'quote', 'heading', 'document', 'text', 'options', 'label', 'precededBy', 'followedBy'])
  const unknown = Object.keys(input).filter((key) => !allowed.has(key))
  if (unknown.length) usage(`${prefix} has unknown fields`, unknown)
  if (!['comment', 'question', 'suggestion', 'decision'].includes(String(input.kind))) {
    usage(`${prefix} has an invalid kind`)
  }
  if (input.kind === 'decision') {
    if (typeof input.text !== 'string' || input.text.trim().length === 0) usage(`${prefix} needs a non-empty prompt in text`)
    byteLengthWithin(input.text, `${prefix}.text`)
    if (!Array.isArray(input.options) || input.options.length < 2) usage(`${prefix} needs at least two options`)
    const options = input.options.map((choice) => {
      if (typeof choice !== 'string' || choice.trim().length === 0) usage(`${prefix} options must be non-empty strings`)
      return byteLengthWithin(choice.trim(), `${prefix}.options`)
    })
    if (new Set(options).size !== options.length) usage(`${prefix} options must be distinct`)
    const anchors = [input.quote !== undefined, input.heading !== undefined, input.document === true].filter(Boolean).length
    if (anchors !== 1) usage(`${prefix} needs exactly one of quote, heading, or document:true`)
    if (input.document !== undefined && input.document !== true) usage(`${prefix}.document must be true when present`)
    for (const key of ['quote', 'heading', 'precededBy', 'followedBy'] as const) {
      if (input[key] !== undefined && typeof input[key] !== 'string') usage(`${prefix}.${key} must be a string`)
    }
    if (typeof input.quote === 'string' && input.quote.length === 0) usage(`${prefix}.quote must not be empty`)
    if (typeof input.heading === 'string' && input.heading.length === 0) usage(`${prefix}.heading must not be empty`)
    return {
      kind: 'decision',
      text: input.text,
      options,
      ...(typeof input.quote === 'string' ? { quote: input.quote } : {}),
      ...(typeof input.heading === 'string' ? { heading: input.heading } : {}),
      ...(input.document === true ? { document: true } : {}),
      ...(typeof input.precededBy === 'string' ? { precededBy: input.precededBy } : {}),
      ...(typeof input.followedBy === 'string' ? { followedBy: input.followedBy } : {}),
    }
  }
  if (typeof input.quote !== 'string' || input.quote.length === 0) {
    usage(`${prefix} needs a non-empty quote`)
  }
  if (input.heading !== undefined || input.document !== undefined || input.options !== undefined) {
    usage(`${prefix} choices and heading/document anchors require kind decision`)
  }
  for (const key of ['text', 'label', 'precededBy', 'followedBy'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      usage(`${prefix}.${key} must be a string`)
    }
  }
  if (typeof input.text === 'string') byteLengthWithin(input.text, `${prefix}.text`)

  return {
    kind: input.kind as 'comment' | 'question' | 'suggestion',
    quote: input.quote,
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
    ...(typeof input.label === 'string' ? { label: input.label } : {}),
    ...(typeof input.precededBy === 'string' ? { precededBy: input.precededBy } : {}),
    ...(typeof input.followedBy === 'string' ? { followedBy: input.followedBy } : {})
  }
}

async function readAnnotations(
  parsed: ParsedOptions,
  stdin: NodeJS.ReadableStream
): Promise<AnnotationInput[]> {
  const jsonSource = option(parsed, 'json')
  if (jsonSource !== undefined) {
    if (
      parsed.options.has('kind') ||
      parsed.options.has('quote') ||
      parsed.options.has('heading') ||
      parsed.options.has('document') ||
      parsed.options.has('option') ||
      parsed.options.has('text') ||
      parsed.options.has('label') ||
      parsed.options.has('preceded-by') ||
      parsed.options.has('followed-by')
    ) {
      usage('--json cannot be combined with individual annotation options')
    }
    return (await readJsonSource(jsonSource, stdin, 'Annotation')).map((value, index) => annotationInput(value, index))
  }

  const kind = requireOption(parsed, 'kind')
  const decision = kind === 'decision'
  const quote = option(parsed, 'quote')
  const heading = option(parsed, 'heading')
  const document = parsed.options.has('document')
  const options = repeatedOption(parsed, 'option')
  if (!decision && quote === undefined) usage('Missing --quote')
  let text = option(parsed, 'text')
  if (text === '-') text = byteLengthWithin(await readStandardInput(stdin), '--text')
  if (decision && (text === undefined || text.trim().length === 0)) usage('A decision needs --text with its prompt')
  return [
    annotationInput({
      kind,
      ...(quote === undefined ? {} : { quote }),
      ...(heading === undefined ? {} : { heading }),
      ...(document ? { document: true } : {}),
      ...(decision ? { options } : {}),
      ...(text === undefined ? {} : { text }),
      ...(option(parsed, 'label') === undefined ? {} : { label: option(parsed, 'label') }),
      ...(option(parsed, 'preceded-by') === undefined
        ? {}
        : { precededBy: option(parsed, 'preceded-by') }),
      ...(option(parsed, 'followed-by') === undefined
        ? {}
        : { followedBy: option(parsed, 'followed-by') })
    })
  ]
}

function editInput(value: unknown, index?: number): EditInput {
  const prefix = index === undefined ? 'Edit' : `Edit ${index + 1}`
  if (!value || typeof value !== 'object' || Array.isArray(value)) usage(`${prefix} must be an object`)
  const input = value as Record<string, unknown>
  const allowed = new Set(['match', 'replace', 'precededBy', 'followedBy', 'append'])
  const unknown = Object.keys(input).filter((key) => !allowed.has(key))
  if (unknown.length) usage(`${prefix} has unknown fields`, { unknown, valid: [...allowed] })
  const match = input.match === undefined && input.append === true ? '' : input.match
  if (typeof match !== 'string') usage(`${prefix} needs a match string`)
  if (input.append !== undefined && input.append !== true) usage(`${prefix}.append must be true when present`)
  for (const key of ['precededBy', 'followedBy'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') usage(`${prefix}.${key} must be a string`)
  }
  const anchored = input.append === true || input.precededBy !== undefined || input.followedBy !== undefined
  if (match.length === 0 && !anchored) {
    usage(`${prefix} needs a non-empty match, or an empty match with precededBy or followedBy, or append`)
  }
  if (input.append === true && match.length > 0) usage(`${prefix} cannot combine append with a match`)
  if (typeof input.replace !== 'string') usage(`${prefix} needs a replace string`)
  byteLengthWithin(input.replace, `${prefix}.replace`)
  return {
    match,
    replace: input.replace,
    ...(typeof input.precededBy === 'string' ? { precededBy: input.precededBy } : {}),
    ...(typeof input.followedBy === 'string' ? { followedBy: input.followedBy } : {}),
    ...(input.append === true ? { append: true } : {})
  }
}

async function readJsonSource(source: string, stdin: NodeJS.ReadableStream, label: string): Promise<unknown[]> {
  let json: string
  try {
    json = source === '-' ? await readStandardInput(stdin) : await readFile(source, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CommandFailure(`Not found: ${source}`, 2, 'NOT_FOUND', { path: source })
    }
    throw error
  }
  let values: unknown
  try {
    values = JSON.parse(json)
  } catch {
    usage(`${label} JSON is not valid JSON`)
  }
  if (!Array.isArray(values) || values.length === 0) usage(`${label} JSON must be a non-empty array`)
  return values
}

async function readEdits(parsed: ParsedOptions, stdin: NodeJS.ReadableStream): Promise<EditInput[]> {
  const jsonSource = option(parsed, 'json')
  if (jsonSource !== undefined) {
    if (
      parsed.options.has('match') ||
      parsed.options.has('replace') ||
      parsed.options.has('preceded-by') ||
      parsed.options.has('followed-by') ||
      parsed.options.has('append')
    ) {
      usage('--json cannot be combined with individual edit options')
    }
    return (await readJsonSource(jsonSource, stdin, 'Edit')).map((value, index) => editInput(value, index))
  }

  const append = parsed.options.has('append')
  const match = option(parsed, 'match')
  if (match === undefined && !append) usage('Missing --match (or --append to insert at the end)')
  if (append && match !== undefined && match.length > 0) usage('--append takes no --match; it inserts at the end of the buffer')
  let replace = option(parsed, 'replace')
  if (replace === undefined) usage('Missing --replace')
  if (replace === '-') replace = await readStandardInput(stdin)
  return [
    editInput({
      match: match ?? '',
      replace,
      ...(option(parsed, 'preceded-by') === undefined ? {} : { precededBy: option(parsed, 'preceded-by') }),
      ...(option(parsed, 'followed-by') === undefined ? {} : { followedBy: option(parsed, 'followed-by') }),
      ...(append ? { append: true } : {})
    })
  ]
}

async function parseCommand(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream
): Promise<
  | { command: CommandName; args: CommandArguments[CommandName]; raw?: boolean }
  | { setup: true; remove: boolean; makeDefault: boolean; skill?: string }
  | { theme: true; id?: string; json: boolean }
  | { components: true; name?: string; json: boolean }
  | { validate: true; file: string; json: boolean }
  | { launch: true }
  | { doctor: true }
> {
  const command = argv[0]
  const rest = argv.slice(1)

  if (command === 'doctor') {
    const parsed = parseOptions(rest, {})
    exactPositionals(parsed, 0, 'doctor')
    return { doctor: true }
  }

  if (command === 'theme') {
    const parsed = parseOptions(rest, { json: { value: false } })
    atMostPositionals(parsed, 1, 'theme')
    const id = parsed.positionals[0]
    if (id !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) usage(`Theme ids are lowercase words joined by dashes, not ${id}`)
    return { theme: true, ...(id === undefined ? {} : { id }), json: parsed.options.has('json') }
  }

  if (command === 'components') {
    const parsed = parseOptions(rest, { json: { value: false } })
    atMostPositionals(parsed, 1, 'components')
    const name = parsed.positionals[0]
    return { components: true, ...(name === undefined ? {} : { name }), json: parsed.options.has('json') }
  }

  if (command === 'validate') {
    const parsed = parseOptions(rest, { json: { value: false } })
    exactPositionals(parsed, 1, 'validate')
    return { validate: true, file: parsed.positionals[0]!, json: parsed.options.has('json') }
  }

  if (command === 'setup') {
    const parsed = parseOptions(rest, { remove: { value: false }, default: { value: false }, skill: { value: true } })
    exactPositionals(parsed, 0, 'setup')
    if (parsed.options.has('remove') && parsed.options.has('default')) {
      usage('setup --remove and setup --default cannot be combined')
    }
    if (parsed.options.has('remove') && parsed.options.has('skill')) {
      usage('setup --remove does not touch skill copies; run it without --skill')
    }
    const skill = option(parsed, 'skill')
    if (skill === '') usage('--skill needs claude, codex, agents, or a skills directory')
    return {
      setup: true,
      remove: parsed.options.has('remove'),
      makeDefault: parsed.options.has('default'),
      ...(skill === undefined ? {} : { skill })
    }
  }

  if (command === 'attach') {
    const parsed = parseOptions(rest, {
      as: { value: true },
      name: { value: true },
      timeout: { value: true },
      'text-only': { value: false }
    })
    atMostPositionals(parsed, 1, command)
    const agent = option(parsed, 'as') || deriveAgentId(environment)
    const rawTimeout = option(parsed, 'timeout') ?? String(DEFAULT_ATTACH_TIMEOUT_SECONDS)
    if (!/^\d+$/.test(rawTimeout)) usage('--timeout must be a non-negative integer')
    const timeout = Number(rawTimeout)
    if (!Number.isSafeInteger(timeout) || timeout > 86_400) usage('--timeout must be at most 86400 seconds')
    const file = parsed.positionals[0]
    return {
      command,
      args: {
        ...(file === undefined ? {} : { file: await canonicalPath(file) }),
        agent,
        name: agentName(agent, option(parsed, 'name'), environment),
        timeout,
        ...(parsed.options.has('text-only') ? { textOnly: true } : {})
      }
    }
  }

  if (command === 'annotate') {
    const parsed = parseOptions(rest, {
      kind: { value: true },
      quote: { value: true },
      heading: { value: true },
      document: { value: false },
      option: { value: true, repeat: true },
      text: { value: true },
      label: { value: true },
      'preceded-by': { value: true },
      'followed-by': { value: true },
      as: { value: true },
      json: { value: true }
    })
    exactPositionals(parsed, 1, command)
    const agent = requireAgent(parsed, environment)
    const name = environment.AI_AGENT
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        ...(name ? { name } : {}),
        annotations: await readAnnotations(parsed, stdin)
      }
    }
  }

  if (command === 'edit') {
    const parsed = parseOptions(rest, {
      match: { value: true },
      replace: { value: true },
      'preceded-by': { value: true },
      'followed-by': { value: true },
      append: { value: false },
      'dry-run': { value: false },
      as: { value: true },
      name: { value: true },
      json: { value: true }
    })
    exactPositionals(parsed, 1, command)
    const agent = requireAgent(parsed, environment)
    const name = option(parsed, 'name') || environment.AI_AGENT
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        ...(name ? { name } : {}),
        edits: await readEdits(parsed, stdin),
        ...(parsed.options.has('dry-run') ? { dryRun: true } : {})
      }
    }
  }

  if (command === 'pin') {
    const parsed = parseOptions(rest, {
      component: { value: true },
      x: { value: true },
      y: { value: true },
      note: { value: true },
      as: { value: true },
      name: { value: true },
    })
    exactPositionals(parsed, 1, command)
    const componentLine = Number(requireOption(parsed, 'component'))
    const x = Number(requireOption(parsed, 'x'))
    const y = Number(requireOption(parsed, 'y'))
    const note = requireOption(parsed, 'note')
    if (!Number.isSafeInteger(componentLine) || componentLine < 1) usage('--component must be a positive line number')
    if (!Number.isFinite(x) || x < 0 || x > 100) usage('--x must be a number from 0 through 100')
    if (!Number.isFinite(y) || y < 0 || y > 100) usage('--y must be a number from 0 through 100')
    if (note.trim().length === 0) usage('--note must contain visible text')
    const agent = requireAgent(parsed, environment)
    const name = option(parsed, 'name') || environment.AI_AGENT
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        ...(name ? { name } : {}),
        componentLine,
        x,
        y,
        note: byteLengthWithin(note, '--note'),
      },
    }
  }

  if (command === 'reply') {
    const parsed = parseOptions(rest, {
      to: { value: true },
      text: { value: true },
      as: { value: true }
    })
    exactPositionals(parsed, 1, command)
    const agent = requireAgent(parsed, environment)
    let text = requireOption(parsed, 'text')
    if (text === '-') text = await readStandardInput(stdin)
    const name = environment.AI_AGENT
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        ...(name ? { name } : {}),
        annotation: requireOption(parsed, 'to'),
        text: byteLengthWithin(text, '--text')
      }
    }
  }

  if (command === 'answer') {
    const parsed = parseOptions(rest, {
      decision: { value: true },
      choice: { value: true },
      other: { value: true },
      as: { value: true }
    })
    exactPositionals(parsed, 1, command)
    const choice = option(parsed, 'choice')
    const other = option(parsed, 'other')
    if ((choice === undefined) === (other === undefined)) usage('answer needs exactly one of --choice or --other')
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent: requireAgent(parsed, environment),
        decision: requireOption(parsed, 'decision'),
        ...(choice === undefined ? {} : { choice }),
        ...(other === undefined ? {} : { other })
      }
    }
  }

  if (command === 'state') {
    const parsed = parseOptions(rest, {
      brief: { value: false },
      'text-only': { value: false },
      annotations: { value: false },
      raw: { value: false }
    })
    atMostPositionals(parsed, 1, command)
    const views = ['brief', 'text-only', 'annotations', 'raw'].filter((view) => parsed.options.has(view))
    if (views.length > 1) usage(`state takes one view; got ${views.map((view) => `--${view}`).join(' and ')}`)
    const file = parsed.positionals[0]
    return {
      command,
      args: {
        ...(file === undefined ? {} : { file: await canonicalPath(file) }),
        ...(parsed.options.has('brief') ? { brief: true } : {}),
        ...(parsed.options.has('text-only') ? { textOnly: true } : {}),
        ...(parsed.options.has('annotations') ? { annotationsOnly: true } : {})
      },
      ...(parsed.options.has('raw') ? { raw: true } : {})
    }
  }

  if (command === 'docs') {
    const parsed = parseOptions(rest, {})
    exactPositionals(parsed, 0, command)
    return { command, args: {} }
  }

  if (command === 'changed') {
    const parsed = parseOptions(rest, { as: { value: true }, name: { value: true } })
    exactPositionals(parsed, 1, command)
    const agent = requireAgent(parsed, environment)
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        name: agentName(agent, option(parsed, 'name'), environment)
      }
    }
  }

  if (command === 'detach') {
    const parsed = parseOptions(rest, { as: { value: true } })
    exactPositionals(parsed, 1, command)
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent: requireAgent(parsed, environment)
      }
    }
  }

  if (command === 'send') {
    const parsed = parseOptions(rest, {
      as: { value: true },
      text: { value: true },
      to: { value: true }
    })
    exactPositionals(parsed, 1, command)
    let text = requireOption(parsed, 'text')
    if (text === '-') text = await readStandardInput(stdin)
    if (text.length === 0) usage('--text needs a note')
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_TEXT_BYTES) usage('--text exceeds 4 KB')
    const toOption = option(parsed, 'to')
    const to = toOption?.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    if (toOption !== undefined && (to === undefined || to.length === 0)) usage('--to needs at least one agent id')
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent: requireAgent(parsed, environment),
        text,
        ...(to === undefined ? {} : { to })
      }
    }
  }

  if (command === 'lead' || command === 'save') {
    const parsed = parseOptions(rest, { as: { value: true } })
    exactPositionals(parsed, 1, command)
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent: requireAgent(parsed, environment)
      }
    }
  }

  if (command === 'accept' || command === 'reject' || command === 'resolve') {
    const parsed = parseOptions(rest, { annotation: { value: true }, as: { value: true } })
    exactPositionals(parsed, 1, command)
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent: requireAgent(parsed, environment),
        annotation: requireOption(parsed, 'annotation')
      }
    }
  }

  if (command === 'open') {
    const parsed = parseOptions(rest, {})
    atMostPositionals(parsed, 1, command)
    const file = parsed.positionals[0]
    // The desktop entry runs `open %f`; a menu launch passes no file and must
    // behave like a bare invocation.
    if (file === undefined) return { launch: true }
    return { command, args: { file: await canonicalPath(file) } }
  }

  if (['changes', 'checkpoint', 'forget'].includes(command ?? '')) {
    const parsed = parseOptions(rest, {})
    exactPositionals(parsed, 1, command!, command === 'checkpoint' ? '<file or directory>' : '<file>')
    return {
      command: command as 'changes' | 'checkpoint' | 'forget',
      args: { file: await canonicalPath(parsed.positionals[0]!) }
    }
  }

  usage(command ? `Unknown command: ${command}` : GENERAL_USAGE, { usage: GENERAL_USAGE })
}

async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`
  await new Promise<void>((resolve, reject) => {
    stream.write(line, 'utf8', (error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

const projectRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The app executable a launch would use: the packaged one from the launcher script, else a development electron. */
async function resolveAppExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const root = projectRoot()
  const configured = environment.STRATAMD_APP_EXECUTABLE
  // Development fallbacks cover both electron layouts: the Linux binary and
  // the Mac app bundle.
  const candidates = configured
    ? [configured]
    : [
        resolve(root, 'node_modules', 'electron', 'dist', 'electron'),
        resolve(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next layout.
    }
  }
  return undefined
}

/** The version in package.json, two levels above this module in both the source tree and the packaged asar. */
async function readAppVersion(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface VersionReport {
  version: string
  protocol: number
  payload: number
  cli: string
  app: string | null
}

export async function versionReport(environment: NodeJS.ProcessEnv = process.env): Promise<VersionReport> {
  return {
    version: await readAppVersion(),
    protocol: PROTOCOL_VERSION,
    payload: PAYLOAD_VERSION,
    cli: environment.STRATAMD_CLI_EXECUTABLE || process.argv[1] || 'stratamd',
    app: (await resolveAppExecutable(environment)) ?? null
  }
}

function logPathFor(environment: NodeJS.ProcessEnv, home: string): string {
  return join(getDataDirectory({ env: environment, home }), 'logs', 'stratamd.log')
}

function unreachable(message: string, socketPath: string, environment: NodeJS.ProcessEnv, home: string): CommandFailure {
  return new CommandFailure(message, 4, 'INSTANCE_UNREACHABLE', {
    socket: socketPath,
    log: logPathFor(environment, home),
    hint: 'Run stratamd doctor'
  })
}

export interface DoctorReport {
  ok: boolean
  version: VersionReport
  socket: { path: string; exists: boolean; answers: boolean; protocol: number | null; error?: string }
  directories: { data: string; config: string }
  log: { path: string; errors: string[] }
  locks: Array<{ path: string; document: string | null; pid: number | null; alive: boolean | null }>
  problems: string[]
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLogErrors(path: string, count = 5): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const errors: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const record = JSON.parse(line) as { level?: unknown; time?: unknown; scope?: unknown; message?: unknown }
      if (record.level !== 'error') continue
      errors.push(`${String(record.time ?? '')} ${String(record.scope ?? '')}: ${String(record.message ?? '')}`.trim())
    } catch {
      errors.push(line)
    }
  }
  return errors.slice(-count)
}

async function lockReports(dataDirectory: string): Promise<DoctorReport['locks']> {
  const docs = join(dataDirectory, 'docs')
  let entries: string[]
  try {
    entries = await readdir(docs)
  } catch {
    return []
  }
  const locks: DoctorReport['locks'] = []
  for (const entry of entries.sort()) {
    const path = join(docs, entry, 'lock')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let pid: number | null = null
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown }
      if (Number.isInteger(parsed.pid)) pid = parsed.pid as number
    } catch {
      // An unreadable lock is still reported, with no pid.
    }
    let document: string | null = null
    try {
      const meta = JSON.parse(await readFile(join(docs, entry, 'meta.json'), 'utf8')) as { realpath?: unknown }
      if (typeof meta.realpath === 'string') document = meta.realpath
    } catch {
      // A lock without readable meta is reported by path alone.
    }
    locks.push({ path, document, pid, alive: pid === null ? null : pidAlive(pid) })
  }
  return locks
}

/**
 * Everything an agent or the owner needs when a command fails for reasons
 * outside the document: is the app there, does it speak this protocol, where
 * do its files and log live, and which documents are locked by whom. Runs
 * without the app and never changes anything.
 */
export async function doctor(
  environment: NodeJS.ProcessEnv,
  home: string,
  socketPath: string,
  requestFunction: typeof requestOverSocket
): Promise<DoctorReport> {
  const problems: string[] = []
  const version = await versionReport(environment)
  if (version.app === null) problems.push('The app executable was not found; set STRATAMD_APP_EXECUTABLE or run from the packaged launcher')

  let exists = false
  try {
    exists = (await lstat(socketPath)).isSocket()
  } catch {
    // No socket: the app is not running.
  }
  const socket: DoctorReport['socket'] = { path: socketPath, exists, answers: false, protocol: null }
  try {
    const response = await requestFunction(requestFor('docs', {}), { socketPath, timeoutMs: 5_000 })
    socket.answers = true
    socket.protocol = typeof response.version === 'number' ? response.version : null
    if (!response.ok && response.error.code === 'PROTOCOL_MISMATCH') {
      problems.push(response.error.error)
    } else if (socket.protocol !== PROTOCOL_VERSION) {
      problems.push(protocolMismatchFailure('cli', PROTOCOL_VERSION, socket.protocol ?? 0).message)
    } else if (!response.ok) {
      problems.push(`The app answered the probe with ${response.error.code}: ${response.error.error}`)
    }
  } catch (error) {
    socket.error = error instanceof Error ? error.message : String(error)
    if (error instanceof SocketTimeoutError) {
      problems.push('StrataMD accepted the connection but did not answer in time; it may be stalled')
    } else if (exists) {
      problems.push('A socket file exists but nothing answers on it; StrataMD may have exited without cleaning up. Start the app again')
    } else {
      problems.push('StrataMD is not running (no socket). Start the app, or run stratamd open <file>')
    }
  }

  const context = { env: environment, home }
  const directories = { data: getDataDirectory(context), config: getConfigDirectory(context) }
  const logPath = logPathFor(environment, home)
  const errors = await readLogErrors(logPath)
  if (errors.length > 0) problems.push(`The log has recent errors (last: ${errors.at(-1)}); see ${logPath}`)

  const locks = await lockReports(directories.data)
  for (const lock of locks) {
    if (lock.alive === false) problems.push(`Stale lock ${lock.path}: process ${lock.pid} is not running${lock.document ? ` (document ${lock.document})` : ''}`)
    if (lock.alive === null) problems.push(`Unreadable lock ${lock.path}`)
  }

  return { ok: problems.length === 0, version, socket, directories, log: { path: logPath, errors }, locks, problems }
}

async function defaultLaunchApp(): Promise<void> {
  const root = projectRoot()
  const executable = await resolveAppExecutable()
  if (!executable) {
    throw new SocketUnavailableError('StrataMD application executable was not found', 'ENOENT')
  }

  const child = spawn(executable, [root], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  })
  child.unref()
}

/**
 * Retries only while the socket refuses or is absent (the app is still
 * starting). Once a connection is accepted the request runs with its full
 * timeout; a stall there is reported, never retried, so the app never sees
 * the same attach twice.
 */
async function waitForRequest(
  request: CommandRequest,
  requestFunction: typeof requestOverSocket,
  socketPath: string,
  launchBudgetMs: number,
  requestTimeoutMs: number,
  now: () => number
) {
  const deadline = now() + launchBudgetMs
  let lastError: unknown
  while (now() < deadline) {
    try {
      return await requestFunction(request, { socketPath, timeoutMs: requestTimeoutMs })
    } catch (error) {
      lastError = error
      if (!(error instanceof SocketUnavailableError)) throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
  }
  throw lastError ?? new SocketUnavailableError('StrataMD did not start', 'ETIMEDOUT')
}

interface OfflineModule {
  handleOfflineCommand?: SocketCommandHandler
  describeThemeOffline?: (configDirectory?: string, id?: string) => Promise<ThemeDescription>
}

interface ThemeDescription {
  id: string
  name: string
  path: string | null
  directory: string
  set: Record<string, string | number>
  defaults: Record<string, string | number>
  keys: { key: string; label: string; description: string; group: string; kind: string }[]
  problems: { key: string; reason: string }[]
}

async function loadOfflineModule(environment: NodeJS.ProcessEnv): Promise<OfflineModule | undefined> {
  const configured = environment.STRATAMD_OFFLINE_MODULE
  const candidates = configured
    ? [pathToFileURL(resolve(configured)).href]
    : [new URL('../main/offline.ts', import.meta.url).href, new URL('../main/offline.js', import.meta.url).href]

  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('file:')) await access(fileURLToPath(candidate))
      const module = (await import(/* @vite-ignore */ candidate)) as OfflineModule
      if (typeof module.handleOfflineCommand === 'function') return module
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

async function loadOfflineHandler(environment: NodeJS.ProcessEnv): Promise<SocketCommandHandler | undefined> {
  return (await loadOfflineModule(environment))?.handleOfflineCommand
}

async function writeText(stream: NodeJS.WritableStream, text: string): Promise<void> {
  await new Promise<void>((resolveWrite, reject) => {
    stream.write(text, 'utf8', (error?: Error | null) => (error ? reject(error) : resolveWrite()))
  })
}

export function formatThemeDescription(described: ThemeDescription): string {
  const lines: string[] = []
  lines.push(`${described.name} (${described.id})`)
  lines.push(described.path ? `file: ${described.path}` : `built-in; user themes live in ${described.directory}`)
  const label = (key: string) => described.keys.find((entry) => entry.key === key)
  const setKeys = Object.keys(described.set)
  lines.push('', setKeys.length ? 'SET (chosen by the theme\'s authors):' : 'SET: nothing yet; every value below is the built-in default.')
  for (const key of setKeys) lines.push(`  ${key} = ${String(described.set[key])}    ${label(key)?.description ?? ''}`)
  lines.push('', 'DEFAULT (not in the file; write any of these to set them):')
  for (const key of Object.keys(described.defaults)) lines.push(`  ${key} = ${String(described.defaults[key])}    ${label(key)?.description ?? ''}`)
  if (described.problems.length) {
    lines.push('', 'PROBLEMS (each falls back to the default until fixed):')
    for (const problem of described.problems) lines.push(`  ${problem.key}: ${problem.reason}`)
  }
  lines.push('')
  return lines.join('\n')
}

function componentSchemas(name?: string): ComponentSchema[] {
  if (name === undefined) return COMPONENT_NAMES.map((componentName) => COMPONENT_REGISTRY[componentName])
  if (!(COMPONENT_NAMES as readonly string[]).includes(name)) {
    throw new CommandFailure(
      `Component ${name} is not registered`,
      2,
      'COMPONENT_NOT_FOUND',
      { name, registered: COMPONENT_NAMES },
    )
  }
  return [COMPONENT_REGISTRY[name as keyof typeof COMPONENT_REGISTRY]]
}

export function formatComponentSchemas(schemas: readonly ComponentSchema[]): string {
  const lines: string[] = []
  for (const schema of schemas) {
    lines.push(`${schema.name} — ${schema.purpose}`, `Body: ${schema.body}`)
    const properties = Object.entries(schema.properties)
    if (properties.length === 0) lines.push('Properties: none')
    else {
      lines.push('Properties:')
      for (const [name, property] of properties) {
        lines.push(`  ${name}: ${property.values.join(' | ')} (default ${property.default}) — ${property.description}`)
      }
    }
    lines.push('Example:', schema.example, '')
  }
  return lines.join('\n')
}

export function formatComponentValidation(file: string, report: ComponentValidationReport): string {
  const lines = [`${report.valid ? 'Valid' : 'Needs attention'}: ${file}`]
  if (report.components.length === 0) lines.push('Components: none')
  else lines.push('Components:', ...report.components.map((component) => `  line ${component.line}: ${component.name}`))
  if (report.problems.length === 0) lines.push('Problems: none')
  else lines.push('Problems:', ...report.problems.map((item) => `  ${item.code} at ${item.line}:${item.column}: ${item.message} ${item.fix}`))
  return `${lines.join('\n')}\n`
}

function requestFor<C extends CommandName>(command: C, args: CommandArguments[C]): CommandRequest<C> {
  return { version: PROTOCOL_VERSION, id: randomUUID(), command, args } as CommandRequest<C>
}

function isPayload(value: unknown): value is AgentPayload {
  return !!value && typeof value === 'object' && typeof (value as { event?: unknown }).event === 'string'
}

/** A response from another build: the app already said so, or its version differs from ours. */
function responseMismatch(response: CommandResponse): CommandFailure | undefined {
  if (!response.ok && response.error.code === 'PROTOCOL_MISMATCH') {
    return new CommandFailure(response.error.error, 4, 'PROTOCOL_MISMATCH', response.error.detail)
  }
  if (response.version !== PROTOCOL_VERSION) {
    return protocolMismatchFailure('cli', PROTOCOL_VERSION, typeof response.version === 'number' ? response.version : 0)
  }
  return undefined
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const environment = runtime.environment ?? process.env
  const io: CliIo = {
    stdin: runtime.io?.stdin ?? process.stdin,
    stdout: runtime.io?.stdout ?? process.stdout,
    stderr: runtime.io?.stderr ?? process.stderr
  }

  const home = environment.HOME || homedir()
  const requestFunction = runtime.request ?? requestOverSocket
  const socketPath = runtime.socketPath ?? socketPathForEnvironment(environment, home)

  try {
    if (argv.includes('--agent-help')) {
      if (argv.length !== 1) usage('--agent-help cannot be combined with a command')
      await writeText(io.stdout, `${AGENT_HELP}\n`)
      return 0
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
      if (argv.length !== 1) usage('--version cannot be combined with a command')
      await writeLine(io.stdout, await versionReport(environment))
      return 0
    }
    if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
      await writeText(io.stdout, HELP_TEXT)
      return 0
    }

    if (argv.length === 0) {
      await (runtime.launchApp ?? defaultLaunchApp)()
      return 0
    }

    const parsed = await parseCommand(argv, environment, io.stdin)
    if ('launch' in parsed) {
      await (runtime.launchApp ?? defaultLaunchApp)()
      return 0
    }
    if ('doctor' in parsed) {
      await writeLine(io.stdout, await doctor(environment, home, socketPath, requestFunction))
      return 0
    }
    if ('theme' in parsed) {
      const offline = await loadOfflineModule(environment)
      if (!offline?.describeThemeOffline) throw new CommandFailure('Theme files are unavailable from this install', 4, 'INSTANCE_UNREACHABLE')
      const described = await offline.describeThemeOffline(environment.STRATAMD_CONFIG_DIRECTORY, parsed.id)
      if (parsed.json) await writeLine(io.stdout, described)
      else await writeText(io.stdout, formatThemeDescription(described))
      return 0
    }
    if ('components' in parsed) {
      const schemas = componentSchemas(parsed.name)
      if (parsed.json) await writeLine(io.stdout, { components: schemas })
      else await writeText(io.stdout, formatComponentSchemas(schemas))
      return 0
    }
    if ('validate' in parsed) {
      let file: string
      let source: string
      try {
        file = await realpath(resolve(parsed.file))
        source = await readFile(file, 'utf8')
      } catch {
        throw new CommandFailure(`Markdown file not found: ${parsed.file}`, 2, 'NOT_FOUND', { file: parsed.file })
      }
      const report = validateComponentMarkdown(source)
      const result = { file, ...report }
      if (parsed.json) await writeLine(io.stdout, result)
      else await writeText(io.stdout, formatComponentValidation(file, report))
      return 0
    }
    if ('setup' in parsed) {
      // Notices go to stderr so stdout stays one JSON line like every other command.
      const result = await setup({
        remove: parsed.remove,
        makeDefault: parsed.makeDefault,
        ...(parsed.skill === undefined ? {} : { skill: parsed.skill }),
        environment,
        home: environment.HOME || homedir(),
        report: (text) => writeText(io.stderr, text)
      })
      await writeLine(io.stdout, result)
      return 0
    }

    const request = requestFor(parsed.command, parsed.args as never)
    let response: CommandResponse
    const requestTimeout =
      parsed.command === 'attach'
        ? ((parsed.args as CommandArguments['attach']).timeout + 15) * 1_000
        : 15_000
    try {
      response = await requestFunction(request, { socketPath, timeoutMs: requestTimeout })
    } catch (error) {
      // Only a failed connection means no instance. A timeout after the
      // connection was accepted is a stalled instance: launching another
      // would double-attach, and answering offline would race it.
      if (!(error instanceof SocketUnavailableError)) throw error

      if (parsed.command === 'open' || parsed.command === 'attach') {
        await (runtime.launchApp ?? defaultLaunchApp)()
        response = await waitForRequest(request, requestFunction, socketPath, 10_000, requestTimeout, runtime.now ?? Date.now)
      } else if (OFFLINE_COMMANDS.has(parsed.command)) {
        const offline = runtime.offlineHandler ?? (await loadOfflineHandler(environment))
        if (!offline) {
          throw unreachable('StrataMD is not running and offline commands are unavailable', socketPath, environment, home)
        }
        const result = await offline(request, {
          connectionId: `offline-${request.id}`,
          signal: new AbortController().signal,
          ...(process.getuid ? { peerUid: process.getuid() } : {})
        })
        response = {
          version: PROTOCOL_VERSION,
          id: request.id,
          ok: true as const,
          ...(result === undefined ? {} : { result })
        }
      } else {
        throw unreachable('StrataMD is not running', socketPath, environment, home)
      }
    }

    const mismatch = responseMismatch(response)
    if (mismatch) throw mismatch

    if (!response.ok) {
      await writeLine(io.stderr, response.error)
      return response.exitCode
    }

    if ('raw' in parsed && parsed.raw) {
      const document = (response.result as { document?: unknown } | undefined)?.document
      if (typeof document !== 'string') {
        throw new CommandFailure('The state payload carried no document', 4, 'COMMAND_FAILED')
      }
      await writeText(io.stdout, document)
      return 0
    }

    // Every command answers with one JSON object, so a caller never has to
    // treat empty output as success.
    await writeLine(io.stdout, response.result === undefined ? { ok: true } : response.result)

    if (isPayload(response.result) && response.result.deliveryId) {
      if (!response.result.file || !response.result.agent) {
        throw new CommandFailure('Delivery response is missing file or agent', 4, 'INVALID_DELIVERY')
      }
      const ack = requestFor('ack', {
        file: response.result.file,
        agent: response.result.agent,
        deliveryId: response.result.deliveryId
      })
      // The payload is already on stdout, so a failed ack is a warning: the
      // same delivery arrives again on the next attach, with the same id.
      const ackWarning = 'The delivery was printed but not acknowledged; it repeats on your next attach with the same deliveryId'
      try {
        const acknowledged = await requestFunction(ack, { socketPath, timeoutMs: 15_000 })
        const ackMismatch = responseMismatch(acknowledged)
        if (ackMismatch) throw ackMismatch
        if (!acknowledged.ok) await writeLine(io.stderr, { warning: ackWarning, ...acknowledged.error })
      } catch (error) {
        await writeLine(io.stderr, {
          warning: ackWarning,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof CommandFailure ? error.code : 'ACK_FAILED'
        })
      }
    }
    return 0
  } catch (error) {
    const failure =
      error instanceof CommandFailure
        ? error
        : error instanceof SocketUnavailableError
          ? unreachable(error.message, socketPath, environment, home)
          : error instanceof SocketTimeoutError
            ? new CommandFailure(error.message, 4, 'INSTANCE_TIMEOUT')
            : new CommandFailure(error instanceof Error ? error.message : 'Command failed', 1, 'COMMAND_FAILED')
    await writeLine(io.stderr, {
      error: failure.message,
      code: failure.code,
      ...(failure.detail === undefined ? {} : { detail: failure.detail })
    })
    return failure.exitCode
  }
}
