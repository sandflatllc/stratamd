import type { SparseTheme, ThemeValues } from './theme-keys'

// The four stock themes (PRD §6.13). Each definition chooses every one of the
// 46 color swatches and all six non-color values explicitly — a stock theme
// never inherits a value from Strata Vivid, so changing the default can never
// silently restyle another stock theme. Equal hex values within a definition
// are deliberate. `New from this` copies a stock theme with every value, while
// user files stay sparse.
//
// Every stock theme colors the rendered document by kind: headings, smaller
// headings, bold, italic, code, links, quotes, and table headings each get
// their own hue, because telling those apart at a glance is what makes a dense
// document scannable. The themes differ in how loud the surfaces, controls, and
// effects around the document are.

export interface StockTheme {
  readonly name: string
  /** Every theme key, flat under its dotted name. */
  readonly values: ThemeValues
}

const STRATA_VIVID: StockTheme = {
  name: 'Strata Vivid',
  // Near-black purple panels, white body text, and a saturated hue for every
  // text kind. Rising motes behind the app, glow orbs inside the panels.
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
    'visuals.category-1': '#9b5cff',
    'visuals.category-2': '#4f8dff',
    'visuals.category-3': '#ff5c8a',
    'visuals.category-4': '#ffb03a',
    'visuals.category-5': '#3dc97c',
    'visuals.category-6': '#8fe3ff',
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

const STRATA_VIVID_LIGHT: StockTheme = {
  name: 'Strata Vivid Light',
  // Strata Vivid turned to daylight: lavender-white panels, near-black body
  // text, and the same hue for every text kind, darkened until it reads on
  // white. Controls and effects keep Vivid's saturated purple and pink.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#ece6fa',
    'surfaces.panel': '#fbfaff',
    'surfaces.inset': '#ebe4fb',
    'surfaces.field': '#f3eefe',
    'surfaces.code': '#f3eefe',
    'surfaces.border': '#cdbfea',
    'surfaces.overlay': '#1d1730',
    'interface.primary': '#14101f',
    'interface.body': '#14101f',
    'interface.secondary': '#4a4670',
    'interface.muted': '#006e74',
    'document.body': '#101018',
    'document.headings': '#a61cb8',
    'document.small-headings': '#006aa6',
    'document.bold': '#a04800',
    'document.italic': '#c62222',
    'document.code': '#0b7317',
    'document.link': '#00704d',
    'document.quote': '#4a5ad6',
    'document.table-heading': '#b81d1d',
    'controls.primary': '#7a3ff0',
    'controls.primary-highlight': '#e0306a',
    'controls.selected': '#7a3ff0',
    'controls.positive': '#178a4e',
    'controls.warning': '#b06d00',
    'controls.danger': '#e0306a',
    'controls.focus': '#2f6fe0',
    'changes.added': '#6a3fd8',
    'changes.removed': '#d6316a',
    'people.you': '#e0306a',
    'people.agent-1': '#7a3ff0',
    'people.agent-2': '#2f6fe0',
    'people.agent-3': '#178a4e',
    'people.agent-4': '#b06d00',
    'people.external': '#7a7297',
    'visuals.category-1': '#7a3ff0',
    'visuals.category-2': '#2f6fe0',
    'visuals.category-3': '#e0306a',
    'visuals.category-4': '#b06d00',
    'visuals.category-5': '#178a4e',
    'visuals.category-6': '#006aa6',
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

const STRATA_NIGHT: StockTheme = {
  name: 'Strata Night',
  // A plain dark mode under a starfield. Neutral charcoal surfaces and grey
  // interface text stay out of the way; the document keeps a distinct, softer
  // hue for every text kind. Controls are muted slate and lavender.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#07080c',
    'surfaces.panel': '#121318',
    'surfaces.inset': '#1c1e26',
    'surfaces.field': '#0d0e13',
    'surfaces.code': '#0d0e13',
    'surfaces.border': '#2a2d38',
    'surfaces.overlay': '#eceef5',
    'interface.primary': '#f2f3f7',
    'interface.body': '#d3d6df',
    'interface.secondary': '#9a9fae',
    'interface.muted': '#8a8f9e',
    'document.body': '#e6e8ee',
    'document.headings': '#c9b3ff',
    'document.small-headings': '#8fd0ff',
    'document.bold': '#ffcb7b',
    'document.italic': '#f2a0ae',
    'document.code': '#8fe3a9',
    'document.link': '#5cd6c2',
    'document.quote': '#98a3c7',
    'document.table-heading': '#e8d6ff',
    'controls.primary': '#8e97d6',
    'controls.primary-highlight': '#b7a6e8',
    'controls.selected': '#5560a8',
    'controls.positive': '#4cbd8a',
    'controls.warning': '#e0aa4e',
    'controls.danger': '#e07082',
    'controls.focus': '#7aa7ff',
    'changes.added': '#5fc9d9',
    'changes.removed': '#f08a6e',
    'people.you': '#e58aa8',
    'people.agent-1': '#a98cf0',
    'people.agent-2': '#7fb0f5',
    'people.agent-3': '#62c99a',
    'people.agent-4': '#e6b45e',
    'people.external': '#8d93a3',
    'visuals.category-1': '#a98cf0',
    'visuals.category-2': '#5fc9d9',
    'visuals.category-3': '#e6b45e',
    'visuals.category-4': '#62c99a',
    'visuals.category-5': '#f08a6e',
    'visuals.category-6': '#7fb0f5',
    'effects.primary': '#8f9cff',
    'effects.secondary': '#6fc6ff',
    'effects.tertiary': '#d9a6ff',
    'effects.detail-1': '#ffd27a',
    'effects.detail-2': '#7fe0b0',
    'effects.background-style': 'starfield',
    'effects.panel-style': 'starfield',
    'effects.intensity': 1.2,
    'effects.speed': 0.8
  })
}

