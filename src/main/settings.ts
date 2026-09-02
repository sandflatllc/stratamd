import { join, resolve } from 'node:path'
import { readFile, rename } from 'node:fs/promises'
import { getConfigDirectory as getPlatformConfigDirectory } from '../platform/paths.js'
import { logError } from './log.js'
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  type StorageEnvironment,
} from './storage'

export const CURRENT_SETTINGS_VERSION = 1
export const DEFAULT_ATTACHMENT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000
/** A year: far beyond any useful idle window, and well inside what a timer can represent. */
export const MAX_ATTACHMENT_IDLE_TIMEOUT = 365 * 24 * 60 * 60 * 1000

/** A settings file that could not be read, kept aside so nothing in it is lost. */
export interface SettingsRecovery {
  /** Where the unreadable file was moved. */
  readonly preservedPath: string
  readonly reason: string
}

export interface ThemePanelGeometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PanelSize {
  readonly width: number
  /** -1 sizes to content until the user resizes. */
  readonly height: number
}

export interface PanelSettings {
  readonly explorerWidth: number
  readonly rightRailWidth: number
  readonly changesHeight: number
  readonly annotationsHeight: number
  readonly documentMeasure: number
  readonly themePanel: ThemePanelGeometry
  readonly threadPanel: PanelSize
  readonly annotationComposer: PanelSize
  readonly sendComposer: PanelSize
}

export interface ZoomSettings {
  readonly explorer: number
  readonly editor: number
  readonly rightRail: number
  readonly composer: number
}

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1

export interface Settings {
  readonly formatVersion: typeof CURRENT_SETTINGS_VERSION
  /** Active theme id (PRD §6.13). Strata Vivid is the default view; `strata` is the built-in fallback. */
  readonly theme: string
  readonly keepResolvedAnnotations: boolean
  readonly attachmentIdleTimeoutMs: number
  readonly explorerFolders: readonly string[]
  readonly panels: PanelSettings
  readonly zoom: ZoomSettings
  readonly ambientMotion: boolean
}

export interface SettingsPatch extends Partial<Omit<Settings, 'formatVersion' | 'panels' | 'zoom'>> {
  readonly panels?: Partial<PanelSettings>
  readonly zoom?: Partial<ZoomSettings>
}

export interface SettingsStoreOptions {
  readonly configDirectory?: string
  readonly env?: StorageEnvironment
  readonly homeDirectory?: string
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  formatVersion: CURRENT_SETTINGS_VERSION,
  theme: 'strata-vivid',
  keepResolvedAnnotations: true,
  attachmentIdleTimeoutMs: DEFAULT_ATTACHMENT_IDLE_TIMEOUT,
  explorerFolders: Object.freeze([]),
  panels: Object.freeze({
    explorerWidth: 212,
    rightRailWidth: 300,
    changesHeight: 250,
    annotationsHeight: 180,
    documentMeasure: 860,
    themePanel: Object.freeze({ x: -1, y: -1, width: 360, height: 560 }),
    threadPanel: Object.freeze({ width: 660, height: -1 }),
    annotationComposer: Object.freeze({ width: 330, height: -1 }),
    sendComposer: Object.freeze({ width: 680, height: -1 }),
  }),
  zoom: Object.freeze({ explorer: 1, editor: 1, rightRail: 1, composer: 1 }),
  ambientMotion: true,
})

export function getConfigDirectory(
  env: StorageEnvironment = process.env,
  homeDirectory?: string,
): string {
  return getPlatformConfigDirectory({ env, ...(homeDirectory ? { home: homeDirectory } : {}) })
}

