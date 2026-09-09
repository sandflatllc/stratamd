import { DEFAULT_THEME_ID } from '../shared/bundled-themes'
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

export const CURRENT_SETTINGS_VERSION = 2
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
  readonly upperReviewHeight: number
  readonly documentMeasure: number
  readonly themePanel: ThemePanelGeometry
  readonly annotationComposer: PanelSize
  readonly sendComposer: PanelSize
}

export interface ZoomSettings {
  readonly explorer: number
  readonly editor: number
  readonly rightRail: number
  readonly composer: number
  readonly themePanel: number
}

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1

export interface Settings {
  readonly formatVersion: typeof CURRENT_SETTINGS_VERSION
  /** Active theme id (PRD §6.13). Strata is the default and built-in fallback. */
  readonly theme: string
  readonly keepResolvedAnnotations: boolean
  readonly explorerFolders: readonly string[]
  readonly panels: PanelSettings
  readonly zoom: ZoomSettings
  readonly engine: { mode: 'managed' | 'external'; keepRunning: boolean; startAtLogin: boolean; lan?: boolean; tailscale?: boolean; tailscalePort?: number }
  readonly windowCapture?: { enabled: boolean; shortcut: boolean }
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
  theme: DEFAULT_THEME_ID,
  keepResolvedAnnotations: true,
  explorerFolders: Object.freeze([]),
  panels: Object.freeze({
    explorerWidth: 212,
    rightRailWidth: 300,
    upperReviewHeight: 444,
    documentMeasure: 860,
    themePanel: Object.freeze({ x: -1, y: -1, width: 360, height: 560 }),
    annotationComposer: Object.freeze({ width: 330, height: -1 }),
    sendComposer: Object.freeze({ width: 680, height: -1 }),
  }),
  zoom: Object.freeze({ explorer: 1, editor: 1, rightRail: 1, composer: 1, themePanel: 1 }),
  engine: Object.freeze({ mode: 'managed', keepRunning: true, startAtLogin: false }),
  windowCapture: { enabled: false, shortcut: false },
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

function readableNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : null
}

/** Version-one had two stacked review windows with a 14px resizer between them. */
function upperReviewHeight(panelValue: Record<string, unknown>): number {
  const explicit = readableNumber(panelValue.upperReviewHeight, 180, 954)
  if (explicit !== null) return explicit
  const changes = readableNumber(panelValue.changesHeight, 120, 520)
  const annotations = readableNumber(panelValue.annotationsHeight, 90, 420)
  if (changes !== null && annotations !== null) return Math.min(954, Math.max(180, changes + 14 + annotations))
  return Math.min(954, Math.max(180, changes ?? annotations ?? DEFAULT_SETTINGS.panels.upperReviewHeight))
}

export function normalizeZoom(value: unknown): number {
  const clamped = numberInRange(value, 1, ZOOM_MIN, ZOOM_MAX)
  return Math.round(clamped * 10) / 10
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
    explorerFolders,
    panels: {
      // Side windows have a floor but no practical ceiling (PRD §6.9).
      explorerWidth: numberInRange(panelValue.explorerWidth, 212, 160, 20_000),
      rightRailWidth: numberInRange(panelValue.rightRailWidth, 300, 240, 20_000),
      upperReviewHeight: upperReviewHeight(panelValue),
      documentMeasure: numberInRange(panelValue.documentMeasure, 860, 620, 1600),
      themePanel: {
        x: numberInRange(themePanelValue.x, -1, -1, 20_000),
        y: numberInRange(themePanelValue.y, -1, -1, 20_000),
        width: numberInRange(themePanelValue.width, 360, 300, 20_000),
        height: numberInRange(themePanelValue.height, 560, 320, 20_000),
      },
      annotationComposer: panelSize(panelValue.annotationComposer, DEFAULT_SETTINGS.panels.annotationComposer, 330, 900),
      sendComposer: panelSize(panelValue.sendComposer, DEFAULT_SETTINGS.panels.sendComposer, 460, 1600),
    },
    zoom: {
      explorer: normalizeZoom(zoomValue.explorer),
      editor: normalizeZoom(zoomValue.editor),
      rightRail: normalizeZoom(zoomValue.rightRail),
      composer: normalizeZoom(zoomValue.composer),
      themePanel: normalizeZoom(zoomValue.themePanel),
    },
    engine: { mode: isRecord(value.engine) && value.engine.mode === 'external' ? 'external' : 'managed', keepRunning: !isRecord(value.engine) || value.engine.keepRunning !== false, startAtLogin: isRecord(value.engine) && value.engine.startAtLogin === true, ...(isRecord(value.engine) && value.engine.lan === true ? { lan: true } : {}), ...(isRecord(value.engine) && value.engine.tailscale === true ? { tailscale: true } : {}), ...(isRecord(value.engine) && typeof value.engine.tailscalePort === 'number' ? { tailscalePort: Math.round(numberInRange(value.engine.tailscalePort, 443, 1, 65535)) } : {}) },
    windowCapture: { enabled: !!(value.windowCapture && typeof value.windowCapture === 'object' && 'enabled' in value.windowCapture && value.windowCapture.enabled === true), shortcut: !!(value.windowCapture && typeof value.windowCapture === 'object' && 'shortcut' in value.windowCapture && value.windowCapture.shortcut === true) },
    ambientMotion: typeof value.ambientMotion === 'boolean'
      ? value.ambientMotion
      : DEFAULT_SETTINGS.ambientMotion,
  }
}

export class SettingsStore {
  readonly configDirectory: string
  readonly path: string
  #recovery: SettingsRecovery | null = null
  #updates: Promise<unknown> = Promise.resolve()

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

  update(patch: SettingsPatch): Promise<Settings> {
    // A later gesture must read the preceding save, and must finish after it.
    const update = this.#updates.then(async () => {
      const current = await this.load()
      return this.save({
        ...current,
        ...patch,
        formatVersion: CURRENT_SETTINGS_VERSION,
        panels: { ...current.panels, ...patch.panels },
        zoom: { ...current.zoom, ...patch.zoom },
      })
    })
    this.#updates = update.catch(() => undefined)
    return update
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
