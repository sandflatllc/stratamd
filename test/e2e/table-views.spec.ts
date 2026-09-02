import { expect, test, type Locator } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { primaryKey, Scenario } from './harness'

const filler = Array.from({ length: 12 }, (_, index) => `Reading context ${index + 1} keeps navigation targets away from the scroll boundary.`).join('\n\n')
const DOCUMENT = `# Review

${filler}

## Islands

| Name | Verdict | Score |
| --- | --- | ---: |
| Alpha | Unprotected | 12 |
| Beta | Ready | 3 |
| Gamma | Unprotected | 20 |

## Close

${filler}
`

let value: Scenario
test.afterEach(async () => { await value?.dispose() })

async function showTableOptions(block: Locator): Promise<void> {
  if (!await block.getByRole('combobox', { name: 'Sort table' }).isVisible()) {
    await block.getByText('Table options', { exact: true }).click()
  }
}

test('table views stay read-only, return to the selected source cell, and separate durable state from session focus', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, DOCUMENT, 'tables.md')
  const other = join(dirname(value.file), 'other.md')
  await writeFile(other, '# Other\n\nNothing here.\n')
  let page = await value.launch()
  let block = page.locator('.strata-table-block')
  await expect(block).toBeVisible()
  await expect(block.locator('.strata-source-table')).toBeVisible()

  await block.locator('.strata-source-table td').filter({ hasText: 'Alpha' }).click()
  await expect(block).toHaveAttribute('data-focused-row', '0')
  await expect(block).toHaveAttribute('data-focused-column', '0')
  await block.getByRole('button', { name: 'Select row' }).click()
  await block.locator('.strata-source-table td').filter({ hasText: 'Beta' }).click()
  await block.getByRole('button', { name: 'Select row' }).click()
  await block.getByRole('button', { name: 'Compare' }).click()
  await expect(block.locator('.strata-source-table')).toBeHidden()
  await expect(block.getByRole('table', { name: 'Compared table rows' })).toBeVisible()
  await expect(block.getByRole('table', { name: 'Compared table rows' }).locator('tbody tr')).toHaveCount(2)
  await block.getByRole('table', { name: 'Compared table rows' }).locator('tbody tr').filter({ hasText: 'Beta' }).locator('td').first().click()
  await block.getByRole('button', { name: 'Focus row' }).click()
  await expect(block.locator('.strata-table-focus-row')).toContainText('Beta')

  await block.getByRole('button', { name: 'Edit' }).click()
  await expect(block.locator('.strata-source-table')).toBeVisible()
  await expect(block.locator('.strata-source-table tbody tr').nth(1)).toContainText('Alpha')
  await expect(block.locator('.strata-source-table tbody tr').nth(2).locator('td').first()).toContainText('Beta')

  await showTableOptions(block)
  await block.getByRole('combobox', { name: 'Sort table' }).selectOption({ label: 'Score, descending' })
  await expect(block.getByRole('table', { name: 'Table view' }).locator('tbody tr').first()).toContainText('Gamma')
  await showTableOptions(block)
  await block.getByRole('combobox', { name: 'Filter column' }).selectOption({ label: 'Verdict' })
  const filter = block.getByRole('searchbox', { name: 'Filter rows' })
  await filter.fill('ready')
  await filter.press('Enter')
  await expect(block.getByRole('table', { name: 'Table view' }).locator('tbody tr')).toHaveCount(1)
  await expect(block.getByRole('table', { name: 'Table view' })).toContainText('Beta')
  await showTableOptions(block)
  await block.locator('.strata-table-columns:visible > summary').click()
  await block.getByRole('checkbox', { name: 'Score' }).click()
  await expect(block.getByRole('table', { name: 'Table view' }).getByRole('columnheader')).toHaveCount(2)
  await showTableOptions(block)
  await block.getByRole('button', { name: 'Wider' }).click()
  const unchanged = await value.state()
  expect(unchanged.document).toBe(DOCUMENT)
  expect(await readFile(unchanged.buffer!, 'utf8')).toBe(DOCUMENT)
  expect(await readFile(value.file, 'utf8')).toBe(DOCUMENT)

  await showTableOptions(block)
  await block.getByRole('button', { name: 'Compact density' }).click()
  await block.getByRole('button', { name: 'Focus', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeHidden()
  await expect(page.getByRole('tablist', { name: 'Document navigation' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()

  await page.evaluate(async (path) => window.strata.openDocument(path), other)
  await expect(page.getByRole('heading', { name: 'Other' })).toBeVisible()
  await page.getByRole('tab', { name: /tables\.md/i }).click()
  block = page.locator('.strata-table-block')
  await expect(block).toHaveAttribute('data-center-focus', 'true')
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeHidden()

  await value.stop()
  page = await value.launch()
  block = page.locator('.strata-table-block')
  await expect(block).toHaveAttribute('data-center-focus', 'false')
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  await expect(block).toHaveAttribute('data-density', 'compact')
  await expect(block.locator('.strata-source-table')).toBeHidden()
  await expect(block.getByRole('table', { name: 'Table view' })).toContainText('Beta')
  await expect(block.getByRole('table', { name: 'Table view' }).getByRole('columnheader')).toHaveCount(2)
  expect(await readFile(value.file, 'utf8')).toBe(DOCUMENT)
})

test('cell discussion uses the exact row and hidden review targets reveal temporarily through find, F7, F8, and rail clicks', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, DOCUMENT, 'table-discussion.md')
  const page = await value.launch()
  const block = page.locator('.strata-table-block')
  await block.locator('.strata-source-table td').filter({ hasText: 'Unprotected' }).first().click()
  await block.getByRole('button', { name: 'Discuss cell' }).click()
  const composer = page.locator('.annotation-composer')
  await expect(composer).toContainText('Islands · Column 2: Verdict')
  await composer.getByRole('textbox', { name: 'Annotation text' }).fill('What protects this island?')
  await composer.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('dialog', { name: 'question thread' })).toBeVisible()
  const annotation = await page.evaluate(async () => (await window.strata.getState()).activeDocument?.annotations[0])
  expect(annotation).toMatchObject({
    kind: 'question',
    quote: '| Alpha | Unprotected | 12 |',
    context: { kind: 'table-cell', heading: 'Islands', columns: ['Name', 'Verdict', 'Score'], column: { index: 1, label: 'Verdict' } },
  })
  await page.getByRole('button', { name: 'Close thread' }).click()

  await block.locator('.strata-source-table td').filter({ hasText: 'Gamma' }).click()
  await block.getByRole('button', { name: 'Discuss row' }).click()
  await expect(composer).toContainText('Islands · Complete table row')
  await composer.getByRole('textbox', { name: 'Annotation text' }).fill('Check the complete record.')
  await composer.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('dialog', { name: 'question thread' })).toBeVisible()
  const rowAnnotation = await page.evaluate(async () => (await window.strata.getState()).activeDocument?.annotations.find((item) => item.context?.kind === 'table-row'))
  expect(rowAnnotation).toMatchObject({
    quote: '| Gamma | Unprotected | 20 |',
    context: { kind: 'table-row', heading: 'Islands', columns: ['Name', 'Verdict', 'Score'], column: null },
  })
  await page.getByRole('button', { name: 'Close thread' }).click()

  const initial = await value.attach('agent-table', 'Table Agent')
  expect(initial.annotations?.[0]).toMatchObject({ id: annotation?.id, quote: '| Alpha | Unprotected | 12 |' })
  expect(initial.annotations?.[0]?.context).toEqual(annotation?.context)
  expect(initial.text).toContain('[Table under Islands; columns Name, Verdict, Score; column 2 Verdict]')

  const changed = DOCUMENT.replace('| Beta | Ready | 3 |', '| Beta | Needs review | 3 |')
  const state = await value.state()
  await value.atomicWrite(state.buffer!, changed)
  await expect(page.getByRole('tab', { name: /^Changes/ }).locator('.rail-tab-count')).toHaveText('1')
  await showTableOptions(block)
  await block.getByRole('combobox', { name: 'Sort table' }).selectOption({ label: 'Score, descending' })
  await expect(block.locator('.strata-source-table')).toBeHidden()
  await expect(block).toHaveAttribute('data-hidden-review-count', '3')
  await expect(block.getByText('3 review items hidden')).toBeVisible()

  await page.keyboard.press('F7')
  await expect(block.locator('.strata-source-table')).toBeVisible()
  await expect(block.getByRole('button', { name: 'Return to table view' })).toBeVisible()
  await block.getByRole('button', { name: 'Return to table view' }).click()

  await page.keyboard.press('F8')
  await expect(page.getByRole('dialog', { name: 'question thread' })).toBeVisible()
  await expect(block.locator('.strata-source-table')).toBeVisible()
  await page.getByRole('button', { name: 'Close thread' }).click()
  await block.getByRole('button', { name: 'Return to table view' }).click()

  await page.keyboard.press(primaryKey('f'))
  await page.getByRole('textbox', { name: 'Find in document' }).fill('Unprotected')
  await expect(block.locator('.strata-source-table')).toBeVisible()
  await page.getByRole('button', { name: 'Close find' }).click()
  await block.getByRole('button', { name: 'Return to table view' }).click()

  await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
  await page.locator('.annotation-row').first().click()
  await expect(block.locator('.strata-source-table')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'question thread' })).toBeVisible()
  await page.getByRole('button', { name: 'Close thread' }).click()
  await block.getByRole('button', { name: 'Return to table view' }).click()

  await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Changes/ }).click()
  await page.locator('.change-row').first().click()
  await expect(block.locator('.strata-source-table')).toBeVisible()
  await page.getByRole('heading', { name: 'Close', exact: true }).click()
  await expect(block.locator('.strata-source-table')).toBeHidden()
  expect(await readFile(value.file, 'utf8')).toBe(DOCUMENT)
})

