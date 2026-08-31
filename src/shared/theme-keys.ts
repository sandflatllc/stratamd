// The one table behind themes (PRD §6.13, docs/plans/completed/theme-restructure-plan.md). The
// theme panel renders one row per entry, the renderer maps each entry to a CSS
// variable, and `stratamd theme` prints each key with its description. The
// table owns labels, descriptions, kinds, grouping, ranges, and highlight
// metadata; the values themselves live in the stock definitions in
// bundled-themes.ts, with Strata as the runtime default.

import { DEFAULT_THEME_VALUES } from './bundled-themes'

export { DEFAULT_THEME_VALUES }

export const THEME_GROUPS = ['fonts', 'surfaces', 'interface', 'document', 'controls', 'changes', 'people', 'effects'] as const
export type ThemeGroup = (typeof THEME_GROUPS)[number]

export const AMBIENT_STYLES = [
  { id: 'rising-motes', label: 'Rising motes' },
  { id: 'aurora-drift', label: 'Aurora drift' },
  { id: 'starfield', label: 'Starfield' },
  { id: 'grid-drift', label: 'Grid drift' },
  { id: 'glow-orbs', label: 'Glow orbs' },
  { id: 'shimmer-sweep', label: 'Shimmer sweep' },
  { id: 'breathing-tint', label: 'Breathing tint' },
  { id: 'none', label: 'None' }
] as const
export type AmbientStyle = (typeof AMBIENT_STYLES)[number]['id']

/** User theme files written from now on carry this marker. */
export const THEME_SCHEMA_VERSION = 2

export type ThemeKind = 'color' | 'font' | 'style' | 'range'

