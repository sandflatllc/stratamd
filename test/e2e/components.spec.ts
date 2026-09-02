import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { lineEndKey, primaryKey, save, Scenario } from './harness'

const componentMarkdown = `# Component review

<Callout kind="warning">
### Before continuing

Edit target
</Callout>

<Verdict outcome="recommended">
Use the closed registry.
</Verdict>

<MetricStrip>
- **Open time:** 224 ms
- **Byte drift:** 0
</MetricStrip>

<PhaseBoard>
### Phase 1

| Work | Status |
|---|---|
| Parser | Complete |
</PhaseBoard>
`

test('registered components render semantically, edit their Markdown children, and preserve wrapper bytes', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, componentMarkdown, 'components.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    const callout = editor.getByRole('region', { name: 'Callout: warning' })
    const verdict = editor.getByRole('region', { name: 'Verdict: recommended' })
    const metrics = editor.getByRole('region', { name: 'MetricStrip: MetricStrip' })
    const phases = editor.getByRole('region', { name: 'PhaseBoard: PhaseBoard' })
    await expect(callout).toBeVisible()
    await expect(verdict).toBeVisible()
    await expect(metrics).toBeVisible()
    await expect(phases).toBeVisible()
    await expect(callout.getByRole('heading', { name: 'Before continuing' })).toBeVisible()
    await expect(metrics.getByRole('list')).toBeVisible()
    await expect(phases.getByRole('table')).toBeVisible()
    await expect(callout).toHaveCSS('border-left-style', 'solid')
    await expect(page.locator('.navigation-rail')).toBeVisible()
    await expect(page.locator('.right-rail')).toBeVisible()

    await save(page)
    expect(await readFile(scenario.file, 'utf8')).toBe(componentMarkdown)

    const paragraph = callout.getByText('Edit target', { exact: true })
    await paragraph.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press(lineEndKey)
    await page.keyboard.insertText(' safely')
    const edited = componentMarkdown.replace('Edit target', 'Edit target safely')
    await scenario.waitForBuffer(edited)
    await expect(callout.getByText('Edit target safely', { exact: true })).toBeVisible()
    await expect(verdict).toContainText('Use the closed registry.')

    await page.keyboard.press(primaryKey('/'))
    const source = page.getByRole('textbox', { name: 'Source editor' })
    await expect(source).toBeVisible()
    await expect(source).toHaveValue(edited)
    await page.keyboard.press(primaryKey('/'))
    await save(page)
    expect(await readFile(scenario.file, 'utf8')).toBe(edited)
  } finally {
    await scenario.dispose()
  }
})

test('invalid registered syntax becomes a preserved error card while unknown and inline tags stay raw', async ({}, testInfo) => {
  const source = `# Invalid components

<Verdict color="pink">
This cannot select presentation.
</Verdict>

<UnknownVisual>
Unknown component.
</UnknownVisual>

Before <Callout>inline</Callout> after.
`
  const scenario = await Scenario.create(testInfo, source, 'invalid-components.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    const error = editor.getByRole('note', { name: 'Verdict component needs attention' })
    await expect(error).toContainText('Component needs attention')
    await expect(error).toContainText('does not accept the color property')
    await expect(error.locator('pre')).toContainText('<Verdict color="pink">')
    await expect(editor.getByRole('region', { name: /Verdict|UnknownVisual|Callout/ })).toHaveCount(0)
    await expect(editor.locator('pre[data-strata-raw="html"]')).toHaveCount(2)

    await save(page)
    expect(await readFile(scenario.file, 'utf8')).toBe(source)
    await page.keyboard.press(primaryKey('/'))
    await expect(page.getByRole('textbox', { name: 'Source editor' })).toHaveValue(source)
  } finally {
    await scenario.dispose()
  }
})
