import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { getConfigDirectory, getDataDirectory } from '../platform/paths.js'
import { SettingsStore } from '../main/settings.js'
import { BUILT_IN_THEME, describeTheme, ThemeBrokenError, ThemeStore } from '../main/themes.js'
import { AGENT_HELP } from './agent-help.js'
import { setup } from './setup.js'

const HELP_TEXT = `Usage: stratamd <open|theme|setup|doctor> [options], stratamd --agent-help, stratamd --version

  open [file]          open StrataMD, optionally with one Markdown file
  theme [id] [--json] inspect the active or named theme
  setup [options]      install the launcher, desktop integration, or bundled skill
  doctor               report local paths and readable configuration problems
  --agent-help         print the T3 thread contract
  --version            print build and launcher paths

The file-only tool never carries agent traffic.
`

class CliFailure extends Error {
  constructor(message: string, readonly exitCode = 1, readonly code = 'USAGE', readonly detail?: unknown) {
    super(message)
  }
}

export interface CliIo {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export interface CliRuntime {
  environment?: NodeJS.ProcessEnv
  io?: Partial<CliIo>
  launchApp?: (file?: string) => Promise<void>
}

async function writeText(stream: NodeJS.WritableStream, value: string): Promise<void> {
  await new Promise<void>((done, reject) => stream.write(value, 'utf8', (error?: Error | null) => error ? reject(error) : done()))
}

async function writeJson(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  await writeText(stream, `${JSON.stringify(value)}\n`)
}

async function appVersion(): Promise<string> {
  try {
    const value = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function appExecutable(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const root = resolve(new URL('../../', import.meta.url).pathname)
  const candidates = environment.STRATAMD_APP_EXECUTABLE
    ? [environment.STRATAMD_APP_EXECUTABLE]
    : [
        resolve(root, 'node_modules/electron/dist/electron'),
        resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      ]
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* next */ }
  }
  return null
}

export async function versionReport(environment: NodeJS.ProcessEnv = process.env) {
  return {
    version: await appVersion(),
    contract: 1,
    cli: environment.STRATAMD_CLI_EXECUTABLE || process.argv[1] || 'stratamd',
    app: await appExecutable(environment),
  }
}

async function defaultLaunchApp(file: string | undefined, environment: NodeJS.ProcessEnv): Promise<void> {
  const executable = await appExecutable(environment)
  if (!executable) throw new CliFailure('StrataMD application executable was not found', 2, 'APP_NOT_FOUND')
  const packaged = Boolean(environment.STRATAMD_APP_EXECUTABLE)
  const root = resolve(new URL('../../', import.meta.url).pathname)
  const args = packaged ? (file ? [file] : []) : [root, ...(file ? [file] : [])]
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...environment, ELECTRON_RUN_AS_NODE: undefined },
  })
  child.unref()
}

function parseTheme(tokens: string[]): { id?: string; json: boolean } {
  const json = tokens.includes('--json')
  const values = tokens.filter((token) => token !== '--json')
  if (values.some((token) => token.startsWith('--'))) throw new CliFailure(`Unknown theme option: ${values.find((token) => token.startsWith('--'))}`)
  if (values.length > 1) throw new CliFailure('theme takes at most one id')
  return { ...(values[0] ? { id: values[0] } : {}), json }
}

