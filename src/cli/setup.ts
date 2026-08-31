import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandFailure } from './protocol.js'

const MANAGED_MARKER = 'Managed by StrataMD setup'
const DESKTOP_ID = 'stratamd.desktop'
const MARKDOWN_MIME = 'text/markdown'

export interface SetupCommandResult {
  status: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: Error
}

export type SetupCommandRunner = (
  command: string,
  args: readonly string[]
) => SetupCommandResult

interface DefaultAssociationState {
  managedBy: typeof MANAGED_MARKER
  previousDefault: string | null
}

async function readBrandIcon(root: string): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    join(root, 'resources', 'stratamd-icon.svg'),
    ...(resourcesPath ? [join(resourcesPath, 'resources', 'stratamd-icon.svg')] : [])
  ]
  let lastError: unknown
  for (const candidate of candidates) {
    try { return await readFile(candidate, 'utf8') }
    catch (error) { lastError = error }
  }
  throw lastError
}

function dataHome(environment: NodeJS.ProcessEnv, home: string): string {
  return environment.XDG_DATA_HOME || join(home, '.local', 'share')
}

function configHome(environment: NodeJS.ProcessEnv, home: string): string {
  return environment.XDG_CONFIG_HOME || join(home, '.config')
}

function commandText(value: string | Buffer | null | undefined): string {
  return value === undefined || value === null ? '' : value.toString().trim()
}

function defaultCommandRunner(command: string, args: readonly string[]): SetupCommandResult {
  return spawnSync(command, [...args], { encoding: 'utf8' })
}

function runChecked(
  runner: SetupCommandRunner,
  command: string,
  args: readonly string[],
  code: string
): string {
  const result = runner(command, args)
  if (result.error || result.status !== 0) {
    throw new CommandFailure(
      `${command} failed`,
      1,
      code,
      commandText(result.stderr) || result.error?.message
    )
  }
  return commandText(result.stdout)
}

function desktopQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`')}"`
}

async function writeManagedFile(path: string, content: string, mode = 0o644): Promise<void> {
  try {
    const current = await readFile(path, 'utf8')
    if (!current.includes(MANAGED_MARKER) && current !== content) {
      throw new CommandFailure(`Refusing to replace ${path}`, 1, 'SETUP_CONFLICT')
    }
    if (current === content) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content, { encoding: 'utf8', mode })
  await rename(temporary, path)
  await chmod(path, mode)
}

