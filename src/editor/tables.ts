import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import type { TableReference, TableViewState } from '../shared/contracts'
import { assignTableReferences, defaultTableView, projectTable, tableReferenceKey, upsertTableView } from '../shared/tables'
import { headingText as editorNodeText } from './headings.js'
import { toolbarButton } from './dom.js'

interface PositionedTable {
  position: number
  reference: TableReference
}

interface ReviewRangeLike {
  id: string
  from: number
  to: number
  status?: string
}

export interface TableDiscussionRequest {
  tablePosition: number
  row: number
  column: number
  kind: 'table-row' | 'table-cell'
  left: number
  top: number
}

export interface TableNodeViewOptions {
  states?: readonly TableViewState[]
  focusedTable?: string | null
  onState?(state: TableViewState): void
  onFocus?(tableKey: string | null): void
  onDiscuss?(request: TableDiscussionRequest): void
}

function tableInputs(doc: ProseMirrorNode): Array<{ position: number; headingLevel: number | null; headingText: string | null; headers: string[] }> {
  const inputs: Array<{ position: number; headingLevel: number | null; headingText: string | null; headers: string[] }> = []
  let headingLevel: number | null = null
  let headingText: string | null = null
  doc.forEach((node, position) => {
    if (node.type.name === 'heading') {
      headingLevel = Number(node.attrs.level)
      headingText = editorNodeText(node)
    } else if (node.type.name === 'table') {
      const header = node.firstChild
      inputs.push({ position, headingLevel, headingText, headers: header ? [...Array(header.childCount)].map((_, index) => editorNodeText(header.child(index))) : [] })
    }
  })
  return inputs
}

export function tableReferencesForDocument(doc: ProseMirrorNode): PositionedTable[] {
  const inputs = tableInputs(doc)
  const references = assignTableReferences(inputs)
  return inputs.map((input, index) => ({ position: input.position, reference: references[index]! }))
}

function cellPosition(tablePosition: number, table: ProseMirrorNode, bodyRow: number, column: number): number | null {
  const rowIndex = bodyRow + 1
  if (rowIndex < 1 || rowIndex >= table.childCount) return null
  let position = tablePosition + 1
  for (let index = 0; index < rowIndex; index += 1) position += table.child(index).nodeSize
  const row = table.child(rowIndex)
  if (column < 0 || column >= row.childCount) return null
  position += 1
  for (let index = 0; index < column; index += 1) position += row.child(index).nodeSize
  return Math.min(position + 2, tablePosition + table.nodeSize - 1)
}

function button(label: string, action: () => void, pressed?: boolean): HTMLButtonElement {
  return toolbarButton(label, action, { ...(pressed === undefined ? {} : { pressed }) })
}

function option(value: string, text: string): HTMLOptionElement {
  const item = document.createElement('option')
  item.value = value
  item.textContent = text
  return item
}

class TableNodeView implements NodeView {
  readonly dom: HTMLDivElement
  readonly contentDOM: HTMLTableSectionElement
  readonly #toolbar: HTMLDivElement
  readonly #source: HTMLTableElement
  readonly #derived: HTMLDivElement
  readonly #style: HTMLStyleElement
  #node: ProseMirrorNode
  #revealed = false
  #toolbarKey = ''

