import { expectDocumentListed } from './harness'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { projectRoot, Scenario } from './harness'

/**
 * Visual acceptance for the structured-reading recovery (docs/design/structured-reading).
 * Fixed data, disabled motion, the shipped Strata Vivid theme, and the same
 * viewports as the prototype captures. Pixel baselines cover the shell, Contents,
 * the table header, and the component sampler; everything dynamic is asserted
 * through the interaction checks that follow.
 */
const fixtures = join(projectRoot, 'test/fixtures/structured-reading')
const captureRoot = process.env.STRATAMD_VISUAL_CAPTURES ? resolve(process.env.STRATAMD_VISUAL_CAPTURES) : null
const SNAPSHOT = { maxDiffPixelRatio: 0.03, animations: 'disabled' as const, caret: 'hide' as const }
const VIEWPORT = { width: 1600, height: 900 }

async function capture(page: Page, name: string, target: Locator | null = null): Promise<void> {
  const path = captureRoot ? join(captureRoot, `${name}.png`) : test.info().outputPath(`${name}.png`)
  await mkdir(dirname(path), { recursive: true })
  if (target) await target.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, animations: 'disabled' })
}

function masks(page: Page): Locator[] {
  // Relative times and the save-state sentence move with the clock.
  return [page.locator('.save-state-footer'), page.locator('.agent-detail small'), page.locator('.change-time')]
}

let value: Scenario
test.afterEach(async () => { await value?.dispose() })

