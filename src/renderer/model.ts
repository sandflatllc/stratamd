import type {
  AgentIdentity,
  AnnotationView,
  AppView,
  AttachmentState,
  AttachmentView,
  DocumentTabView,
  DocumentView,
  ExplorerFileView,
  HunkView,
  PaneZoom,
  PanelSizes,
  RoundHunkView,
  SaveRoundAuthorView,
  SpellingContext,
  ThemePanelGeometry,
  ThemeView,
  DocumentProblem,
} from '../shared/contracts'
import type { CSSProperties } from 'react'
import { sameJson } from '../shared/view-sync'
import { AMBIENT_STYLES, BUILT_IN_THEME_ID, BUILT_IN_THEME_NAME, contrastingText, DEFAULT_THEME_VALUES, mixHex, THEME_KEYS, type AmbientStyle } from '../shared/theme-keys'

export type NumericPanelKey = Exclude<keyof PanelSizes, 'themePanel' | 'threadPanel' | 'annotationComposer' | 'sendComposer'>

/** Side windows have a floor but no ceiling: the owner decides how wide they get (decided 2026-09-02). */
export const SIDE_WINDOW_MAX = 20_000

export const PANEL_LIMITS = {
  explorerWidth: [160, SIDE_WINDOW_MAX],
  rightRailWidth: [240, SIDE_WINDOW_MAX],
  upperReviewHeight: [180, 954],
  documentMeasure: [620, 1600]
} as const satisfies Record<NumericPanelKey, readonly [number, number]>

export const THEME_PANEL_LIMITS = { minWidth: 300, maxWidth: 900, minHeight: 320, maxHeight: 1600 } as const

/** The left window's width while the Thread tab is selected: never below the old popover's 330px (PRD §6.9). */
export const THREAD_PANEL_LIMITS = { minWidth: 330, maxWidth: SIDE_WINDOW_MAX } as const

/** The editor never drops below this width because a side window grew; the side window yields instead. */
export const EDITOR_FLOOR = 240
/** Shell padding and the two drag handles either side of the editor. */
const SIDE_CHROME = 88

/**
 * The widest a side window may be right now: whatever leaves the other side
 * window, the handles, and an editor at least EDITOR_FLOOR wide on screen.
 * There is no fixed ceiling; the window itself is the only limit. The floor
 * wins over the editor when the window is too narrow for both.
 */
export function sideWindowCeiling(minimum: number, windowWidth: number, otherSide: number): number {
  return Math.max(minimum, windowWidth - SIDE_CHROME - otherSide - EDITOR_FLOOR)
}

/**
 * The left window carries two widths: one for Files and Contents, one for the
 * Thread tab, so navigation can stay narrow while a conversation gets room.
 * The stored width is what the owner chose; what shows is that width clamped
 * to the window so the editor never collapses.
 */
export function leftWindowWidth(sizes: PanelSizes, threadShown: boolean, windowWidth: number): number {
  const minimum = threadShown ? THREAD_PANEL_LIMITS.minWidth : PANEL_LIMITS.explorerWidth[0]
  const preferred = threadShown ? sizes.threadPanel.width : sizes.explorerWidth
  return Math.min(Math.max(minimum, preferred), sideWindowCeiling(minimum, windowWidth, sizes.rightRailWidth))
}
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
      upperReviewHeight: 444,
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

/** The compact form for rail rows: "just now", "3 min ago", "2 h ago", "yesterday". */
export function timeAgoShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** An agent that has not called in for this long while "working" is not listening. */
export const NOT_LISTENING_AFTER_MS = 10 * 60_000

/**
 * The attachment row's state line: the state, then when the agent last called
 * in. A working agent that has gone quiet reads as not listening instead, so
 * the row does not promise attention the agent is not paying.
 */
