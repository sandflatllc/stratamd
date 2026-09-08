import type { SparseTheme, ThemeValues } from './theme-keys'

// The four stock themes (PRD §6.13). Each definition chooses every one of the
// color swatches and all non-color values explicitly — a stock theme
// never inherits a value from Strata, so changing the default can never
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
  // Promoted from the owner's saved theme on 2026-09-07.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#0a0810',
    'surfaces.panel': '#15141a',
    'surfaces.transcript-style': 'panel',
    'surfaces.transcript-shadow-style': 'none',
    'surfaces.transcript-shadow-strength': 1,
    'surfaces.transcript-shadow': '#000000',
    'surfaces.transcript': '#15141a',
    'surfaces.inset': '#312a50',
    'surfaces.user-message': '#312a50',
    'surfaces.tool-call': '#1d1731',
    'surfaces.field': '#1d1731',
    'surfaces.code': '#1d1731',
    'surfaces.border': '#463c6e',
    'surfaces.transcript-border': '#463c6e',
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
    'people.external': '#aaa1be',
    'visuals.table-style': 'gradient',
    'visuals.table-background': '#242038',
    'visuals.table-background-end': '#15141a',
    'visuals.table-toolbar': '#242038',
    'visuals.table-header': '#312a50',
    'visuals.table-border': '#2f2a47',
    'visuals.table-hover': '#201a2c',
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
    'effects.background-style': 'none',
    'effects.panel-style': 'stars-and-smoke',
    'effects.side-window-style': 'background',
    'effects.side-window-opacity': 0.55,
    'effects.intensity': 1.5,
    'effects.speed': 0.75
  })
}

const STRATA_VIVID_LIGHT: StockTheme = {
  name: 'Strata Light',
  // Promoted from the owner's saved theme on 2026-09-07.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#ece6fa',
    'surfaces.panel': '#fbfaff',
    'surfaces.transcript-style': 'open',
    'surfaces.transcript-shadow-style': 'none',
    'surfaces.transcript-shadow-strength': 1,
    'surfaces.transcript-shadow': '#000000',
    'surfaces.transcript': '#fbfaff',
    'surfaces.inset': '#ebe4fb',
    'surfaces.user-message': '#ebe4fb',
    'surfaces.tool-call': '#f3eefe',
    'surfaces.field': '#f3eefe',
    'surfaces.code': '#f3eefe',
    'surfaces.border': '#cdbfea',
    'surfaces.transcript-border': '#cdbfea',
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
    'controls.primary-highlight': '#bc2058',
    'controls.selected': '#7a3ff0',
    'controls.positive': '#116e3c',
    'controls.warning': '#885200',
    'controls.danger': '#bc2058',
    'controls.focus': '#2f6fe0',
    'changes.added': '#6a3fd8',
    'changes.removed': '#d6316a',
    'people.you': '#a51245',
    'people.agent-1': '#7a3ff0',
    'people.agent-2': '#2f6fe0',
    'people.agent-3': '#116e3c',
    'people.agent-4': '#885200',
    'people.external': '#554871',
    'visuals.table-style': 'gradient',
    'visuals.table-background': '#f2eefd',
    'visuals.table-background-end': '#fbfaff',
    'visuals.table-toolbar': '#f2eefd',
    'visuals.table-header': '#ebe4fb',
    'visuals.table-border': '#e2daf4',
    'visuals.table-hover': '#f1ebfe',
    'visuals.category-1': '#7a3ff0',
    'visuals.category-2': '#2f6fe0',
    'visuals.category-3': '#bc2058',
    'visuals.category-4': '#885200',
    'visuals.category-5': '#116e3c',
    'visuals.category-6': '#006aa6',
    'effects.primary': '#9b5cff',
    'effects.secondary': '#4f8dff',
    'effects.tertiary': '#ff5c8a',
    'effects.detail-1': '#ffb03a',
    'effects.detail-2': '#3dc97c',
    'effects.background-style': 'none',
    'effects.panel-style': 'dense-stars',
    'effects.side-window-style': 'glass',
    'effects.side-window-opacity': 0,
    'effects.intensity': 2,
    'effects.speed': 1.4
  })
}

