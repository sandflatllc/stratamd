// A turn's changed files as the conversation shows them (PRD §6.9, decided
// 2026-09-04): a count and a net delta, the top-level folders they fall under,
// a few file chips, and the full list on request. Paths read relative to the
// project's workspace root; a path outside the root keeps its absolute form.

export interface ChangedFileInput {
  path: string
  additions: number
  deletions: number
  markdown: boolean
}

export interface ChangedFileView extends ChangedFileInput {
  /** File name without its directory. */
  name: string
  /** Path relative to the workspace root, or the absolute path when outside it. */
  relative: string
  /** The relative directory, empty for a file at the root. */
  directory: string
  /** Lower-case extension without the dot, empty when none. */
  extension: string
}

export interface ChangedFileGroup {
  /** The top-level folder under the root, or `.` for files at the root, or the absolute parent for files outside it. */
  label: string
  files: ChangedFileView[]
}

export interface ChangedFilesSummary {
  count: number
  additions: number
  deletions: number
  groups: ChangedFileGroup[]
  /** The first few files in group order, for the collapsed card. */
  preview: ChangedFileView[]
}

export const PREVIEW_COUNT = 3

/** 4400 reads `4.4k`, 12000 reads `12k`, under a thousand stays exact. */
export function formatDelta(value: number): string {
  const count = Math.max(0, Math.round(value))
  if (count < 1_000) return String(count)
  const thousands = count / 1_000
  return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export function relativeChangedPath(path: string, root: string | null): string {
  if (!root) return path
  const base = trimSlash(root)
  if (path === base) return '.'
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

export function describeChangedFile(file: ChangedFileInput, root: string | null): ChangedFileView {
  const relative = relativeChangedPath(file.path, root)
  const slash = relative.lastIndexOf('/')
  const name = slash === -1 ? relative : relative.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return {
    ...file,
    name,
    relative,
    directory: slash === -1 ? '' : relative.slice(0, slash),
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  }
}

function groupLabel(file: ChangedFileView): string {
  if (file.relative.startsWith('/')) return file.directory || '/'
  const slash = file.relative.indexOf('/')
  return slash === -1 ? '.' : file.relative.slice(0, slash)
}

/** Groups by top-level folder, largest group first, files in path order; the same path appears once with its counts summed. */
export function summarizeChangedFiles(files: readonly ChangedFileInput[], root: string | null): ChangedFilesSummary {
  const merged = new Map<string, ChangedFileInput>()
  for (const file of files) {
    const seen = merged.get(file.path)
    merged.set(file.path, seen ? { ...seen, additions: seen.additions + file.additions, deletions: seen.deletions + file.deletions } : { ...file })
  }
  const views = [...merged.values()].map((file) => describeChangedFile(file, root)).sort((a, b) => a.relative.localeCompare(b.relative))
  const groups = new Map<string, ChangedFileView[]>()
  for (const view of views) {
    const label = groupLabel(view)
    groups.set(label, [...(groups.get(label) ?? []), view])
  }
  const ordered = [...groups.entries()].map(([label, entries]) => ({ label, files: entries })).sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label))
  const inOrder = ordered.flatMap((group) => group.files)
  return {
    count: views.length,
    additions: views.reduce((sum, file) => sum + file.additions, 0),
    deletions: views.reduce((sum, file) => sum + file.deletions, 0),
    groups: ordered,
    preview: inOrder.slice(0, PREVIEW_COUNT),
  }
}

export function changedFilesLabel(count: number): string {
  return `${count} changed ${count === 1 ? 'file' : 'files'}`
}