export function attachmentStatusLine(
  attachment: Pick<AttachmentView, 'state' | 'lastCallAt' | 'queuedSendCount'>,
  now = Date.now(),
): string {
  const { state, lastCallAt, queuedSendCount } = attachment
  const quiet = state === 'working' && lastCallAt !== null && now - lastCallAt > NOT_LISTENING_AFTER_MS
  const parts = [quiet ? 'not listening' : attachmentStateLabel(state)]
  if (lastCallAt !== null) parts.push(`last heard ${timeAgoShort(now - lastCallAt)}`)
  if (queuedSendCount > 0) parts.push(`${queuedSendCount} update${queuedSendCount === 1 ? '' : 's'} waiting for it`)
  return parts.join(' · ')
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

export type AnnotationFilter = 'all' | 'decisions' | 'questions' | 'comments' | 'suggestions' | 'resolved'

export function filteredAnnotations(document: DocumentView, filter: AnnotationFilter): AnnotationView[] {
  if (filter === 'resolved') return document.annotations.filter((annotation) => annotation.status === 'resolved')
  const open = document.annotations.filter((annotation) => annotation.status !== 'resolved')
  if (filter === 'all') return open
  const kinds: Record<Exclude<AnnotationFilter, 'all' | 'resolved'>, AnnotationView['kind']> = {
    decisions: 'decision',
    questions: 'question',
    comments: 'comment',
    suggestions: 'suggestion',
  }
  return open.filter((annotation) => annotation.kind === kinds[filter])
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

/** The tab to show after cycling from the active one; null when there is nothing to cycle to. */
export function cycleTab(tabs: readonly DocumentTabView[], direction: 1 | -1): DocumentTabView | null {
  if (tabs.length < 2) return null
  const active = Math.max(0, tabs.findIndex((tab) => tab.active))
  return tabs[(active + direction + tabs.length) % tabs.length] ?? null
}

export interface ReviewTarget {
  kind: 'hunk' | 'suggestion' | 'thread'
  id: string
  line: number
}

/** Open comments and questions in document order, for F8 / Shift+F8 (§5.12). */
export function threadTargets(document: DocumentView): ReviewTarget[] {
  return document.annotations
    .filter((annotation) => annotation.kind !== 'suggestion' && annotation.status === 'open' && annotation.line !== null)
    .map((annotation): ReviewTarget => ({ kind: 'thread', id: annotation.id, line: annotation.line! }))
    .sort((left, right) => left.line - right.line)
}

/** Pending hunks and open suggestions in document order (PRD §6.1 next/previous change). */
export function reviewTargets(document: DocumentView): ReviewTarget[] {
  const hunks = document.pendingHunks.map((hunk): ReviewTarget => ({ kind: 'hunk', id: hunk.id, line: hunk.newStart }))
  const suggestions = document.annotations
    .filter((annotation) => annotation.kind === 'suggestion' && annotation.status === 'open' && annotation.line !== null)
    .map((annotation): ReviewTarget => ({ kind: 'suggestion', id: annotation.id, line: annotation.line! }))
  return [...hunks, ...suggestions].sort((left, right) => left.line - right.line || (left.kind === right.kind ? 0 : left.kind === 'hunk' ? -1 : 1))
}

/** The target after (or before) `currentId`, wrapping; the first (or last) when the current one is gone. */
export function nextReviewTarget(targets: readonly ReviewTarget[], currentId: string | null, direction: 1 | -1): ReviewTarget | null {
  if (targets.length === 0) return null
  const index = currentId === null ? -1 : targets.findIndex((target) => target.id === currentId)
  if (index < 0) return (direction === 1 ? targets[0] : targets.at(-1)) ?? null
  return targets[(index + direction + targets.length) % targets.length] ?? null
}

/** Pending hunks grouped by author, for the per-author bulk revert row; only authors with more than one. */
export function bulkRevertGroups(document: DocumentView): Array<{ key: string; name: string; author: AgentIdentity | null; hunks: HunkView[] }> {
  const groups = new Map<string, { key: string; name: string; author: AgentIdentity | null; hunks: HunkView[] }>()
  for (const hunk of document.pendingHunks) {
    const key = hunk.author?.id ?? 'external'
    const group = groups.get(key) ?? { key, name: hunkAuthor(hunk), author: hunk.author, hunks: [] }
    group.hunks.push(hunk)
    groups.set(key, group)
  }
  return [...groups.values()].filter((group) => group.hunks.length > 1)
}

/** What a new user pastes to an agent so it attaches to the open document. */
export const AGENT_PROMPT = 'Attach to the document I have open in StrataMD: run `stratamd --agent-help` to learn how it works, then `stratamd attach --name "<your name>"` and follow what it returns.'

/** A quiet relative time for a thread entry; empty when the record carries no time. */
export function threadTime(time: number | undefined, now = Date.now()): string {
  return time === undefined || time <= 0 ? '' : timeAgo(now - time)
}

export function pendingCount(document: DocumentView | null): number {
  if (!document) return 0
  return document.pendingHunks.length + document.annotations.filter((annotation) => annotation.kind === 'suggestion' && annotation.status === 'open').length
}

export function bannerFor(document: DocumentView): { tone: 'warning' | 'danger'; text: string } | null {
  if (document.invalidUtf8) return { tone: 'danger', text: 'Invalid UTF-8. Opened read-only in source view.' }
  if (document.deleted) return { tone: 'warning', text: `${document.path.split('/').pop() ?? 'This file'} was deleted. The tab stays open; Save will recreate it.` }
  const problem = document.problems[0]
  if (problem) return { tone: 'warning', text: PROBLEM_COPY[problem] }
  return null
}

/** Plain-language copy for background failures (PRD §6.10); one sentence on what stopped and what it means. */
const PROBLEM_COPY: Record<DocumentProblem, string> = {
  mirror: "StrataMD can't update the copy agents read. Agents may be seeing an older version of this document.",
  watch: "StrataMD can't watch this file for changes made outside it. Edits made elsewhere won't show until you reopen it.",
  persist: "StrataMD can't save its review notes for this document. Pending changes and annotations may not survive closing it.",
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

// ---- Agent activity (§5.4): what a document push added since the last one.

export interface ActivitySnapshot {
  hunkIds: readonly string[]
  suggestionIds: readonly string[]
}

export function activitySnapshot(document: DocumentView): ActivitySnapshot {
  return {
    hunkIds: document.pendingHunks.map((hunk) => hunk.id),
    suggestionIds: document.annotations.filter((annotation) => annotation.kind === 'suggestion' && annotation.status === 'open').map((annotation) => annotation.id),
  }
}

export interface AgentActivity {
  /** Agent names, in order of first appearance. */
  authors: string[]
  changes: number
  suggestions: number
  /** The first new item in document order, for the toast's Show button. */
  target: ReviewTarget
}

/** New pending changes and open suggestions by agents since `previous`; null when there are none. */
export function agentActivity(previous: ActivitySnapshot | null, document: DocumentView): AgentActivity | null {
  if (!previous) return null
  const knownHunks = new Set(previous.hunkIds)
  const knownSuggestions = new Set(previous.suggestionIds)
  const hunks = document.pendingHunks.filter((hunk) => hunk.author !== null && !knownHunks.has(hunk.id))
  const suggestions = document.annotations.filter((annotation) =>
    annotation.kind === 'suggestion' && annotation.status === 'open' && annotation.author !== 'user' && !knownSuggestions.has(annotation.id))
  if (hunks.length === 0 && suggestions.length === 0) return null
  const authors: string[] = []
  for (const name of [...hunks.map((hunk) => hunk.author!.name), ...suggestions.map((annotation) => (annotation.author as AgentIdentity).name)]) {
    if (!authors.includes(name)) authors.push(name)
  }
  const targets: ReviewTarget[] = [
    ...hunks.map((hunk): ReviewTarget => ({ kind: 'hunk', id: hunk.id, line: hunk.newStart })),
    ...suggestions.filter((annotation) => annotation.line !== null).map((annotation): ReviewTarget => ({ kind: 'suggestion', id: annotation.id, line: annotation.line! })),
  ].sort((left, right) => left.line - right.line)
  const target = targets[0] ?? { kind: 'suggestion', id: suggestions[0]!.id, line: 0 }
  return { authors, changes: hunks.length, suggestions: suggestions.length, target }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Claude changed 3 passages", "Claude suggested 2 changes", "Claude and GPT changed 1 passage and suggested 1 change". */
export function agentActivityMessage(activity: AgentActivity): string {
  const who = activity.authors.length <= 2
    ? activity.authors.join(' and ')
    : `${activity.authors.slice(0, -1).join(', ')}, and ${activity.authors.at(-1)}`
  const parts: string[] = []
  if (activity.changes > 0) parts.push(`changed ${plural(activity.changes, 'passage', 'passages')}`)
  if (activity.suggestions > 0) parts.push(`suggested ${plural(activity.suggestions, 'change', 'changes')}`)
  return `${who} ${parts.join(' and ')}`
}

/**
 * Whether a pushed panel size or zoom should replace the local value (§5.14):
 * only when it differs from what this window last committed, so an echo of an
 * older commit never clobbers a drag in progress.
 */
export function shouldAdoptPushed(pushed: unknown, lastCommitted: unknown): boolean {
  return lastCommitted === undefined || lastCommitted === null || !sameJson(pushed, lastCommitted)
}

// ---- Recent documents (§5.10), kept in this window's local storage.



/** Tab-menu bulk close (§5.16): clean tabs close; tabs with unsaved edits stay and are counted. */
export function tabsToClose(tabs: readonly DocumentTabView[], mode: 'others' | 'all' | 'saved', keepPath: string): { close: DocumentTabView[]; keptDirty: number } {
  const candidates = tabs.filter((tab) => mode === 'others' ? tab.path !== keepPath : true)
  const close = candidates.filter((tab) => !tab.dirty)
  const keptDirty = mode === 'saved' ? 0 : candidates.length - close.length
  return { close, keptDirty }
}
