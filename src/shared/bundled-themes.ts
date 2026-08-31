import type { SparseTheme, ThemeValues } from './theme-keys'

// The seven stock themes (PRD §6.13, docs/plans/completed/theme-restructure-plan.md §7). Each
// definition chooses every one of the 40 color swatches and all six non-color
// values explicitly — a stock theme never inherits a value from Strata, so a
// Strata change can never silently restyle another stock theme. Equal hex
// values within a definition are deliberate. `New from this` copies a stock
// theme with every value, while user files stay sparse.

export interface StockTheme {
  readonly name: string
  /** Every theme key, flat under its dotted name. */
  readonly values: ThemeValues
}

const STRATA: StockTheme = {
  name: 'Strata',
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#0a0810',
    'surfaces.panel': '#241e3b',
    'surfaces.inset': '#312a50',
    'surfaces.field': '#1d1731',
    'surfaces.code': '#1d1731',
    'surfaces.border': '#463c6e',
    'surfaces.overlay': '#f4f0fe',
    'interface.primary': '#f4f3f6',
    'interface.body': '#dbdade',
    'interface.secondary': '#a8a6b0',
    'interface.muted': '#8b8994',
    'document.body': '#dbdade',
    'document.headings': '#f4f3f6',
    'document.small-headings': '#dbdade',
    'document.bold': '#dbdade',
    'document.italic': '#dbdade',
    'document.code': '#bebcc6',
    'document.link': '#4f8dff',
    'document.quote': '#a8a6b0',
    'document.table-heading': '#f4f3f6',
    'controls.primary': '#c4a7ff',
    'controls.primary-highlight': '#ff9abb',
    'controls.selected': '#854fdb',
    'controls.positive': '#3dc97c',
    'controls.warning': '#ffb03a',
    'controls.danger': '#ff9a92',
    'controls.focus': '#77aaff',
    'changes.added': '#45d4e6',
    'changes.removed': '#ff8a5c',
    'people.you': '#ff9abb',
    'people.agent-1': '#c4a7ff',
    'people.agent-2': '#82b5ff',
    'people.agent-3': '#68dca0',
    'people.agent-4': '#ffc56b',
    'people.external': '#b8afc7',
    'effects.primary': '#9b5cff',
    'effects.secondary': '#4f8dff',
    'effects.tertiary': '#ff5c8a',
    'effects.detail-1': '#ffb03a',
    'effects.detail-2': '#3dc97c',
    'effects.background-style': 'rising-motes',
    'effects.panel-style': 'glow-orbs',
    'effects.intensity': 1,
    'effects.speed': 1
  })
}

const STRATA_VIVID: StockTheme = {
  name: 'Strata Vivid',
  // Strata's structure on a near-black panel, with the owner's vivid text
  // palette: white body text and a distinct saturated hue for every text kind.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#0a0810',
    'surfaces.panel': '#15141a',
    'surfaces.inset': '#312a50',
    'surfaces.field': '#1d1731',
    'surfaces.code': '#1d1731',
    'surfaces.border': '#463c6e',
    'surfaces.overlay': '#f4f0fe',
    'interface.primary': '#ffffff',
    'interface.body': '#ffffff',
    'interface.secondary': '#d8ddfd',
    'interface.muted': '#80fdff',
    'document.body': '#ffffff',
    'document.headings': '#f7b8ff',
    'document.small-headings': '#8fe3ff',
    'document.bold': '#ffbe5c',
    'document.italic': '#ff7070',
    'document.code': '#54ff52',
    'document.link': '#5ee0b4',
    'document.quote': '#9aa8ff',
    'document.table-heading': '#ff7070',
    'controls.primary': '#9b5cff',
    'controls.primary-highlight': '#ff5c8a',
    'controls.selected': '#9b5cff',
    'controls.positive': '#3dc97c',
    'controls.warning': '#ffb03a',
    'controls.danger': '#ff5c8a',
    'controls.focus': '#4f8dff',
    'changes.added': '#9c66ff',
    'changes.removed': '#fe769d',
    'people.you': '#ff5c8a',
    'people.agent-1': '#9b5cff',
    'people.agent-2': '#4f8dff',
    'people.agent-3': '#3dc97c',
    'people.agent-4': '#ffb03a',
    'people.external': '#7a7292',
    'effects.primary': '#9b5cff',
    'effects.secondary': '#4f8dff',
    'effects.tertiary': '#ff5c8a',
    'effects.detail-1': '#ffb03a',
    'effects.detail-2': '#3dc97c',
    'effects.background-style': 'rising-motes',
    'effects.panel-style': 'glow-orbs',
    'effects.intensity': 1.5,
    'effects.speed': 1
  })
}