test('the Mesa-style review reads as numbered sections with Contents, the walkthrough bar, composed tables, and populated review cards', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const review = await readFile(join(fixtures, 'dense-review.md'), 'utf8')
  value = await Scenario.create(testInfo, review, 'mesa-review.md')
  const directory = dirname(value.file)
  const components = join(directory, 'mesa-review-components.md')
  await copyFile(join(fixtures, 'dense-review-components.md'), components)
  await value.writeSettings({
    theme: 'strata-vivid',
    animatedBackground: false,
    panels: { explorerWidth: 274, rightRailWidth: 365, upperReviewHeight: 520, documentMeasure: 1600 },
  })
  const page = await value.launch()
  await page.setViewportSize(VIEWPORT)
  const editor = page.getByRole('textbox', { name: 'Document editor' })
  await expect(editor).toBeVisible()

  // Populate the review column: one outside change, one decision, one question, one suggestion.
  const state = await value.inspectDocument()
  await value.atomicWrite(state.buffer!, review.replace('The process spends almost all of its weight on the prose.', 'The written process spends almost all of its weight on the prose.'))
  await expect(page.getByRole('tab', { name: /^Changes/ }).locator('.rail-tab-count')).toHaveText('1')
  for (const annotation of [
    { kind: 'decision' as const, quote: '## 6. CI and release gates', text: 'Should deploys wait for green CI?', options: ['Gate deploys', 'Informational'] },
    { kind: 'question' as const, quote: 'The rules it needs fit in about 5,000.', text: 'Is 5,000 tokens a hard target or a useful comparison?' },
    { kind: 'suggestion' as const, quote: 'Make the gate mechanical.', text: 'Make the gate mechanical and visible.' },
  ]) {
    const from = review.indexOf(annotation.quote)
    await page.evaluate(async ({ path, annotation, from }) => {
      if (annotation.kind === 'decision') {
        await window.strata.addAnnotation(path, { ...annotation, from, to: from + annotation.quote.length, anchor: 'heading' })
      } else {
        await window.strata.addAnnotation(path, { ...annotation, from, to: from + annotation.quote.length })
      }
    }, { path: value.file, annotation, from })
  }

  // Contents and the walkthrough.
  const navigation = page.getByRole('tablist', { name: 'Document navigation' })
  await navigation.getByRole('tab', { name: 'Contents' }).click()
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  const card = page.getByLabel('Walkthrough controls')
  await expect(card).toContainText('Section 1 of 7')
  await expect(card).toContainText('1. Verdict')
  await expect(card).toContainText("Mesa's product is strong")
  const bar = page.getByRole('group', { name: 'Walkthrough progress' })
  await expect(bar).toContainText('01 / 07')
  await expect(bar.getByRole('button', { name: 'Reviewed' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Revisit' })).toBeVisible()
  // H2 mode shows include controls only for H2 steps; H3 rows never carry them here.
  await expect(page.getByRole('button', { name: 'Remove 1. Verdict from walkthrough' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Remove 3\.1 What exists.*from walkthrough/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show subsections of 3. Islands: the ownership model' }).click()
  await expect(page.getByRole('button', { name: /3\.1 What exists/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Remove 3\.1 What exists.*from walkthrough/ })).toHaveCount(0)
  await card.getByRole('radio', { name: 'H2 + H3' }).click()
  await expect(page.getByRole('button', { name: 'Remove 3.1 What exists from walkthrough' })).toBeVisible()
  await card.getByRole('radio', { name: 'H2', exact: true }).click()
  await page.getByRole('button', { name: 'Hide subsections of 3. Islands: the ownership model' }).click()
  await expect(page.locator('.strata-fold-heading:has(> h2)').first()).toHaveCSS('counter-increment', /strata-section/)

  // The review column: Annotations with populated cards and a visible Agents window.
  const reviewTabs = page.getByRole('tablist', { name: 'Document review' })
  await reviewTabs.getByRole('tab', { name: /^Items/ }).click()
  const decision = page.locator('.annotation-row.kind-decision')
  await expect(decision).toContainText('Should deploys wait for green CI?')
  await expect(decision.locator('.decision-chips > span')).toHaveCount(2)
  await expect(page.locator('.annotation-row.kind-question .quote-mini')).toContainText('5,000')
  await expect(page.getByRole('heading', { name: 'Attached' })).toBeVisible()
  await expect(page.getByText('None attached', { exact: true })).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await capture(page, 'shell-walkthrough-annotations')
  await expect(page).toHaveScreenshot('shell-walkthrough-annotations.png', { ...SNAPSHOT, mask: masks(page) })
  await expect(page.locator('.navigation-rail')).toHaveScreenshot('contents-walkthrough.png', SNAPSHOT)

  await reviewTabs.getByRole('tab', { name: /^Changes/ }).click()
  await expect.poll(() => page.locator('.changes-panel .change-row').count()).toBeGreaterThanOrEqual(2)
  await expect(page.locator('.changes-panel .change-avatar').first()).toBeVisible()
  await capture(page, 'shell-changes-tab')
  await reviewTabs.getByRole('tab', { name: /^Items/ }).click()
  await page.getByRole('button', { name: 'Pin changes' }).click()
  const pinned = page.getByLabel('Pinned changes')
  await expect(pinned).toContainText('Pinned changes')
  expect((await pinned.boundingBox())!.height).toBeLessThanOrEqual(155)
  await expect(page.getByRole('heading', { name: 'Attached' })).toBeVisible()
  expect((await page.locator('.agents-panel').boundingBox())!.height).toBeGreaterThanOrEqual(140)
  await capture(page, 'shell-pinned-changes')
  await page.getByRole('button', { name: 'Pin changes' }).click()

  // Tables: the product-islands table in its default, Focus row, and Compare views.
  await page.getByRole('button', { name: '2. What Mesa is, in one page per island', exact: true }).click()
  await expect(card).toContainText('Section 2 of 7')
  const islands = page.locator('.strata-table-block').filter({ hasText: 'Address and job' })
  const head = islands.locator('.strata-table-head')
  await expect(head.locator('.strata-table-title')).toHaveText('2. What Mesa is, in one page per island')
  await expect(head.locator('.strata-table-count')).toHaveText('8 rows')
  await expect(head.getByRole('group', { name: 'Table presentation' }).getByRole('button')).toHaveCount(3)
  await expect(islands.locator('.strata-table-utilities')).toBeHidden()
  await expect(islands.getByRole('button', { name: 'Discuss row' })).toHaveCount(0)
  expect(await head.getByRole('button').count()).toBeLessThanOrEqual(6)
  await capture(page, 'table-default')
  await expect(head).toHaveScreenshot('table-header.png', SNAPSHOT)

  await islands.locator('.strata-source-table td').filter({ hasText: /^Sales$/ }).click()
  await expect(islands.locator('.strata-table-utilities')).toBeVisible()
  await expect(islands.getByRole('button', { name: 'Discuss row' })).toBeVisible()
  await islands.getByRole('button', { name: 'Focus row' }).click()
  await expect(islands.locator('.strata-table-focus-row')).toContainText('Sales')
  await expect(islands.locator('.strata-table-focus-row dt').first()).toHaveText('Island')
  await capture(page, 'table-focus-row')

  await islands.getByRole('button', { name: 'Table', exact: true }).click()
  await islands.getByRole('button', { name: 'Select row' }).click()
  await islands.locator('.strata-source-table td').filter({ hasText: /^Measurement$/ }).click()
  await islands.getByRole('button', { name: 'Select row' }).click()
  await islands.getByRole('button', { name: 'Compare' }).click()
  const compared = islands.getByRole('table', { name: 'Compared table rows' })
  await expect(compared.locator('tbody tr')).toHaveCount(2)
  await expect(compared.locator('td[data-label="Owns"]').first()).toBeVisible()
  await expect(head.locator('.strata-table-count')).toHaveText('2 of 8 shown')
  await capture(page, 'table-compare')
  await islands.getByRole('button', { name: 'Table', exact: true }).click()
  expect((await value.inspectDocument()).document).toBe(review.replace('The process spends almost all of its weight on the prose.', 'The written process spends almost all of its weight on the prose.'))
  expect(await readFile(value.file, 'utf8')).toBe(review)

  // The ordered change list as a PhaseBoard, labelled in human copy.
  await page.evaluate(async (path) => window.strata.openDocument(path), components)
  await expectDocumentListed(page, /mesa-review-components\.md/i)
  await navigation.getByRole('tab', { name: 'Contents' }).click()
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  await page.getByRole('button', { name: /3\. Change list, ordered/ }).first().click()
  const phases = page.getByRole('region', { name: 'PhaseBoard: PhaseBoard' })
  await expect(phases.locator('.strata-component__label')).toHaveText('Phases')
  await expect(phases).toHaveCSS('--phase-count', '3')
  const columns = await phases.locator('.strata-component__body h3').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)))
  expect(new Set(columns).size).toBe(3)
  await expect(page.locator('.strata-component__label').filter({ hasText: /PhaseBoard|MetricStrip|EvidenceChain/ })).toHaveCount(0)
  await capture(page, 'phase-board')
})

test('a single document shows all nine approved components with their own visual grammar', async ({}, testInfo) => {
  const sampler = await readFile(join(fixtures, 'component-sampler.md'), 'utf8')
  value = await Scenario.create(testInfo, sampler, 'component-sampler.md')
  const directory = dirname(value.file)
  await copyFile(join(fixtures, 'review-screenshot.png'), join(directory, 'review-screenshot.png'))
  await copyFile(join(fixtures, 'evidence.md'), join(directory, 'evidence.md'))
  // Pin rows carry the copied image's real version so no "image changed" notice appears.
  const details = await stat(join(directory, 'review-screenshot.png'), { bigint: true })
  const written = sampler.replaceAll('| 0:0 |', `| ${details.size}:${details.mtimeNs} |`)
  await writeFile(value.file, written)
  await value.writeSettings({
    theme: 'strata-vivid',
    animatedBackground: false,
    panels: { explorerWidth: 274, rightRailWidth: 365, upperReviewHeight: 520, documentMeasure: 1600 },
  })
  const page = await value.launch()
  await page.setViewportSize({ width: 1600, height: 2600 })
  const editor = page.getByRole('textbox', { name: 'Document editor' })
  const expected: Array<[string, string]> = [
    ['Verdict: recommended', 'Verdict'],
    ['Callout: warning', 'Warning'],
    ['MetricStrip: MetricStrip', 'Metrics'],
    ['PhaseBoard: PhaseBoard', 'Phases'],
    ['DecisionMatrix: DecisionMatrix', 'Decision matrix'],
    ['BeforeAfter: BeforeAfter', 'Before and after'],
    ['Chart: bar', 'Bar chart'],
    ['EvidenceChain: EvidenceChain', 'Evidence'],
    ['AnnotatedScreenshot: AnnotatedScreenshot', 'Annotated screenshot'],
  ]
  for (const [name, label] of expected) {
    const region = editor.getByRole('region', { name })
    await expect(region).toBeVisible()
    await expect(region.locator('.strata-component__label')).toHaveText(label)
  }
  await expect(editor.getByRole('region', { name: 'Verdict: recommended' }).locator('.strata-component__qualifier')).toHaveText('Recommended')
  await expect(editor.getByRole('region', { name: 'Chart: bar' }).getByRole('img', { name: /bar chart/ })).toBeVisible({ timeout: 20_000 })
  await expect(editor.getByRole('region', { name: 'AnnotatedScreenshot: AnnotatedScreenshot' }).getByRole('button', { name: /^Pin 1:/ })).toBeVisible()
  // Components differ in more than an accent color: their bodies take different layouts.
  const layouts = await editor.locator('.strata-component__body').evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node)
    return `${style.display}|${style.columnCount}|${style.paddingLeft}`
  }))
  expect(new Set(layouts).size).toBeGreaterThanOrEqual(4)
  const metricCells = editor.getByRole('region', { name: 'MetricStrip: MetricStrip' }).locator('li')
  const tops = await metricCells.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await capture(page, 'components-sampler')
  await expect(page.locator('.editor-island')).toHaveScreenshot('components-sampler.png', SNAPSHOT)
  expect(await readFile(value.file, 'utf8')).toBe(written)
  const externalResources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => /^https?:/u.test(url)))
  expect(externalResources).toEqual([])
})
