import { expect, test } from '@playwright/test'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, projectRoot } from './harness'

const clip = (value: string | null | undefined): string => value ? `${value.slice(0, 40)}...${value.slice(-24)}` : String(value)
const norm = (value: string): string => value.replace(/\s+/g, ' ').trim()
const log = (step: string): void => console.log(`[${new Date().toISOString().slice(11, 23)}] ${step}`)

type Page = import('@playwright/test').Page

async function run(testInfo: import('@playwright/test').TestInfo, typeFirst: string | null, andThen?: (page: Page, value: Scenario) => Promise<void>) {
  test.setTimeout(120_000)
  const sample = await readFile(join(projectRoot, 'test/corpus/real/strata-product-page.md'), 'utf8')
  const value = await Scenario.create(testInfo, sample, 'strata.md')
  await mkdir(join(dirname(dirname(value.file)), 'screenshots'), { recursive: true })
  await cp(join(projectRoot, 'docs/screenshots'), join(dirname(dirname(value.file)), 'screenshots'), { recursive: true })
  try {
    const page = await value.launch()
    log('launched')
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toBeVisible()
    await page.waitForTimeout(1000)

    const caretAt = async (selector: (blocks: Element[]) => Element, offset = 0) => page.evaluate(([selectorSource, offset]) => {
      const pick = new Function('blocks', `return (${selectorSource})(blocks)`) as (blocks: Element[]) => Element
      const blocks = [...document.querySelectorAll('.strata-prosemirror > *')]
      const block = pick(blocks)
      block.scrollIntoView({ block: 'center' })
      const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode() as Text
      const range = document.createRange()
      range.setStart(text, offset); range.setEnd(text, offset)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + 1, y: rect.top + rect.height / 2 }
    }, [selector.toString(), offset] as const)

    if (typeFirst) {
      const point = await caretAt((blocks) => blocks.find((el) => el.tagName === 'P')!)
      await page.mouse.click(point.x, point.y)
      await page.keyboard.press('Home')
      await page.keyboard.type(typeFirst)
      await page.waitForTimeout(800)
      log(`typed ${typeFirst.length} chars at the start of the first paragraph`)
    }

    // Drag from the start of "StrataMD itself makes no network calls..." to the start of the "Project status" heading.
    const { from, to } = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('.strata-prosemirror > *')]
      const start = blocks.find((el) => el.textContent?.startsWith('StrataMD itself makes no network calls'))!
      const heading = blocks.find((el) => el.tagName === 'H2' && el.textContent === 'Project status')!
      start.scrollIntoView({ block: 'center' })
      const point = (block: Element) => {
        const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode() as Text
        const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 0)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + 1, y: rect.top + rect.height / 2 }
      }
      return { from: point(start), to: point(heading) }
    })
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const selected = await page.evaluate(() => document.getSelection()?.toString() ?? '')
    log(`dragged; browser selection = ${JSON.stringify(clip(selected))}`)

    const menu = page.getByRole('menu', { name: /annotate selection/i })
    await menu.waitFor({ state: 'visible', timeout: 10_000 })
    const box = (await page.locator('.selection-menu button').first().boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    log('clicked Comment')
    const composer = page.locator('.annotation-composer')
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    const composerQuote = await composer.locator('blockquote').textContent()
    await composer.locator('textarea').fill('probe comment')
    await page.evaluate(() => (document.querySelector('.annotation-composer') as HTMLFormElement).requestSubmit())
    await composer.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.waitForTimeout(800)
    log('submitted comment')

    const highlight = await page.evaluate(() => [...document.querySelectorAll('.strata-annotation[data-annotation-author="user"]')].map((el) => el.textContent).join(''))
    const state = await value.state()
    const stored = state.annotations?.find((a) => a.text === 'probe comment')
    const result = { typeFirst: typeFirst?.length ?? 0, selected: clip(selected), composerQuote: clip(composerQuote), storedQuote: clip(stored?.quote), highlight: clip(highlight) }
    console.log(JSON.stringify(result, null, 1))
    await andThen?.(page, value)
    return { selected, composerQuote, storedQuote: stored?.quote, highlight }
  } finally {
    await value.dispose()
  }
}

test('control: comment without prior edits', async ({}, testInfo) => {
  const r = await run(testInfo, null)
  expect(norm(r.highlight)).toBe(norm(r.selected))
})

test('after typing 63 chars above, comment highlight lands where it was selected', async ({}, testInfo) => {
  const r = await run(testInfo, 'x'.repeat(63))
  expect(norm(r.highlight)).toBe(norm(r.selected))
})

test('dragging the end handle moves the stored quote to the new span', async ({}, testInfo) => {
  let storedAfter: string | undefined
  let highlightAfter = ''
  await run(testInfo, null, async (page, value) => {
    // Open the thread by clicking the highlight; the handles appear on the selected annotation.
    const highlight = page.locator('.strata-annotation[data-annotation-author="user"]').first()
    await highlight.click({ force: true })
    const endHandle = page.locator('.strata-annotation-handle--end .strata-annotation-handle__grip')
    await endHandle.waitFor({ state: 'visible', timeout: 5_000 })
    const grip = (await endHandle.boundingBox())!
    const target = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('.strata-prosemirror > p')].find((el) => el.textContent?.startsWith('StrataMD is an early-stage'))!
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      while (walker.nextNode()) last = walker.currentNode as Text
      const range = document.createRange(); range.setStart(last!, last!.length); range.setEnd(last!, last!.length)
      const rect = range.getBoundingClientRect()
      // Drop a little past the last glyph so the position resolves after it, as a user aiming for the line end would.
      return { x: rect.left + 8, y: rect.top + rect.height / 2 }
    })
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move((grip.x + target.x) / 2, (grip.y + target.y) / 2, { steps: 6 })
    await page.mouse.move(target.x, target.y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(1000)
    log('dragged the end handle to the end of the Project status paragraph')
    highlightAfter = await page.evaluate(() => [...document.querySelectorAll('.strata-annotation[data-annotation-author="user"]')].map((el) => el.textContent).join(''))
    const state = await value.state()
    storedAfter = state.annotations?.find((a) => a.text === 'probe comment')?.quote
    console.log(JSON.stringify({ storedAfter: clip(storedAfter), highlightAfter: clip(highlightAfter) }, null, 1))
    await page.screenshot({ path: '/tmp/strata-repro/after-drag.png' })
  })
  expect(storedAfter).toMatch(/^StrataMD itself makes no network calls/)
  expect(storedAfter).toMatch(/Windows build yet\.$/)
  expect(norm(highlightAfter)).toMatch(/^StrataMD itself makes no network calls.*Windows build yet\.$/)
})
