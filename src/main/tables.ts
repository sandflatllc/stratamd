import { mdastText, parseMarkdown } from '../core/markdown/index'
import type { ParsedMarkdown } from '../core/markdown/types'
import type { TableReference, TableViewState } from '../shared/contracts'
import { assignTableReferences, tableReferenceKey } from '../shared/tables'

interface AstNode {
  type?: string
  value?: string
  alt?: string | null
  depth?: number
  children?: readonly AstNode[]
}

export function tableReferences(markdown: string, parsed: ParsedMarkdown = parseMarkdown(markdown)): TableReference[] {
  const root = parsed.ast as AstNode
  let headingLevel: number | null = null
  let headingText: string | null = null
  const inputs = []
  for (const node of root.children ?? []) {
    if (node.type === 'heading') {
      headingLevel = node.depth ?? null
      headingText = mdastText(node as never)
    } else if (node.type === 'table') {
      inputs.push({
        headingLevel,
        headingText,
        headers: (node.children?.[0]?.children ?? []).map((cell) => mdastText(cell as never)),
      })
    }
  }
  return assignTableReferences(inputs)
}

export function reconcileTableViews(states: readonly TableViewState[], markdown: string, parsed: ParsedMarkdown = parseMarkdown(markdown)): TableViewState[] {
  const references = tableReferences(markdown, parsed)
  const tables = (parsed.ast as AstNode).children?.filter((node) => node.type === 'table') ?? []
  const available = new Map(references.map((reference, index) => [tableReferenceKey(reference), {
    reference,
    rows: Math.max(0, (tables[index]?.children?.length ?? 1) - 1),
  }]))
  return states.flatMap((state) => {
    const current = available.get(tableReferenceKey(state.table))
    if (!current) return []
    const focusedRow = state.focusedRow !== null && state.focusedRow < current.rows ? state.focusedRow : null
    return [{
      ...state,
      table: current.reference,
      selectedRows: state.selectedRows.filter((row) => row < current.rows),
      focusedRow,
      focusedColumn: focusedRow === null || (state.focusedColumn !== null && state.focusedColumn >= current.reference.headers.length)
        ? null
        : state.focusedColumn,
    }]
  })
}
