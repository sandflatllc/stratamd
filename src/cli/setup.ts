import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
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
import { getCliLinkPath } from '../platform/paths.js'
import { isDarwin } from '../platform/runtime.js'
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
  // A checkout keeps resources/ at the root; a packaged build keeps it beside
  // app.asar, which is where `root` lands when the CLI runs from the archive.
  const candidates = [
    join(root, 'resources', 'stratamd-icon.svg'),
    join(dirname(root), 'resources', 'stratamd-icon.svg'),
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
      throw new CommandFailure(
        `Refusing to replace ${link}: it is a file, not a link StrataMD made`,
        1,
        'SETUP_CONFLICT',
        { link, existing: null, hint: `Move ${link} aside, then run setup again.` }
      )
    }
    const existing = resolve(dirname(link), await readlink(link))
    if (existing === target) return
    throw new CommandFailure(
      `Refusing to replace ${link}: it points at ${existing}`,
      1,
      'SETUP_CONFLICT',
      {
        link,
        existing,
        hint: `Run "${existing} setup --remove" to unlink the old install, then run setup again. If that build is gone, delete the link.`
      }
    )
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

/**
 * Refreshes the desktop and MIME caches. A missing or failing tool is a
 * warning, not a failure: the files are already in place, and the package
 * name (the same on apt, dnf, and pacman) tells the user what to install.
 */