export function getSettingsPath(
  env: StorageEnvironment = process.env,
  homeDirectory?: string,
): string {
  return join(getConfigDirectory(env, homeDirectory), 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

export function normalizeZoom(value: unknown): number {
  const clamped = numberInRange(value, 1, ZOOM_MIN, ZOOM_MAX)
  return Math.round(clamped * 10) / 10
}

function idleTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(MAX_ATTACHMENT_IDLE_TIMEOUT, Math.max(1, Math.round(value)))
}

export function normalizeSettings(value: unknown): Settings {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS)
  const version = value.formatVersion ?? value.version ?? CURRENT_SETTINGS_VERSION
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error('Invalid settings format version')
  }
  if (version > CURRENT_SETTINGS_VERSION) {
    throw new Error(`Settings version ${version} is newer than this build`)
  }

  // Version zero used flat panel fields. Reading them here is the migration;
  // saveSettings writes the current envelope on the next mutation.
  const panelValue = isRecord(value.panels) ? value.panels : value
  const zoomValue = isRecord(value.zoom) ? value.zoom : {}
  const themePanelValue = isRecord(panelValue.themePanel) ? panelValue.themePanel : {}
  const panelSize = (raw: unknown, fallback: PanelSize, minWidth: number, maxWidth: number): PanelSize => {
    const record = isRecord(raw) ? raw : {}
    return {
      width: numberInRange(record.width, fallback.width, minWidth, maxWidth),
      height: numberInRange(record.height, fallback.height, -1, 1600),
    }
  }

  const folders = Array.isArray(value.explorerFolders)
    ? value.explorerFolders.filter((folder): folder is string => typeof folder === 'string')
    : []
  const explorerFolders = [...new Set(folders.map((folder) => resolve(folder)))]
  // Version-one files carried 'system' | 'light' | 'dark' here, plus `font` and
  // `annotationColors`; all three are superseded by themes and ignored.
  const theme = typeof value.theme === 'string'
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.theme)
    && !['system', 'light', 'dark'].includes(value.theme)
    ? value.theme
    : DEFAULT_SETTINGS.theme

  return {
    formatVersion: CURRENT_SETTINGS_VERSION,
    theme,
    keepResolvedAnnotations: typeof value.keepResolvedAnnotations === 'boolean'
      ? value.keepResolvedAnnotations
      : DEFAULT_SETTINGS.keepResolvedAnnotations,
    attachmentIdleTimeoutMs: idleTimeout(
      value.attachmentIdleTimeoutMs,
      DEFAULT_SETTINGS.attachmentIdleTimeoutMs,
    ),
    explorerFolders,
    panels: {
      explorerWidth: numberInRange(panelValue.explorerWidth, 212, 160, 340),
      rightRailWidth: numberInRange(panelValue.rightRailWidth, 300, 240, 440),
      changesHeight: numberInRange(panelValue.changesHeight, 250, 120, 520),
      annotationsHeight: numberInRange(panelValue.annotationsHeight, 180, 90, 420),
      documentMeasure: numberInRange(panelValue.documentMeasure, 860, 620, 1600),
      themePanel: {
        x: numberInRange(themePanelValue.x, -1, -1, 20_000),
        y: numberInRange(themePanelValue.y, -1, -1, 20_000),
        width: numberInRange(themePanelValue.width, 360, 300, 900),
        height: numberInRange(themePanelValue.height, 560, 320, 1600),
      },
      threadPanel: panelSize(panelValue.threadPanel, DEFAULT_SETTINGS.panels.threadPanel, 330, 1200),
      annotationComposer: panelSize(panelValue.annotationComposer, DEFAULT_SETTINGS.panels.annotationComposer, 330, 900),
      sendComposer: panelSize(panelValue.sendComposer, DEFAULT_SETTINGS.panels.sendComposer, 460, 1600),
    },
    zoom: {
      explorer: normalizeZoom(zoomValue.explorer),
      editor: normalizeZoom(zoomValue.editor),
      rightRail: normalizeZoom(zoomValue.rightRail),
      composer: normalizeZoom(zoomValue.composer),
    },
    ambientMotion: typeof value.ambientMotion === 'boolean'
      ? value.ambientMotion
      : DEFAULT_SETTINGS.ambientMotion,
  }
}

export class SettingsStore {
  readonly configDirectory: string
  readonly path: string
  #recovery: SettingsRecovery | null = null

  constructor(options: SettingsStoreOptions = {}) {
    this.configDirectory = options.configDirectory
      ? resolve(options.configDirectory)
      : getConfigDirectory(options.env, options.homeDirectory)
    this.path = join(this.configDirectory, 'settings.json')
  }

  /** Set when the last load found an unreadable file and moved it aside. */
  get recovery(): SettingsRecovery | null {
    return this.#recovery
  }

  /**
   * A file this build cannot read (corrupt JSON, or written by a newer
   * build) is moved to settings.json.broken-<time> and the defaults apply.
   * Nothing is deleted: the user or a newer build can still read the copy.
   */
  async load(): Promise<Settings> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS)
      throw error
    }
    try {
      const settings = normalizeSettings(JSON.parse(text))
      this.#recovery = null
      return settings
    } catch (error) {
      await this.#preserveBroken(error)
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  async #preserveBroken(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error)
    const preservedPath = `${this.path}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.path, preservedPath)
      logError('settings', `Settings could not be read; the file was kept at ${preservedPath} and defaults apply`, error)
      this.#recovery = { preservedPath, reason }
    } catch (renameError) {
      logError('settings', `Settings could not be read and the file could not be moved aside (${this.path}); defaults apply`, renameError)
      this.#recovery = { preservedPath: this.path, reason }
    }
  }

  async save(settings: Settings): Promise<Settings> {
    const normalized = normalizeSettings(settings)
    await ensurePrivateDirectory(this.configDirectory)
    await atomicWriteFile(this.path, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    })
    return normalized
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const current = await this.load()
    return this.save({
      ...current,
      ...patch,
      formatVersion: CURRENT_SETTINGS_VERSION,
      panels: { ...current.panels, ...patch.panels },
      zoom: { ...current.zoom, ...patch.zoom },
    })
  }
}

export async function loadSettings(options: SettingsStoreOptions = {}): Promise<Settings> {
  return new SettingsStore(options).load()
}

export async function saveSettings(
  settings: Settings,
  options: SettingsStoreOptions = {},
): Promise<Settings> {
  return new SettingsStore(options).save(settings)
}