export interface ThemeKeyEntry {
  /** Dotted key: `<group>.<name>`. The file nests it as `{ group: { name } }`. */
  readonly key: string
  readonly group: ThemeGroup
  readonly variable: string
  readonly label: string
  readonly description: string
  readonly kind: ThemeKind
  /** Which element(s) light up when the row is hovered. */
  readonly sample?: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

const color = (key: string, label: string, description: string): ThemeKeyEntry => ({
  key,
  group: key.split('.')[0] as ThemeGroup,
  variable: `--${key.replace('.', '-')}`,
  label,
  description,
  kind: 'color',
  sample: key.replace('.', '-')
})

export const THEME_KEYS: readonly ThemeKeyEntry[] = Object.freeze([
  { key: 'fonts.text', group: 'fonts', variable: '--font-text', label: 'App and document font', description: 'Prose and every label in the app', kind: 'font', sample: 'fonts-text' },
  { key: 'fonts.code', group: 'fonts', variable: '--font-code', label: 'Code and keyboard font', description: 'Code, source view, and keyboard hints', kind: 'font', sample: 'fonts-code' },

  color('surfaces.window', 'Window background', 'The window itself, behind all panels'),
  color('surfaces.panel', 'Panel background', 'Explorer, editor, right rail, dialogs, theme panel, thread panel, and ordinary menus'),
  color('surfaces.inset', 'Inset and hover background', 'Hovered rows, chips, table header cells, notices, and nested panel areas'),
  color('surfaces.field', 'Text field background', 'Annotation, reply, send, rename, and other text-entry fields'),
  color('surfaces.code', 'Code and preview background', 'Boxes behind code, source previews, image placeholders, and delivery previews'),
  color('surfaces.border', 'Borders and rules', 'Panel borders, input borders, dividers, tables, scrollbars, and horizontal rules'),
  color('surfaces.overlay', 'Popover and toast background', 'The selection menu, active tab, and toasts; their text color is chosen automatically'),

  color('interface.primary', 'Titles and active labels', 'Panel headings, active labels, menu text, and other prominent app text'),
  color('interface.body', 'Interface body text', 'Dialog paragraphs, change rows, annotation text, replies, and theme-row labels'),
  color('interface.secondary', 'Secondary interface text', 'Inactive tabs, file rows, toolbar icons, quiet controls, and supporting labels'),
  color('interface.muted', 'Fine print and timestamps', 'Timestamps, keyboard hints, default marks, and other fine print'),

  color('document.body', 'Paragraph text', 'Paragraphs, list items, and ordinary table cells in the document'),
  color('document.headings', 'Main headings', 'Lines starting with # or ## in the document'),
  color('document.small-headings', 'Smaller headings', 'Lines starting with ### or more in the document'),
  color('document.bold', 'Bold text', 'Text wrapped in ** ** in the document'),
  color('document.italic', 'Italic text', 'Text wrapped in * * in the document'),
  color('document.code', 'Code text', 'Text inside `backticks`, code blocks, and the source view'),
  color('document.link', 'Links', 'Link text in the document'),
  color('document.quote', 'Quotes and list markers', 'Block quotes, bullet markers, and list numbers'),
  color('document.table-heading', 'Table heading text', 'Header cells in document tables'),

  color('controls.primary', 'Primary actions', 'Main buttons, add and reply controls, sliders, resizers, and toolbar hovers'),
  color('controls.primary-highlight', 'Primary action highlight', 'The second color and glow on prominent buttons like Send and Copy'),
  color('controls.selected', 'Selected text and active items', 'Text selection, active files, counts, chosen recipients, and the Lead crown'),
  color('controls.positive', 'Accept, keep, and save', 'Accept, keep, resolve, and complete actions, the Save button, and the file-drop target'),
  color('controls.warning', 'Warnings and pending', 'Warnings, questions, waiting agents, unsaved marks, and theme problems'),
  color('controls.danger', 'Delete, reject, and discard', 'Delete, reject, discard, and close controls, and danger notices'),
  color('controls.focus', 'Keyboard focus ring', 'The outline around whatever the keyboard has focused'),

  color('changes.added', 'Added and replacement text', 'Added text, suggested replacements, and added lines in change rows'),
  color('changes.removed', 'Removed text', 'Removed text, rejected text, and removed lines in change rows'),

  color('people.you', 'Your changes', 'Your annotations and your edits'),
  color('people.agent-1', 'First attached agent', 'The first attached agent'),
  color('people.agent-2', 'Second attached agent', 'The second attached agent'),
  color('people.agent-3', 'Third attached agent', 'The third attached agent'),
  color('people.agent-4', 'Fourth attached agent', 'The fourth attached agent; later agents repeat from the first'),
  color('people.external', 'Outside changes', 'Edits made outside StrataMD, and annotations whose text was removed'),

  color('effects.primary', 'Main effect color', 'The page glow, grids, shimmers, breathing tints, the biggest glows, and some motes and stars'),
  color('effects.secondary', 'Supporting effect color', 'The second aurora band, a supporting glow, and some motes and stars'),
  color('effects.tertiary', 'Third effect color', 'The third aurora band, a third glow, and some motes and stars'),
  color('effects.detail-1', 'Small effect color 1', 'One set of small motes and stars'),
  color('effects.detail-2', 'Small effect color 2', 'A second set of small motes and stars, and the small explorer glow'),

  { key: 'effects.background-style', group: 'effects', variable: '--effects-background-style', label: 'Effect behind the app', description: `Animation behind the whole app: ${AMBIENT_STYLES.map((style) => style.id).join(', ')}`, kind: 'style', sample: 'effects-background' },
  { key: 'effects.panel-style', group: 'effects', variable: '--effects-panel-style', label: 'Effect inside panels', description: `Animation inside each panel: ${AMBIENT_STYLES.map((style) => style.id).join(', ')}`, kind: 'style', sample: 'effects-panels' },
  { key: 'effects.intensity', group: 'effects', variable: '--effects-intensity', label: 'Effect visibility', description: 'How visible the effects are, 0 to 2', kind: 'range', min: 0, max: 2, step: 0.05, sample: 'effects-background' },
  { key: 'effects.speed', group: 'effects', variable: '--effects-speed', label: 'Effect speed', description: 'How fast the effects move, 0.25 to 2', kind: 'range', min: 0.25, max: 2, step: 0.05, sample: 'effects-background' }
])

export type ThemeKey = (typeof THEME_KEYS)[number]['key']
export type ThemeValues = Readonly<Record<string, string | number>>

export const THEME_KEY_BY_NAME: ReadonlyMap<string, ThemeKeyEntry> = new Map(THEME_KEYS.map((entry) => [entry.key, entry]))

export const BUILT_IN_THEME_ID = 'strata'
export const BUILT_IN_THEME_NAME = 'Strata'
export const BUNDLED_FONTS = ['Baloo 2', 'JetBrains Mono'] as const

export interface ThemeProblem {
  readonly key: string
  readonly reason: string
}

/** The file as written: nested groups, only the keys its authors set, unknown keys kept. */
export type SparseTheme = Readonly<Record<string, unknown>>

const HEX = /^#[0-9a-f]{6}$/i
const SHORT_HEX = /^#[0-9a-f]{3}$/i

export function normalizeThemeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (HEX.test(trimmed)) return trimmed.toLowerCase()
  if (SHORT_HEX.test(trimmed)) return `#${[...trimmed.slice(1)].map((digit) => digit + digit).join('')}`.toLowerCase()
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readSparseValue(sparse: SparseTheme, key: string): unknown {
  const dot = key.indexOf('.')
  const section = sparse[key.slice(0, dot)]
  return isRecord(section) ? section[key.slice(dot + 1)] : undefined
}

/** Returns a copy of `sparse` with `key` set, or removed when `value` is null. Empty groups are dropped. */
export function writeSparseValue(sparse: SparseTheme, key: string, value: string | number | null): SparseTheme {
  const dot = key.indexOf('.')
  const [group, name] = [key.slice(0, dot), key.slice(dot + 1)]
  const section = isRecord(sparse[group]) ? { ...(sparse[group] as Record<string, unknown>) } : {}
  if (value === null) delete section[name]
  else section[name] = value
  const next: Record<string, unknown> = { ...sparse }
  if (Object.keys(section).length === 0) delete next[group]
  else next[group] = section
  return next
}

export function normalizeThemeValue(entry: ThemeKeyEntry, value: unknown): { value: string | number; problem?: string } {
  const fallback = DEFAULT_THEME_VALUES[entry.key]!
  switch (entry.kind) {
    case 'color': {
      const normalized = normalizeThemeColor(value)
      return normalized === null ? { value: fallback, problem: 'not a color (use #rrggbb)' } : { value: normalized }
    }
    case 'font':
      return typeof value === 'string' && value.trim() ? { value: value.trim() } : { value: fallback, problem: 'not a font family name' }
    case 'style':
      return typeof value === 'string' && AMBIENT_STYLES.some((style) => style.id === value)
        ? { value }
        : { value: fallback, problem: `not one of ${AMBIENT_STYLES.map((style) => style.id).join(', ')}` }
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { value: fallback, problem: `not a number between ${entry.min} and ${entry.max}` }
      return { value: Math.min(entry.max!, Math.max(entry.min!, value)) }
    }
  }
}

