import { readFile } from 'node:fs/promises'
import type { HeadingReference, ReadingState, TableReference, TableViewState } from '../shared/contracts'
import { referenceKey } from '../shared/walkthrough'
import { normalizeTableText, tableReferenceKey } from '../shared/tables'
import { atomicWriteFile, PRIVATE_FILE_MODE } from './storage'

export const CURRENT_READING_VERSION = 4

export const DEFAULT_READING_STATE: ReadingState = Object.freeze({
  formatVersion: CURRENT_READING_VERSION,
  navigationTab: 'files',
  reviewTab: 'changes',
  walkthrough: { active: false, level: 'h2' as const, current: null, excluded: [], markers: [] },
  tables: [],
  foldedHeadings: [],
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeHeadingReference(value: unknown): HeadingReference | null {
  if (!isRecord(value)) return null
  if (![1, 2, 3, 4, 5, 6].includes(Number(value.level))) return null
  const text = typeof value.text === 'string' ? value.text.trim().replace(/\s+/gu, ' ').slice(0, 512) : ''
  if (!text) return null
  const context = (field: 'parentText' | 'previousText' | 'nextText'): string | null =>
    typeof value[field] === 'string' ? value[field].trim().replace(/\s+/gu, ' ').slice(0, 512) : null
  return { level: value.level as 1 | 2 | 3 | 4 | 5 | 6, text, parentText: context('parentText'), previousText: context('previousText'), nextText: context('nextText') }
}

function walkthroughState(value: unknown): ReadingState['walkthrough'] {
  if (!isRecord(value)) return { active: false, level: 'h2', current: null, excluded: [], markers: [] }
  const current = normalizeHeadingReference(value.current)
  const excluded = Array.isArray(value.excluded)
    ? [...new Map(value.excluded.slice(0, 10_000).map(normalizeHeadingReference).filter((entry) => entry !== null).map((entry) => [referenceKey(entry), entry])).values()]
    : []
  const markers = Array.isArray(value.markers)
    ? [...new Map(value.markers.slice(0, 10_000).flatMap((entry) => {
        if (!isRecord(entry)) return []
        const heading = normalizeHeadingReference(entry.heading)
        if (!heading || (entry.status !== 'reviewed' && entry.status !== 'revisit')) return []
        const reviewedHash = typeof entry.reviewedHash === 'string' && /^[0-9a-f]{64}$/u.test(entry.reviewedHash) ? entry.reviewedHash : null
        const sourceHash = typeof entry.sourceHash === 'string' && /^[0-9a-f]{64}$/u.test(entry.sourceHash) ? entry.sourceHash : reviewedHash
        if (sourceHash === null) return []
        return [[referenceKey(heading), { heading, status: entry.status, reviewedHash, sourceHash }] as const]
      })).values()]
    : []
  return { active: value.active === true, level: value.level === 'h2-h3' ? 'h2-h3' : 'h2', current, excluded, markers }
}

function tableReference(value: unknown): TableReference | null {
  if (!isRecord(value)) return null
  const headingLevel = value.headingLevel === null || value.headingLevel === undefined
    ? null
    : Number.isInteger(value.headingLevel) && Number(value.headingLevel) >= 1 && Number(value.headingLevel) <= 6
      ? Number(value.headingLevel)
      : null
  const headingText = value.headingText === null || value.headingText === undefined
    ? null
    : typeof value.headingText === 'string'
      ? normalizeTableText(value.headingText).slice(0, 512)
      : null
  if (!Array.isArray(value.headers) || value.headers.length === 0 || value.headers.length > 100) return null
  const headers = value.headers.map((header) => typeof header === 'string' ? normalizeTableText(header).slice(0, 512) : '')
  const occurrence = Number.isInteger(value.occurrence) && Number(value.occurrence) >= 0 && Number(value.occurrence) <= 10_000
    ? Number(value.occurrence)
    : -1
  return occurrence < 0 ? null : { headingLevel, headingText, headers, occurrence }
}

function uniqueIndexes(value: unknown, maximum = 100_000): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, 10_000).filter((entry) => Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= maximum).map(Number))]
}

