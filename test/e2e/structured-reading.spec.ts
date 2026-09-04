import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, setSource } from './harness'

const filler = (label: string) => Array.from({ length: 18 }, (_, index) => `${label} paragraph ${index + 1} keeps the document tall enough to exercise centered navigation.`).join('\n\n')
const DOCUMENT = `# Reading guide

${filler('Opening')}

## Alpha

${filler('Alpha')}

### Alpha detail

${filler('Detail')}

#### Deep note

${filler('Deep')}

## Beta

${filler('Beta')}
`

let value: Scenario
test.afterEach(async () => { await value?.dispose() })

test('tab hosts preserve the shell, expose counts, and keep Agents visible while Changes is pinned', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, '# Review\n\nOriginal sentence.\n')
  await value.writeSettings({ panels: { upperReviewHeight: 954 } })
  const page = await value.launch()

  const navigation = page.getByRole('tablist', { name: 'Document navigation' })
  const review = page.getByRole('tablist', { name: 'Document review' })
  await expect(navigation.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  await expect(review.getByRole('tab', { name: /^Changes/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Attached' })).toBeVisible()
  await expect(page.getByText('None attached', { exact: true })).toBeVisible()

  expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
  const state = await value.state()
  await value.atomicWrite(state.buffer!, '# Review\n\nAgent proposal.\n')
  await expect(review.getByRole('tab', { name: /^Changes/ }).locator('.rail-tab-count')).toHaveText('1')
  await expect(page.getByText('1 attached', { exact: true })).toBeVisible()

  const annotations = review.getByRole('tab', { name: /^Annotations/ })
  await annotations.focus()
  await page.keyboard.press('Home')
  await expect(review.getByRole('tab', { name: /^Changes/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(annotations).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Pin changes' }).click()
  const pinned = page.getByLabel('Pinned changes')
  await expect(pinned).toBeVisible()
  expect((await pinned.boundingBox())!.height).toBeLessThanOrEqual(155)
  await pinned.getByRole('button').first().click()
  await expect(review.getByRole('tab', { name: /^Changes/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Attached' })).toBeVisible()
  expect((await page.locator('.agents-panel').boundingBox())!.height).toBeGreaterThanOrEqual(140)
})

test('Contents follows the live document, centers jumps, and restores each document selection', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, DOCUMENT, 'guide.md')
  const second = join(dirname(value.file), 'plain.md')
  await writeFile(second, 'No headings here.\n')
  const page = await value.launch()
  const navigation = page.getByRole('tablist', { name: 'Document navigation' })
  const review = page.getByRole('tablist', { name: 'Document review' })

  const files = navigation.getByRole('tab', { name: 'Files' })
  await files.focus()
  await page.keyboard.press('ArrowRight')
  await expect(navigation.getByRole('tab', { name: 'Contents' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /Reading guide/ })).toBeVisible()
  // H2 rows are the primary route; deeper headings appear beneath the active or explicitly expanded section.
  await expect(page.getByRole('treeitem')).toHaveCount(2)
  await expect(page.getByRole('treeitem').nth(0)).toHaveAttribute('aria-level', '2')
  await page.getByRole('button', { name: 'Show subsections of Alpha' }).click()
  await expect(page.getByRole('treeitem')).toHaveCount(4)
  await expect(page.getByRole('treeitem').nth(1)).toHaveAttribute('aria-level', '3')
  await expect(page.getByRole('treeitem').nth(2)).toHaveAttribute('aria-level', '4')

  const alphaFold = page.locator('.strata-fold-heading').filter({ has: page.getByRole('heading', { name: 'Alpha', exact: true }) })
  await alphaFold.getByRole('button', { name: 'Collapse section' }).click()
  const transactionTime = await page.locator('html').getAttribute('data-editor-transaction-ms')
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await page.locator('html').getAttribute('data-editor-transaction-ms')).toBe(transactionTime)
  await expect(page.getByRole('heading', { name: 'Alpha detail', exact: true })).toBeHidden()
  await page.getByRole('button', { name: /^Alpha detail/ }).click()
  await expect(page.getByRole('heading', { name: 'Alpha detail', exact: true })).toBeVisible()
  await expect(alphaFold).toContainText('Temporarily open')

  const before = await value.state()
  const deep = page.getByRole('button', { name: /Deep note/ })
  await deep.click()
  await expect(deep).toHaveAttribute('aria-current', 'location')
  const centered = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.editor-scroll')!
    const heading = [...document.querySelectorAll<HTMLElement>('.ProseMirror h4')].find((node) => node.textContent === 'Deep note')!
    const bounds = scroll.getBoundingClientRect()
    return Math.abs(heading.getBoundingClientRect().top - (bounds.top + bounds.height / 2))
  })
  expect(centered).toBeLessThan(36)
  expect((await value.state()).buffer).toBe(before.buffer)

  const edited = DOCUMENT.replace('#### Deep note', '#### Live heading')
  await setSource(page, edited)
  await value.waitForBuffer(edited)
  await expect(page.getByRole('button', { name: /Live heading/ })).toBeVisible()
  expect(Number(await page.locator('html').getAttribute('data-heading-index-ms'))).toBeLessThan(50)

  await review.getByRole('tab', { name: /^Annotations/ }).click()
  await page.evaluate(async (path) => window.strata.openDocument(path), second)
  await expect(navigation.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  await expect(review.getByRole('tab', { name: /^Changes/ })).toHaveAttribute('aria-selected', 'true')
  await navigation.getByRole('tab', { name: 'Contents' }).click()
  await expect(page.getByText('This document has no headings.')).toBeVisible()

  await page.getByRole('tab', { name: /guide\.md/i }).click()
  await expect(navigation.getByRole('tab', { name: 'Contents' })).toHaveAttribute('aria-selected', 'true')
  await expect(review.getByRole('tab', { name: /^Annotations/ })).toHaveAttribute('aria-selected', 'true')
  await value.stop()

  const restarted = await value.launch()
  await expect(restarted.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' })).toHaveAttribute('aria-selected', 'true')
  await expect(restarted.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ })).toHaveAttribute('aria-selected', 'true')
  expect(await readFile(value.file, 'utf8')).toBe(DOCUMENT)
})
