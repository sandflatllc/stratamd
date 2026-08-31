import { execFile } from 'node:child_process'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  BUILT_IN_THEME_ID,
  BUILT_IN_THEME_NAME,
  BUNDLED_FONTS,
  DEFAULT_THEME_VALUES,
  normalizeTheme,
  readSparseValue,
  slugifyThemeName,
  THEME_KEYS,
  THEME_SCHEMA_VERSION,
  type SparseTheme,
  type ThemeProblem,
  type ThemeValues
} from '../shared/theme-keys'
import { BUNDLED_THEMES, nestThemeValues } from '../shared/bundled-themes'
import { fontFamiliesFromFcList, queryInstalledFontFamilies } from '../platform/fonts'
import { getConfigDirectory } from './settings'
import { atomicWriteFile, ensurePrivateDirectory, PRIVATE_FILE_MODE, type StorageEnvironment } from './storage'

const execFileAsync = promisify(execFile)

export interface ThemeSummary {
  readonly id: string
  readonly name: string
  readonly builtIn: boolean
  readonly broken: boolean
  readonly problems: readonly ThemeProblem[]
}

export interface LoadedTheme {
  readonly id: string
  readonly name: string
  readonly builtIn: boolean
  readonly path: string | null
  readonly sparse: SparseTheme
  readonly values: ThemeValues
  readonly problems: readonly ThemeProblem[]
  readonly set: readonly string[]
}

// The built-in Strata theme is a complete stock definition like the rest: its
// sparse form carries every value, so New from this copies all of them.
export const BUILT_IN_THEME: LoadedTheme = Object.freeze({
  id: BUILT_IN_THEME_ID,
  name: BUILT_IN_THEME_NAME,
  builtIn: true,
  path: null,
  sparse: nestThemeValues(BUILT_IN_THEME_NAME, DEFAULT_THEME_VALUES),
  values: DEFAULT_THEME_VALUES,
  problems: Object.freeze([]),
  set: Object.freeze(THEME_KEYS.map((entry) => entry.key))
})

export interface ThemeStoreOptions {
  readonly configDirectory?: string
  readonly env?: StorageEnvironment
  readonly homeDirectory?: string
}

export class ThemeBrokenError extends Error {
  constructor(readonly id: string, readonly detail: string) {
    super(`Theme ${id} is not valid JSON: ${detail}`)
  }
}

export function getThemesDirectory(env: StorageEnvironment = process.env, homeDirectory?: string): string {
  return join(getConfigDirectory(env, homeDirectory), 'themes')
}

function isThemeId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** Read-only themes that ship with the app: the built-in Strata plus the bundled starters. */
export function isShippedThemeId(id: string): boolean {
  return id === BUILT_IN_THEME_ID || BUNDLED_THEMES.has(id)
}

function bundledTheme(id: string): LoadedTheme {
  const sparse = BUNDLED_THEMES.get(id)!
  const normalized = normalizeTheme(sparse, id)
  return { id, name: normalized.name, builtIn: true, path: null, sparse, values: normalized.values, problems: normalized.problems, set: normalized.set }
}

export class ThemeStore {
  readonly directory: string

  constructor(options: ThemeStoreOptions = {}) {
    this.directory = options.configDirectory
      ? join(resolve(options.configDirectory), 'themes')
      : getThemesDirectory(options.env, options.homeDirectory)
  }

  pathFor(id: string): string {
    return join(this.directory, `${id}.json`)
  }

  async ensureDirectory(): Promise<void> {
    await ensurePrivateDirectory(this.directory)
  }

  async ids(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((id) => isThemeId(id) && !isShippedThemeId(id))
      .sort()
  }

  async list(): Promise<ThemeSummary[]> {
    const summaries: ThemeSummary[] = [
      { id: BUILT_IN_THEME_ID, name: BUILT_IN_THEME_NAME, builtIn: true, broken: false, problems: [] },
      ...[...BUNDLED_THEMES.keys()].map((id) => ({ id, name: bundledTheme(id).name, builtIn: true, broken: false, problems: [] }))
    ]
    for (const id of await this.ids()) {
      try {
        const theme = await this.load(id)
        summaries.push({ id, name: theme.name, builtIn: false, broken: false, problems: theme.problems })
      } catch (error) {
        if (!(error instanceof ThemeBrokenError)) throw error
        summaries.push({ id, name: `${id}.json`, builtIn: false, broken: true, problems: [{ key: 'file', reason: error.detail }] })
      }
    }
    return summaries
  }

