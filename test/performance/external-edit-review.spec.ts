import { expect, test } from '../e2e/test'
import { writeFile } from 'node:fs/promises'
import { Scenario, documentStartKey, lineEndKey } from '../e2e/harness'
import { generateCorpus } from './corpus'
import { parseMarkdown } from '../../src/core/markdown'

// Product timing uses one in-page observer. Repeated role-based accessible
// name queries can themselves block a large table DOM for over a second.
for (const position of ['top', 'bottom'] as const) {
  test(`external ${position} edit to review after typing`, async ({}, testInfo) => {
    test.setTimeout(60_000)
    const original = generateCorpus('table-heavy', 100_000).markdown
    const scenario = await Scenario.create(testInfo, original, 'tables.md')
    try {
      const page = await scenario.launch()
      const editor = page.locator('.strata-prosemirror')
      await editor.focus()
      await page.keyboard.press(documentStartKey)
      await page.keyboard.press(lineEndKey)
      const typingStarted = Date.now()
      await page.keyboard.insertText(' measured')
      const typingCallMs = Date.now() - typingStarted
      const headingEnd = original.indexOf('\n')
      const typed = `${original.slice(0, headingEnd)} measured${original.slice(headingEnd)}`
      await scenario.waitForBuffer(typed, 15_000)
      const typingToMirrorMs = Date.now() - typingStarted
      const { buffer } = await scenario.inspectDocument()
      const parsed = parseMarkdown(typed)
      const block = position === 'top'
        ? parsed.blocks.find((block) => block.node.type === 'paragraph')!
        : parsed.blocks.findLast((block) => block.node.type === 'table')!
      const at = position === 'top' ? block.span.end.offset : block.span.end.offset - 2
      const changed = `${typed.slice(0, at)} external sentence${typed.slice(at)}`
      await page.evaluate(() => {
        const root = globalThis as typeof globalThis & { reviewAppeared: Promise<number>; strataReparseStats: { stitched: number; fallbacks: Record<string, number> } }
        root.strataReparseStats.stitched = 0
        root.strataReparseStats.fallbacks = {}
        root.reviewAppeared = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            const button = document.querySelector('button[aria-label^="Keep change"]')
            if (button && button.getClientRects().length > 0) { observer.disconnect(); resolve(Date.now()) }
          })
          observer.observe(document.body, { childList: true, subtree: true, attributes: true })
        })
      })
      const writtenAt = Date.now()
      await scenario.atomicWrite(buffer!, changed)
      const appearedAt = await page.evaluate(() => (globalThis as typeof globalThis & { reviewAppeared: Promise<number> }).reviewAppeared)
      const reparse = await page.evaluate(() => (globalThis as typeof globalThis & { strataReparseStats: unknown }).strataReparseStats)
      expect((await scenario.inspectDocument()).document).toBe(changed)
      const result = { position, bytes: Buffer.byteLength(original), typingCallMs, typingToMirrorMs, externalEditToReviewMs: appearedAt - writtenAt, reparse }
      const path = testInfo.outputPath('measurement.json')
      await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
      await testInfo.attach('measurement', { path, contentType: 'application/json' })
      console.log(JSON.stringify(result))
    } finally { await scenario.dispose() }
  })
}