const STRATA_DAY: StockTheme = {
  name: 'Strata Day',
  // An easy light mode: warm off-white surfaces with no pure white, dark grey
  // interface text, and deep ink colors that keep every document text kind
  // distinct without glare. Controls are muted indigo; a slow aurora drifts
  // behind the app and the panels stay still.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#e9e6df',
    'surfaces.panel': '#f7f5f0',
    'surfaces.inset': '#ece8e0',
    'surfaces.field': '#efece5',
    'surfaces.code': '#edeae2',
    'surfaces.border': '#d3cec3',
    'surfaces.overlay': '#2e2b33',
    'interface.primary': '#26232b',
    'interface.body': '#3d3a44',
    'interface.secondary': '#6b6772',
    'interface.muted': '#6d6974',
    'document.body': '#2b2830',
    'document.headings': '#5b3ea6',
    'document.small-headings': '#1a5f92',
    'document.bold': '#8a4f00',
    'document.italic': '#9c3249',
    'document.code': '#196b40',
    'document.link': '#0d6b6b',
    'document.quote': '#55607f',
    'document.table-heading': '#6b3f8f',
    'controls.primary': '#5f63a0',
    'controls.primary-highlight': '#7d6cbd',
    'controls.selected': '#7a7fc4',
    'controls.positive': '#25805a',
    'controls.warning': '#96620c',
    'controls.danger': '#b8485c',
    'controls.focus': '#2f6fd1',
    'changes.added': '#1b7580',
    'changes.removed': '#b4533d',
    'people.you': '#b0416a',
    'people.agent-1': '#6a48b8',
    'people.agent-2': '#2c66b3',
    'people.agent-3': '#237a53',
    'people.agent-4': '#9a6210',
    'people.external': '#6e6a73',
    'visuals.category-1': '#6a48b8',
    'visuals.category-2': '#1b7580',
    'visuals.category-3': '#9a6210',
    'visuals.category-4': '#237a53',
    'visuals.category-5': '#b4533d',
    'visuals.category-6': '#2c66b3',
    'effects.primary': '#9c8fe0',
    'effects.secondary': '#86b8e8',
    'effects.tertiary': '#e2a3b8',
    'effects.detail-1': '#e8c37a',
    'effects.detail-2': '#8fd0ad',
    'effects.background-style': 'aurora-drift',
    'effects.panel-style': 'none',
    'effects.intensity': 1,
    'effects.speed': 0.7
  })
}

/** All four stock themes, with the default Strata Vivid first. */
export const STOCK_THEMES: ReadonlyMap<string, StockTheme> = new Map([
  ['strata-vivid', STRATA_VIVID],
  ['strata-vivid-light', STRATA_VIVID_LIGHT],
  ['strata-night', STRATA_NIGHT],
  ['strata-day', STRATA_DAY]
])

/** Strata Vivid owns fresh-install selection and every missing-value fallback. */
export const DEFAULT_THEME_ID = 'strata-vivid'
export const DEFAULT_THEME_NAME = STRATA_VIVID.name
export const DEFAULT_THEME_VALUES: ThemeValues = STRATA_VIVID.values

/** Nests flat dotted keys into the on-disk file shape `{ group: { name } }`. */
export function nestThemeValues(name: string, values: ThemeValues): SparseTheme {
  const nested: Record<string, Record<string, string | number>> = {}
  for (const [key, value] of Object.entries(values)) {
    const [group, rest] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
    ;(nested[group] ??= {})[rest] = value
  }
  return Object.freeze({ name, ...nested })
}

/** The alternate stock themes beyond the built-in Strata Vivid, in their file shape. */
export const BUNDLED_THEMES: ReadonlyMap<string, SparseTheme> = new Map(
  [...STOCK_THEMES].filter(([id]) => id !== DEFAULT_THEME_ID).map(([id, theme]) => [id, nestThemeValues(theme.name, theme.values)])
)

export const BUNDLED_THEME_IDS: readonly string[] = [...BUNDLED_THEMES.keys()]
