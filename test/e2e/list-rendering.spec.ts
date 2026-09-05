import { expect, test, type Locator } from '@playwright/test'
import { Scenario } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'

/**
 * Lists keep their markers and gutter in the ProseMirror editor (PRD §6.1
 * lists, §6.9 conversation text). The stylesheet imports Tailwind, whose
 * preflight strips every list's marker and padding, so the editor must put
 * them back for documents and for mounted conversation messages alike.
 */
const LISTS = [
  'A paragraph before.',
  '',
  '- Alpha',
  '- Beta',
  '  - Nested one',
  '  - Nested two',
  '    - Third level',
  '- Gamma',
  '',
  '1. First',
  '2. Second',
  '3. Third',
  '',
  'Then a loose list.',
  '',
  '1. Loose first',
  '',
  '   Second paragraph of the first item.',
  '',
  '2. Loose second',
  '',
  '- [ ] Open task',
  '- [x] Done task',
  '',
  'A paragraph after.',
  '',
].join('\n')

async function listStyles(editor: Locator) {
  return editor.evaluate((node) => {
    const read = (selector: string, property: string) => {
      const element = node.querySelector(selector)
      return element ? getComputedStyle(element).getPropertyValue(property) : null
    }
    return {
      bullet: read('ul', 'list-style-type'),
      nested: read('ul ul', 'list-style-type'),
      third: read('ul ul ul', 'list-style-type'),
      numbered: read('ol', 'list-style-type'),
      gutter: Number.parseFloat(read('ul', 'padding-left') ?? '0'),
      nestedGutter: Number.parseFloat(read('ul ul', 'padding-left') ?? '0'),
      tightItemParagraph: read('ol[data-tight="true"] > li > p', 'margin-bottom'),
      tightItemGap: Number.parseFloat(read('ol[data-tight="true"] > li + li', 'margin-top') ?? '0'),
      looseItemGap: Number.parseFloat(read('ol[data-tight="false"] > li + li', 'margin-top') ?? '0'),
    }
  })
}

function expectMarkers(styles: Awaited<ReturnType<typeof listStyles>>) {
  expect(styles.bullet).toBe('disc')
  expect(styles.nested).toBe('circle')
  expect(styles.third).toBe('square')
  expect(styles.numbered).toBe('decimal')
  expect(styles.gutter).toBeGreaterThan(16)
  expect(styles.nestedGutter).toBeGreaterThan(16)
  expect(styles.tightItemParagraph).toBe('0px')
  expect(styles.looseItemGap).toBeGreaterThan(styles.tightItemGap)
}

test('a document renders bullet, numbered, nested, tight, and loose lists with markers and a gutter', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, `# Lists\n\n${LISTS}`, 'lists.md')
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1400, height: 1000 })
    const editor = page.getByRole('textbox', { name: 'Document editor' })
    await expect(editor.locator('ol > li')).toHaveCount(5)
    await expect(editor.locator('ul ul ul > li')).toHaveCount(1)
    expectMarkers(await listStyles(editor))
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.locator('.editor-island').screenshot({ path: testInfo.outputPath('document-lists.png'), animations: 'disabled' })
  } finally {
    await scenario.dispose()
  }
})

test('a completed conversation message keeps its list markers once the read-only editor mounts', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  engine.setMessage(LISTS)
  engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Open in center' }).click()
    const message = page.locator('.conversation-panel[data-placement="center"] [data-message-id="m1"]')
    const editor = message.locator('.ProseMirror')
    await expect(editor).toBeVisible()
    await expect(editor.locator('ol > li')).toHaveCount(5)
    expectMarkers(await listStyles(editor))
    await editor.locator('ul').first().scrollIntoViewIfNeeded()
    await page.locator('.conversation-panel[data-placement="center"]').screenshot({ path: testInfo.outputPath('conversation-lists.png'), animations: 'disabled' })
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
