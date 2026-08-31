import type {
  AgentIdentity,
  AnnotationView,
  AppView,
  AttachmentState,
  DocumentView,
  ExplorerFileView,
  HunkView,
  PaneZoom,
  PanelSizes,
  RoundHunkView,
  SaveRoundAuthorView,
  SpellingContext,
  ThemePanelGeometry,
  ThemeView
} from '../shared/contracts'
import type { CSSProperties } from 'react'
import { AMBIENT_STYLES, BUILT_IN_THEME_ID, BUILT_IN_THEME_NAME, contrastingText, DEFAULT_THEME_VALUES, mixHex, THEME_KEYS, type AmbientStyle } from '../shared/theme-keys'

export type NumericPanelKey = Exclude<keyof PanelSizes, 'themePanel' | 'threadPanel' | 'annotationComposer' | 'sendComposer'>

export const PANEL_LIMITS = {
  explorerWidth: [160, 340],
  rightRailWidth: [240, 440],
  changesHeight: [120, 520],
  annotationsHeight: [90, 420],
  documentMeasure: [620, 1600]
} as const satisfies Record<NumericPanelKey, readonly [number, number]>

export const THEME_PANEL_LIMITS = { minWidth: 300, maxWidth: 900, minHeight: 320, maxHeight: 1600 } as const

/** The floating thread panel: default about twice the old popover, never below it (PRD §6.9). */
export const THREAD_PANEL_LIMITS = { minWidth: 330, maxWidth: 1200, minHeight: 180, maxHeight: 1600 } as const
export const COMPOSER_LIMITS = { minWidth: 330, maxWidth: 900, minHeight: 160, maxHeight: 1200 } as const

export const EMPTY_VIEW: AppView = {
  tabs: [],
  activeDocument: null,
  explorer: [],
  settings: {
    animatedBackground: true,
    attachmentIdleHours: 24,
    panelSizes: {
      explorerWidth: 212,
      rightRailWidth: 300,
      changesHeight: 250,
      annotationsHeight: 180,
      documentMeasure: 860,
      themePanel: { x: -1, y: -1, width: 360, height: 560 },
      threadPanel: { width: 660, height: -1 },
      annotationComposer: { width: 330, height: -1 },
      sendComposer: { width: 680, height: -1 }
    },
    zoom: { explorer: 1, editor: 1, rightRail: 1, composer: 1 },
    theme: {
      active: { id: BUILT_IN_THEME_ID, name: BUILT_IN_THEME_NAME, builtIn: true, missing: false, path: null, sparse: { name: BUILT_IN_THEME_NAME }, values: { ...DEFAULT_THEME_VALUES }, problems: [] },
      available: [{ id: BUILT_IN_THEME_ID, name: BUILT_IN_THEME_NAME, builtIn: true, broken: false, missing: false, problems: [] }],
      externalRevision: 0
    }
  }
}

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1

export function clampZoom(value: number): number {
  return Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value)) * 10) / 10
}

export function stepZoom(value: number, direction: 1 | -1): number {
  return clampZoom(value + direction * ZOOM_STEP)
}

export function isZoomed(zoom: PaneZoom): boolean {
  return Object.values(zoom).some((factor) => Math.abs(factor - 1) > 1e-9)
}

/** Attach-order slots (PRD §6.9) resolve to the active theme's `people` colors. */
export const AGENT_COLORS: Record<AgentIdentity['color'], string> = {
  grape: 'var(--people-agent-1)',
  sky: 'var(--people-agent-2)',
  mint: 'var(--people-agent-3)',
  tangerine: 'var(--people-agent-4)'
}

export const USER_ANNOTATION_COLOR = 'var(--people-you)'
export const EXTERNAL_COLOR = 'var(--people-external)'

/** The derived readable text for a filled theme color: `var(--x)` → `var(--x-text)`. */
export function textColorFor(colorVariable: string): string {
  return colorVariable.replace(')', '-text)')
}

function quotedFontFamily(font: string): string {
  return `"${font.replace(/["\\]/g, '\\$&')}"`
}

/** The keys whose filled surfaces need a derived readable text color. */
const CONTRAST_KEYS = [
  'surfaces.overlay',
  'controls.primary',
  'controls.selected',
  'controls.positive',
  'controls.warning',
  'controls.danger',
  'people.you',
  'people.agent-1',
  'people.agent-2',
  'people.agent-3',
  'people.agent-4',
  'people.external'
] as const

/**
 * Every theme value as a CSS variable on `.app-shell`, plus the derived ones
 * (PRD §6.13): a readable `-text` foreground for every filled surface and the
 * text-selection pair, computed at use time rather than stored as swatches.
 */