  constructor(node: ProseMirrorNode, readonly view: EditorView, readonly getPos: () => number | undefined, readonly manager: TableNodeViewManager) {
    this.#node = node
    this.dom = document.createElement('div')
    this.dom.className = 'strata-table-block'
    this.dom.style.containerType = 'inline-size'
    this.#toolbar = document.createElement('div')
    this.#toolbar.className = 'strata-table-toolbar'
    this.#toolbar.contentEditable = 'false'
    this.#toolbar.setAttribute('role', 'toolbar')
    this.#toolbar.setAttribute('aria-label', 'Table view controls')
    const scroller = document.createElement('div')
    scroller.className = 'strata-table-scroll'
    this.#source = document.createElement('table')
    this.#source.className = 'strata-source-table'
    this.contentDOM = document.createElement('tbody')
    this.#source.append(this.contentDOM)
    this.#derived = document.createElement('div')
    this.#derived.className = 'strata-table-derived'
    this.#derived.contentEditable = 'false'
    this.#derived.setAttribute('aria-live', 'polite')
    this.#style = document.createElement('style')
    scroller.append(this.#source, this.#derived)
    this.dom.append(this.#toolbar, scroller, this.#style)
    this.contentDOM.addEventListener('click', (event) => this.#selectFromTarget(event.target))
    queueMicrotask(() => this.render())
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false
    this.#node = node
    queueMicrotask(() => this.render())
    return true
  }

  stopEvent(event: Event): boolean {
    const target = event.target
    return target instanceof Node && !this.contentDOM.contains(target)
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target)
  }

  destroy(): void {
    this.manager.remove(this)
  }

  reference(): TableReference | null {
    const position = this.getPos()
    if (position === undefined) return null
    return this.manager.referenceAt(this.view.state.doc, position)
  }

  contains(position: number): boolean {
    const from = this.getPos()
    return from !== undefined && position >= from && position <= from + this.#node.nodeSize
  }

  setRevealed(value: boolean): void {
    this.#revealed = value
    this.render()
  }

  isRevealed(): boolean {
    return this.#revealed
  }

  #state(): TableViewState | null {
    const reference = this.reference()
    return reference ? this.manager.stateFor(reference) : null
  }

  #commit(patch: Partial<Omit<TableViewState, 'table'>>): void {
    const state = this.#state()
    if (!state) return
    this.manager.commit({ ...state, ...patch })
  }

  #selectFromTarget(target: EventTarget | null): void {
    const cell = target instanceof Element ? target.closest('td, th') : null
    const row = cell?.parentElement
    if (!cell || !row || row.parentElement !== this.contentDOM) return
    const rowIndex = [...this.contentDOM.children].indexOf(row)
    if (rowIndex <= 0) return
    const column = [...row.children].indexOf(cell)
    // Let ProseMirror finish its native click and selection handling before a
    // table-state render replaces controls around the editable contentDOM.
    setTimeout(() => this.#commit({ focusedRow: rowIndex - 1, focusedColumn: column }), 0)
  }

