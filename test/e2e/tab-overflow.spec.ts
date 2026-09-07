import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, expectActiveDocument, openDocsMenu } from './harness'

// Open documents stay in a vertically scrolling menu; the icon bar stays compact.
let value: Scenario
test.afterEach(async () => { await value?.dispose() })

async function openDocuments(testInfo: TestInfo, count: number): Promise<Page> {
  value = await Scenario.create(testInfo, '# One\n')
  const page = await value.launch()
  await page.setViewportSize({ width: 1100, height: 760 })
  for (let i = 2; i <= count; i += 1) {
    const file = join(dirname(value.file), `meeting-notes-${String(i).padStart(2, '0')}.md`)
    await writeFile(file, `# Doc ${i}\n`)
    await page.evaluate((path) => window.strata.openDocument(path), file)
  }
  await openDocsMenu(page)
  await expect(page.getByRole('menu', { name: 'Open docs' }).getByRole('menuitem')).toHaveCount(count)
  return page
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Open docs', exact: true })

test('many open documents scroll vertically without expanding the top bar', async ({}, testInfo) => {
  const page = await openDocuments(testInfo, 24)
  const metrics = await menu(page).evaluate(el => ({
    scrollable: el.scrollHeight > el.clientHeight,
    rowHeights: [...el.children].map(row => row.getBoundingClientRect().height)
  }))
  expect(metrics.scrollable).toBe(true)
  for (const height of metrics.rowHeights) expect(height).toBeLessThan(50)
  expect(await page.locator('.topbar').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false)
})

test('keyboard navigation reaches both ends of the open-document menu', async ({}, testInfo) => {
  const page = await openDocuments(testInfo, 24)
  await page.keyboard.press('End')
  const last = menu(page).getByRole('menuitem', { name: 'meeting-notes-24.md', exact: true })
  await expect(last).toBeFocused()
  await expect.poll(() => menu(page).evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('Home')
  const first = menu(page).getByRole('menuitem', { name: 'scenario.md', exact: true })
  await expect(first).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu(page)).toBeHidden()
  await expectActiveDocument(page, /scenario\.md/)
})

test('a vertical wheel scrolls the open-document list', async ({}, testInfo) => {
  const page = await openDocuments(testInfo, 24)
  await menu(page).hover()
  await page.mouse.wheel(0, 120)
  await expect.poll(() => menu(page).evaluate(el => el.scrollTop)).toBeGreaterThan(0)
})

test('one long file name truncates in the menu and keeps its full path tooltip', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, '# One\n')
  const page = await value.launch()
  const file = join(dirname(value.file), 'quarterly-planning-meeting-notes-with-follow-ups-and-decisions.md')
  await writeFile(file, '# Long\n')
  await page.evaluate(path => window.strata.openDocument(path), file)
  await openDocsMenu(page)
  const item = menu(page).getByRole('menuitem', { name: /quarterly-planning/i })
  await expect(item).toHaveAttribute('aria-current', 'true')
  const title = item.locator('.tab-name')
  await expect(title).toHaveCSS('text-overflow', 'ellipsis')
  expect(await title.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
  await expect(item).toHaveAttribute('title', file)
})
