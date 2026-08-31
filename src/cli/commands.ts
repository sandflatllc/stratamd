import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { access, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_HELP } from './agent-help.js'
import {
  CommandFailure,
  PROTOCOL_VERSION,
  type AgentPayload,
  type AnnotationInput,
  type CommandArguments,
  type CommandName,
  type CommandRequest,
  type SocketCommandHandler
} from './protocol.js'
import {
  requestOverSocket,
  SocketUnavailableError,
  socketPathForEnvironment
} from './socket-client.js'
import { setup } from './setup.js'

const MAX_TEXT_BYTES = 64 * 1024
const MAX_MESSAGE_TEXT_BYTES = 4 * 1024
// The six collaboration verbs (send, lead, accept, reject, resolve, save) are
// online-only: no offline handler and no app auto-launch (PRD §6.8).
const OFFLINE_COMMANDS = new Set<CommandName>([
  'annotate',
  'reply',
  'state',
  'changes',
  'changed',
  'checkpoint',
  'forget'
])
const STDOUT_COMMANDS = new Set<CommandName>(['attach', 'state', 'changes', 'send'])

const GENERAL_USAGE =
  'Usage: stratamd <attach|annotate|reply|send|lead|accept|reject|resolve|save|state|theme|changes|changed|open|checkpoint|detach|forget|setup> [options]'

interface ParsedOptions {
  positionals: string[]
  options: Map<string, string | true>
}

interface OptionDefinition {
  value: boolean
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
  const options = new Map<string, string | true>()
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
    if (!definition) usage(`Unknown option --${name}`)
    if (options.has(name)) usage(`Option --${name} may only be given once`)

    if (!definition.value) {
      if (equals !== -1) usage(`Option --${name} does not take a value`)
      options.set(name, true)
      continue
    }

    const value = equals === -1 ? tokens[++index] : token.slice(equals + 1)
    if (value === undefined) usage(`Option --${name} needs a value`)
    options.set(name, value)
  }

  return { positionals, options }
}

function option(parsed: ParsedOptions, name: string): string | undefined {
  const value = parsed.options.get(name)
  return typeof value === 'string' ? value : undefined
}

function requireOption(parsed: ParsedOptions, name: string): string {
  const value = option(parsed, name)
  if (value === undefined || value.length === 0) usage(`Missing --${name}`)
  return value
}

function exactPositionals(parsed: ParsedOptions, count: number, command: string): void {
  if (parsed.positionals.length !== count) usage(`Invalid ${command} arguments`)
}