function tableView(value: unknown): TableViewState | null {
  if (!isRecord(value)) return null
  const table = tableReference(value.table)
  if (!table) return null
  const columns = table.headers.length
  const selectedRows = uniqueIndexes(value.selectedRows)
  const focusedRow = value.focusedRow === null || value.focusedRow === undefined
    ? null
    : Number.isInteger(value.focusedRow) && Number(value.focusedRow) >= 0 ? Number(value.focusedRow) : null
  const focusedColumn = value.focusedColumn === null || value.focusedColumn === undefined
    ? null
    : Number.isInteger(value.focusedColumn) && Number(value.focusedColumn) >= 0 && Number(value.focusedColumn) < columns ? Number(value.focusedColumn) : null
  const sort = isRecord(value.sort) && Number.isInteger(value.sort.column) && Number(value.sort.column) >= 0 && Number(value.sort.column) < columns
    && (value.sort.direction === 'ascending' || value.sort.direction === 'descending')
    ? { column: Number(value.sort.column), direction: value.sort.direction as 'ascending' | 'descending' }
    : null
  const filter = isRecord(value.filter) && Number.isInteger(value.filter.column) && Number(value.filter.column) >= 0 && Number(value.filter.column) < columns
    && typeof value.filter.query === 'string' && value.filter.query.length <= 1_000
    ? { column: Number(value.filter.column), query: value.filter.query }
    : null
  const widths = Array.isArray(value.columnWidths)
    ? value.columnWidths.slice(0, columns).map((width) => Number.isFinite(width) ? Math.round(Math.min(640, Math.max(80, Number(width)))) : 180)
    : table.headers.map(() => 180)
  return {
    table,
    presentation: value.presentation === 'focus-row' || value.presentation === 'compare' ? value.presentation : 'table',
    sort,
    filter,
    hiddenColumns: uniqueIndexes(value.hiddenColumns, columns - 1),
    selectedRows,
    focusedRow,
    focusedColumn,
    density: value.density === 'compact' ? 'compact' : 'comfortable',
    columnWidths: widths,
  }
}

function tableViews(value: unknown): TableViewState[] {
  if (!Array.isArray(value)) return []
  const valid = value.slice(0, 1_000).map(tableView).filter((entry): entry is TableViewState => entry !== null)
  return [...new Map(valid.map((entry) => [tableReferenceKey(entry.table), entry])).values()]
}

export function normalizeReadingState(value: unknown): ReadingState {
  if (!isRecord(value)) return { ...DEFAULT_READING_STATE }
  const version = value.formatVersion ?? 0
  if (!Number.isInteger(version) || (version as number) < 0) throw new Error('Invalid reading state format version')
  if ((version as number) > CURRENT_READING_VERSION) throw new Error(`Reading state version ${String(version)} is newer than this build`)
  return {
    formatVersion: CURRENT_READING_VERSION,
    navigationTab: value.navigationTab === 'contents' ? 'contents' : 'files',
    reviewTab: value.reviewTab === 'annotations' ? 'annotations' : 'changes',
    walkthrough: walkthroughState(value.walkthrough),
    tables: tableViews(value.tables),
    foldedHeadings: Array.isArray(value.foldedHeadings)
      ? [...new Map(value.foldedHeadings.slice(0, 10_000).map(normalizeHeadingReference).filter((entry) => entry !== null).map((entry) => [referenceKey(entry), entry])).values()]
      : [],
  }
}

export async function readReadingState(path: string): Promise<ReadingState> {
  try {
    return normalizeReadingState(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_READING_STATE }
    // Reading preferences are disposable private state. A malformed or newer
    // file must not prevent the document itself from opening.
    return { ...DEFAULT_READING_STATE }
  }
}

export async function writeReadingState(path: string, state: ReadingState): Promise<void> {
  const normalized = normalizeReadingState(state)
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
}
