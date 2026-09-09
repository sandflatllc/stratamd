import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import { DEFAULT_THEME_VALUES } from '../../src/shared/theme-keys'
import { nestThemeValues, STOCK_THEMES } from '../../src/shared/bundled-themes'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'
import { ThemeStore } from '../../src/main/themes'
import type { AppView } from '../../src/shared/contracts'

const roots: string[] = []
const applications: StrataApplication[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(watch = false) {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-themes-'))
  roots.push(root)
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const themeStore = new ThemeStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, themeStore, watch, listFonts: async () => ['Baloo 2', 'JetBrains Mono', 'Abel'] })
  applications.push(app)
  const states: AppView[] = []
  app.subscribe((state) => states.push(state))
  return { root, app, settingsStore, themeStore, states }
}

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting; last value ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('themes in the application', () => {
  it('starts on Strata, the default view, with every key resolved', async () => {
    const { app } = await fixture()
    const { theme } = (await app.getState()).settings
    expect(theme.active).toMatchObject({ id: 'strata-night', name: 'Strata', builtIn: true, missing: false, path: null })
    expect(theme.active.values['document.bold']).toBe('#ffcb7b')
    expect(theme.available.map((summary) => summary.id)).toEqual(['strata-night', 'strata-vivid', 'strata-vivid-light', 'strata-day'])
    expect(theme.available.map((summary) => summary.name)).toEqual(['Strata', 'Strata Vivid', 'Strata Light', 'Strata Mono'])
    expect(await app.listFonts()).toEqual(['Baloo 2', 'JetBrains Mono', 'Abel'])
  })

  it('copies a stock theme with every value chosen, applies edits on the same call, and writes shortly after', async () => {
    const { app, themeStore, settingsStore, states } = await fixture()
    const id = await app.createTheme('Copy of Strata Night', 'strata-night')
    const strataValues = STOCK_THEMES.get('strata-night')!.values
    expect(id).toBe('copy-of-strata-night')
    expect((await settingsStore.load()).theme).toBe(id)

    const complete = (values: Record<string, string | number>, name: string) => ({ 'schema-version': 3, ...nestThemeValues(name, values) })
    await app.setThemeValue('document.bold', '#ff8800')
    const latest = states.at(-1)!.settings.theme
    expect(latest.active.values['document.bold']).toBe('#ff8800')
    expect(latest.active.sparse).toEqual(complete({ ...strataValues, 'document.bold': '#ff8800' }, 'Copy of Strata Night'))

    await app.flushThemeWrites()
    expect(JSON.parse(await readFile(themeStore.pathFor(id), 'utf8'))).toEqual(complete({ ...strataValues, 'document.bold': '#ff8800' }, 'Copy of Strata Night'))

    // Use default removes the one value; the rest of the copy stays chosen.
    await app.setThemeValue('document.bold', null)
    await app.renameTheme('Warm')
    await app.flushThemeWrites()
    const withoutBold = Object.fromEntries(Object.entries(strataValues).filter(([key]) => key !== 'document.bold'))
    expect(JSON.parse(await readFile(themeStore.pathFor(id), 'utf8'))).toEqual(complete(withoutBold, 'Warm'))
    expect(Object.keys(JSON.parse(await readFile(themeStore.pathFor(id), 'utf8')).document)).toHaveLength(8)
    expect(states.at(-1)!.settings.theme.available.find((summary) => summary.id === id)?.name).toBe('Warm')

    await expect(app.setThemeValue('document.bold', 'orange')).rejects.toThrow(/Invalid value/)
    await expect(app.setThemeValue('nope.key', '#000000')).rejects.toThrow(/Unknown theme key/)
    await expect(app.deleteTheme('strata-night')).rejects.toThrow(/ship with StrataMD/)
    // Deleting the active theme falls back to the built-in first.
    await app.deleteTheme(id)
    expect((await app.getState()).settings.theme.active.id).toBe('strata-night')
    expect((await settingsStore.load()).theme).toBe('strata-night')
    await expect(app.setThemeValue('document.bold', '#000000')).rejects.toThrow(/ship with StrataMD/)
    expect(states.at(-1)!.settings.theme.available.map((summary) => summary.id)).toEqual(['strata-night', 'strata-vivid', 'strata-vivid-light', 'strata-day'])
  })

  it('reverts to a snapshot and lists broken files without applying them', async () => {
    const { app, themeStore } = await fixture()
    const id = await app.createTheme('Dusk', 'strata-night')
    const snapshot = (await app.getState()).settings.theme.active.sparse
    await app.setThemeValue('surfaces.window', '#ffffff')
    await app.revertTheme(snapshot)
    expect((await app.getState()).settings.theme.active.values['surfaces.window']).toBe('#000000')
    await app.flushThemeWrites()

    await writeFile(themeStore.pathFor('broken'), '{ nope')
    await app.selectTheme(id)
    const list = (await app.getState()).settings.theme.available
    expect(list.find((summary) => summary.id === 'broken')).toMatchObject({ broken: true })
    await app.selectTheme('broken')
    const active = (await app.getState()).settings.theme.active
    expect(active.values['surfaces.window']).toBe('#000000')
    expect(active.problems[0]?.key).toBe('file')
  })

  it('follows external writes to the active file, ignores its own, keeps values when the file is deleted, and repairs a broken file on the next edit', async () => {
    const { app, themeStore, states } = await fixture(true)
    const id = await app.createTheme('Dusk', 'strata-night')
    await app.flushThemeWrites()
    const path = themeStore.pathFor(id)
    const revisionBefore = (await app.getState()).settings.theme.externalRevision

    const ownWriteStart = states.length
    await app.setThemeValue('document.bold', '#123456')
    await app.flushThemeWrites()
    // The edit and completed write each publish once. The next publication
    // confirms the filesystem watcher has processed the active file too.
    await until(() => states.slice(ownWriteStart).filter(state => state.settings.theme.active.values['document.bold'] === '#123456').length, count => count >= 3)
    expect((await app.getState()).settings.theme.externalRevision).toBe(revisionBefore)

    await writeFile(path, JSON.stringify({ name: 'Dusk', document: { bold: '#abcdef' } }))
    const external = await until(() => app.getState(), (state) => state.settings.theme.active.values['document.bold'] === '#abcdef')
    expect(external.settings.theme.externalRevision).toBe(revisionBefore + 1)

    await rm(path)
    const missing = await until(() => app.getState(), (state) => state.settings.theme.active.missing)
    expect(missing.settings.theme.active.values['document.bold']).toBe('#abcdef')
    expect(missing.settings.theme.active.id).toBe(id)

    await writeFile(path, '{ broken')
    await until(() => app.getState(), (state) => state.settings.theme.active.problems.some((problem) => problem.key === 'file'))
    await app.setThemeValue('document.italic', '#000001')
    await app.flushThemeWrites()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'schema-version': 3, name: 'Dusk', document: { bold: '#abcdef', italic: '#000001' } })
    expect(states.at(-1)!.settings.theme.active.problems).toEqual([])
  })

  it('does not replace a newer local edit with a theme reload that was already in flight', async () => {
    const { app, themeStore, states } = await fixture(true)
    const id = await app.createTheme('Concurrent', 'strata-vivid')
    await app.flushThemeWrites()
    const revision = (await app.getState()).settings.theme.externalRevision
    const originalLoad = themeStore.load.bind(themeStore)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const loading = new Promise<void>(resolve => { entered = resolve })
    let holdNext = true
    themeStore.load = async (name) => {
      const loaded = await originalLoad(name)
      if (name === id && holdNext) {
        holdNext = false
        entered()
        await held
      }
      return loaded
    }
    try {
      await writeFile(themeStore.pathFor(id), JSON.stringify({ name: 'Concurrent', surfaces: { transcript: '#203040' } }))
      await loading
      await app.setThemeValue('surfaces.transcript-border', '#607080')
      await app.flushThemeWrites()
      const beforeRelease = states.length
      release()
      await until(() => states.length, count => count > beforeRelease)
      const theme = (await app.getState()).settings.theme
      expect(theme.active.values['surfaces.transcript-border']).toBe('#607080')
      expect(theme.externalRevision).toBe(revision)
    } finally { release(); themeStore.load = originalLoad }
  })

  it('reports a failed theme write beside the theme and clears it when a write lands', async () => {
    const { app, themeStore } = await fixture()
    await app.createTheme('Fragile', 'strata-night')
    const original = themeStore.write.bind(themeStore)
    let failing = true
    themeStore.write = async (id, sparse) => {
      if (failing) throw new Error('EACCES: permission denied')
      return original(id, sparse)
    }

    await app.setThemeValue('document.bold', '#123456')
    await app.flushThemeWrites()
    let { theme } = (await app.getState()).settings
    // The edit stays live in memory; the panel says the file did not take it.
    expect(theme.active.values['document.bold']).toBe('#123456')
    expect(theme.active.problems).toEqual([expect.objectContaining({ key: 'write', reason: expect.stringContaining('permission denied') })])

    failing = false
    await app.setThemeValue('document.bold', '#654321')
    await app.flushThemeWrites()
    theme = (await app.getState()).settings.theme
    expect(theme.active.problems).toEqual([])
    expect((await themeStore.load('fragile')).values['document.bold']).toBe('#654321')
  })
})
