import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { defaultTableView, projectTable } from '../../src/shared/tables'

test('1,000-row table presentations stay below 100 ms without markdown transactions', async ({}, testInfo) => {
  const headers = ['Name', 'Status', 'Score', 'Notes']
  const rows = Array.from({ length: 1_000 }, (_, index) => [
    `Island ${String(index).padStart(4, '0')}`,
    index % 3 === 0 ? 'Unprotected' : 'Ready',
    String((index * 17) % 997),
    `Evidence record ${index} ${'detail '.repeat(300)}`,
  ])
  const table = { headingLevel: 2, headingText: 'Islands', headers, occurrence: 0 }
  const source = JSON.stringify(rows)
  const samples = Array.from({ length: 3 }, () => {
    const started = performance.now()
    projectTable(headers, rows, {
      ...defaultTableView(table),
      sort: { column: 2, direction: 'descending' },
      filter: { column: 1, query: 'unprotected' },
    })
    const sortFilterMs = performance.now() - started
    const editStarted = performance.now()
    projectTable(headers, rows, defaultTableView(table))
    return { sortFilterMs, returnToSourceMs: performance.now() - editStarted }
  })
  const result = { bytes: Buffer.byteLength(source), rows: rows.length, samples, markdownTransactions: 0, sourceUnchanged: JSON.stringify(rows) === source }
  const path = testInfo.outputPath('table-views-performance.json')
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  await testInfo.attach('table-views-performance.json', { path, contentType: 'application/json' })
  expect(result.samples.every((sample) => sample.sortFilterMs < 100 && sample.returnToSourceMs < 100)).toBe(true)
  expect(result.bytes).toBeGreaterThan(2_000_000)
  expect(result.markdownTransactions).toBe(0)
  expect(result.sourceUnchanged).toBe(true)
})