function atMostPositionals(parsed: ParsedOptions, count: number, command: string): void {
  if (parsed.positionals.length > count) usage(`Invalid ${command} arguments`)
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

export function deriveAgentId(environment: NodeJS.ProcessEnv = process.env): string {
  const session =
    environment.CLAUDE_CODE_SESSION_ID ??
    environment.CODEX_THREAD_ID ??
    environment.CODEX_SESSION_ID ??
    environment.T3_CODE_SESSION_ID ??
    environment.CURSOR_AGENT_SESSION_ID
  if (!session) return `ag_${randomBytes(9).toString('base64url')}`
  return `ag_${createHash('sha256').update(session).digest('hex').slice(0, 12)}`
}

function agentName(agent: string, specified: string | undefined, environment: NodeJS.ProcessEnv): string {
  return specified || environment.AI_AGENT || agent
}

function annotationInput(value: unknown, index?: number): AnnotationInput {
  const prefix = index === undefined ? 'Annotation' : `Annotation ${index + 1}`
  if (!value || typeof value !== 'object' || Array.isArray(value)) usage(`${prefix} must be an object`)
  const input = value as Record<string, unknown>
  const allowed = new Set(['kind', 'quote', 'text', 'label', 'precededBy', 'followedBy'])
  const unknown = Object.keys(input).filter((key) => !allowed.has(key))
  if (unknown.length) usage(`${prefix} has unknown fields`, unknown)
  if (!['comment', 'question', 'suggestion'].includes(String(input.kind))) {
    usage(`${prefix} has an invalid kind`)
  }
  if (typeof input.quote !== 'string' || input.quote.length === 0) {
    usage(`${prefix} needs a non-empty quote`)
  }
  for (const key of ['text', 'label', 'precededBy', 'followedBy'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      usage(`${prefix}.${key} must be a string`)
    }
  }
  if (typeof input.text === 'string') byteLengthWithin(input.text, `${prefix}.text`)

  return {
    kind: input.kind as AnnotationInput['kind'],
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
      parsed.options.has('text') ||
      parsed.options.has('label') ||
      parsed.options.has('preceded-by') ||
      parsed.options.has('followed-by')
    ) {
      usage('--json cannot be combined with individual annotation options')
    }
    let json: string
    try {
      json = jsonSource === '-' ? await readStandardInput(stdin) : await readFile(jsonSource, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CommandFailure(`Not found: ${jsonSource}`, 2, 'NOT_FOUND', { path: jsonSource })
      }
      throw error
    }
    let values: unknown
    try {
      values = JSON.parse(json)
    } catch {
      usage('Annotation JSON is not valid JSON')
    }
    if (!Array.isArray(values) || values.length === 0) usage('Annotation JSON must be a non-empty array')
    return values.map((value, index) => annotationInput(value, index))
  }

  const kind = requireOption(parsed, 'kind')
  const quote = requireOption(parsed, 'quote')
  let text = option(parsed, 'text')
  if (text === '-') text = byteLengthWithin(await readStandardInput(stdin), '--text')
  return [
    annotationInput({
      kind,
      quote,
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

async function parseCommand(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream
): Promise<{ command: CommandName; args: CommandArguments[CommandName] } | { setup: true; remove: boolean; makeDefault: boolean } | { theme: true; id?: string; json: boolean } | { launch: true }> {
  const command = argv[0]
  const rest = argv.slice(1)

  if (command === 'theme') {
    const parsed = parseOptions(rest, { json: { value: false } })
    atMostPositionals(parsed, 1, 'theme')
    const id = parsed.positionals[0]
    if (id !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) usage(`Theme ids are lowercase words joined by dashes, not ${id}`)
    return { theme: true, ...(id === undefined ? {} : { id }), json: parsed.options.has('json') }
  }

  if (command === 'setup') {
    const parsed = parseOptions(rest, { remove: { value: false }, default: { value: false } })
    exactPositionals(parsed, 0, 'setup')
    if (parsed.options.has('remove') && parsed.options.has('default')) {
      usage('setup --remove and setup --default cannot be combined')
    }
    return {
      setup: true,
      remove: parsed.options.has('remove'),
      makeDefault: parsed.options.has('default')
    }
  }

  if (command === 'attach') {
    const parsed = parseOptions(rest, {
      as: { value: true },
      name: { value: true },
      timeout: { value: true }
    })
    atMostPositionals(parsed, 1, command)
    const agent = option(parsed, 'as') || deriveAgentId(environment)
    const rawTimeout = option(parsed, 'timeout') ?? '600'
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
        timeout
      }
    }
  }

  if (command === 'annotate') {
    const parsed = parseOptions(rest, {
      kind: { value: true },
      quote: { value: true },
      text: { value: true },
      label: { value: true },
      'preceded-by': { value: true },
      'followed-by': { value: true },
      as: { value: true },
      json: { value: true }
    })
    exactPositionals(parsed, 1, command)
    const agent = option(parsed, 'as') || deriveAgentId(environment)
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        annotations: await readAnnotations(parsed, stdin)
      }
    }
  }

  if (command === 'reply') {
    const parsed = parseOptions(rest, {
      to: { value: true },
      text: { value: true },
      as: { value: true }
    })
    exactPositionals(parsed, 1, command)
    const agent = option(parsed, 'as') || deriveAgentId(environment)
    let text = requireOption(parsed, 'text')
    if (text === '-') text = await readStandardInput(stdin)
    return {
      command,
      args: {
        file: await canonicalPath(parsed.positionals[0]!),
        agent,
        annotation: requireOption(parsed, 'to'),
        text: byteLengthWithin(text, '--text')
      }
    }
  }

  if (command === 'state') {
    const parsed = parseOptions(rest, {})
    atMostPositionals(parsed, 1, command)
    const file = parsed.positionals[0]
    return { command, args: file === undefined ? {} : { file: await canonicalPath(file) } }
  }

  if (command === 'changed') {
    const parsed = parseOptions(rest, { as: { value: true }, name: { value: true } })
    exactPositionals(parsed, 1, command)
    const agent = requireOption(parsed, 'as')
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
        agent: requireOption(parsed, 'as')
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
        agent: requireOption(parsed, 'as'),
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
        agent: requireOption(parsed, 'as')
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
        agent: requireOption(parsed, 'as'),
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
    exactPositionals(parsed, 1, command!)
    return {
      command: command as 'changes' | 'checkpoint' | 'forget',
      args: { file: await canonicalPath(parsed.positionals[0]!) }
    }
  }

  usage(command ? `Unknown command: ${command}` : GENERAL_USAGE)
}