  /** Throws ThemeBrokenError for unparseable files and ENOENT for missing ones. */
  async load(id: string): Promise<LoadedTheme> {
    if (id === BUILT_IN_THEME_ID) return BUILT_IN_THEME
    if (BUNDLED_THEMES.has(id)) return bundledTheme(id)
    if (!isThemeId(id)) throw Object.assign(new Error(`No theme named ${id}`), { code: 'ENOENT' })
    const path = this.pathFor(id)
    const text = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new ThemeBrokenError(id, error instanceof Error ? error.message : 'parse error')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ThemeBrokenError(id, 'the file is not a JSON object')
    return this.#loaded(id, path, parsed as SparseTheme)
  }

  /** Normalizes a sparse object for `id` without touching disk. */
  normalize(id: string, sparse: SparseTheme): LoadedTheme {
    return this.#loaded(id, this.pathFor(id), sparse)
  }

  #loaded(id: string, path: string, sparse: SparseTheme): LoadedTheme {
    const normalized = normalizeTheme(sparse, id)
    return { id, name: normalized.name, builtIn: false, path, sparse, values: normalized.values, problems: normalized.problems, set: normalized.set }
  }

  async write(id: string, sparse: SparseTheme): Promise<LoadedTheme> {
    if (isShippedThemeId(id)) throw new Error('Themes that ship with StrataMD cannot be edited; make a copy first')
    if (!isThemeId(id)) throw new Error(`Invalid theme id ${id}`)
    await this.ensureDirectory()
    const path = this.pathFor(id)
    const stamped: SparseTheme = { 'schema-version': THEME_SCHEMA_VERSION, ...sparse }
    await atomicWriteFile(path, `${JSON.stringify(stamped, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
    return this.#loaded(id, path, stamped)
  }

  /** Copies the set keys of `fromId` (nothing for the built-in) into a new file named `name`. */
  async create(name: string, fromId: string): Promise<LoadedTheme> {
    const source = await this.load(fromId)
    const trimmed = name.trim() || 'Untitled'
    const base = slugifyThemeName(trimmed)
    const taken = new Set(await this.ids())
    let id = base
    for (let suffix = 2; taken.has(id) || isShippedThemeId(id); suffix += 1) id = `${base}-${suffix}`
    const sparse: Record<string, unknown> = { ...source.sparse, name: trimmed }
    return this.write(id, sparse)
  }

  async delete(id: string, activeId: string): Promise<void> {
    if (isShippedThemeId(id)) throw new Error('Themes that ship with StrataMD cannot be deleted')
    if (id === activeId) throw new Error('Choose another theme before deleting the active one')
    if (!isThemeId(id)) throw new Error(`Invalid theme id ${id}`)
    await rm(this.pathFor(id), { force: true })
  }
}

/** Fonts installed on the machine, bundled families first. Falls back to the bundled list when the platform query is unavailable. */
export async function listInstalledFonts(
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = (file, args) => execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024 })
): Promise<string[]> {
  const families = await queryInstalledFontFamilies(run)
  if (families === null) return [...BUNDLED_FONTS]
  return orderFontFamilies(families)
}

export function orderFontFamilies(installed: string | readonly string[]): string[] {
  const families = new Set(typeof installed === 'string' ? fontFamiliesFromFcList(installed) : installed)
  for (const bundled of BUNDLED_FONTS) families.delete(bundled)
  return [...BUNDLED_FONTS, ...[...families].sort((a, b) => a.localeCompare(b))]
}

/** What `stratamd theme` prints: set values, defaults with descriptions, problems. */
export function describeTheme(theme: LoadedTheme): {
  id: string
  name: string
  path: string | null
  set: Record<string, string | number>
  defaults: Record<string, string | number>
  keys: { key: string; label: string; description: string; group: string; kind: string }[]
  problems: ThemeProblem[]
} {
  const set: Record<string, string | number> = {}
  const defaults: Record<string, string | number> = {}
  for (const entry of THEME_KEYS) {
    if (readSparseValue(theme.sparse, entry.key) === undefined) defaults[entry.key] = DEFAULT_THEME_VALUES[entry.key]!
    else set[entry.key] = theme.values[entry.key]!
  }
  return {
    id: theme.id,
    name: theme.name,
    path: theme.path,
    set,
    defaults,
    keys: THEME_KEYS.map(({ key, label, description, group, kind }) => ({ key, label, description, group, kind })),
    problems: [...theme.problems]
  }
}