test('a blank header cell accepts table state and survives reopen', async ({}, testInfo) => {
  const source = '# Blank header\n\n| | Alpha | Beta |\n|---|---|---|\n| One | 2 | 3 |\n| Two | 1 | 4 |\n'
  value = await Scenario.create(testInfo, source, 'blank-header.md')
  let page = await value.launch()
  let block = page.locator('.strata-table-block')
  await block.locator('td').filter({ hasText: 'One' }).click()
  await showTableOptions(block)
  await block.getByRole('combobox', { name: 'Sort table' }).selectOption('1:ascending')
  await expect(block.locator('.strata-source-table')).toBeHidden()
  const tableView = await page.evaluate(async () => (await window.strata.getState()).activeDocument!.reading.tables[0]!)
  await page.evaluate(async ({ path, tableView }) => {
    await window.strata.updateTableView(path, { ...tableView, focusedRow: 99, focusedColumn: 1, selectedRows: [0, 99] })
  }, { path: value.file, tableView })
  await expect(block.getByRole('button', { name: 'Discuss row' })).toBeDisabled()
  await expect(block.getByRole('button', { name: 'Discuss cell' })).toBeDisabled()
  await value.stop()
  page = await value.launch()
  block = page.locator('.strata-table-block')
  await expect(block.locator('.strata-source-table')).toBeHidden()
  await expect(block).toHaveAttribute('data-focused-row', '')
  await expect(block).toHaveAttribute('data-focused-column', '')
  await showTableOptions(block)
  await expect(block.getByRole('combobox', { name: 'Sort table' })).toHaveValue('1:ascending')
  expect(await page.evaluate(async () => (await window.strata.getState()).activeDocument?.reading.tables[0]?.selectedRows)).toEqual([0])
})