async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`
  await new Promise<void>((resolve, reject) => {
    stream.write(line, 'utf8', (error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

async function defaultLaunchApp(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const configured = process.env.STRATAMD_APP_EXECUTABLE
  // Development fallbacks cover both electron layouts: the Linux binary and
  // the Mac app bundle.
  const candidates = configured
    ? [configured]
    : [
        resolve(root, 'node_modules', 'electron', 'dist', 'electron'),
        resolve(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      ]
  let executable: string | undefined
  for (const candidate of candidates) {
    try {
      await access(candidate)
      executable = candidate
      break
    } catch {
      // Try the next layout.
    }
  }
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

async function waitForRequest(
  request: CommandRequest,
  requestFunction: typeof requestOverSocket,
  socketPath: string,
  timeoutMs: number,
  now: () => number
) {
  const deadline = now() + timeoutMs
  let lastError: unknown
  while (now() < deadline) {
    try {
      return await requestFunction(request, { socketPath, timeoutMs: 1_000 })
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

function requestFor<C extends CommandName>(command: C, args: CommandArguments[C]): CommandRequest<C> {
  return { version: PROTOCOL_VERSION, id: randomUUID(), command, args } as CommandRequest<C>
}

function isPayload(value: unknown): value is AgentPayload {
  return !!value && typeof value === 'object' && typeof (value as { event?: unknown }).event === 'string'
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const environment = runtime.environment ?? process.env
  const io: CliIo = {
    stdin: runtime.io?.stdin ?? process.stdin,
    stdout: runtime.io?.stdout ?? process.stdout,
    stderr: runtime.io?.stderr ?? process.stderr
  }

  try {
    if (argv.includes('--agent-help')) {
      if (argv.length !== 1) usage('--agent-help cannot be combined with a command')
      await new Promise<void>((resolveWrite, rejectWrite) => {
        io.stdout.write(`${AGENT_HELP}\n`, 'utf8', (error?: Error | null) =>
          error ? rejectWrite(error) : resolveWrite()
        )
      })
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
    if ('theme' in parsed) {
      const offline = await loadOfflineModule(environment)
      if (!offline?.describeThemeOffline) throw new CommandFailure('Theme files are unavailable from this install', 4, 'INSTANCE_UNREACHABLE')
      const described = await offline.describeThemeOffline(environment.STRATAMD_CONFIG_DIRECTORY, parsed.id)
      if (parsed.json) await writeLine(io.stdout, described)
      else await writeText(io.stdout, formatThemeDescription(described))
      return 0
    }
    if ('setup' in parsed) {
      await setup({
        remove: parsed.remove,
        makeDefault: parsed.makeDefault,
        environment,
        home: environment.HOME || homedir(),
        report: (text) => writeText(io.stdout, text)
      })
      return 0
    }

    const request = requestFor(parsed.command, parsed.args as never)
    const requestFunction = runtime.request ?? requestOverSocket
    const socketPath = runtime.socketPath ?? socketPathForEnvironment(environment, environment.HOME || homedir())
    let response
    try {
      const requestTimeout =
        parsed.command === 'attach'
          ? ((parsed.args as CommandArguments['attach']).timeout + 15) * 1_000
          : 15_000
      response = await requestFunction(request, { socketPath, timeoutMs: requestTimeout })
    } catch (error) {
      if (!(error instanceof SocketUnavailableError)) throw error

      if (parsed.command === 'open' || parsed.command === 'attach') {
        await (runtime.launchApp ?? defaultLaunchApp)()
        response = await waitForRequest(request, requestFunction, socketPath, 10_000, runtime.now ?? Date.now)
      } else if (OFFLINE_COMMANDS.has(parsed.command)) {
        const offline = runtime.offlineHandler ?? (await loadOfflineHandler(environment))
        if (!offline) {
          throw new CommandFailure('StrataMD is not running and offline commands are unavailable', 4, 'INSTANCE_UNREACHABLE')
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
        throw new CommandFailure('StrataMD is not running', 4, 'INSTANCE_UNREACHABLE')
      }
    }

    if (!response.ok) {
      await writeLine(io.stderr, response.error)
      return response.exitCode
    }

    if (response.result !== undefined && STDOUT_COMMANDS.has(parsed.command)) {
      await writeLine(io.stdout, response.result)
    }

    if (isPayload(response.result) && response.result.deliveryId) {
      if (!response.result.file || !response.result.agent) {
        throw new CommandFailure('Delivery response is missing file or agent', 4, 'INVALID_DELIVERY')
      }
      const ack = requestFor('ack', {
        file: response.result.file,
        agent: response.result.agent,
        deliveryId: response.result.deliveryId
      })
      const acknowledged = await requestFunction(ack, { socketPath, timeoutMs: 15_000 })
      if (!acknowledged.ok) {
        await writeLine(io.stderr, acknowledged.error)
        return acknowledged.exitCode
      }
    }
    return 0
  } catch (error) {
    const failure =
      error instanceof CommandFailure
        ? error
        : error instanceof SocketUnavailableError
          ? new CommandFailure(error.message, 4, 'INSTANCE_UNREACHABLE')
          : new CommandFailure(error instanceof Error ? error.message : 'Command failed', 1, 'COMMAND_FAILED')
    await writeLine(io.stderr, {
      error: failure.message,
      code: failure.code,
      ...(failure.detail === undefined ? {} : { detail: failure.detail })
    })
    return failure.exitCode
  }
}