export function rendererThemeStyle(theme: ThemeView): CSSProperties {
  const style: Record<string, string | number> = {}
  const value = (key: string) => theme.active.values[key] ?? DEFAULT_THEME_VALUES[key]!
  for (const entry of THEME_KEYS) {
    style[entry.variable] = entry.kind === 'font' ? quotedFontFamily(String(value(entry.key))) : value(entry.key)
  }
  for (const key of CONTRAST_KEYS) style[`--${key.replace('.', '-')}-text`] = contrastingText(String(value(key)))
  const selection = mixHex(String(value('controls.selected')), String(value('surfaces.panel')), 0.55)
  style['--selection-background'] = selection
  style['--selection-text'] = contrastingText(selection)
  return style as CSSProperties
}

function ambientStyle(value: unknown, fallback: AmbientStyle): AmbientStyle {
  return AMBIENT_STYLES.some((style) => style.id === value) ? (value as AmbientStyle) : fallback
}

export function ambientStyles(theme: ThemeView): { background: AmbientStyle; windows: AmbientStyle } {
  return {
    background: ambientStyle(theme.active.values['effects.background-style'], 'rising-motes'),
    windows: ambientStyle(theme.active.values['effects.panel-style'], 'glow-orbs')
  }
}

export function clampThemePanel(geometry: ThemePanelGeometry, viewport: { width: number; height: number }): ThemePanelGeometry {
  const width = Math.round(Math.max(THEME_PANEL_LIMITS.minWidth, Math.min(THEME_PANEL_LIMITS.maxWidth, geometry.width, viewport.width - 16)))
  const height = Math.round(Math.max(THEME_PANEL_LIMITS.minHeight, Math.min(THEME_PANEL_LIMITS.maxHeight, geometry.height, viewport.height - 16)))
  const defaultX = viewport.width - width - 26
  const defaultY = viewport.height - height - 24
  const x = Math.round(Math.max(8, Math.min(viewport.width - width - 8, geometry.x < 0 ? defaultX : geometry.x)))
  const y = Math.round(Math.max(8, Math.min(viewport.height - height - 8, geometry.y < 0 ? defaultY : geometry.y)))
  return { x, y, width, height }
}

export function clampPanelSize(key: NumericPanelKey, value: number): number {
  const [min, max] = PANEL_LIMITS[key]
  return Math.max(min, Math.min(max, Math.round(value)))
}

// ---- Review-board copy (PRD §6.9): plain everyday words everywhere users read.

export function hunkAuthor(hunk: HunkView): string {
  return hunk.author?.name ?? 'someone else'
}

export type HunkAction = 'adds' | 'removes' | 'changes'

export function hunkAction(hunk: HunkView | RoundHunkView): HunkAction {
  if (hunk.oldLines === 0) return 'adds'
  if (hunk.newLines === 0) return 'removes'
  return 'changes'
}

export interface SnippetLine {
  kind: 'removed' | 'added'
  text: string
}

function firstMeaningfulLines(lines: readonly string[]): string[] {
  const meaningful = lines.filter((line) => line.trim().length > 0)
  return (meaningful.length > 0 ? meaningful : [...lines]).slice(0, 2)
}

/** At most two lines of the affected text; the full diff is read in the document. */
export function hunkSnippet(hunk: HunkView | RoundHunkView): SnippetLine[] {
  if (hunk.removed.length === 0) return firstMeaningfulLines(hunk.added).map((text) => ({ kind: 'added' as const, text }))
  if (hunk.added.length === 0) return firstMeaningfulLines(hunk.removed).map((text) => ({ kind: 'removed' as const, text }))
  return [
    { kind: 'removed', text: firstMeaningfulLines(hunk.removed)[0] ?? '' },
    { kind: 'added', text: firstMeaningfulLines(hunk.added)[0] ?? '' },
  ]
}

/** The file detail lives in a tooltip, never in the row. */
export function hunkSourceTooltip(hunk: HunkView): string {
  return hunk.source === 'buffer' ? 'A change to the copy in the editor' : 'A change to the saved file'
}

export function attachmentStateLabel(state: AttachmentState): string {
  if (state === 'waiting') return 'waiting for changes'
  if (state === 'pending') return 'has an update waiting'
  return 'working'
}

export function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return 'moments ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'a day ago' : `${days} days ago`
}

export function attachedAgo(attachedAt: number, now = Date.now()): string {
  return `attached ${timeAgo(now - attachedAt)}`
}

export function absoluteTime(time: number): string {
  return new Date(time).toLocaleString()
}

/** The rail footer: whether the editor matches the saved file is always visible. */
export function saveStateSentence(dirty: boolean, lastSavedAt: number | null, now = Date.now()): string {
  const ago = lastSavedAt === null ? null : timeAgo(now - lastSavedAt)
  if (dirty) return ago === null ? 'Unsaved changes' : `Unsaved changes · last saved ${ago}`
  return ago === null ? 'Everything saved' : `Everything saved · ${ago}`
}