const EMBER: StockTheme = {
  name: 'Ember',
  // Warm dark panels with amber, coral, and rose emphasis.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#120b0a',
    'surfaces.panel': '#2a1d1b',
    'surfaces.inset': '#3a2825',
    'surfaces.field': '#1f1412',
    'surfaces.code': '#1f1412',
    'surfaces.border': '#4f3733',
    'surfaces.overlay': '#fff1e6',
    'interface.primary': '#fff4ec',
    'interface.body': '#e6d9d0',
    'interface.secondary': '#b8a59a',
    'interface.muted': '#9b8880',
    'document.body': '#e6d9d0',
    'document.headings': '#ffd9a1',
    'document.small-headings': '#e8d3b8',
    'document.bold': '#ffb03a',
    'document.italic': '#ff9dbb',
    'document.code': '#e6c9b5',
    'document.link': '#ffa26b',
    'document.quote': '#b8a59a',
    'document.table-heading': '#fff4ec',
    'controls.primary': '#d6a6ff',
    'controls.primary-highlight': '#ff9a9f',
    'controls.selected': '#8b58b5',
    'controls.positive': '#8fd66b',
    'controls.warning': '#ffb03a',
    'controls.danger': '#ff9a9f',
    'controls.focus': '#8dbbff',
    'changes.added': '#73d7c3',
    'changes.removed': '#ff8c78',
    'people.you': '#ffa0b7',
    'people.agent-1': '#ffc15b',
    'people.agent-2': '#d6a6ff',
    'people.agent-3': '#a0dc7c',
    'people.agent-4': '#8dbbff',
    'people.external': '#c2aaa0',
    'effects.primary': '#c47cff',
    'effects.secondary': '#7fb0ff',
    'effects.tertiary': '#ff6b7a',
    'effects.detail-1': '#ffb03a',
    'effects.detail-2': '#8fd66b',
    'effects.background-style': 'glow-orbs',
    'effects.panel-style': 'breathing-tint',
    'effects.intensity': 1.1,
    'effects.speed': 0.9
  })
}

const CANDYFLOSS: StockTheme = {
  name: 'Candyfloss',
  // Light pink canvas with dark plum text.
  values: Object.freeze({
    'fonts.text': 'Fredoka',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#f9e8f0',
    'surfaces.panel': '#fffbfd',
    'surfaces.inset': '#f7ecf2',
    'surfaces.field': '#f8eff4',
    'surfaces.code': '#f8eff4',
    'surfaces.border': '#ecd3e0',
    'surfaces.overlay': '#3a2434',
    'interface.primary': '#33202c',
    'interface.body': '#4d3a46',
    'interface.secondary': '#7d6875',
    'interface.muted': '#75616f',
    'document.body': '#4d3a46',
    'document.headings': '#33202c',
    'document.small-headings': '#4d3a46',
    'document.bold': '#3d2836',
    'document.italic': '#5f4a58',
    'document.code': '#6e4a60',
    'document.link': '#2565a8',
    'document.quote': '#7d6875',
    'document.table-heading': '#33202c',
    'controls.primary': '#7040b8',
    'controls.primary-highlight': '#ad2e61',
    'controls.selected': '#7d53d2',
    'controls.positive': '#177a58',
    'controls.warning': '#9b5e00',
    'controls.danger': '#ad2e61',
    'controls.focus': '#1c61b8',
    'changes.added': '#176d78',
    'changes.removed': '#a63d45',
    'people.you': '#a82f62',
    'people.agent-1': '#7040b8',
    'people.agent-2': '#2565a8',
    'people.agent-3': '#167459',
    'people.agent-4': '#915b0d',
    'people.external': '#6f626a',
    'effects.primary': '#a06ef5',
    'effects.secondary': '#5b9df0',
    'effects.tertiary': '#f06292',
    'effects.detail-1': '#f5a623',
    'effects.detail-2': '#4cbf8f',
    'effects.background-style': 'rising-motes',
    'effects.panel-style': 'starfield',
    'effects.intensity': 1.2,
    'effects.speed': 1.25
  })
}

