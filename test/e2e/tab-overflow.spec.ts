import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario } from './harness'

/**
 * With more open documents than fit across the window, tabs keep their
 * natural single-line size and the strip scrolls sideways; tabs never
 * shrink, wrap onto multiple lines, or get clipped out of reach.
 */
let value: Scenario
test.afterEach(async () => { await value?.dispose() })

async function openDocuments(testInfo: TestInfo, count: number): Promise<Page> {
  value = await Scenario.create(testInfo, '# One\n')
  const page = await value.launch()
  for (let i = 2; i <= count; i += 1) {
    const file = join(dirname(value.file), `meeting-notes-${String(i).padStart(2, '0')}.md`)
    await writeFile(file, `# Doc ${i}\n`)
    await page.evaluate((path) => window.strata.openDocument(path), file)
  }
  await expect(page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')).toHaveCount(count)
  return page
}

function strip(page: Page) {
  return page.locator('.tabs')
}

test('overflowing tabs scroll sideways instead of squishing', async ({}, testInfo) => {
  const page = await openDocuments(testInfo, 12)
  const metrics = await strip(page).evaluate((el) => ({
    scrollable: el.scrollWidth > el.clientWidth,
    tabHeights: [...el.children].map((tab) => tab.getBoundingClientRect().height)
  }))
  expect(metrics.scrollable).toBe(true)
  // A squished tab wraps its name onto multiple lines and doubles in height.
  for (const height of metrics.tabHeights) expect(height).toBeLessThan(50)
})

test('the active tab is scrolled into view when it changes', async ({}, testInfo) => {
  const page = await openDocuments(testInfo, 12)
  const lastTab = page.getByRole('tab', { name: /meeting-notes-12\.md/i })
  await expect(lastTab).toHaveAttribute('aria-selected', 'true')
  const visible = async (tab: typeof lastTab) => {
    const [tabBox, stripBox] = [await tab.boundingBox(), await strip(page).boundingBox()]
    return tabBox!.x >= stripBox!.x - 1 && tabBox!.x + tabBox!.width <= stripBox!.x + stripBox!.width + 1
  }
  expect(await visible(lastTab)).toBe(true)

  // Reactivating the first document scrolls its tab back into view.
  await page.evaluate((path) => window.strata.openDocument(path), value.file)
  const firstTab = page.getByRole('tab', { name: /scenario\.md/i })
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
  expect(await visible(firstTab)).toBe(true)
})

test('a vertical wheel over the strip scrolls it sideways', async ({}, testInfo) => {
  const page = await openDocuments(testInfo, 12)
  await page.evaluate((path) => window.strata.openDocument(path), value.file)
  await expect(page.getByRole('tab', { name: /scenario\.md/i })).toHaveAttribute('aria-selected', 'true')
  await strip(page).hover()
  await page.mouse.wheel(0, 120)
  await expect.poll(() => strip(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
})

test('one long file name is capped with an ellipsis instead of eating the strip', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, '# One\n')
  const page = await value.launch()
  const file = join(dirname(value.file), 'quarterly-planning-meeting-notes-with-follow-ups-and-decisions.md')
  await writeFile(file, '# Long\n')
  await page.evaluate((path) => window.strata.openDocument(path), file)
  const tab = page.getByRole('tab', { name: /quarterly-planning/i })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  expect((await tab.boundingBox())!.width).toBeLessThanOrEqual(222)
  // The full name stays reachable as a tooltip.
  await expect(tab).toHaveAttribute('title', 'quarterly-planning-meeting-notes-with-follow-ups-and-decisions.md')
})
