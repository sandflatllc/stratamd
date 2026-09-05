import type { EngineProjectView, EngineThreadView } from '../shared/contracts'

export type ProjectThreadSort = 'recent' | 'oldest' | 'title'

export interface ProjectFolderView {
  project: EngineProjectView
  threads: EngineThreadView[]
  visibleThreads: EngineThreadView[]
  hasOverflow: boolean
  /** The loudest state among the folder's active threads, drawn on the header so a collapsed folder still reads. */
  state: ProjectFolderState
}

/** One state per row. Favorite and selected are separate axes. */
export type ProjectThreadState = 'input' | 'failed' | 'working' | 'completed' | 'monitoring' | 'idle'
export type ProjectFolderState = 'input' | 'working' | 'completed' | null

type ThreadStateInput = Pick<EngineThreadView, 'status' | 'unread' | 'pendingApprovals' | 'pendingUserInput' | 'backgroundLiveness'>

/**
 * T3's sidebar precedence with Strata's unread slotted before monitoring: an open approval or question
 * outranks everything, a failed session outranks lingering background work, a running session or live
 * background agents read as working, an unopened completion shows before a quiet watch loop.
 */
export function projectThreadState(thread: ThreadStateInput): ProjectThreadState {
  if (thread.pendingApprovals || thread.pendingUserInput) return 'input'
  if (thread.status === 'error') return 'failed'
  if (thread.status === 'running' || thread.status === 'starting' || thread.backgroundLiveness === 'working') return 'working'
  if (thread.unread) return 'completed'
  if (thread.backgroundLiveness === 'monitoring') return 'monitoring'
  return 'idle'
}

const FOLDER_ORDER: ProjectFolderState[] = ['input', 'working', 'completed']

export function projectFolderState(threads: readonly ThreadStateInput[]): ProjectFolderState {
  const states = new Set(threads.map(projectThreadState))
  return FOLDER_ORDER.find((state) => state !== null && states.has(state)) ?? null
}

export interface ProjectShelfEntry {
  thread: EngineThreadView
  projectName: string
}

export interface ProjectsRailView {
  folders: ProjectFolderView[]
  snoozed: ProjectShelfEntry[]
  settled: ProjectShelfEntry[]
}

/** Snooze outranks explicit settlement. Archived threads are classified but filtered from every rendered collection. */
export function classifyProjectThread(thread: Pick<EngineThreadView, 'snoozedUntil' | 'lifecycle'>, nowMs: number): EngineThreadView['lifecycle'] {
  if (thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > nowMs) return 'snoozed'
  return thread.lifecycle === 'settled' ? 'settled' : 'active'
}

function compare(sort: ProjectThreadSort, a: EngineThreadView, b: EngineThreadView): number {
  if (sort === 'title') return a.title.localeCompare(b.title)
  const delta = Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
  return sort === 'oldest' ? delta : -delta
}

/** Favorites form the first run; the selected sort order applies within both runs. */
export function sortProjectFolderThreads(threads: readonly EngineThreadView[], sort: ProjectThreadSort = 'recent'): EngineThreadView[] {
  const favorites = threads.filter((thread) => thread.pinnedAt !== null).sort((a, b) => compare(sort, a, b))
  const rest = threads.filter((thread) => thread.pinnedAt === null).sort((a, b) => compare(sort, a, b))
  return [...favorites, ...rest]
}

/** The cap counts non-favorites only, so pinning never pushes a favorite behind Show more. */
export function previewProjectFolderThreads(threads: readonly EngineThreadView[], previewCount: number, expanded = false): { threads: EngineThreadView[]; hasOverflow: boolean } {
  const favoriteCount = threads.filter((thread) => thread.pinnedAt !== null).length
  const hasOverflow = threads.length - favoriteCount > previewCount
  return {
    threads: expanded || !hasOverflow ? [...threads] : threads.slice(0, favoriteCount + Math.max(0, previewCount)),
    hasOverflow,
  }
}

/** A collapsed shelf still includes the open thread so navigation never makes it disappear. */
export function resolveShelfThreads(entries: readonly ProjectShelfEntry[], expanded: boolean, visibleCount: number, activeThreadId: string | null): ProjectShelfEntry[] {
  if (expanded) return entries.slice(0, Math.max(0, visibleCount))
  if (activeThreadId === null) return []
  const active = entries.find((entry) => entry.thread.id === activeThreadId)
  return active ? [active] : []
}

export function buildProjectsRail(projects: readonly EngineProjectView[], options: { nowMs: number; sort?: ProjectThreadSort; previewCountByProject?: Readonly<Record<string, number>>; expandedProjects?: ReadonlySet<string> }): ProjectsRailView {
  const sort = options.sort ?? 'recent'
  const snoozed: ProjectShelfEntry[] = []
  const settled: ProjectShelfEntry[] = []
  const folders = projects.map((project) => {
    const active: EngineThreadView[] = []
    for (const thread of project.threads) {
      if (thread.archived) continue
      const lifecycle = classifyProjectThread(thread, options.nowMs)
      if (lifecycle === 'snoozed') snoozed.push({ thread, projectName: project.title })
      else if (lifecycle === 'settled') settled.push({ thread, projectName: project.title })
      else active.push(thread)
    }
    const threads = sortProjectFolderThreads(active, sort)
    const preview = previewProjectFolderThreads(threads, options.previewCountByProject?.[project.id] ?? 5, options.expandedProjects?.has(project.id) ?? false)
    return { project, threads, visibleThreads: preview.threads, hasOverflow: preview.hasOverflow, state: projectFolderState(active) }
  })
  const shelfSort = (a: ProjectShelfEntry, b: ProjectShelfEntry) => compare(sort, a.thread, b.thread)
  return { folders, snoozed: snoozed.sort(shelfSort), settled: settled.sort(shelfSort) }
}
