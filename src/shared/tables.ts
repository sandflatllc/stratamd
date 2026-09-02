import type { TableReference, TableViewState } from './contracts'

export interface TableIdentityInput {
  headingLevel: number | null
  headingText: string | null
  headers: readonly string[]
}

export interface TableProjection {
  rows: Array<{ sourceIndex: number; cells: string[] }>
  visibleColumns: number[]
}

export function normalizeTableText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

export function assignTableReferences(inputs: readonly TableIdentityInput[]): TableReference[] {
  const counts = new Map<string, number>()
  return inputs.map((input) => {
    const identity = {
      headingLevel: input.headingLevel,
      headingText: input.headingText === null ? null : normalizeTableText(input.headingText),
      headers: input.headers.map(normalizeTableText),
    }
    const key = JSON.stringify(identity)
    const occurrence = counts.get(key) ?? 0
    counts.set(key, occurrence + 1)
    return { ...identity, occurrence }
  })
}

export function tableReferenceKey(reference: TableReference): string {
  return JSON.stringify(reference)
}

export function defaultTableView(table: TableReference): TableViewState {
  return {
    table,
    presentation: 'table',
    sort: null,
    filter: null,
    hiddenColumns: [],
    selectedRows: [],
    focusedRow: null,
    focusedColumn: null,
    density: 'comfortable',
    columnWidths: table.headers.map(() => 180),
  }
}

export function upsertTableView(states: readonly TableViewState[], state: TableViewState): TableViewState[] {
  const key = tableReferenceKey(state.table)
  return [...states.filter((candidate) => tableReferenceKey(candidate.table) !== key), state]
}

function cellValue(value: string): string | number {
  const compact = value.trim().replaceAll(',', '')
  const numeric = Number(compact)
  return compact !== '' && Number.isFinite(numeric) ? numeric : value.toLocaleLowerCase()
}

export function projectTable(headers: readonly string[], rows: readonly (readonly string[])[], state: TableViewState): TableProjection {
  const visibleColumns = headers.map((_, index) => index).filter((index) => !state.hiddenColumns.includes(index))
  let projected = rows.map((cells, sourceIndex) => ({ sourceIndex, cells: [...cells] }))
  if (state.filter && state.filter.query.trim()) {
    const query = state.filter.query.trim().toLocaleLowerCase()
    projected = projected.filter(({ cells }) => (cells[state.filter!.column] ?? '').toLocaleLowerCase().includes(query))
  }
  if (state.sort) {
    const { column, direction } = state.sort
    projected.sort((left, right) => {
      const a = cellValue(left.cells[column] ?? '')
      const b = cellValue(right.cells[column] ?? '')
      const result = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
      return direction === 'ascending' ? result : -result
    })
  }
  if (state.presentation === 'focus-row') {
    projected = projected.filter(({ sourceIndex }) => sourceIndex === state.focusedRow)
  } else if (state.presentation === 'compare') {
    const selected = new Set(state.selectedRows)
    projected = projected.filter(({ sourceIndex }) => selected.has(sourceIndex))
  }
  return { rows: projected, visibleColumns }
}