export interface NormalizedTheme {
  readonly name: string
  readonly values: ThemeValues
  readonly problems: readonly ThemeProblem[]
  /** Keys present in the file, whether or not their values were valid. */
  readonly set: readonly string[]
}

/** Resolves a sparse file against the built-in values. Pure. */
export function normalizeTheme(sparse: SparseTheme, fallbackName = 'Untitled'): NormalizedTheme {
  const values: Record<string, string | number> = {}
  const problems: ThemeProblem[] = []
  const set: string[] = []
  for (const entry of THEME_KEYS) {
    const raw = readSparseValue(sparse, entry.key)
    if (raw === undefined) {
      values[entry.key] = DEFAULT_THEME_VALUES[entry.key]!
      continue
    }
    set.push(entry.key)
    const { value, problem } = normalizeThemeValue(entry, raw)
    values[entry.key] = value
    if (problem) problems.push({ key: entry.key, reason: problem })
  }
  const name = typeof sparse.name === 'string' && sparse.name.trim() ? sparse.name.trim() : fallbackName
  if (typeof sparse.name !== 'string' || !sparse.name.trim()) problems.push({ key: 'name', reason: 'missing name' })
  return { name, values, problems, set }
}

export function slugifyThemeName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'theme'
}

function channels(hex: string): [number, number, number] {
  return [0, 1, 2].map((index) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)) as [number, number, number]
}

/** `weight` of `a` mixed into `b`, like CSS color-mix in srgb. */
export function mixHex(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  const mix = (x: number, y: number) => Math.round(x * weight + y * (1 - weight)).toString(16).padStart(2, '0')
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`
}

/** Chooses black or white text for a surface from its relative luminance. */
export function contrastingText(hex: string): string {
  const channel = (index: number) => {
    const value = channels(hex)[index]! / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
  return luminance > 0.4 ? '#241f31' : '#f4f3f6'
}
