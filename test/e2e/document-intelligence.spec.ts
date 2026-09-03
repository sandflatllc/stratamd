import { expect, test } from '@playwright/test'
import { dirname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { primaryKey, Scenario } from './harness'

const markdown = `# Document intelligence

## Fold this section

Hidden review sentence.

Read [the notes](notes.md#details) or preview \`notes.md\`.

\`\`\`mermaid
flowchart LR
  A[First<br/>line] --> B[Second]
\`\`\`

\`\`\`tree
project/
├── notes.md
└── src/
    └── index.ts
\`\`\`

![Tiny sample](pixel.png "One pixel")

## Next section

Visible ending.
`

test('diagrams, trees, images, local previews, and durable folds remain document-safe', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const scenario = await Scenario.create(testInfo, markdown, 'intelligence.md')
  try {
    const documentDirectory = dirname(scenario.file)
    await writeFile(join(documentDirectory, 'notes.md'), '# Notes\n\n## Details\n\nPreview body.\n')
    await writeFile(join(documentDirectory, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })

    const diagram = page.locator('.strata-visual-code--mermaid')
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 20_000 })
    await expect(diagram.locator('svg')).not.toContainText('<br/>')
    const diagramTheme = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--controls-primary)'
      document.querySelector<HTMLElement>('.strata-mermaid-canvas')!.append(probe)
      const primary = getComputedStyle(probe).color
      probe.style.color = 'var(--text)'
      const text = getComputedStyle(probe).color
      probe.remove()
      const node = document.querySelector<SVGElement>('.strata-mermaid-canvas svg .node rect')
      const label = document.querySelector<SVGElement>('.strata-mermaid-canvas svg text')
      return { primary, text, stroke: node ? getComputedStyle(node).stroke : null, fill: label ? getComputedStyle(label).fill : null }
    })
    expect(diagramTheme.stroke).toBe(diagramTheme.primary)
    expect(diagramTheme.fill).toBe(diagramTheme.text)
    await diagram.getByRole('button', { name: '+', exact: true }).click()
    const diagramViewport = diagram.getByRole('img', { name: /110 percent zoom/ })
    await diagramViewport.focus()
    await diagramViewport.press('ArrowRight')
    await expect(diagram.locator('.strata-mermaid-canvas')).toHaveAttribute('style', /translate\(12px, 0px\) scale\(1\.1\)/)
    await diagram.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(diagram.locator('pre')).toContainText('First<br/>line')
    await diagram.getByRole('button', { name: 'Diagram', exact: true }).click()

    const tree = page.locator('.strata-visual-code--tree')
    await expect(tree.getByRole('treeitem')).toHaveCount(4)
    const sourceFolder = tree.getByRole('treeitem').filter({ hasText: 'src/' }).first()
    await sourceFolder.focus()
    await page.keyboard.press('Enter')
    await expect(sourceFolder).toHaveAttribute('aria-expanded', 'false')

    const inspectImage = page.getByRole('button', { name: 'Inspect Tiny sample' })
    await inspectImage.click()
    const inspector = page.getByRole('dialog', { name: 'Inspect Tiny sample' })
    await expect(inspector).toContainText('One pixel')
    await expect(inspector).toContainText('pixel.png')
    expect(await inspector.locator('img').getAttribute('src')).toBe(await inspectImage.locator('img').getAttribute('src'))
    const inspectorPlacement = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('.strata-image-inspector')!.getBoundingClientRect()
      const island = document.querySelector<HTMLElement>('.editor-island')!.getBoundingClientRect()
      return {
        delta: Math.max(
          Math.abs(surface.left - island.left),
          Math.abs(surface.top - island.top),
          Math.abs(surface.width - island.width),
          Math.abs(surface.height - island.height),
        ),
        sideRegionsVisible: [...document.querySelectorAll<HTMLElement>('.navigation-rail, .right-rail')]
          .every((element) => element.getBoundingClientRect().width > 0),
      }
    })
    expect(inspectorPlacement.delta).toBeLessThan(1)
    expect(inspectorPlacement.sideRegionsVisible).toBe(true)
    await inspector.getByRole('button', { name: '+', exact: true }).click()
    await inspector.locator('.strata-image-inspector__viewport').press('ArrowDown')
    await expect(inspector.locator('img')).toHaveAttribute('style', /translate\(0px, 12px\) scale\(1\.1\)/)
    await page.evaluate(async (path) => window.strata.openDocument(path), join(documentDirectory, 'notes.md'))
    await page.getByRole('tab', { name: /intelligence\.md/i }).click()
    const restoredInspector = page.getByRole('dialog', { name: 'Inspect Tiny sample' })
    await expect(restoredInspector.locator('img')).toHaveAttribute('style', /translate\(0px, 12px\) scale\(1\.1\)/)
    await restoredInspector.locator('.strata-image-inspector__viewport').press('Escape')
    await expect(inspectImage).toBeFocused()
    await expect(diagram.locator('.strata-mermaid-canvas')).toHaveAttribute('style', /translate\(12px, 0px\) scale\(1\.1\)/)

    await editor.getByRole('link', { name: 'the notes' }).click()
    const linkPreview = page.getByRole('dialog', { name: 'Preview notes.md#details' })
    await expect(linkPreview).toContainText('Preview body.')
    await linkPreview.getByRole('button', { name: 'Open document' }).click()
    await expect(page.getByRole('tab', { name: /notes\.md/i })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: /intelligence\.md/i }).click()
    await editor.getByRole('button', { name: 'Preview notes.md' }).press('Enter')
    await expect(page.getByRole('dialog', { name: 'Preview notes.md' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor.getByRole('button', { name: 'Preview notes.md' })).toBeFocused()

    await page.getByRole('button', { name: 'Close tab intelligence.md' }).click()
    await expect(page.getByRole('tab', { name: /intelligence\.md/i })).toHaveCount(0)
    await page.evaluate(async (path) => window.strata.openDocument(path), scenario.file)
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 20_000 })
    await expect(diagram.locator('.strata-mermaid-canvas')).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/)
    await inspectImage.click()
    await expect(page.getByRole('dialog', { name: 'Inspect Tiny sample' }).locator('img')).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/)
    await page.keyboard.press('Escape')

    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    const annotation = await scenario.cli(['annotate', scenario.file, '--kind', 'question', '--quote', 'Hidden review sentence.', '--text', 'Check this?', '--as', 'agent-a'])
    expect(annotation.code, annotation.stderr).toBe(0)
    const changed = markdown.replace('Hidden review sentence.\n', 'Hidden review sentence.\n\nAgent-added sentence.\n')
    const state = await scenario.state()
    await scenario.atomicWrite(state.buffer!, changed)
    await expect(page.getByRole('tab', { name: /^Changes/ }).locator('.rail-tab-count')).toHaveText('1')
    const foldHeading = page.locator('.strata-fold-heading').filter({ hasText: 'Fold this section' })
    const fold = foldHeading.getByRole('button', { name: 'Collapse section' })
    await fold.click()
    await expect(editor.getByText('Hidden review sentence.', { exact: true })).toBeHidden()
    await expect(foldHeading).toContainText('1 annotation hidden · 1 change hidden')
    expect(await readFile(scenario.file, 'utf8')).toBe(markdown)

    await editor.click()
    await page.keyboard.press(primaryKey('f'))
    await page.getByRole('textbox', { name: 'Find in document' }).fill('Hidden review sentence')
    await expect(editor.getByText('Hidden review sentence.', { exact: true })).toBeVisible()
    await expect(foldHeading).toContainText('Temporarily open')
    await page.getByRole('button', { name: 'Close find' }).click()
    await editor.getByText('Visible ending.', { exact: true }).click()
    await expect(editor.getByText('Hidden review sentence.', { exact: true })).toBeHidden()

    await page.keyboard.press('F7')
    await expect(editor.getByText('Agent-added sentence.', { exact: true })).toBeVisible()
    await editor.getByText('Visible ending.', { exact: true }).click()
    await expect(editor.getByText('Agent-added sentence.', { exact: true })).toBeHidden()

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    await page.locator('.annotation-row').filter({ hasText: 'Hidden review sentence.' }).click()
    await expect(editor.getByText('Hidden review sentence.', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'question thread' })).toBeVisible()
    await page.getByRole('button', { name: 'Close thread' }).click()
    await editor.getByText('Visible ending.', { exact: true }).click()
    await expect(editor.getByText('Hidden review sentence.', { exact: true })).toBeHidden()

    await scenario.stop()
    const reopened = await scenario.launch()
    await expect(reopened.locator('.strata-fold-heading').filter({ hasText: 'Fold this section' }).getByRole('button', { name: 'Expand section' })).toBeVisible()
  } finally {
    await scenario.dispose()
  }
})

