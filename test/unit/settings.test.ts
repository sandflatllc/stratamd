import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  getConfigDirectory,
  normalizeSettings,
} from '../../src/main/settings'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratamd-settings-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('settings', () => {
  it('honors XDG_CONFIG_HOME and returns complete defaults', async () => {
    expect(getConfigDirectory({ XDG_CONFIG_HOME: '/config' })).toBe('/config/stratamd')
    const directory = await temporaryDirectory()
    expect(await new SettingsStore({ configDirectory: directory }).load()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.panels).toEqual({
      explorerWidth: 212,
      rightRailWidth: 300,
      upperReviewHeight: 444,
      documentMeasure: 860,
      themePanel: { x: -1, y: -1, width: 360, height: 560 },
      annotationComposer: { width: 330, height: -1 },
      sendComposer: { width: 680, height: -1 },
    })
  })

  it('clamps per-pane zoom to 0.5–2.0 in tenth steps and defaults missing panes to 1', async () => {
    const settings = normalizeSettings({ zoom: { explorer: 9, editor: 0.01, rightRail: 1.2499 } })
    expect(settings.zoom).toEqual({ explorer: 2, editor: 0.5, rightRail: 1.2, composer: 1, themePanel: 1 })
    expect(normalizeSettings({ zoom: { editor: 'big' } }).zoom).toEqual({ explorer: 1, editor: 1, rightRail: 1, composer: 1, themePanel: 1 })
    const store = new SettingsStore({ configDirectory: await temporaryDirectory() })
    const updated = await store.update({ zoom: { editor: 1.3 } })
    expect(updated.zoom).toEqual({ explorer: 1, editor: 1.3, rightRail: 1, composer: 1, themePanel: 1 })
  })

  it('migrates flat version-zero panels and constrains handoff ranges', () => {
    const settings = normalizeSettings({
      version: 0,
      theme: 'light',
      explorerWidth: 900,
      rightRailWidth: 10,
      documentMeasure: 2000,
      explorerFolders: ['./one', './one'],
    })
    expect(settings.formatVersion).toBe(2)
    expect(settings.theme).toBe('strata-vivid')
    expect(settings.panels).toMatchObject({ explorerWidth: 900, rightRailWidth: 240, documentMeasure: 1600 })
    expect(settings.explorerFolders).toHaveLength(1)
  })

  it('migrates the two legacy review heights to their former combined allocation', () => {
    expect(normalizeSettings({ formatVersion: 1, panels: { changesHeight: 300, annotationsHeight: 200 } }).panels.upperReviewHeight).toBe(514)
    expect(normalizeSettings({ formatVersion: 1, panels: { changesHeight: 9_000, annotationsHeight: 9_000 } }).panels.upperReviewHeight).toBe(954)
    expect(normalizeSettings({ formatVersion: 1, panels: { changesHeight: 1, annotationsHeight: 1 } }).panels.upperReviewHeight).toBe(224)
    expect(normalizeSettings({ formatVersion: 1, panels: { changesHeight: 300 } }).panels.upperReviewHeight).toBe(300)
    expect(normalizeSettings({ formatVersion: 1, panels: { annotationsHeight: 200 } }).panels.upperReviewHeight).toBe(200)
    expect(normalizeSettings({ formatVersion: 1, panels: { changesHeight: 120 } }).panels.upperReviewHeight).toBe(180)
    expect(normalizeSettings({ formatVersion: 1, panels: { annotationsHeight: 90 } }).panels.upperReviewHeight).toBe(180)
    expect(normalizeSettings({ formatVersion: 2, panels: { upperReviewHeight: 620, changesHeight: 100 } }).panels.upperReviewHeight).toBe(620)
  })

  it('writes atomically with private modes and supports deep updates', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore({ configDirectory: directory })
    const updated = await store.update({ ambientMotion: true, panels: { documentMeasure: 1200 } })
    expect(updated.ambientMotion).toBe(true)
    expect(updated.panels.documentMeasure).toBe(1200)
    expect(updated.panels.explorerWidth).toBe(DEFAULT_SETTINGS.panels.explorerWidth)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(store.path, 'utf8')).formatVersion).toBe(2)
  })

  it('keeps a theme id, ignores the superseded font and color fields, and clamps theme panel geometry', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore({ configDirectory: directory })
    await store.update({ theme: 'dusk-warm', panels: { themePanel: { x: 40, y: 30_000, width: 100, height: 700 } } })
    const restarted = await new SettingsStore({ configDirectory: directory }).load()
    expect(restarted.theme).toBe('dusk-warm')
    expect(restarted.panels.themePanel).toEqual({ x: 40, y: 20_000, width: 300, height: 700 })
    const legacy = normalizeSettings({ theme: 'dark', font: 'Nunito', annotationColors: { user: '#102030' } }) as unknown as Record<string, unknown>
    expect(legacy.theme).toBe('strata-vivid')
    expect(legacy).not.toHaveProperty('font')
    expect(legacy).not.toHaveProperty('annotationColors')
    expect(normalizeSettings({ theme: 'Not A Slug' }).theme).toBe('strata-vivid')
  })

  it('preserves newer settings aside and falls back to defaults', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore({ configDirectory: directory })
    const newer = JSON.stringify({ formatVersion: 99, future: true })
    await writeFile(store.path, newer)
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
    expect(store.recovery).toMatchObject({ reason: expect.stringContaining('newer than this build') })
    const kept = (await readdir(directory)).filter((name) => name.startsWith('settings.json.broken-'))
    expect(kept).toHaveLength(1)
    expect(await readFile(join(directory, kept[0]!), 'utf8')).toBe(newer)
    expect(store.recovery?.preservedPath).toBe(join(directory, kept[0]!))
    // The next write starts a fresh file; the preserved copy stays untouched,
    // and once a readable file loads the recovery record clears.
    await store.update({ ambientMotion: false })
    expect(JSON.parse(await readFile(store.path, 'utf8')).ambientMotion).toBe(false)
    await store.load()
    expect(store.recovery).toBeNull()
    expect(await readFile(join(directory, kept[0]!), 'utf8')).toBe(newer)
  })

  it('preserves a corrupt settings file the same way', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore({ configDirectory: directory })
    await writeFile(store.path, '{ not json')
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
    expect(store.recovery?.preservedPath).toMatch(/settings\.json\.broken-/)
    await expect(readFile(store.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

})