async function removeManagedFile(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf8')
    if (!content.includes(MANAGED_MARKER)) return
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function installLink(link: string, target: string): Promise<void> {
  await mkdir(dirname(link), { recursive: true })
  try {
    const entry = await lstat(link)
    if (!entry.isSymbolicLink()) {
      throw new CommandFailure(`Refusing to replace ${link}`, 1, 'SETUP_CONFLICT')
    }
    const existing = resolve(dirname(link), await readlink(link))
    if (existing === target) return
    throw new CommandFailure(`Refusing to replace ${link}`, 1, 'SETUP_CONFLICT')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await symlink(target, link)
}

async function removeLink(link: string, target: string): Promise<void> {
  try {
    const entry = await lstat(link)
    if (!entry.isSymbolicLink()) return
    const existing = resolve(dirname(link), await readlink(link))
    if (existing === target) await unlink(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function refreshDesktopDatabases(
  dataDirectory: string,
  runner: SetupCommandRunner = defaultCommandRunner
): void {
  runChecked(
    runner,
    'update-desktop-database',
    [join(dataDirectory, 'applications')],
    'DESKTOP_DATABASE_FAILED'
  )
  runChecked(
    runner,
    'update-mime-database',
    [join(dataDirectory, 'mime')],
    'MIME_DATABASE_FAILED'
  )
}

async function readDefaultState(path: string): Promise<DefaultAssociationState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<DefaultAssociationState>
    if (
      value.managedBy !== MANAGED_MARKER ||
      (value.previousDefault !== null && typeof value.previousDefault !== 'string')
    ) return undefined
    return value as DefaultAssociationState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeDefaultState(path: string, previousDefault: string | null): Promise<void> {
  await writeManagedFile(
    path,
    `${JSON.stringify({ managedBy: MANAGED_MARKER, previousDefault }, null, 2)}\n`,
    0o600
  )
}

function queryDefault(runner: SetupCommandRunner): string | null {
  return runChecked(
    runner,
    'xdg-mime',
    ['query', 'default', MARKDOWN_MIME],
    'QUERY_DEFAULT_FAILED'
  ) || null
}

async function removeStrataDefaultFrom(path: string): Promise<void> {
  let content: string
  let mode: number
  try {
    const [read, fileStat] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    content = read
    mode = fileStat.mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = content.endsWith('\n')
  const lines = content.split(/\r?\n/)
  if (finalNewline) lines.pop()
  let section = ''
  let changed = false
  const next: string[] = []

  for (const line of lines) {
    const heading = line.trim().match(/^\[([^\]]+)\]$/)
    if (heading) section = heading[1] ?? ''
    if (section !== 'Default Applications') {
      next.push(line)
      continue
    }

    const assignment = line.match(/^(\s*text\/markdown\s*=)(.*)$/)
    if (!assignment) {
      next.push(line)
      continue
    }
    const existingApplications = (assignment[2] ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)
    if (!existingApplications.includes(DESKTOP_ID)) {
      next.push(line)
      continue
    }
    const applications = existingApplications.filter((value) => value !== DESKTOP_ID)
    changed = true
    if (applications.length > 0) next.push(`${assignment[1]}${applications.join(';')};`)
  }
  if (!changed) return

  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${next.join(newline)}${finalNewline ? newline : ''}`, {
    encoding: 'utf8',
    mode
  })
  await rename(temporary, path)
  await chmod(path, mode)
}

async function restoreDefaultAssociation(
  statePath: string,
  environment: NodeJS.ProcessEnv,
  home: string,
  dataDirectory: string,
  runner: SetupCommandRunner
): Promise<void> {
  const state = await readDefaultState(statePath)
  if (!state || queryDefault(runner) !== DESKTOP_ID) return
  if (state.previousDefault) {
    runChecked(
      runner,
      'xdg-mime',
      ['default', state.previousDefault, MARKDOWN_MIME],
      'RESTORE_DEFAULT_FAILED'
    )
    return
  }

  await Promise.all([
    removeStrataDefaultFrom(join(configHome(environment, home), 'mimeapps.list')),
    removeStrataDefaultFrom(join(dataDirectory, 'applications', 'mimeapps.list'))
  ])
}

export interface SetupOptions {
  remove?: boolean
  makeDefault?: boolean
  environment?: NodeJS.ProcessEnv
  home?: string
  executable?: string
  commandRunner?: SetupCommandRunner
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env
  const home = options.home ?? homedir()
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const executable = resolve(
    options.executable
      ?? environment.STRATAMD_CLI_EXECUTABLE
      ?? join(root, 'bin', 'stratamd')
  )
  const userData = dataHome(environment, home)
  const runner = options.commandRunner ?? defaultCommandRunner
  const link = join(home, '.local', 'bin', 'stratamd')
  const desktop = join(userData, 'applications', 'stratamd.desktop')
  const icon = join(userData, 'icons', 'hicolor', 'scalable', 'apps', 'stratamd-icon.svg')
  const mime = join(userData, 'mime', 'packages', 'stratamd.xml')
  const setupConfigDirectory = join(configHome(environment, home), 'stratamd')
  const defaultState = join(setupConfigDirectory, 'setup-default.json')

  if (options.remove) {
    await restoreDefaultAssociation(defaultState, environment, home, userData, runner)
    await removeLink(link, executable)
    await removeManagedFile(desktop)
    await removeManagedFile(icon)
    await removeManagedFile(mime)
    refreshDesktopDatabases(userData, runner)
    await removeManagedFile(defaultState)
    await rmdir(setupConfigDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
    })
    return
  }

  const iconSource = await readBrandIcon(root)
  await access(executable, constants.X_OK)
  await installLink(link, executable)
  await writeManagedFile(
    desktop,
    // StartupWMClass matches the packaged executable's window class, so the
    // running window picks up this entry's icon in the task bar.
    `# ${MANAGED_MARKER}\n[Desktop Entry]\nType=Application\nName=StrataMD\nComment=Markdown editor for working with AI agents\nExec=${desktopQuote(executable)} open %f\nTryExec=${executable}\nIcon=stratamd-icon\nTerminal=false\nCategories=Office;TextEditor;\nMimeType=text/markdown;\nStartupNotify=true\nStartupWMClass=stratamd-app\n`
  )
  await writeManagedFile(icon, `<!-- ${MANAGED_MARKER} -->\n${iconSource}`)
  await writeManagedFile(
    mime,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MANAGED_MARKER} -->\n<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">\n  <mime-type type="text/markdown">\n    <comment>Markdown document</comment>\n    <glob pattern="*.md"/>\n    <glob pattern="*.markdown"/>\n  </mime-type>\n</mime-info>\n`
  )
  refreshDesktopDatabases(userData, runner)

  if (options.makeDefault) {
    const existingState = await readDefaultState(defaultState)
    const current = queryDefault(runner)
    const previousDefault = current === DESKTOP_ID
      ? (existingState?.previousDefault ?? null)
      : current
    await mkdir(setupConfigDirectory, { recursive: true })
    await writeDefaultState(defaultState, previousDefault)
    runChecked(
      runner,
      'xdg-mime',
      ['default', DESKTOP_ID, MARKDOWN_MIME],
      'SET_DEFAULT_FAILED'
    )
  }
}
