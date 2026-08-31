import { expect, test } from '@playwright/test'
import { Scenario } from './harness'

// Right-click annotates without dragging a selection: the word under the
// cursor becomes the anchor, the annotate menu opens on it, and the gesture
// works again on the same word after the menu was dismissed with Escape.
test('right-click selects the word under the cursor and opens the annotate menu', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const target = 'gamma'
  const sample = `Alpha beta ${target} delta.\n\nSecond paragraph.\n`

  const scenario = await Scenario.create(testInfo, sample, 'right-click.md')
  try {
    const page = await scenario.launch()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    await page.waitForTimeout(1_500)

    const point = await page.evaluate((needle) => {
      const paragraphs = [...document.querySelectorAll('.strata-prosemirror p')]
      const paragraph = paragraphs.find((el) => el.textContent?.includes(needle))!
      paragraph.scrollIntoView({ block: 'center' })
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      let start = -1
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        const found = candidate.data.indexOf(needle)
        if (found >= 0) { node = candidate; start = found }
      }
      const range = document.createRange()
      const middle = start + Math.floor(needle.length / 2)
      range.setStart(node!, middle); range.setEnd(node!, middle)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + 1, y: rect.top + rect.height / 2 }
    }, target)
    await page.mouse.click(point.x, point.y, { button: 'right' })

    const menu = page.getByRole('menu', { name: /annotate selection/i })
    await menu.waitFor({ state: 'visible', timeout: 10_000 })

    // Escape dismisses; the same explicit gesture must bring the menu back.
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await menu.waitFor({ state: 'visible', timeout: 10_000 })

    await page.locator('.selection-menu button').first().click()
    const composer = page.locator('.annotation-composer')
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    expect((await composer.locator('blockquote').textContent()) ?? '').toBe(target)
    await composer.locator('textarea').fill('right-click comment')
    await page.evaluate(() => (document.querySelector('.annotation-composer') as HTMLFormElement).requestSubmit())
    await composer.waitFor({ state: 'hidden', timeout: 10_000 })

    await expect.poll(async () => {
      const state = await scenario.state()
      return state.annotations?.find((a) => a.text === 'right-click comment')?.quote ?? ''
    }, { timeout: 10_000 }).toBe(target)
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
  } finally {
    await scenario.dispose()
  }
})