async function themeDescription(environment: NodeJS.ProcessEnv, id?: string) {
  const home = environment.HOME || homedir()
  const configDirectory = environment.STRATAMD_CONFIG_DIRECTORY || getConfigDirectory({ env: environment, home })
  const themes = new ThemeStore({ configDirectory })
  let selected = id
  if (!selected) selected = (await new SettingsStore({ configDirectory }).load()).theme
  try {
    return { ...describeTheme(await themes.load(selected)), directory: themes.directory }
  } catch (error) {
    if (id || (!(error instanceof ThemeBrokenError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')) throw error
    return { ...describeTheme(BUILT_IN_THEME), directory: themes.directory }
  }
}

export function formatThemeDescription(value: Awaited<ReturnType<typeof themeDescription>>): string {
  const lines = [`${value.name} (${value.id})`, value.path ?? `built-in; user themes live in ${value.directory}`, '']
  lines.push('Set values:')
  const chosen = Object.entries(value.set)
  lines.push(...(chosen.length ? chosen.map(([key, item]) => `  ${key} = ${String(item)}`) : ['  none']))
  if (value.problems.length) lines.push('', 'Problems:', ...value.problems.map((item) => `  ${item.key}: ${item.reason}`))
  return `${lines.join('\n')}\n`
}

export async function doctor(environment: NodeJS.ProcessEnv = process.env) {
  const home = environment.HOME || homedir()
  const directories = {
    data: getDataDirectory({ env: environment, home }),
    config: getConfigDirectory({ env: environment, home }),
  }
  const app = await appExecutable(environment)
  const paths = {
    app,
    cli: environment.STRATAMD_CLI_EXECUTABLE || process.argv[1] || 'stratamd',
    log: resolve(directories.data, 'logs/stratamd.log'),
    engineCredential: resolve(directories.data, 'engine-credential.json'),
  }
  const problems = app ? [] : ['The StrataMD application executable was not found.']
  return { ok: problems.length === 0, version: await appVersion(), directories, paths, problems }
}

function setupArgs(tokens: string[]): { remove: boolean; makeDefault: boolean; skill?: string } {
  let remove = false
  let makeDefault = false
  let skill: string | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--remove') remove = true
    else if (token === '--default') makeDefault = true
    else if (token === '--skill') {
      skill = tokens[++index]
      if (!skill) throw new CliFailure('--skill needs a target')
    } else throw new CliFailure(`Unknown setup option: ${token}`)
  }
  if (remove && (makeDefault || skill)) throw new CliFailure('--remove cannot be combined with --default or --skill')
  return { remove, makeDefault, ...(skill ? { skill } : {}) }
}

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  const environment = runtime.environment ?? process.env
  const io: CliIo = {
    stdout: runtime.io?.stdout ?? process.stdout,
    stderr: runtime.io?.stderr ?? process.stderr,
  }
  try {
    if (argv.length === 0) {
      await (runtime.launchApp ?? ((file) => defaultLaunchApp(file, environment)))()
      return 0
    }
    if (argv[0] === '--agent-help') {
      if (argv.length !== 1) throw new CliFailure('--agent-help cannot be combined with a command')
      await writeText(io.stdout, `${AGENT_HELP}\n`)
      return 0
    }
    if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
      if (argv.length !== 1) throw new CliFailure('help does not take arguments')
      await writeText(io.stdout, HELP_TEXT)
      return 0
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
      if (argv.length !== 1) throw new CliFailure('--version cannot be combined with a command')
      await writeJson(io.stdout, await versionReport(environment))
      return 0
    }

    const [command, ...tokens] = argv
    if (command === 'open') {
      if (tokens.length > 1) throw new CliFailure('open takes at most one Markdown file')
      const file = tokens[0] ? resolve(tokens[0]) : undefined
      if (file && !/\.(?:md|markdown)$/i.test(file)) throw new CliFailure(`Not a Markdown file: ${file}`, 2, 'NOT_MARKDOWN', { file })
      if (file) {
        try { await access(file) } catch { throw new CliFailure(`Markdown file not found: ${file}`, 2, 'NOT_FOUND', { file }) }
      }
      await (runtime.launchApp ?? ((value) => defaultLaunchApp(value, environment)))(file)
      await writeJson(io.stdout, { opened: file ?? null })
      return 0
    }
    if (command === 'theme') {
      const parsed = parseTheme(tokens)
      const value = await themeDescription(environment, parsed.id)
      if (parsed.json) await writeJson(io.stdout, value)
      else await writeText(io.stdout, formatThemeDescription(value))
      return 0
    }
    if (command === 'doctor') {
      if (tokens.length) throw new CliFailure('doctor takes no arguments')
      await writeJson(io.stdout, await doctor(environment))
      return 0
    }
    if (command === 'setup') {
      const parsed = setupArgs(tokens)
      const result = await setup({
        ...parsed,
        environment,
        home: environment.HOME || homedir(),
        report: (notice) => writeText(io.stderr, notice),
      })
      await writeJson(io.stdout, result)
      return 0
    }
    throw new CliFailure(`Unknown command: ${command}`, 1, 'USAGE', { commands: ['open', 'theme', 'setup', 'doctor'] })
  } catch (error) {
    const failure = error instanceof CliFailure
      ? error
      : new CliFailure(error instanceof Error ? error.message : String(error), 1, 'COMMAND_FAILED')
    await writeJson(io.stderr, { error: failure.message, code: failure.code, ...(failure.detail === undefined ? {} : { detail: failure.detail }) })
    return failure.exitCode
  }
}
