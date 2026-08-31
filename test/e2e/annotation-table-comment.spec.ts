import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario, projectRoot } from './harness'

// A selection inside a table cell used to map to no source range at all: the
// rendered-to-source character walk consumed a real newline for the virtual
// separator between cells, stranding every later cell of the row. The
// annotate menu then silently never appeared for table text.
test('a comment lands on text selected inside a table cell', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const sample = await readFile(join(projectRoot, 'test/corpus/real/strata-product-page.md'), 'utf8')
  const target = 'Multiple agents can attach'
  expect(sample.includes(target)).toBe(true)

  const scenario = await Scenario.create(testInfo, sample, 'strata.md')
  try {
    const page = await scenario.launch()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    await page.waitForTimeout(1_500)

    // A real mouse drag across the cell text, as a user would select it.
    const points = await page.evaluate((needle) => {
      const cells = [...document.querySelectorAll('.strata-prosemirror td')]
      const cell = cells.find((el) => el.textContent?.includes(needle))!
      cell.scrollIntoView({ block: 'center' })
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      let start = -1
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        const found = candidate.data.indexOf(needle)
        if (found >= 0) { node = candidate; start = found }
      }
      const at = (offset: number) => {
        const range = document.createRange()
        range.setStart(node!, offset); range.setEnd(node!, offset)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + 1, y: rect.top + rect.height / 2 }
      }
      return { from: at(start), to: at(start + needle.length) }
    }, target)
    await page.mouse.move(points.from.x, points.from.y)
    await page.mouse.down()
    await page.mouse.move((points.from.x + points.to.x) / 2, (points.from.y + points.to.y) / 2, { steps: 5 })
    await page.mouse.move(points.to.x, points.to.y, { steps: 5 })
    await page.mouse.up()

    const menu = page.getByRole('menu', { name: /annotate selection/i })
    await menu.waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('.selection-menu button').first().click()
    const composer = page.locator('.annotation-composer')
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    const composerQuote = (await composer.locator('blockquote').textContent()) ?? ''
    expect(composerQuote).toContain(target)
    await composer.locator('textarea').fill('table cell comment')
    await page.evaluate(() => (document.querySelector('.annotation-composer') as HTMLFormElement).requestSubmit())
    await composer.waitFor({ state: 'hidden', timeout: 10_000 })

    await expect.poll(async () => {
      const state = await scenario.state()
      return state.annotations?.find((a) => a.text === 'table cell comment')?.quote ?? ''
    }, { timeout: 10_000 }).toContain(target)
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
  } finally {
    await scenario.dispose()
  }
})