const defensiveMarkdown = `# Defensive document intelligence

[Missing notes](missing.md)

\`https://example.test/remote.md\` and \`notes.txt\`

![Remote sample](https://example.test/remote.png)

\`\`\`mermaid title="ordinary"
flowchart LR
  A --> B
\`\`\`

\`\`\`tree extra
root/
\`\`\`

\`\`\`mermaid
this is not a diagram
\`\`\`

\`\`\`tree
root/
        invalid-depth.md
\`\`\`
`

test('invalid and nonlocal constructs stay inert and preserve their source', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, defensiveMarkdown, 'defensive-intelligence.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })

    await expect(editor.locator(':scope > pre[data-info="mermaid"]')).toContainText('A --> B')
    await expect(editor.locator(':scope > pre[data-info="tree"]')).toContainText('root/')
    await expect(page.locator('.strata-visual-code--mermaid')).toHaveCount(1)
    await expect(page.locator('.strata-visual-code--tree')).toHaveCount(1)

    const failedDiagram = page.locator('.strata-visual-code--mermaid')
    await expect(failedDiagram.locator('.strata-visual-code__error')).toContainText('could not be drawn', { timeout: 20_000 })
    await failedDiagram.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(failedDiagram.locator('pre')).toContainText('this is not a diagram')

    const malformedTree = page.locator('.strata-visual-code--tree')
    await expect(malformedTree.locator('.strata-visual-code__error')).toContainText('could not be read')
    await expect(malformedTree.locator('.strata-file-tree__preserved')).toHaveText('root/\n        invalid-depth.md')

    await expect(editor.getByText('Remote image blocked')).toBeVisible()
    await expect(editor.locator('code').filter({ hasText: 'https://example.test/remote.md' })).not.toHaveAttribute('role', 'button')
    await expect(editor.locator('code').filter({ hasText: 'notes.txt' })).not.toHaveAttribute('role', 'button')
    await editor.getByRole('link', { name: 'Missing notes' }).click()
    await expect(page.getByRole('dialog', { name: 'Preview missing.md' })).toHaveCount(0)

    const externalResources = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /^https?:/u.test(url)))
    expect(externalResources).toEqual([])
    expect(await readFile(scenario.file, 'utf8')).toBe(defensiveMarkdown)
  } finally {
    await scenario.dispose()
  }
})