const ISOTOPE: StockTheme = {
  name: 'Isotope',
  // Neutral light grey, no motion; status colors stay distinguishable without a colorful interface.
  values: Object.freeze({
    'fonts.text': 'Atkinson Hyperlegible',
    'fonts.code': 'Spline Sans Mono',
    'surfaces.window': '#dfe3e8',
    'surfaces.panel': '#fafbfc',
    'surfaces.inset': '#e3e7ec',
    'surfaces.field': '#e9edf2',
    'surfaces.code': '#e9edf2',
    'surfaces.border': '#c3cbd5',
    'surfaces.overlay': '#1c2430',
    'interface.primary': '#17202b',
    'interface.body': '#333e4c',
    'interface.secondary': '#63707f',
    'interface.muted': '#65717f',
    'document.body': '#333e4c',
    'document.headings': '#17202b',
    'document.small-headings': '#333e4c',
    'document.bold': '#1e2936',
    'document.italic': '#4a5665',
    'document.code': '#3e4c5e',
    'document.link': '#145fb3',
    'document.quote': '#63707f',
    'document.table-heading': '#17202b',
    'controls.primary': '#6540ad',
    'controls.primary-highlight': '#a92f62',
    'controls.selected': '#7d53d2',
    'controls.positive': '#0d7a52',
    'controls.warning': '#935100',
    'controls.danger': '#a92f62',
    'controls.focus': '#145fb3',
    'changes.added': '#176a70',
    'changes.removed': '#98354a',
    'people.you': '#a92f62',
    'people.agent-1': '#145fb3',
    'people.agent-2': '#6540ad',
    'people.agent-3': '#0d7a52',
    'people.agent-4': '#935100',
    'people.external': '#586777',
    'effects.primary': '#7a4fd8',
    'effects.secondary': '#1f6fe0',
    'effects.tertiary': '#e0447c',
    'effects.detail-1': '#e08a1f',
    'effects.detail-2': '#14a06e',
    'effects.background-style': 'none',
    'effects.panel-style': 'none',
    'effects.intensity': 0,
    'effects.speed': 1
  })
}

const NEBULA: StockTheme = {
  name: 'Nebula',
  // Near-black blue canvas, cool document text, space effects. Selected items
  // and additions deliberately avoid the agent attribution hues.
  values: Object.freeze({
    'fonts.text': 'Outfit',
    'fonts.code': 'Fira Code',
    'surfaces.window': '#05070f',
    'surfaces.panel': '#0c1120',
    'surfaces.inset': '#141b31',
    'surfaces.field': '#080d1a',
    'surfaces.code': '#080d1a',
    'surfaces.border': '#232d4c',
    'surfaces.overlay': '#eef1fb',
    'interface.primary': '#f0f3fc',
    'interface.body': '#c9d0e4',
    'interface.secondary': '#8e97b5',
    'interface.muted': '#7e88a6',
    'document.body': '#c9d0e4',
    'document.headings': '#f0f3fc',
    'document.small-headings': '#c9d0e4',
    'document.bold': '#e2e7f6',
    'document.italic': '#c9d0e4',
    'document.code': '#a5aecb',
    'document.link': '#5ea0ff',
    'document.quote': '#8e97b5',
    'document.table-heading': '#f0f3fc',
    'controls.primary': '#c1a8ff',
    'controls.primary-highlight': '#ff9bc8',
    'controls.selected': '#c7b1fc',
    'controls.positive': '#68e8bd',
    'controls.warning': '#ffc175',
    'controls.danger': '#ff9aa3',
    'controls.focus': '#81b4ff',
    'changes.added': '#62d9e3',
    'changes.removed': '#ff857f',
    'people.you': '#ff9bc8',
    'people.agent-1': '#c1a8ff',
    'people.agent-2': '#81b4ff',
    'people.agent-3': '#68e8bd',
    'people.agent-4': '#ffc175',
    'people.external': '#aeb6d3',
    'effects.primary': '#a883ff',
    'effects.secondary': '#5ea0ff',
    'effects.tertiary': '#ff6bb3',
    'effects.detail-1': '#ffb054',
    'effects.detail-2': '#4fe0b0',
    'effects.background-style': 'starfield',
    'effects.panel-style': 'glow-orbs',
    'effects.intensity': 1.2,
    'effects.speed': 0.75
  })
}

