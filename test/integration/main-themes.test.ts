import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import { DEFAULT_THEME_VALUES } from '../../src/shared/theme-keys'
import { nestThemeValues } from '../../src/shared/bundled-themes'
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
  it('starts on Strata Vivid, the default view, with every key resolved', async () => {
    const { app } = await fixture()
    const { theme } = (await app.getState()).settings
    expect(theme.active).toMatchObject({ id: 'strata-vivid', builtIn: true, missing: false, path: null })
    expect(theme.active.values['document.bold']).toBe('#ffbe5c')
    expect(theme.available.map((summary) => summary.id)).toEqual(['strata', 'strata-vivid', 'ember', 'candyfloss', 'isotope', 'nebula', 'paper'])
    expect(await app.listFonts()).toEqual(['Baloo 2', 'JetBrains Mono', 'Abel'])
  })

  it('copies a stock theme with every value chosen, applies edits on the same call, and writes shortly after', async () => {
    const { app, themeStore, settingsStore, states } = await fixture()
    const id = await app.createTheme('Copy of Strata', 'strata')
    expect(id).toBe('copy-of-strata')
    expect((await settingsStore.load()).theme).toBe(id)

    const complete = (values: Record<string, string | number>, name: string) => ({ 'schema-version': 2, ...nestThemeValues(name, values) })
    await app.setThemeValue('document.bold', '#ff8800')
    const latest = states.at(-1)!.settings.theme
    expect(latest.active.values['document.bold']).toBe('#ff8800')
    expect(latest.active.sparse).toEqual(complete({ ...DEFAULT_THEME_VALUES, 'document.bold': '#ff8800' }, 'Copy of Strata'))

    await app.flushThemeWrites()
    expect(JSON.parse(await readFile(themeStore.pathFor(id), 'utf8'))).toEqual(complete({ ...DEFAULT_THEME_VALUES, 'document.bold': '#ff8800' }, 'Copy of Strata'))

    // Use default removes the one value; the rest of the copy stays chosen.
    await app.setThemeValue('document.bold', null)
    await app.renameTheme('Warm')
    await app.flushThemeWrites()
    const withoutBold = Object.fromEntries(Object.entries(DEFAULT_THEME_VALUES).filter(([key]) => key !== 'document.bold'))
    expect(JSON.parse(await readFile(themeStore.pathFor(id), 'utf8'))).toEqual(complete(withoutBold, 'Warm'))
    expect(Object.keys(JSON.parse(await readFile(themeStore.pathFor(id), 'utf8')).document)).toHaveLength(8)
    expect(states.at(-1)!.settings.theme.available.find((summary) => summary.id === id)?.name).toBe('Warm')

    await expect(app.setThemeValue('document.bold', 'orange')).rejects.toThrow(/Invalid value/)
    await expect(app.setThemeValue('nope.key', '#000000')).rejects.toThrow(/Unknown theme key/)
    await expect(app.deleteTheme('strata')).rejects.toThrow(/ship with StrataMD/)
    // Deleting the active theme falls back to the built-in first.
    await app.deleteTheme(id)
    expect((await app.getState()).settings.theme.active.id).toBe('strata')
    expect((await settingsStore.load()).theme).toBe('strata')
    await expect(app.setThemeValue('document.bold', '#000000')).rejects.toThrow(/ship with StrataMD/)
    expect(states.at(-1)!.settings.theme.available.map((summary) => summary.id)).toEqual(['strata', 'strata-vivid', 'ember', 'candyfloss', 'isotope', 'nebula', 'paper'])
  })

  it('reverts to a snapshot and lists broken files without applying them', async () => {
    const { app, themeStore } = await fixture()
    const id = await app.createTheme('Dusk', 'strata')
    const snapshot = (await app.getState()).settings.theme.active.sparse
    await app.setThemeValue('surfaces.window', '#ffffff')
    await app.revertTheme(snapshot)
    expect((await app.getState()).settings.theme.active.values['surfaces.window']).toBe('#0a0810')
    await app.flushThemeWrites()

    await writeFile(themeStore.pathFor('broken'), '{ nope')
    await app.selectTheme(id)
    const list = (await app.getState()).settings.theme.available
    expect(list.find((summary) => summary.id === 'broken')).toMatchObject({ broken: true })
    await app.selectTheme('broken')
    const active = (await app.getState()).settings.theme.active
    expect(active.values['surfaces.window']).toBe('#0a0810')
    expect(active.problems[0]?.key).toBe('file')
  })

  it('follows external writes to the active file, ignores its own, keeps values when the file is deleted, and repairs a broken file on the next edit', async () => {
    const { app, themeStore, states } = await fixture(true)
    const id = await app.createTheme('Dusk', 'strata')
    await app.flushThemeWrites()
    const path = themeStore.pathFor(id)
    const revisionBefore = (await app.getState()).settings.theme.externalRevision

    await app.setThemeValue('document.bold', '#123456')
    await app.flushThemeWrites()
    await new Promise((resolve) => setTimeout(resolve, 400))
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
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'schema-version': 2, name: 'Dusk', document: { bold: '#abcdef', italic: '#000001' } })
    expect(states.at(-1)!.settings.theme.active.problems).toEqual([])
  })
})
