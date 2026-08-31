import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILT_IN_THEME, describeTheme, listInstalledFonts, orderFontFamilies, ThemeBrokenError, ThemeStore } from '../../src/main/themes'
import { contrastingText, DEFAULT_THEME_VALUES, mixHex, normalizeTheme, slugifyThemeName, THEME_GROUPS, THEME_KEYS, writeSparseValue } from '../../src/shared/theme-keys'
import { BUNDLED_THEMES, nestThemeValues, STOCK_THEMES } from '../../src/shared/bundled-themes'

const directories: string[] = []
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stratamd-themes-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('theme schema', () => {
  it('exposes exactly 40 color swatches with the planned per-group counts and six non-color values', () => {
    const colors = THEME_KEYS.filter((entry) => entry.kind === 'color')
    expect(colors).toHaveLength(40)
    expect(new Set(colors.map((entry) => entry.key)).size).toBe(40)
    const counts = Object.fromEntries(THEME_GROUPS.map((group) => [group, colors.filter((entry) => entry.group === group).length]))
    expect(counts).toEqual({ fonts: 0, surfaces: 7, interface: 4, document: 9, controls: 7, changes: 2, people: 6, effects: 5 })
    const nonColor = THEME_KEYS.filter((entry) => entry.kind !== 'color')
    expect(nonColor.map((entry) => entry.key)).toEqual(['fonts.text', 'fonts.code', 'effects.background-style', 'effects.panel-style', 'effects.intensity', 'effects.speed'])
  })

  it('gives every entry a job label, a visible target description, and highlight metadata', () => {
    for (const entry of THEME_KEYS) {
      expect(entry.label.length, entry.key).toBeGreaterThan(0)
      expect(entry.description.length, entry.key).toBeGreaterThan(10)
      expect(entry.sample, entry.key).toBeTruthy()
      if (entry.kind === 'color') expect(entry.variable).toBe(`--${entry.key.replace('.', '-')}`)
    }
  })

  it('names jobs, never hues, in keys and labels', () => {
    for (const entry of THEME_KEYS) {
      for (const hue of ['pink', 'tangerine', 'mint', 'sky', 'grape']) {
        expect(entry.key, entry.key).not.toContain(hue)
        expect(entry.label.toLowerCase(), entry.key).not.toContain(hue)
      }
    }
  })
})

describe('stock themes', () => {
  it('declare all seven completely: every color and non-color value, explicitly', () => {
    expect([...STOCK_THEMES.keys()]).toEqual(['strata', 'strata-vivid', 'ember', 'candyfloss', 'isotope', 'nebula', 'paper'])
    for (const [id, theme] of STOCK_THEMES) {
      for (const entry of THEME_KEYS) {
        expect(theme.values[entry.key], `${id} ${entry.key}`).toBeDefined()
      }
      expect(Object.keys(theme.values), id).toHaveLength(THEME_KEYS.length)
    }
  })

  it('normalize with no problems and no fallback values', () => {
    for (const [id, theme] of STOCK_THEMES) {
      const normalized = normalizeTheme(nestThemeValues(theme.name, theme.values), id)
      expect(normalized.problems, id).toEqual([])
      expect(normalized.set, id).toHaveLength(THEME_KEYS.length)
      expect(normalized.values, id).toEqual(theme.values)
    }
  })

  it('use the complete Strata definition as the runtime defaults', () => {
    expect(DEFAULT_THEME_VALUES).toBe(STOCK_THEMES.get('strata')!.values)
    expect(BUILT_IN_THEME.set).toHaveLength(THEME_KEYS.length)
    expect(BUILT_IN_THEME.values).toBe(DEFAULT_THEME_VALUES)
  })
})