/** History rows (PRD §6.7): the newest save is "Last save", older ones show their time. */
export function saveRoundLabel(index: number, count: number, time: number): string {
  return index === count - 1 ? 'Last save' : `Saved ${absoluteTime(time)}`
}

/** "you and Claude" — the round's active contributors in plain words. */
export function saveRoundAuthors(authors: readonly SaveRoundAuthorView[]): string {
  const names = authors.map((author) =>
    author.user ? 'you' : author.name === 'external' ? 'someone else' : author.name,
  )
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}

export interface ChangeGroups {
  /** Open suggestions: not in the text until accepted. */
  proposed: AnnotationView[]
  /** Applied in the editor; lands on the next save. */
  unsaved: HunkView[]
  /** Already in the file, awaiting review. */
  saved: HunkView[]
}

export function changeGroups(document: DocumentView): ChangeGroups {
  return {
    proposed: document.annotations.filter((annotation) => annotation.kind === 'suggestion' && annotation.status === 'open'),
    unsaved: document.pendingHunks.filter((hunk) => !hunk.saved),
    saved: document.pendingHunks.filter((hunk) => hunk.saved),
  }
}

/** Tints the top-bar total while any counted change is unsaved. */
export function hasUnsavedCounted(document: DocumentView): boolean {
  return document.pendingHunks.some((hunk) => !hunk.saved)
}

export function annotationCounts(document: DocumentView): { open: number; removedText: number } {
  return {
    open: document.annotations.filter((annotation) => annotation.status === 'open').length,
    removedText: document.annotations.filter((annotation) => annotation.status === 'orphaned').length,
  }
}

export function activeAnnotations(document: DocumentView): AnnotationView[] {
  return document.annotations.filter((annotation) => annotation.status !== 'resolved')
}

export function currentAnnotation(document: DocumentView, selected: AnnotationView | null): AnnotationView | null {
  if (!selected) return null
  return document.annotations.find((annotation) => annotation.id === selected.id) ?? null
}

/**
 * The spelling column shows only when the selection is exactly the forwarded
 * misspelled word (docs/plans/completed/spellcheck-plan.md). The exact match hides the column
 * for section highlights and makes a payload from an earlier right-click
 * harmless: it can never attach to a different word.
 */
export function spellingForSelection(
  spelling: SpellingContext | null,
  selection: { quote: string } | null
): SpellingContext | null {
  if (!spelling || !selection || spelling.word !== selection.quote) return null
  return spelling
}

export function previewTabIndex(current: number, count: number, key: string): number | null {
  if (count === 0) return null
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  if (key === 'ArrowRight') return (current + 1) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function hasResolvedAnnotations(document: DocumentView): boolean {
  return document.annotations.some((annotation) => annotation.status === 'resolved')
}

export function pendingCount(document: DocumentView | null): number {
  if (!document) return 0
  return document.pendingHunks.length + document.annotations.filter((annotation) => annotation.kind === 'suggestion' && annotation.status === 'open').length
}

export function bannerFor(document: DocumentView): { tone: 'warning' | 'danger'; text: string } | null {
  if (document.invalidUtf8) return { tone: 'danger', text: 'Invalid UTF-8. Opened read-only in source view.' }
  if (document.deleted) return { tone: 'warning', text: `${document.path.split('/').pop() ?? 'This file'} was deleted. The tab stays open; Save will recreate it.` }
  return null
}

export interface ExplorerTreeNode {
  name: string
  path: string
  folders: ExplorerTreeNode[]
  files: ExplorerFileView[]
}

/**
 * Groups a root's files by the subfolders they sit in on disk, so the explorer
 * mirrors the directory layout instead of flattening every file into one list.
 * Folders sort before files; both sort by name.
 */
export function explorerTree(root: { path: string; name: string; files: ExplorerFileView[] }): ExplorerTreeNode {
  const tree: ExplorerTreeNode = { name: root.name, path: root.path, folders: [], files: [] }
  for (const file of root.files) {
    const parts = file.relativePath.split('/')
    let node = tree
    for (const part of parts.slice(0, -1)) {
      let child = node.folders.find((folder) => folder.name === part)
      if (child === undefined) {
        child = { name: part, path: `${node.path}/${part}`, folders: [], files: [] }
        node.folders.push(child)
      }
      node = child
    }
    node.files.push(file)
  }
  const sort = (node: ExplorerTreeNode): void => {
    node.folders.sort((left, right) => left.name.localeCompare(right.name))
    node.files.sort((left, right) => left.name.localeCompare(right.name))
    node.folders.forEach(sort)
  }
  sort(tree)
  return tree
}
