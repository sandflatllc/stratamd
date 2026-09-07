import { expect, test } from './test'
import { dirname, join } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { primaryKey, save, Scenario } from './harness'

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function visualMarkdown(version: string): string {
  return `# Visual review

<DecisionMatrix>
| Criterion | Keep current | Adopt bounded parser |
|---|---|---|
| Byte preservation | Partial | Strong |
| Executable content | Possible | Blocked |
</DecisionMatrix>

<BeforeAfter>
> ### Before
> Manual review.

> ### After
> Tracked review.
</BeforeAfter>

<Chart kind="line">
| Month | Open time | Typing |
|---|---:|---:|
| Jul | 240 | 12.4 |
| Aug | 224 | 9.8 |
</Chart>

<EvidenceChain>
### Claim

Mechanical guards hold better than prose.

### Evidence

- [Local finding](./evidence.md#finding)
- [Review conclusion](#conclusion)

### Therefore

Move the invariant into executable boundaries.
</EvidenceChain>

<AnnotatedScreenshot>
![Review screenshot](./review.png)

| Pin | X | Y | Image version | Note |
|---:|---:|---:|---|---|
| 1 | 24.0 | 31.5 | ${version} | Long rows need a clearer boundary. |
</AnnotatedScreenshot>

## Conclusion

Use the bounded visual set.
`
}

test('extended visuals remain editable, accessible, document-safe, and collaborative', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Preparing\n', 'visual-components.md')
  try {
    const directory = dirname(scenario.file)
    const image = join(directory, 'review.png')
    await writeFile(image, imageBytes)
    const imageDetails = await stat(image, { bigint: true })
    const version = `${imageDetails.size}:${imageDetails.mtimeNs}`
    const original = visualMarkdown(version)
    await writeFile(scenario.file, original)
    await writeFile(join(directory, 'evidence.md'), '# Evidence\n\n## Finding\n\nThe invariant held.\n')

    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    const matrix = editor.getByRole('region', { name: 'DecisionMatrix: DecisionMatrix' })
    const beforeAfter = editor.getByRole('region', { name: 'BeforeAfter: BeforeAfter' })
    const chart = editor.getByRole('region', { name: 'Chart: line' })
    const evidence = editor.getByRole('region', { name: 'EvidenceChain: EvidenceChain' })
    const screenshot = editor.getByRole('region', { name: 'AnnotatedScreenshot: AnnotatedScreenshot' })
    await expect(matrix).toBeVisible()
    await expect(beforeAfter.locator('blockquote')).toHaveCount(2)
    await expect(chart.getByRole('img', { name: /line chart with 2 categories and 2 series/ })).toBeVisible({ timeout: 20_000 })
    await expect(chart.getByRole('table')).toBeVisible()
    await expect(evidence.getByRole('heading', { name: 'Claim' })).toBeVisible()
    await expect(screenshot.getByRole('button', { name: 'Pin 1: Long rows need a clearer boundary.' })).toBeVisible()

    const sides = beforeAfter.locator('blockquote')
    await page.setViewportSize({ width: 960, height: 900 })
    await expect.poll(async () => {
      const boxes = await sides.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))
      return boxes[1]!.top >= boxes[0]!.bottom
    }).toBe(true)
    await page.setViewportSize({ width: 1_600, height: 900 })
    await expect.poll(async () => {
      const boxes = await sides.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))
      return Math.abs(boxes[1]!.top - boxes[0]!.top) < 2
    }).toBe(true)

    await matrix.getByRole('button', { name: 'Focus Adopt bounded parser' }).click()
    await expect(matrix).toHaveAttribute('data-focused-alternative', '3')
    await expect(matrix.locator('tbody td:nth-child(2)').first()).toHaveCSS('opacity', '0.28')
    await expect(matrix.locator('tbody td:nth-child(3)').first()).toHaveCSS('opacity', '1')
    expect((await scenario.inspectDocument()).document).toBe(original)
    await matrix.getByRole('button', { name: 'Show all' }).click()
    await expect(matrix).not.toHaveAttribute('data-focused-alternative')

    await evidence.getByRole('link', { name: 'Local finding' }).click()
    await expect(page.getByRole('dialog', { name: 'Preview ./evidence.md#finding' })).toContainText('The invariant held.')
    await expect(evidence).toHaveAttribute('data-evidence-active', '')
    await expect(evidence.getByRole('heading', { name: 'Claim' })).toHaveCSS('background-color', /(?:rgb|color)\(/)
    await page.keyboard.press('Escape')
    const localFinding = evidence.getByRole('link', { name: 'Local finding' })
    await localFinding.focus()
    await expect(localFinding).toBeFocused()
    await localFinding.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Preview ./evidence.md#finding' })).toBeVisible()
    await page.keyboard.press('Escape')

    const inlineImage = screenshot.locator('.strata-image--ready')
    const decodedImages = screenshot.locator('img:not(.ProseMirror-separator)')
    await expect(decodedImages).toHaveCount(1)
    await inlineImage.click()
    await expect(screenshot).toHaveAttribute('data-screenshot-focused', '')
    await expect(page.getByRole('dialog', { name: 'Inspect Review screenshot' })).toHaveCount(0)
    await expect(decodedImages).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: /Annotate selection/i })).toHaveCount(0)
    await screenshot.getByRole('button', { name: 'Close focus' }).click()
    await expect(screenshot).not.toHaveAttribute('data-screenshot-focused')

    await screenshot.getByRole('button', { name: 'Pin 1: Long rows need a clearer boundary.' }).click()
    await expect(screenshot).toHaveAttribute('data-active-pin', '1')
    const composer = page.locator('.annotation-composer')
    await expect(composer).toBeVisible()
    await expect(composer.locator('blockquote')).toContainText('Long rows need a clearer boundary.')
    await composer.locator('textarea').fill('Should this boundary be stronger?')
    await page.evaluate(() => (document.querySelector('.annotation-composer') as HTMLFormElement).requestSubmit())
    await expect.poll(async () => (await scenario.inspectDocument()).annotations?.some((annotation) => annotation.text === 'Should this boundary be stronger?')).toBe(true)
    await page.getByRole('button', { name: 'Close thread' }).click()

    await screenshot.getByRole('button', { name: 'Place pin' }).click()
    await inlineImage.click({ position: { x: 90, y: 45 } })
    await expect(screenshot.getByText('Describe this pin', { exact: true })).toBeVisible()
    const newPin = screenshot.getByRole('button', { name: 'Pin 2: Describe this pin' })
    await expect(newPin).toBeVisible()
    await newPin.click()
    await expect(composer.locator('blockquote')).toHaveText(/^\| 2 \| [\d.]+ \| [\d.]+ \| \d+:\d+ \| Describe this pin \|$/u)
    await page.keyboard.press('Escape')
    expect(await readFile(scenario.file, 'utf8')).toBe(original)

    await save(page)
    expect(await readFile(scenario.file, 'utf8')).toContain('| 2 |')

    const externalResources = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /^https?:/u.test(url)))
    expect(externalResources).toEqual([])

    await scenario.stop()
    await writeFile(image, Buffer.concat([imageBytes, Buffer.from([0])]))
    const reopened = await scenario.launch()
    const reopenedScreenshot = reopened.getByRole('region', { name: 'AnnotatedScreenshot: AnnotatedScreenshot' })
    await expect(reopenedScreenshot.getByRole('status')).toContainText('Image changed — verify pin positions')
    await expect(reopenedScreenshot.getByRole('button', { name: /Pin 1:/ })).toBeVisible()
    await reopenedScreenshot.getByRole('button', { name: 'Positions are correct' }).click()
    await expect(reopenedScreenshot.getByRole('status')).toHaveCount(0)
    await expect(reopenedScreenshot.locator('img:not(.ProseMirror-separator)')).toHaveCount(1)
  } finally {
    await scenario.dispose()
  }
})