describe('theme normalization', () => {
  it('resolves a sparse file against the built-in values and reports each replaced value', () => {
    const result = normalizeTheme({
      name: 'Dusk',
      document: { bold: '#ABC', italic: 'reddish' },
      fonts: { text: '  Nunito ' },
      effects: { 'background-style': 'starfield', 'panel-style': 'lava', intensity: 9, speed: 'fast' },
      notes: 'kept',
    })
    expect(result.name).toBe('Dusk')
    expect(result.values['document.bold']).toBe('#aabbcc')
    expect(result.values['document.italic']).toBe(DEFAULT_THEME_VALUES['document.italic'])
    expect(result.values['fonts.text']).toBe('Nunito')
    expect(result.values['effects.background-style']).toBe('starfield')
    expect(result.values['effects.panel-style']).toBe('glow-orbs')
    expect(result.values['effects.intensity']).toBe(2)
    expect(result.values['effects.speed']).toBe(1)
    expect(result.problems.map((problem) => problem.key)).toEqual(['document.italic', 'effects.panel-style', 'effects.speed'])
    expect(result.set).toEqual(['fonts.text', 'document.bold', 'document.italic', 'effects.background-style', 'effects.panel-style', 'effects.intensity', 'effects.speed'])
    expect(Object.keys(result.values)).toHaveLength(THEME_KEYS.length)
  })

  it('reports a missing name and falls back to the id', () => {
    const result = normalizeTheme({}, 'dusk')
    expect(result.name).toBe('dusk')
    expect(result.problems).toEqual([{ key: 'name', reason: 'missing name' }])
  })

  it('writes and removes sparse values without touching unknown keys', () => {
    const withBold = writeSparseValue({ name: 'A', notes: 'n', document: { link: '#000000' } }, 'document.bold', '#ffffff')
    expect(withBold).toEqual({ name: 'A', notes: 'n', document: { link: '#000000', bold: '#ffffff' } })
    const cleared = writeSparseValue(writeSparseValue(withBold, 'document.link', null), 'document.bold', null)
    expect(cleared).toEqual({ name: 'A', notes: 'n' })
  })

  it('slugs names, mixes hex pairs, and picks readable text for a filled surface', () => {
    expect(slugifyThemeName('  Dusk & Warm!  ')).toBe('dusk-warm')
    expect(slugifyThemeName('***')).toBe('theme')
    expect(contrastingText('#f4f0fe')).toBe('#241f31')
    expect(contrastingText('#101010')).toBe('#f4f3f6')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#ff0000', '#0000ff', 1)).toBe('#ff0000')
  })
})

describe('ThemeStore', () => {
  it('lists the built-in first, loads sparse files, and flags broken ones without applying them', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    await store.ensureDirectory()
    await writeFile(store.pathFor('dusk'), JSON.stringify({ name: 'Dusk', document: { bold: '#112233' } }))
    await writeFile(store.pathFor('broken'), '{ not json')
    await writeFile(join(store.directory, 'Bad Name.json'), '{}')
    const list = await store.list()
    expect(list.map((theme) => theme.id)).toEqual(['strata', 'strata-vivid', 'ember', 'candyfloss', 'isotope', 'nebula', 'paper', 'broken', 'dusk'])
    expect(list[0]).toMatchObject({ builtIn: true, broken: false })
    expect(list[7]).toMatchObject({ broken: true, name: 'broken.json' })
    expect(list[7]!.problems[0]!.key).toBe('file')
    const dusk = await store.load('dusk')
    expect(dusk.values['document.bold']).toBe('#112233')
    expect(dusk.set).toEqual(['document.bold'])
    await expect(store.load('broken')).rejects.toBeInstanceOf(ThemeBrokenError)
    await expect(store.load('missing')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.load('strata')).toBe(BUILT_IN_THEME)
  })

  it('a sparse user theme falls back to Strata for missing values and Use default removes the value', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    await store.ensureDirectory()
    await writeFile(store.pathFor('dusk'), JSON.stringify({ name: 'Dusk', controls: { positive: '#00ff00' } }))
    const dusk = await store.load('dusk')
    expect(dusk.values['controls.positive']).toBe('#00ff00')
    expect(dusk.values['controls.danger']).toBe(DEFAULT_THEME_VALUES['controls.danger'])
    const cleared = writeSparseValue(dusk.sparse, 'controls.positive', null)
    expect(normalizeTheme(cleared).values['controls.positive']).toBe(DEFAULT_THEME_VALUES['controls.positive'])
  })

  it('stamps schema-version 2 on write and round-trips unrelated unknown keys', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    const written = await store.write('dusk', { name: 'Dusk', notes: 'mine', document: { bold: '#112233' } })
    const onDisk = JSON.parse(await readFile(written.path!, 'utf8'))
    expect(onDisk).toEqual({ 'schema-version': 2, name: 'Dusk', notes: 'mine', document: { bold: '#112233' } })
    const reloaded = await store.load('dusk')
    expect(reloaded.sparse['schema-version']).toBe(2)
    expect(reloaded.sparse.notes).toBe('mine')
  })

  it('creates copies with unique ids, writes privately, and guards the shipped and active themes', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    const first = await store.create('My Theme', 'strata')
    expect(first.id).toBe('my-theme')
    await store.write(first.id, { name: 'My Theme', document: { bold: '#ff0000' } })
    const second = await store.create('My Theme', first.id)
    expect(second.id).toBe('my-theme-2')
    // A copy of a user theme stays sparse: only the source's set keys plus the marker.
    expect(second.sparse).toEqual({ 'schema-version': 2, name: 'My Theme', document: { bold: '#ff0000' } })
    await expect(store.write('strata', {})).rejects.toThrow(/ship with StrataMD/)
    await expect(store.delete('strata', first.id)).rejects.toThrow(/ship with StrataMD/)
    await expect(store.delete(first.id, first.id)).rejects.toThrow(/active/)
    await store.delete(second.id, first.id)
    expect(await store.ids()).toEqual([first.id])
  })

  it('New from this on every stock theme writes all 40 swatches and all six non-color values', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    for (const id of STOCK_THEMES.keys()) {
      const copy = await store.create(`Copy of ${id}`, id)
      expect(copy.builtIn).toBe(false)
      expect(copy.set, id).toHaveLength(THEME_KEYS.length)
      expect(copy.problems, id).toEqual([])
      const onDisk = JSON.parse(await readFile(copy.path!, 'utf8'))
      for (const entry of THEME_KEYS) {
        const [group, name] = [entry.key.slice(0, entry.key.indexOf('.')), entry.key.slice(entry.key.indexOf('.') + 1)]
        expect(onDisk[group]?.[name], `${id} ${entry.key}`).toBe(STOCK_THEMES.get(id)!.values[entry.key])
      }
      expect(onDisk['schema-version']).toBe(2)
    }
  })

  it('describes a theme as set values, defaults with descriptions, and problems', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    await store.ensureDirectory()
    await writeFile(store.pathFor('dusk'), JSON.stringify({ name: 'Dusk', document: { bold: '#112233', link: 'blue' } }))
    const described = describeTheme(await store.load('dusk'))
    expect(described.set).toEqual({ 'document.bold': '#112233', 'document.link': DEFAULT_THEME_VALUES['document.link'] })
    expect(Object.keys(described.defaults)).toHaveLength(THEME_KEYS.length - 2)
    expect(described.keys.find((key) => key.key === 'document.bold')).toMatchObject({ label: 'Bold text', group: 'document', kind: 'color' })
    expect(described.problems).toEqual([{ key: 'document.link', reason: 'not a color (use #rrggbb)' }])
    // A stock theme describes every value as chosen by its authors.
    expect(Object.keys(describeTheme(BUILT_IN_THEME).set)).toHaveLength(THEME_KEYS.length)
  })
})

