import { describe, expect, it } from 'vitest'
import { reconcileTableViews, tableReferences } from '../../src/main/tables'
import { defaultTableView, projectTable } from '../../src/shared/tables'
import { parseMarkdownForEditor } from '../../src/editor/markdown'
import { tableReferencesForDocument } from '../../src/editor/tables'

const markdown = [
  '# Report',
  '',
  '## Islands',
  '',
  '| Name | Gaps | Score |',
  '| --- | --- | ---: |',
  '| Alpha | Yes | 12 |',
  '| Beta | No | 3 |',
  '',
  '| Name | Gaps | Score |',
  '| --- | --- | ---: |',
  '| Gamma | Yes | 20 |',
  '',
  '### Detail',
  '',
  '| Item | Verdict |',
  '| --- | --- |',
  '| Gate | Unprotected |',
].join('\n')

describe('table identity and private presentations', () => {
  it('identifies tables by their nearest heading, normalized headers, and occurrence', () => {
    expect(tableReferences(markdown)).toEqual([
      { headingLevel: 2, headingText: 'Islands', headers: ['Name', 'Gaps', 'Score'], occurrence: 0 },
      { headingLevel: 2, headingText: 'Islands', headers: ['Name', 'Gaps', 'Score'], occurrence: 1 },
      { headingLevel: 3, headingText: 'Detail', headers: ['Item', 'Verdict'], occurrence: 0 },
    ])
  })

  it('keeps exact identities and drops missing tables without guessing', () => {
    const references = tableReferences(markdown)
    const states = references.map((table) => ({ ...defaultTableView(table), density: 'compact' as const }))
    expect(reconcileTableViews(states, markdown)).toEqual(states)

    const renamed = markdown.replace('## Islands', '## Systems')
    expect(reconcileTableViews(states, renamed)).toEqual([states[2]])
    expect(reconcileTableViews(states, renamed.replace('### Detail', '### Other'))).toEqual([])
  })

  it('clears row state that no longer exists', () => {
    const table = tableReferences(markdown)[0]!
    const state = { ...defaultTableView(table), selectedRows: [0, 1, 9], focusedRow: 9, focusedColumn: 1 }
    expect(reconcileTableViews([state], markdown)[0]).toMatchObject({
      selectedRows: [0, 1],
      focusedRow: null,
      focusedColumn: null,
    })
  })

  it('uses image alt text for the same table identity in main and editor', () => {
    const source = '## ![Island](./island.png) review\n\n| ![Name](./name.png) | Score |\n|---|---:|\n| Alpha | 1 |\n'
    const main = tableReferences(source)[0]
    const editor = tableReferencesForDocument(parseMarkdownForEditor(source).doc)[0]?.reference
    expect(editor).toEqual(main)
  })

  it('sorts numbers and text, filters case-insensitively, hides columns, and preserves source indexes', () => {
    const table = tableReferences(markdown)[0]!
    const headers = table.headers
    const rows = [
      ['Alpha', 'Yes', '12'],
      ['beta', 'No', '3'],
      ['Gamma', 'Yes', '20'],
    ]
    const state = {
      ...defaultTableView(table),
      sort: { column: 2, direction: 'descending' as const },
      filter: { column: 1, query: 'YES' },
      hiddenColumns: [1],
    }
    expect(projectTable(headers, rows, state)).toEqual({
      visibleColumns: [0, 2],
      rows: [
        { sourceIndex: 2, cells: ['Gamma', 'Yes', '20'] },
        { sourceIndex: 0, cells: ['Alpha', 'Yes', '12'] },
      ],
    })
    expect(rows).toEqual([
      ['Alpha', 'Yes', '12'],
      ['beta', 'No', '3'],
      ['Gamma', 'Yes', '20'],
    ])
  })

  it('focuses one source row and compares selected source rows', () => {
    const table = tableReferences(markdown)[0]!
    const rows = [['A', 'No', '1'], ['B', 'Yes', '2'], ['C', 'No', '3']]
    expect(projectTable(table.headers, rows, { ...defaultTableView(table), presentation: 'focus-row', focusedRow: 1 }).rows)
      .toEqual([{ sourceIndex: 1, cells: rows[1] }])
    expect(projectTable(table.headers, rows, { ...defaultTableView(table), presentation: 'compare', selectedRows: [0, 2] }).rows)
      .toEqual([{ sourceIndex: 0, cells: rows[0] }, { sourceIndex: 2, cells: rows[2] }])
  })
})