test('copy and paste preserves explicit component properties', { tag: '@clipboard' }, async ({}, testInfo) => {
  const source = '# Clipboard\n\n<Callout kind="warning">\nWarning body.\n</Callout>\n'
  const scenario = await Scenario.create(testInfo, source, 'component-clipboard.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    await editor.click()
    await page.keyboard.press(primaryKey('a'))
    await page.keyboard.press(primaryKey('c'))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.keyboard.press(primaryKey('v'))
    await expect(editor.getByRole('region', { name: 'Callout: warning' })).toHaveCount(2)
    await save(page)
    expect((await readFile(scenario.file, 'utf8')).match(/<Callout kind="warning">/gu)).toHaveLength(2)
  } finally {
    await scenario.dispose()
  }
})

test('a malformed pin cell does not shift later pin rows', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Preparing\n', 'pin-row-identity.md')
  try {
    const image = join(dirname(scenario.file), 'review.png')
    await writeFile(image, imageBytes)
    const details = await stat(image, { bigint: true })
    const version = `${details.size}:${details.mtimeNs}`
    const source = `<AnnotatedScreenshot>\n![Review screenshot](./review.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n| 1 | 20 | 30 | ${version} | First. |\n| 2 | 70 | 80 | ${version} | Second. |\n</AnnotatedScreenshot>\n`
    await writeFile(scenario.file, source)
    const page = await scenario.launch()
    const screenshot = page.getByRole('region', { name: 'AnnotatedScreenshot: AnnotatedScreenshot' })
    await expect(screenshot).toBeVisible()
    const rows = screenshot.locator('tbody tr:has(td)')
    await rows.nth(0).locator('td').first().evaluate((cell) => {
      const selection = window.getSelection()
      const range = document.createRange()
      cell.closest<HTMLElement>('.ProseMirror')?.focus()
      range.selectNodeContents(cell)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await page.keyboard.insertText('not-a-number')
    await expect(screenshot.getByRole('button', { name: 'Pin 1: First.' })).toHaveCount(0)
    const secondPin = screenshot.getByRole('button', { name: 'Pin 2: Second.' })
    await expect(secondPin).toBeVisible()
    await rows.nth(1).click()
    await expect(secondPin).toHaveClass(/is-active/u)
  } finally {
    await scenario.dispose()
  }
})