const STRATA_NIGHT: StockTheme = {
  name: 'Strata',
  // Promoted from the owner's saved theme on 2026-09-07.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#000000',
    'surfaces.panel': '#0d0d0d',
    'surfaces.transcript-style': 'panel',
    'surfaces.transcript-shadow-style': 'drop-shadow',
    'surfaces.transcript-shadow-strength': 1,
    'surfaces.transcript-shadow': '#2e2e2e',
    'surfaces.transcript': '#080808',
    'surfaces.inset': '#405b77',
    'surfaces.user-message': '#242638',
    'surfaces.tool-call': '#090c09',
    'surfaces.field': '#0d0d0d',
    'surfaces.code': '#0d0e13',
    'surfaces.border': '#525252',
    'surfaces.transcript-border': '#262626',
    'surfaces.overlay': '#eceef5',
    'interface.primary': '#f2f3f7',
    'interface.body': '#d3d6df',
    'interface.secondary': '#dbdce1',
    'interface.muted': '#8a8f9e',
    'document.body': '#ededed',
    'document.headings': '#c9b3ff',
    'document.small-headings': '#8fd0ff',
    'document.bold': '#ffcb7b',
    'document.italic': '#f2a0ae',
    'document.code': '#8fe3a9',
    'document.link': '#5cd6c2',
    'document.quote': '#98a3c7',
    'document.table-heading': '#dfc7ff',
    'controls.primary': '#80e5d9',
    'controls.primary-highlight': '#b7a6e8',
    'controls.selected': '#5560a8',
    'controls.positive': '#4cbd8a',
    'controls.warning': '#e0aa4e',
    'controls.danger': '#e07082',
    'controls.focus': '#7aa7ff',
    'changes.added': '#715cc7',
    'changes.removed': '#f56d47',
    'people.you': '#e58aa8',
    'people.agent-1': '#a98cf0',
    'people.agent-2': '#7fb0f5',
    'people.agent-3': '#62c99a',
    'people.agent-4': '#e6b45e',
    'people.external': '#9fa6b6',
    'visuals.table-style': 'gradient',
    'visuals.table-background': '#27353a',
    'visuals.table-background-end': '#1f3951',
    'visuals.table-toolbar': '#000000',
    'visuals.table-header': '#42687b',
    'visuals.table-border': '#bdbdbd',
    'visuals.table-hover': '#201a2c',
    'visuals.category-1': '#a98cf0',
    'visuals.category-2': '#5fc9d9',
    'visuals.category-3': '#e6b45e',
    'visuals.category-4': '#62c99a',
    'visuals.category-5': '#f08a6e',
    'visuals.category-6': '#7fb0f5',
    'effects.primary': '#ffa8d2',
    'effects.secondary': '#6fc6ff',
    'effects.tertiary': '#e2bdff',
    'effects.detail-1': '#ffd27a',
    'effects.detail-2': '#5dbb8c',
    'effects.background-style': 'none',
    'effects.panel-style': 'stars-and-smoke',
    'effects.side-window-style': 'background',
    'effects.side-window-opacity': 0.85,
    'effects.intensity': 1,
    'effects.speed': 0.45
  })
}

const STRATA_DAY: StockTheme = {
  name: 'Strata Mono',
  // An easy light mode: warm off-white surfaces with no pure white, dark grey
  // interface text, and deep ink colors that keep every document text kind
  // distinct without glare. Controls are muted indigo; a slow aurora drifts
  // behind the app and the panels stay still.
  values: Object.freeze({
    'fonts.text': 'Baloo 2',
    'fonts.code': 'JetBrains Mono',
    'surfaces.window': '#dedbd3',
    'surfaces.panel': '#f1eee7',
    'surfaces.transcript-style': 'panel',
    'surfaces.transcript-shadow-style': 'none',
    'surfaces.transcript-shadow-strength': 1,
    'surfaces.transcript-shadow': '#000000',
    'surfaces.transcript': '#f1eee7',
    'surfaces.inset': '#e5e1d8',
    'surfaces.user-message': '#e5e1d8',
    'surfaces.tool-call': '#e7e3da',
    'surfaces.field': '#e8e4db',
    'surfaces.code': '#e7e3da',
    'surfaces.border': '#bab5aa',
    'surfaces.transcript-border': '#bab5aa',
    'surfaces.overlay': '#2e2b33',
    'interface.primary': '#26232b',
    'interface.body': '#3d3a44',
    'interface.secondary': '#5c5864',
    'interface.muted': '#605c68',
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
    'controls.primary-highlight': '#624da3',
    'controls.selected': '#6268b2',
    'controls.positive': '#176744',
    'controls.warning': '#805009',
    'controls.danger': '#a83a50',
    'controls.focus': '#285fb5',
    'changes.added': '#1b7580',
    'changes.removed': '#b4533d',
    'people.you': '#8f2652',
    'people.agent-1': '#6a48b8',
    'people.agent-2': '#2c66b3',
    'people.agent-3': '#237a53',
    'people.agent-4': '#9a6210',
    'people.external': '#514b58',
    'visuals.table-style': 'gradient',
    'visuals.table-background': '#eae7df',
    'visuals.table-background-end': '#f1eee7',
    'visuals.table-toolbar': '#eae7df',
    'visuals.table-header': '#e5e1d8',
    'visuals.table-border': '#d3cfc6',
    'visuals.table-hover': '#e5e3e1',
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
    'effects.side-window-style': 'animation',
    'effects.side-window-opacity': 0.55,
    'effects.intensity': 1,
    'effects.speed': 0.7
  })
}

/** All four stock themes, with the default Strata first; IDs stay stable for saved selections. */
export const STOCK_THEMES: ReadonlyMap<string, StockTheme> = new Map([
  ['strata-night', STRATA_NIGHT],
  ['strata-vivid', STRATA_VIVID],
  ['strata-vivid-light', STRATA_VIVID_LIGHT],
  ['strata-day', STRATA_DAY]
])

/** Strata owns fresh-install selection and every missing-value fallback. */
export const DEFAULT_THEME_ID = 'strata-night'
export const DEFAULT_THEME_NAME = STRATA_NIGHT.name
export const DEFAULT_THEME_VALUES: ThemeValues = STRATA_NIGHT.values

/** Nests flat dotted keys into the on-disk file shape `{ group: { name } }`. */
export function nestThemeValues(name: string, values: ThemeValues): SparseTheme {
  const nested: Record<string, Record<string, string | number>> = {}
  for (const [key, value] of Object.entries(values)) {
    const [group, rest] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
    ;(nested[group] ??= {})[rest] = value
  }
  return Object.freeze({ name, ...nested })
}

/** The alternate stock themes beyond the built-in Strata, in their file shape. */
export const BUNDLED_THEMES: ReadonlyMap<string, SparseTheme> = new Map(
  [...STOCK_THEMES].filter(([id]) => id !== DEFAULT_THEME_ID).map(([id, theme]) => [id, nestThemeValues(theme.name, theme.values)])
)

export const BUNDLED_THEME_IDS: readonly string[] = [...BUNDLED_THEMES.keys()]