  #focusSelectedCell(): void {
    const state = this.#state()
    const tablePosition = this.getPos()
    if (!state) return
    this.#commit({ presentation: 'table', sort: null, filter: null, hiddenColumns: [] })
    if (tablePosition === undefined || state.focusedRow === null) return
    const position = cellPosition(tablePosition, this.#node, state.focusedRow, state.focusedColumn ?? 0)
    if (position === null) return
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(position))).setMeta('addToHistory', false))
    this.view.focus()
  }

  #modeControls(state: TableViewState): HTMLElement {
    const group = document.createElement('div')
    group.className = 'strata-table-modes'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Table presentation')
    group.append(
      button('Table', () => this.#commit({ presentation: 'table', sort: null, filter: null, hiddenColumns: [] }), state.presentation === 'table' && !state.sort && !state.filter && state.hiddenColumns.length === 0),
      button('Focus row', () => this.#commit({ presentation: 'focus-row' }), state.presentation === 'focus-row'),
      button('Compare', () => this.#commit({ presentation: 'compare' }), state.presentation === 'compare'),
    )
    return group
  }

  #secondaryControls(state: TableViewState, className: string): HTMLElement {
    const group = document.createElement('div')
    group.className = className
    const headers = state.table.headers
    const sort = document.createElement('select')
    sort.setAttribute('aria-label', 'Sort table')
    sort.append(option('', 'Source order'))
    headers.forEach((header, column) => {
      sort.append(option(`${column}:ascending`, `${header}, ascending`), option(`${column}:descending`, `${header}, descending`))
    })
    sort.value = state.sort ? `${state.sort.column}:${state.sort.direction}` : ''
    sort.addEventListener('change', () => {
      const [column, direction] = sort.value.split(':')
      this.#commit({ sort: direction ? { column: Number(column), direction: direction as 'ascending' | 'descending' } : null })
    })

    const filterColumn = document.createElement('select')
    filterColumn.setAttribute('aria-label', 'Filter column')
    headers.forEach((header, column) => filterColumn.append(option(String(column), header)))
    filterColumn.value = String(state.filter?.column ?? state.focusedColumn ?? 0)
    const filter = document.createElement('input')
    filter.type = 'search'
    filter.setAttribute('aria-label', 'Filter rows')
    filter.placeholder = 'Filter rows'
    filter.value = state.filter?.query ?? ''
    const applyFilter = () => this.#commit({ filter: filter.value ? { column: Number(filterColumn.value), query: filter.value } : null })
    filter.addEventListener('change', applyFilter)
    filter.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyFilter() } })

    const columns = document.createElement('details')
    columns.className = 'strata-table-columns'
    const summary = document.createElement('summary')
    summary.textContent = 'Columns'
    columns.append(summary)
    headers.forEach((header, column) => {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = !state.hiddenColumns.includes(column)
      checkbox.addEventListener('change', () => {
        const hidden = new Set(state.hiddenColumns)
        if (checkbox.checked) hidden.delete(column)
        else if (hidden.size < headers.length - 1) hidden.add(column)
        this.#commit({ hiddenColumns: [...hidden].sort((left, right) => left - right) })
      })
      label.append(checkbox, document.createTextNode(header))
      columns.append(label)
    })

    const column = state.focusedColumn ?? 0
    const widths = Array.from({ length: headers.length }, (_, index) => state.columnWidths[index] ?? 180)
    const resize = (delta: number) => {
      widths[column] = Math.max(80, Math.min(640, (widths[column] || 180) + delta))
      this.#commit({ columnWidths: widths })
    }
    const widthGroup = document.createElement('span')
    widthGroup.className = 'strata-table-width'
    widthGroup.append(button('Narrower', () => resize(-20)), button('Wider', () => resize(20)))
    group.append(sort, filterColumn, filter, columns, widthGroup, button(state.density === 'compact' ? 'Comfortable density' : 'Compact density', () => this.#commit({ density: state.density === 'compact' ? 'comfortable' : 'compact' })))
    return group
  }

  #discussionControls(state: TableViewState): HTMLElement {
    const group = document.createElement('div')
    group.className = 'strata-table-discussion'
    const selected = state.focusedRow !== null && state.focusedRow < this.#node.childCount - 1
    const selectedForCompare = selected && state.selectedRows.includes(state.focusedRow!)
    const select = button(selectedForCompare ? 'Remove row' : 'Select row', () => {
      if (state.focusedRow === null) return
      const rows = selectedForCompare ? state.selectedRows.filter((row) => row !== state.focusedRow) : [...state.selectedRows, state.focusedRow]
      this.#commit({ selectedRows: [...new Set(rows)].sort((left, right) => left - right) })
    }, selectedForCompare)
    select.disabled = !selected
    const discuss = (kind: 'table-row' | 'table-cell') => {
      const position = this.getPos()
      if (position === undefined || state.focusedRow === null) return
      const bounds = this.dom.getBoundingClientRect()
      this.manager.discuss({ tablePosition: position, row: state.focusedRow, column: state.focusedColumn ?? 0, kind, left: bounds.left + bounds.width / 2, top: bounds.top })
    }
    const row = button('Discuss row', () => discuss('table-row'))
    const cell = button('Discuss cell', () => discuss('table-cell'))
    row.disabled = !selected
    cell.disabled = !selected
    group.append(select, row, cell)
    return group
  }

  #renderDerived(state: TableViewState): void {
    this.#derived.replaceChildren()
    const headers = state.table.headers
    const rows = [...Array(Math.max(0, this.#node.childCount - 1))].map((_, rowIndex) => {
      const row = this.#node.child(rowIndex + 1)
      return [...Array(row.childCount)].map((__, column) => row.child(column).textContent)
    })
    const projection = projectTable(headers, rows, state)
    if (state.presentation === 'compare' && state.selectedRows.length < 2) {
      this.#derived.textContent = 'Select at least two rows to compare.'
      return
    }
    if (projection.rows.length === 0) {
      this.#derived.textContent = state.presentation === 'focus-row' ? 'Choose a body row to focus.' : 'No rows match this filter.'
      return
    }
    if (state.presentation === 'focus-row') {
      const list = document.createElement('dl')
      list.className = 'strata-table-focus-row'
      for (const column of projection.visibleColumns) {
        const term = document.createElement('dt')
        term.textContent = headers[column] ?? `Column ${column + 1}`
        const value = document.createElement('dd')
        value.textContent = projection.rows[0]!.cells[column] ?? ''
        list.append(term, value)
      }
      this.#derived.append(list)
      return
    }
    const table = document.createElement('table')
    table.setAttribute('aria-label', state.presentation === 'compare' ? 'Compared table rows' : 'Table view')
    const head = document.createElement('thead')
    const headerRow = document.createElement('tr')
    for (const column of projection.visibleColumns) {
      const cell = document.createElement('th')
      cell.scope = 'col'
      cell.textContent = headers[column] ?? ''
      headerRow.append(cell)
    }
    head.append(headerRow)
    const body = document.createElement('tbody')
    for (const projected of projection.rows) {
      const row = document.createElement('tr')
      row.dataset.sourceRow = String(projected.sourceIndex)
      for (const column of projection.visibleColumns) {
        const cell = document.createElement('td')
        cell.textContent = projected.cells[column] ?? ''
        cell.addEventListener('click', () => this.#commit({ focusedRow: projected.sourceIndex, focusedColumn: column }))
        row.append(cell)
      }
      body.append(row)
    }
    table.append(head, body)
    this.#derived.append(table)
  }

  render(): void {
    if (!this.dom.isConnected) return
    const state = this.#state()
    if (!state) return
    const optionsWereOpen = this.#toolbar.querySelector<HTMLDetailsElement>('.strata-table-options')?.open ?? false
    const key = tableReferenceKey(state.table)
    const transformed = state.presentation !== 'table' || state.sort !== null || state.filter !== null || state.hiddenColumns.length > 0
    const showingSource = !transformed || this.#revealed
    this.dom.dataset.tableKey = key
    this.dom.dataset.presentation = state.presentation
    this.dom.dataset.density = state.density
    this.dom.dataset.centerFocus = String(this.manager.focusedTable === key)
    this.dom.classList.toggle('is-temporarily-revealed', this.#revealed)
    this.#source.hidden = !showingSource
    this.#derived.hidden = showingSource
    this.dom.dataset.focusedRow = state.focusedRow === null ? '' : String(state.focusedRow)
    this.dom.dataset.focusedColumn = state.focusedColumn === null ? '' : String(state.focusedColumn)
    const hiddenReviewCount = this.manager.hiddenReviewCount(this)
    this.dom.dataset.hiddenReviewCount = String(hiddenReviewCount)
    const currentCell = state.focusedRow !== null && state.focusedColumn !== null
      ? `.strata-source-table tbody > tr:nth-child(${state.focusedRow + 2}) > *:nth-child(${state.focusedColumn + 1}) { outline:2px solid var(--controls-focus); outline-offset:-3px; background:color-mix(in srgb, var(--controls-selected) 16%, transparent); }`
      : ''
    this.#style.textContent = `${state.columnWidths.map((width, index) => width ? `.strata-source-table tr > *:nth-child(${index + 1}), .strata-table-derived tr > *:nth-child(${index + 1}) { width:${width}px; min-width:${width}px; }` : '').join('\n')}\n${currentCell}`
    if (transformed) this.#renderDerived(state)

    const toolbarKey = JSON.stringify([state, hiddenReviewCount, this.#revealed, this.manager.focusedTable === key])
    if (toolbarKey !== this.#toolbarKey) {
      this.#toolbarKey = toolbarKey
      this.#toolbar.replaceChildren()
      this.#toolbar.append(this.#modeControls(state))
      const status = document.createElement('span')
      status.className = 'strata-table-status'
      status.textContent = transformed && !this.#revealed ? 'Read-only view' : 'Editable source order'
      this.#toolbar.append(status)
      if (transformed) this.#toolbar.append(button(this.#revealed ? 'Return to table view' : 'Edit', () => this.#revealed ? this.manager.restoreReveals() : this.#focusSelectedCell()))
      this.#toolbar.append(button(this.manager.focusedTable === key ? 'Exit focus' : 'Focus', () => this.manager.focus(key)))
      const hidden = transformed && !this.#revealed ? hiddenReviewCount : 0
      if (hidden > 0) {
        const count = document.createElement('span')
        count.className = 'strata-table-hidden-review'
        count.textContent = `${hidden} review item${hidden === 1 ? '' : 's'} hidden`
        this.#toolbar.append(count)
      }
      this.#toolbar.append(this.#discussionControls(state))
      this.#toolbar.append(this.#secondaryControls(state, 'strata-table-secondary'))
      const collapsed = document.createElement('details')
      collapsed.className = 'strata-table-options'
      const summary = document.createElement('summary')
      summary.textContent = 'Table options'
      collapsed.append(summary, this.#secondaryControls(state, 'strata-table-secondary-collapsed'))
      collapsed.open = optionsWereOpen
      this.#toolbar.append(collapsed)
    }

  }
}

export class TableNodeViewManager {
  readonly #views = new Set<TableNodeView>()
  #states: TableViewState[]
  readonly #pending = new Map<string, TableViewState>()
  #reviewRanges: readonly ReviewRangeLike[] = []
  #annotationRanges: readonly ReviewRangeLike[] = []
  focusedTable: string | null
  #referenceDocument: ProseMirrorNode | null = null
  #references: PositionedTable[] = []

  constructor(readonly options: TableNodeViewOptions) {
    this.#states = [...(options.states ?? [])]
    this.focusedTable = options.focusedTable ?? null
  }

  create(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined): NodeView {
    const nodeView = new TableNodeView(node, view, getPos, this)
    this.#views.add(nodeView)
    return nodeView
  }

  remove(nodeView: TableNodeView): void {
    this.#views.delete(nodeView)
  }

  referenceAt(doc: ProseMirrorNode, position: number): TableReference | null {
    if (doc !== this.#referenceDocument) {
      this.#referenceDocument = doc
      this.#references = tableReferencesForDocument(doc)
    }
    return this.#references.find((table) => table.position === position)?.reference ?? null
  }

  stateFor(reference: TableReference): TableViewState {
    return this.#states.find((state) => tableReferenceKey(state.table) === tableReferenceKey(reference)) ?? defaultTableView(reference)
  }

  commit(state: TableViewState): void {
    this.#states = upsertTableView(this.#states, state)
    this.#pending.set(tableReferenceKey(state.table), state)
    this.options.onState?.(state)
    this.refresh()
  }

  setStates(states: readonly TableViewState[]): void {
    let next = [...states]
    for (const [key, pending] of this.#pending) {
      const incoming = next.find((state) => tableReferenceKey(state.table) === key)
      if (incoming && JSON.stringify(incoming) === JSON.stringify(pending)) this.#pending.delete(key)
      else next = upsertTableView(next, pending)
    }
    if (JSON.stringify(next) === JSON.stringify(this.#states)) return
    this.#states = next
    this.refresh()
  }

  setReviewRanges(review: readonly ReviewRangeLike[], annotations: readonly ReviewRangeLike[]): void {
    if (review === this.#reviewRanges && annotations === this.#annotationRanges) return
    this.#reviewRanges = review
    this.#annotationRanges = annotations
    this.refresh()
  }

  hiddenReviewCount(table: TableNodeView): number {
    const ids = new Set<string>()
    for (const range of [...this.#reviewRanges, ...this.#annotationRanges]) {
      if (range.status === 'resolved' || range.status === 'orphaned') continue
      if (table.contains(range.from) || table.contains(range.to)) ids.add(range.id)
    }
    return ids.size
  }

  revealPosition(position: number): void {
    let found = false
    for (const table of this.#views) {
      const reveal = table.contains(position)
      table.setRevealed(reveal)
      found ||= reveal
    }
    if (!found) this.restoreReveals()
  }

  restoreWhenSelectionLeaves(position: number): void {
    if ([...this.#views].some((table) => table.isRevealed() && !table.contains(position))) this.restoreReveals()
  }

  restoreReveals(): void {
    for (const table of this.#views) table.setRevealed(false)
  }

  focus(key: string): void {
    this.focusedTable = this.focusedTable === key ? null : key
    this.options.onFocus?.(this.focusedTable)
    this.refresh()
  }

  discuss(request: TableDiscussionRequest): void {
    this.options.onDiscuss?.(request)
  }

  refresh(): void {
    for (const view of this.#views) view.render()
  }
}