const PAPER: StockTheme = {
  name: 'Paper',
  // Cream surfaces and restrained, print-like document colors.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#f3efe7',
    'surfaces.panel': '#fffdf8',
    'surfaces.inset': '#efe9dd',
    'surfaces.field': '#f0ebe1',
    'surfaces.code': '#f0ebe1',
    'surfaces.border': '#d8d0c2',
    'surfaces.overlay': '#2b2436',
    'interface.primary': '#1f1a26',
    'interface.body': '#33303a',
    'interface.secondary': '#6d6873',
    'interface.muted': '#756f79',
    'document.body': '#33303a',
    'document.headings': '#1f1a26',
    'document.small-headings': '#3a3342',
    'document.bold': '#b0452f',
    'document.italic': '#4b4356',
    'document.code': '#4a3f5e',
    'document.link': '#1f5fd1',
    'document.quote': '#6d6873',
    'document.table-heading': '#1f1a26',
    'controls.primary': '#6540ad',
    'controls.primary-highlight': '#a62f5c',
    'controls.selected': '#7d53d2',
    'controls.positive': '#177249',
    'controls.warning': '#8a5500',
    'controls.danger': '#a62f5c',
    'controls.focus': '#1c5fb2',
    'changes.added': '#256c5c',
    'changes.removed': '#9d3b30',
    'people.you': '#a62f5c',
    'people.agent-1': '#6540ad',
    'people.agent-2': '#1c5fb2',
    'people.agent-3': '#177249',
    'people.agent-4': '#8a5500',
    'people.external': '#6b6072',
    'effects.primary': '#7a4fd1',
    'effects.secondary': '#2f6fdd',
    'effects.tertiary': '#d9456f',
    'effects.detail-1': '#d98b1f',
    'effects.detail-2': '#2e9a5f',
    'effects.background-style': 'breathing-tint',
    'effects.panel-style': 'none',
    'effects.intensity': 0.7,
    'effects.speed': 1
  })
}

/** All seven stock themes, Strata first. */
export const STOCK_THEMES: ReadonlyMap<string, StockTheme> = new Map([
  ['strata', STRATA],
  ['strata-vivid', STRATA_VIVID],
  ['ember', EMBER],
  ['candyfloss', CANDYFLOSS],
  ['isotope', ISOTOPE],
  ['nebula', NEBULA],
  ['paper', PAPER]
])

/** The complete Strata definition is the runtime default for every value. */
export const DEFAULT_THEME_VALUES: ThemeValues = STRATA.values

/** Nests flat dotted keys into the on-disk file shape `{ group: { name } }`. */
export function nestThemeValues(name: string, values: ThemeValues): SparseTheme {
  const nested: Record<string, Record<string, string | number>> = {}
  for (const [key, value] of Object.entries(values)) {
    const [group, rest] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
    ;(nested[group] ??= {})[rest] = value
  }
  return Object.freeze({ name, ...nested })
}

/** The stock themes beyond Strata, in their file shape. */
export const BUNDLED_THEMES: ReadonlyMap<string, SparseTheme> = new Map(
  [...STOCK_THEMES].filter(([id]) => id !== 'strata').map(([id, theme]) => [id, nestThemeValues(theme.name, theme.values)])
)

export const BUNDLED_THEME_IDS: readonly string[] = [...BUNDLED_THEMES.keys()]