export function refreshDesktopDatabases(
  dataDirectory: string,
  runner: SetupCommandRunner = defaultCommandRunner
): string[] {
  const refreshes = [
    {
      command: 'update-desktop-database',
      args: [join(dataDirectory, 'applications')],
      pkg: 'desktop-file-utils',
      effect: 'the app menu entry may not show up'
    },
    {
      command: 'update-mime-database',
      args: [join(dataDirectory, 'mime')],
      pkg: 'shared-mime-info',
      effect: 'file managers may not offer StrataMD for .md files'
    }
  ]
  const warnings: string[] = []
  for (const { command, args, pkg, effect } of refreshes) {
    const result = runner(command, args)
    if (!result.error && result.status === 0) continue
    const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    const reason = missing
      ? `${command} is not installed`
      : `${command} failed${commandText(result.stderr) ? `: ${commandText(result.stderr)}` : ''}`
    warnings.push(`${reason}, so ${effect} until it runs. Install ${pkg} (package name on apt, dnf, and pacman) and run setup again.`)
  }
  return warnings
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

export type SetupPlatform = 'linux' | 'darwin'

export interface SkillInstallResult {
  /** What was asked for: claude, codex, agents, or the directory given. */
  target: string
  /** The skill directory the harness reads. */
  path: string
  /** Where `path` leads when it is a symlink; the files were written there. */
  resolved?: string
  status: 'installed' | 'updated' | 'unchanged'
  files: string[]
}

export interface SetupResult {
  ok: true
  platform: SetupPlatform
  action: 'install' | 'remove'
  link: string
  executable: string
  skill?: SkillInstallResult
  hint?: string
  warnings: string[]
}

export interface SetupOptions {
  remove?: boolean
  makeDefault?: boolean
  /** A harness name (claude, codex, agents) or a skills directory to copy the bundled skill into. */
  skill?: string
  environment?: NodeJS.ProcessEnv
  home?: string
  executable?: string
  commandRunner?: SetupCommandRunner
  platform?: string
  report?: (text: string) => void | Promise<void>
}

const SKILL_NAME = 'stratamd'
export const SKILL_HINT =
  'To give your agent the StrataMD skill, run: stratamd setup --skill claude (or codex, agents, or a skills directory).'

/**
 * Where the skill goes for each harness. `codex` follows CODEX_HOME the way the
 * Codex CLI documents it, falling back to ~/.codex; that layout is taken from
 * documentation, not verified against a running Codex install.
 */
export function resolveSkillTarget(spec: string, home: string, environment: NodeJS.ProcessEnv): string {
  switch (spec) {
    case 'claude': return join(home, '.claude', 'skills', SKILL_NAME)
    case 'codex': return join(environment.CODEX_HOME || join(home, '.codex'), 'skills', SKILL_NAME)
    case 'agents': return join(home, '.agents', 'skills', SKILL_NAME)
    default: {
      const directory = spec === '~' || spec.startsWith('~/') ? join(home, spec.slice(1)) : resolve(spec)
      return join(directory, SKILL_NAME)
    }
  }
}

/** The bundled skill: `skills/` in a checkout, or beside `resources/` in a packaged build. */
async function findSkillSource(root: string): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    join(root, 'skills', SKILL_NAME),
    join(dirname(root), 'skills', SKILL_NAME),
    ...(resourcesPath ? [join(resourcesPath, 'skills', SKILL_NAME)] : [])
  ]
  for (const candidate of candidates) {
    try {
      if ((await stat(join(candidate, 'SKILL.md'))).isFile()) return candidate
    } catch {
      // Try the next layout.
    }
  }
  throw new CommandFailure(
    'The bundled skill is missing from this install',
    1,
    'SKILL_SOURCE_MISSING',
    { searched: candidates }
  )
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFiles(join(directory, entry.name), relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

/**
 * Copies the skill directory file by file. A symlinked target keeps its link
 * and gets the files written through it, so a harness directory that points
 * at a canonical copy refreshes that copy. Files the target has and the
 * source lacks are left alone.
 */
async function installSkill(
  root: string,
  spec: string,
  home: string,
  environment: NodeJS.ProcessEnv
): Promise<SkillInstallResult> {
  const source = await findSkillSource(root)
  const path = resolveSkillTarget(spec, home, environment)
  let resolved: string | undefined
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      try {
        resolved = await realpath(path)
      } catch {
        throw new CommandFailure(`${path} is a link to a missing directory`, 1, 'SETUP_CONFLICT', {
          path,
          hint: 'Remove the link or point it at a directory, then run setup --skill again.'
        })
      }
    }
    if (!(await stat(resolved ?? path)).isDirectory()) {
      throw new CommandFailure(`${path} exists and is not a directory`, 1, 'SETUP_CONFLICT', {
        path,
        hint: 'Move it aside, then run setup --skill again.'
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const destination = resolved ?? path
  let existed = true
  try {
    await stat(join(destination, 'SKILL.md'))
  } catch {
    existed = false
  }
  await mkdir(destination, { recursive: true })
  const files = await listFiles(source)
  let changed = 0
  for (const file of files) {
    const content = await readFile(join(source, file))
    const target = join(destination, file)
    try {
      if (Buffer.compare(await readFile(target), content) === 0) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, content)
    await rename(temporary, target)
    changed += 1
  }
  return {
    target: spec,
    path,
    ...(resolved ? { resolved } : {}),
    status: existed ? (changed > 0 ? 'updated' : 'unchanged') : 'installed',
    files
  }
}

function pathWarning(environment: NodeJS.ProcessEnv, link: string): string | undefined {
  const directory = dirname(link)
  if ((environment.PATH ?? '').split(':').includes(directory)) return undefined
  return `${directory} is not on your PATH. Add it to your shell profile to run stratamd by name.`
}

/**
 * macOS setup manages only the PATH link. Launch Services learns the document
 * association from the .app bundle itself, and choosing the default app is a
 * user action in Finder — a deliberate product difference from Linux, where a
 * stable command can change and restore the default (mac-plan §4.3).
 */
async function setupDarwin(
  options: SetupOptions,
  environment: NodeJS.ProcessEnv,
  executable: string,
  result: SetupResult,
  warn: (text: string) => Promise<void>
): Promise<void> {
  const report = options.report ?? (() => undefined)

  if (options.remove) {
    await removeLink(result.link, executable)
    return
  }

  await access(executable, constants.X_OK)
  await installLink(result.link, executable)
  const warning = pathWarning(environment, result.link)
  if (warning) await warn(warning)
  if (options.makeDefault) {
    await report(
      'StrataMD cannot change the default app for Markdown files on macOS. To finish:\n'
      + '  1. In Finder, select any .md file and choose File > Get Info.\n'
      + '  2. Under "Open with", choose StrataMD.\n'
      + '  3. Click "Change All…" to apply it to every Markdown file.\n'
    )
  }
}

async function setupLinux(
  options: SetupOptions,
  environment: NodeJS.ProcessEnv,
  home: string,
  root: string,
  executable: string,
  result: SetupResult,
  warn: (text: string) => Promise<void>
): Promise<void> {
  const userData = dataHome(environment, home)
  const runner = options.commandRunner ?? defaultCommandRunner
  const link = result.link
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
    for (const warning of refreshDesktopDatabases(userData, runner)) await warn(warning)
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
  for (const warning of refreshDesktopDatabases(userData, runner)) await warn(warning)
  const warning = pathWarning(environment, link)
  if (warning) await warn(warning)

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

export async function setup(options: SetupOptions = {}): Promise<SetupResult> {
  const environment = options.environment ?? process.env
  const home = options.home ?? homedir()
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const executable = resolve(
    options.executable
      ?? environment.STRATAMD_CLI_EXECUTABLE
      ?? join(root, 'bin', 'stratamd')
  )
  const platform: SetupPlatform =
    (options.platform ? options.platform === 'darwin' : isDarwin()) ? 'darwin' : 'linux'
  const result: SetupResult = {
    ok: true,
    platform,
    action: options.remove ? 'remove' : 'install',
    link: getCliLinkPath(home),
    executable,
    warnings: []
  }
  const report = options.report ?? (() => undefined)
  const warn = async (text: string): Promise<void> => {
    result.warnings.push(text)
    await report(`${text}\n`)
  }

  if (platform === 'darwin') await setupDarwin(options, environment, executable, result, warn)
  else await setupLinux(options, environment, home, root, executable, result, warn)

  if (!options.remove) {
    if (options.skill !== undefined) result.skill = await installSkill(root, options.skill, home, environment)
    else result.hint = SKILL_HINT
  }
  return result
}