const nestedFoldMarkdown = `# Fold levels

## Outer

### Middle

#### Deep section

Deep body.

##### Deeper child

Child body.

#### Peer section

Peer body.
`

test('a nested fold keeps source identity through a heading rename and restart', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, nestedFoldMarkdown, 'fold-identity.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    const deep = page.locator('.strata-fold-heading').filter({ has: page.getByRole('heading', { name: 'Deep section', exact: true }) })
    await deep.getByRole('button', { name: 'Collapse section' }).click()
    await expect(editor.getByText('Deep body.', { exact: true })).toBeHidden()
    await expect(editor.getByRole('heading', { name: 'Deeper child', exact: true })).toBeHidden()
    await expect(editor.getByRole('heading', { name: 'Peer section', exact: true })).toBeVisible()

    const heading = deep.getByRole('heading', { name: 'Deep section', exact: true })
    // Click the text edge rather than the flexed heading's empty trailing width.
    await heading.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('End')
    await page.keyboard.insertText(' renamed')
    const renamedMarkdown = nestedFoldMarkdown.replace('#### Deep section', '#### Deep section renamed')
    await scenario.waitForBuffer(renamedMarkdown)
    const renamedBeforeRestart = page.locator('.strata-fold-heading').filter({ has: page.getByRole('heading', { name: 'Deep section renamed', exact: true }) })
    await expect(renamedBeforeRestart.getByRole('button', { name: 'Expand section' })).toBeVisible()
    await expect(editor.getByText('Deep body.', { exact: true })).toBeHidden()

    await scenario.stop()
    const reopened = await scenario.launch()
    const renamed = reopened.locator('.strata-fold-heading').filter({ has: reopened.getByRole('heading', { name: 'Deep section renamed', exact: true }) })
    await expect(renamed.getByRole('button', { name: 'Expand section' })).toBeVisible()
    await expect(reopened.getByRole('textbox', { name: 'Document editor' }).getByText('Deep body.', { exact: true })).toBeHidden()
    expect(await readFile(scenario.file, 'utf8')).toBe(nestedFoldMarkdown)
  } finally {
    await scenario.dispose()
  }
})

test('typing from a folded heading opens the new text temporarily', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, nestedFoldMarkdown, 'fold-typing.md')
  try {
    const page = await scenario.launch()
    const fold = page.locator('.strata-fold-heading').filter({ has: page.getByRole('heading', { name: 'Deep section', exact: true }) })
    await fold.getByRole('button', { name: 'Collapse section' }).click()
    const heading = fold.getByRole('heading', { name: 'Deep section', exact: true })
    await heading.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('Visible while editing.')
    await expect(page.getByText('Visible while editing.', { exact: true })).toBeVisible()
    await expect(fold).toContainText('Temporarily open')
  } finally {
    await scenario.dispose()
  }
})