describe('bundled themes', () => {
  it('ship complete, without problems, read-only', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    for (const id of BUNDLED_THEMES.keys()) {
      const theme = await store.load(id)
      expect(theme.problems, id).toEqual([])
      expect(theme.builtIn).toBe(true)
      expect(theme.set, id).toHaveLength(THEME_KEYS.length)
      await expect(store.write(id, {})).rejects.toThrow(/cannot be edited/)
      await expect(store.delete(id, 'strata')).rejects.toThrow(/cannot be deleted/)
    }
    const copy = await store.create('Copy of Paper', 'paper')
    expect(copy.id).toBe('copy-of-paper')
    expect(copy.builtIn).toBe(false)
    expect(copy.values['surfaces.window']).toBe('#f3efe7')
  })

  it('cannot be shadowed by a user file of the same id', async () => {
    const store = new ThemeStore({ configDirectory: await temporaryDirectory() })
    await store.ensureDirectory()
    await writeFile(store.pathFor('paper'), JSON.stringify({ name: 'Fake' }))
    expect(await store.ids()).toEqual([])
    expect((await store.load('paper')).name).toBe('Paper')
  })
})

describe('installed fonts', () => {
  it('orders bundled families first, dedupes, and takes the canonical name before the comma', () => {
    expect(orderFontFamilies('Noto Sans,Noto Sans CJK\nBaloo 2\nAbel\nAbel\n\nZilla Slab')).toEqual(['Baloo 2', 'JetBrains Mono', 'Abel', 'Noto Sans', 'Zilla Slab'])
  })

  it('falls back to the bundled families when fc-list is unavailable', async () => {
    expect(await listInstalledFonts(async () => { throw new Error('ENOENT') })).toEqual(['Baloo 2', 'JetBrains Mono'])
    expect(await listInstalledFonts(async () => ({ stdout: 'Abel\n' }))).toEqual(['Baloo 2', 'JetBrains Mono', 'Abel'])
  })
})
